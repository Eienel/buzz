// BUZZ (Last Comb Standing), devnet agent swarm.
// One process = keeper + N player agents with distinct strategies, playing
// continuous games so spectators (app/) always have something live to watch.
//
//   PAYER=path/to/funded-keypair.json RPC=https://api.devnet.solana.com \
//   AGENTS=5 GAMES=0 node agents/swarm.mjs        # GAMES=0 -> loop forever
//
// The payer funds ephemeral agent wallets each game; refunds/winnings are
// swept back to the payer at the end, so one funded wallet sustains the swarm.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
         SYSVAR_SLOT_HASHES_PUBKEY, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync } from "@solana/spl-token";
import jsSha3 from "js-sha3";
const { keccak_256 } = jsSha3;
import { readFileSync } from "node:fs";
import { decide, reasoningEnabled, modelFor, personaFor } from "./reason.mjs";
import { makeBudget, totalPointsOf } from "./budget.mjs";
import { loadKeypair } from "../server/keypair.mjs";

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
// At least MIN_COMBS agents, one per comb, or the game cannot legally start.
const MIN_COMBS = 4;
const N_AGENTS = Math.max(MIN_COMBS, Number(process.env.AGENTS ?? 5));
// Agent wallets are derived from `${strategy}-${slot}${i}`, so folding a fourth
// strategy into the rotation would rename every existing agent and orphan a
// leaderboard that herd-00 has been building for days. Reasoning agents are
// appended after the heuristics instead: the control group keeps its names,
// its wallets and its record.
const POD_AGENTS = Number(process.env.POD_AGENTS ?? (reasoningEnabled() ? 4 : 0));
// Measured UsePod latency is 0.5s to 21s, routing variance rather than model
// choice, so on a 24s instance the model will often miss the commit window.
// That is no longer a reason to sit the game out: a reasoning agent that misses
// stays in its comb and skips only the prediction, so it is still exposed to
// the board and still counted. Set POD_MIN_TEMPO to gate them off fast games
// again if the miss rate makes those games uninteresting.
const POD_MIN_TEMPO = Number(process.env.POD_MIN_TEMPO ?? 0);
// How many games may be live at once, and how long to wait between starting
// them so three lobbies do not all crank on the same second.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 3);
const STAGGER_MS = Number(process.env.STAGGER_SECONDS ?? 25) * 1000;
// Tempos a game may be dealt. A fast lobby and a slow one running side by side
// is the point: spectators always have something resolving, and agents have to
// handle both a 60 second and a 5 minute think.
// Instance length, not game length: a game runs until one comb is left, so
// with five or six combs that is four or five instances. 24 / 60 / 120 gives
// games of roughly two, five and ten minutes.
// Two and five minute games. A ten minute game costs twice the wall clock of
// a five and tells you nothing extra: nobody watches a full one, and it was
// the tempo that filled slowest, so it dominated the stranded lobbies.
const TEMPOS = (process.env.TEMPOS ?? "24,60").split(",").map(Number);
// One game in this many is played in the second asset; the rest are the ranked
// one. 4 means three quarters of the arena counts toward the season.
const BUZZ_EVERY = Number(process.env.RANKED_RATIO ?? 4);
// Swarm identities are derived from a seed rather than generated per game, so
// "herd-0" is the same wallet every time and builds a record worth beating.
// Ephemeral keys would have left the leaderboard permanently empty.
// One set per concurrent slot, so two live games never share a wallet and race
// each other's funding and sweep.
const SWARM_SEED = process.env.SWARM_SEED ?? "buzz-devnet-swarm-v1";
const agentKey = (name) => Keypair.fromSeed(
  Uint8Array.from(Buffer.from(keccak_256.arrayBuffer(`${SWARM_SEED}:${name}`)).subarray(0, 32)));
// 0 = forever, which is what a hosted arena wants. Defaulting to one game meant
// the process exited after each one, the supervisor restarted it, gameNo reset
// to zero, and the slot was therefore always zero: the concurrency scheduler
// never ran and only the first five agent identities ever played.
const N_GAMES = Number(process.env.GAMES ?? 0);
// Stakes are SPL tokens now. STAKE is in whole units of the stake asset.
const STAKE_UNITS = Number(process.env.STAKE_UNITS ?? 10);
const mints = JSON.parse(readFileSync(new URL("./devnet-mints.json", import.meta.url), "utf8"));
const ASSETS = Object.entries(mints).map(([name, m]) => ({
  name, mint: new PublicKey(m.mint), decimals: m.decimals,
  tokenProgram: new PublicKey(m.tokenProgram),
}));
const GAME_INTERVAL = Number(process.env.GAME_INTERVAL_SECONDS ?? 180) * 1000; // idle between games
// Per-agent funding: stake + fixed headroom for Circle/Player PDA rent
// (~0.0036), tx fees, and the agent wallet's own rent-exempt minimum (~0.0009).
// A multiplier breaks at small stakes, the headroom cost is constant.
const FUND = 8_000_000; // SOL for fees and PDA rent only; the stake is a token

const payer = loadKeypair(process.env.PAYER, `${process.env.HOME}/.config/solana/id.json`);
const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8"));
const program = new Program(idl, provider);
const PID = program.programId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PID)[0];
const configPda = pda(Buffer.from("config"));
const gamePdaOf = (gid) => pda(Buffer.from("game"), gid.toArrayLike(Buffer, "le", 8));
// Cross-game record per wallet; created on a wallet's first claim.
const statsPda = (owner) => pda(Buffer.from("agent"), owner.toBuffer());

// ----- strategies: given fog (prev-instance member counts of alive circles),
// return { move: circleId|null, predict: circleId } -------------------------
const strategies = {
  // herd: go where it's crowded (safe from "fewest dies"), predict the thinnest
  herd(fog, self) {
    const alive = Object.entries(fog).map(([id, m]) => ({ id: +id, m }));
    alive.sort((a, b) => b.m - a.m);
    const target = alive[0].id;
    const thin = alive[alive.length - 1].id;
    return { move: target === self ? null : target, predict: thin };
  },
  // contrarian: assume the herd moves, so yesterday's thin circle refills; stay put more
  contrarian(fog, self) {
    const alive = Object.entries(fog).map(([id, m]) => ({ id: +id, m }));
    alive.sort((a, b) => a.m - b.m);
    const predict = alive[1] ? alive[1].id : alive[0].id; // second-thinnest dies once herd flees
    return { move: null, predict };
  },
  // random walker: pure noise (the control group)
  random(fog, self) {
    const ids = Object.keys(fog).map(Number);
    const pick = () => ids[Math.floor(Math.random() * ids.length)];
    const mv = pick();
    return { move: mv === self ? null : mv, predict: pick() };
  },
};
const stratNames = Object.keys(strategies);

// ----- commit hash (must mirror lib.rs) ------------------------------------
const moveHash = (target, nonce, owner, game, instance) =>
  Buffer.from(keccak_256.arrayBuffer(Buffer.concat([
    Buffer.from([target]), nonce.toArrayLike(Buffer, "le", 8),
    owner.toBuffer(), game.toBuffer(),
    Buffer.from(new Uint16Array([instance]).buffer),
  ])));

async function fundAgents(agents, asset) {
  const tx = new Transaction();
  for (const a of agents) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: a.kp.publicKey, lamports: FUND }));
  await provider.sendAndConfirm(tx, []);
  // hand each agent the stake asset (we hold mint authority on devnet)
  const amount = BigInt(STAKE_UNITS) * BigInt(10) ** BigInt(asset.decimals);
  for (const a of agents) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, asset.mint,
      a.kp.publicKey, false, undefined, undefined, asset.tokenProgram);
    a.ata = ata.address;
    await mintTo(connection, payer, asset.mint, a.ata, payer.publicKey, amount,
      [], undefined, asset.tokenProgram);
  }
}

async function sweepBack(agents) {
  for (const a of agents) {
    try {
      const bal = await connection.getBalance(a.kp.publicKey);
      if (bal <= 0) continue;
      // Move the agent's ENTIRE balance (down to 0) with the PAYER as fee payer,
      // so the agent isn't left with sub-rent-exempt dust (which the runtime
      // rejects) and doesn't need to keep lamports for its own fee.
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: a.kp.publicKey, toPubkey: payer.publicKey, lamports: bal }));
      tx.feePayer = payer.publicKey;
      await provider.sendAndConfirm(tx, [a.kp]); // payer signs as fee payer + wallet; agent signs the transfer
    } catch (e) { log(`sweep ${a.name} failed: ${String(e.message).slice(0, 60)}`); }
  }
}

const fetchGame = (g) => program.account.game.fetch(g);
const waitPhaseEnd = async (gamePda, margin = 1500) => {
  const g = await fetchGame(gamePda);
  const ms = g.phaseEndsAt.toNumber() * 1000 - Date.now() + margin;
  if (ms > 0) await sleep(ms);
};

// The arena the swarm plays in. In production the swarm is a child of the
// server, so this is the same process's own HTTP port.
const ARENA_URL = process.env.ARENA_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
// Opt in while the scheduler and the swarm both exist, so turning one on does
// not silently change what the other does.
const ADOPT_SCHEDULED = process.env.ADOPT_SCHEDULED === "1";

/**
 * An open lobby for this asset that the scheduler opened and nobody has filled.
 *
 * Returns null on anything unexpected, and the caller opens its own game. A
 * swarm that cannot reach the arena should keep playing, not stop.
 */
async function findScheduledLobby(asset) {
  if (!ADOPT_SCHEDULED) return null;
  try {
    const r = await fetch(`${ARENA_URL}/api/state`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const mint = asset.mint.toBase58();
    const open = (await r.json()).live?.filter((g) =>
      g.status === 0 && g.stakeMint === mint && (g.players ?? 0) === 0) ?? [];
    // Oldest first: a lobby that has been waiting is the one to fill.
    open.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return open[0] ?? null;
  } catch { return null; }
}

/** Wait for whoever opened the lobby to start it, rather than racing them. */
async function waitForRunning(gamePda, gid, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const g = await program.account.game.fetch(gamePda);
    if (g.status.running) { log(`game ${gid}: scheduler started it`); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Nobody started it. Start it ourselves rather than stranding the stakes we
  // just put in: this is exactly the failure the scheduler exists to prevent,
  // so it should be loud when it happens anyway.
  log(`game ${gid}: nobody started the lobby in time, starting it`);
  await program.methods.startGame()
    .accountsPartial({ game: gamePda, authority: payer.publicKey }).rpc();
}

// A game that never finishes is worse than one that fails.
//
// Anchor's .rpc() has no timeout, so a stalled RPC hangs the call forever. The
// main loop waits on Promise.race(inflight), which never settles if every game
// in flight is hung, so the swarm goes silent: no new games, no crash, and the
// supervisor never restarts it because the process is still alive. That is
// exactly how the arena ended up with twelve stranded lobbies and nothing
// running for half an hour.
//
// Five instances at the slowest tempo, doubled, plus room to settle.
const GAME_DEADLINE_MS = Number(process.env.GAME_DEADLINE_MS
  ?? (Math.max(...TEMPOS) * 5 * 2 + 300) * 1000);

function withDeadline(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} passed its deadline`)), ms); }),
  ]);
}

// Last time anything finished. If nothing does for long enough the process is
// wedged in a way it cannot see, and the only honest move is to die so the
// supervisor can restart it.
let lastProgress = Date.now();
// The per-game deadline already stops the loop wedging, so this only catches
// a stall somewhere else. Deadline plus five minutes: long enough that a slow
// game is never mistaken for a hang, short enough that nobody watches a dead
// arena for half an hour again.
const STALL_EXIT_MS = Number(process.env.STALL_EXIT_MS ?? GAME_DEADLINE_MS + 300_000);
setInterval(() => {
  if (Date.now() - lastProgress < STALL_EXIT_MS) return;
  log(`no game finished in ${Math.round(STALL_EXIT_MS / 60000)}m, exiting so the supervisor restarts`);
  process.exit(1);
}, 30_000).unref();

async function playGame(gameNo) {
  // Only BUZZ has an open season, so only BUZZ games move the leaderboard.
  // A strict alternation made half the arena unranked, which is the wrong
  // shape when ranked play is the reason people are here. ANSEM still gets a
  // share so it stays exercised rather than becoming dead code.
  const asset = ASSETS[gameNo % BUZZ_EVERY === 0 && ASSETS.length > 1 ? 1 : 0];
  const treasuryPda = pda(Buffer.from("treasury"), asset.mint.toBuffer());
  const tvaultPda = pda(Buffer.from("tvault"), asset.mint.toBuffer());
  const allowedPda = pda(Buffer.from("allowed"), asset.mint.toBuffer());
  // Either adopt a game the scheduler opened, or open one. Adopting is the
  // direction of travel: the swarm creating the games it plays is what strands
  // lobbies, because a lobby only starts itself while its creator is alive.
  const adopted = await findScheduledLobby(asset);
  const gid = adopted ? new BN(adopted.gameId) : new BN(Date.now());
  const gamePda = gamePdaOf(gid);
  const vaultPda = pda(Buffer.from("vault"), gamePda.toBuffer());
  const circlePda = (id) => pda(Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id]));
  const playerPda = (o) => pda(Buffer.from("player"), gamePda.toBuffer(), o.toBuffer());

  // A game's tempo is fixed when it is created, so an adopted one dictates it.
  const tempo = adopted ? adopted.instanceSeconds
                        : TEMPOS[Math.floor(Math.random() * TEMPOS.length)];
  const slot = gameNo % MAX_CONCURRENT;
  const podsThisGame = tempo >= POD_MIN_TEMPO ? POD_AGENTS : 0;
  const agents = Array.from({ length: N_AGENTS + podsThisGame }, (_, i) => {
    const pod = i >= N_AGENTS;
    const podIx = i - N_AGENTS;                       // 0..POD_AGENTS-1
    const name = pod ? `pod-${slot}${i}` : `${stratNames[i % stratNames.length]}-${slot}${i}`;
    return {
      kp: agentKey(name),
      name,
      pod,
      model: pod ? modelFor(podIx) : null,
      strat: pod
        ? (fog, self, instance) => decide(fog, self, {
            instance, instanceSeconds: tempo, history: fogHistory,
            model: modelFor(podIx), persona: personaFor(podIx), budget: budgets.get(name),
            // spread across the range so four pods on one board do not converge
            temperature: 0.5 + podIx * 0.15,
          })
        : strategies[stratNames[i % stratNames.length]],
      // one agent per comb for the first MIN_COMBS, so the comb floor is met by
      // construction rather than by luck; the rest spread over the six
      circle: i < MIN_COMBS ? i : i % 6, dead: false,
    };
  });
  log(`game ${gid}: ${asset.name}, ${tempo}s instances, ${N_AGENTS} heuristic` +
      `${podsThisGame ? ` + ${podsThisGame} reasoning (${[...new Set(agents.filter((a) => a.pod).map((a) => a.model))].join(", ")})` : ""} agents…`);
  // What each reasoning agent may spend on thinking this game, bought with the
  // skill points it has already earned on chain. Read once per game: a budget
  // that refilled mid-game would not be a budget.
  const budgets = new Map();
  for (const a of agents.filter((x) => x.pod)) {
    const pts = await totalPointsOf(connection, program.programId, a.kp.publicKey);
    budgets.set(a.name, makeBudget(pts));
    log(`  ${a.name}: ${pts} skill points buys ${budgets.get(a.name).granted} calls`);
  }

  await fundAgents(agents, asset);

  // Everything after funding is wrapped so sweepBack ALWAYS runs, a throw
  // anywhere in the lobby, instance loop, or settlement would otherwise strand
  // the ephemeral agent wallets' balances (their keypairs live only in memory).
  try {
  // lobby: keeper (payer) creates the game; agents create/join circles 0..5
  if (!adopted) {
    await program.methods.createGame(gid, 6, tempo, false).accountsPartial({
      config: configPda, stakeMint: asset.mint, allowed: allowedPda, game: gamePda, vault: vaultPda,
      authority: payer.publicKey, tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId,
    }).rpc();
  } else {
    log(`game ${gid}: adopted a scheduled lobby, ${tempo}s instances`);
  }
  const taken = new Set();
  for (const a of agents) {
    const stake = new BN(String(BigInt(STAKE_UNITS) * BigInt(10) ** BigInt(asset.decimals)));
    const acc = { config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(a.circle),
      player: playerPda(a.kp.publicKey), owner: a.kp.publicKey, payer: a.kp.publicKey, relayer: null,
      stakeMint: asset.mint, payerToken: a.ata, tokenProgram: asset.tokenProgram,
      systemProgram: SystemProgram.programId };
    if (!taken.has(a.circle)) {
      await program.methods.createCircle(a.circle, stake).accountsPartial(acc).signers([a.kp]).rpc();
      taken.add(a.circle);
      a.createdCircle = a.circle; // this agent is the circle's fixed creator (κ claimant)
    } else {
      await program.methods.joinCircle(stake).accountsPartial(acc).signers([a.kp]).rpc();
    }
    log(`  ${a.name} staked into circle ${a.circle}`);
  }
  // The scheduler starts what it opened. Racing it is harmless (the loser gets
  // WrongPhase) but pointless, so only start a game we opened ourselves.
  if (!adopted) {
    await program.methods.startGame().accountsPartial({ game: gamePda, authority: payer.publicKey }).rpc();
    log(`game ${gid}: started (${taken.size} circles)`);
  } else {
    await waitForRunning(gamePda, gid);
  }

  // fog = previous instance's finalized member counts
  let fog = {};
  // Every past fog, so a reasoning agent can see which combs are bleeding and
  // which just took a crowd. One snapshot alone has no trend in it.
  const fogHistory = [];
  const readFog = async () => {
    fog = {};
    for (const id of taken) {
      const c = await program.account.circle.fetch(circlePda(id));
      if (c.alive) fog[id] = c.memberCount;
    }
    fogHistory.push({ ...fog });
  };
  await readFog();

  // instance loop
  for (;;) {
    let g = await fetchGame(gamePda);
    if (g.status.settling) break;
    const instance = g.instance;

    // commit phase: every live agent commits a move + prediction
    const plans = new Map();
    // Thinking happens concurrently; a model agent can take seconds, and doing
    // that one after another would run past the commit window.
    const live = agents.filter((a) => !a.dead);
    const thought = await Promise.all(live.map(async (a) => {
      try { return { a, plan: await a.strat(fog, a.circle, instance) }; }
      catch (e) { log(`  ${a.name} strategy failed: ${String(e.message).slice(0, 60)}`); return null; }
    }));
    const modelled = thought.filter((t) => t?.plan?.by === "model").length;
    const podCount = live.filter((a) => a.pod).length;
    if (podCount) {
      const skipped = podCount - modelled;
      const broke = live.filter((a) => a.pod && budgets.get(a.name)?.left === 0).length;
      log(`  ${modelled}/${podCount} reasoning agents answered` +
        (skipped ? `, ${skipped} held and did not predict` : "") +
        (broke ? `, ${broke} out of budget` : ""));
      // One line of the model's own rationale per round. If every agent says
      // "smallest comb" the prompt is not producing reasoning and we should know.
      for (const t of thought) {
        if (t?.a?.pod && t.plan?.why)
          log(`    ${t.a.name} -> ${t.plan.predict}: ${t.plan.why}`);
      }
    }

    for (const t of thought) {
      // A null plan is a model that did not answer usably inside the commit
      // window. The agent still plays: it holds its comb, stays exposed to
      // whatever happens there, and simply forfeits the prediction. Guessing
      // one for it would credit the model with a point it never earned.
      if (!t || !t.plan) continue;
      const { a, plan } = t;
      const mvNonce = new BN(Math.floor(Math.random() * 1e9));
      const pdNonce = new BN(Math.floor(Math.random() * 1e9));
      // The agent asked to sit the next round out. Only worth honouring while
      // it still has something to save.
      const b = a.pod && budgets.get(a.name);
      if (b && plan.thinkNext === false && b.left > 0) b.saving = true;
      plans.set(a, { ...plan, mvNonce, pdNonce });
      try {
        if (plan.move !== null && fog[plan.move] !== undefined)
          await program.methods.commitMove([...moveHash(plan.move, mvNonce, a.kp.publicKey, gamePda, instance)])
            .accountsPartial({ game: gamePda, player: playerPda(a.kp.publicKey), owner: a.kp.publicKey, actor: a.kp.publicKey }).signers([a.kp]).rpc();
        await program.methods.commitPrediction([...moveHash(plan.predict, pdNonce, a.kp.publicKey, gamePda, instance)])
          .accountsPartial({ game: gamePda, player: playerPda(a.kp.publicKey), owner: a.kp.publicKey, actor: a.kp.publicKey }).signers([a.kp]).rpc();
      } catch (e) { log(`  ${a.name} commit failed: ${e.message?.slice(0, 80)}`); }
    }
    await waitPhaseEnd(gamePda);
    await program.methods.advanceToReveal().accountsPartial({ game: gamePda, cranker: payer.publicKey }).rpc();

    // reveal phase
    for (const [a, p] of plans) {
      if (p.move === null || fog[p.move] === undefined) continue;
      try {
        await program.methods.revealMove(p.move, p.mvNonce)
          .accountsPartial({ game: gamePda, player: playerPda(a.kp.publicKey), fromCircle: circlePda(a.circle), toCircle: circlePda(p.move), owner: a.kp.publicKey, actor: a.kp.publicKey })
          .signers([a.kp]).rpc();
        a.circle = p.move;
      } catch (e) { log(`  ${a.name} reveal failed: ${e.message?.slice(0, 80)}`); }
    }
    await waitPhaseEnd(gamePda);

    // death: select (retry until entropy slot passes), execute
    for (;;) {
      try {
        await program.methods.selectDeath()
          .accountsPartial({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, randomness: null, cranker: payer.publicKey })
          .remainingAccounts([...taken].filter((i) => fog[i] !== undefined).map((i) => ({ pubkey: circlePda(i), isSigner: false, isWritable: false })))
          .rpc();
        break;
      } catch (e) {
        if (String(e).includes("PhaseNotOver")) { await sleep(1200); continue; }
        throw e;
      }
    }
    g = await fetchGame(gamePda);
    const doomed = g.doomedCircle;
    await program.methods.executeDeath(doomed).accountsPartial({ game: gamePda, circle: circlePda(doomed), cranker: payer.publicKey }).rpc();
    log(`game ${gid}: instance ${instance}, circle ${doomed} died`);

    // scoring: reveal predictions; casualties land in the fullest surviving circle
    for (const [a, p] of plans) {
      try {
        await program.methods.revealPrediction(p.predict, p.pdNonce)
          .accountsPartial({ game: gamePda, player: playerPda(a.kp.publicKey), owner: a.kp.publicKey, actor: a.kp.publicKey }).signers([a.kp]).rpc();
        if (p.predict === doomed) log(`  ${a.name} called it (+1 skill point)`);
      } catch {}
    }
    delete fog[doomed];
    const gNow = await fetchGame(gamePda);
    const canLand = gNow.status.running && gNow.aliveCircles > 1; // land only while undecided
    for (const a of agents) {
      if (a.dead || a.circle !== doomed) continue;
      const alive = Object.keys(fog).map(Number);
      if (alive.length && canLand) {
        const target = alive.sort((x, y) => fog[y] - fog[x])[0];
        try {
          await program.methods.land(target)
            .accountsPartial({ game: gamePda, player: playerPda(a.kp.publicKey), fromCircle: circlePda(doomed), toCircle: circlePda(target), owner: a.kp.publicKey, actor: a.kp.publicKey })
            .signers([a.kp]).rpc();
          a.circle = target;
          log(`  ${a.name} landed in circle ${target} (haircut applied)`);
          continue;
        } catch {}
      }
      a.dead = true;
    }
    await waitPhaseEnd(gamePda);
    await program.methods.advanceInstance().accountsPartial({ game: gamePda, cranker: payer.publicKey }).rpc();

    g = await fetchGame(gamePda);
    if (g.status.running && g.instance >= g.lockInstance && !g.insaneRolled) {
      await sleep(3000);
      try {
        await program.methods.rollInsane().accountsPartial({
            config: configPda, game: gamePda, vault: vaultPda, treasury: treasuryPda,
            treasuryVault: tvaultPda, stakeMint: asset.mint, tokenProgram: asset.tokenProgram,
            recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, randomness: null,
            cranker: payer.publicKey, systemProgram: SystemProgram.programId })
          .rpc();
        if ((await fetchGame(gamePda)).insane) log(`game ${gid}: INSANE ROUND, jackpot injected`);
      } catch {}
    }
    await readFog();
  }

  // settlement: creator cut, survivors claim, skill scorers claim, dead cash
  // out, fees sweep. Wrapped so sweepBack ALWAYS runs (even on a mid-settle
  // throw), otherwise the ephemeral agent wallets' balances are stranded.
  log(`game ${gid}: settling`);
  for (const a of agents.filter((x) => x.pod)) {
    const b = budgets.get(a.name);
    if (b) log(`  ${a.name} spent ${b.spent()}/${b.granted} inference calls`);
  }
  const winner = Object.keys(fog).map(Number)[0];
    // the winning circle's creator claims κ (else 15% of the pot strands in the vault)
    const winnerCreator = agents.find((a) => a.circle === winner && a.createdCircle === winner);
    if (winnerCreator) {
      try {
        await program.methods.claimCreatorCut()
          .accountsPartial({ game: gamePda, vault: vaultPda, winningCircle: circlePda(winner), owner: winnerCreator.kp.publicKey, player: null, actor: winnerCreator.kp.publicKey,
            stakeMint: asset.mint, ownerToken: winnerCreator.ata, tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId })
          .signers([winnerCreator.kp]).rpc();
      } catch (e) { log(`  creator-cut claim failed: ${e.message?.slice(0, 80)}`); }
    }
    for (const a of agents) {
      const P = playerPda(a.kp.publicKey);
      const st = await program.account.player.fetch(P);
      try {
        if (st.status.active && st.currentCircle === winner)
          await program.methods.claimWinnings().accountsPartial({ game: gamePda, vault: vaultPda, winningCircle: circlePda(winner), player: P, owner: a.kp.publicKey, actor: a.kp.publicKey,
            stats: statsPda(a.kp.publicKey), treasury: treasuryPda,
            stakeMint: asset.mint, ownerToken: a.ata, tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
        else if (st.status.active)
          await program.methods.cashOut().accountsPartial({ game: gamePda, vault: vaultPda, circle: circlePda(st.currentCircle), player: P, owner: a.kp.publicKey, actor: a.kp.publicKey,
            stakeMint: asset.mint, ownerToken: a.ata, tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
        if (st.points > 0)
          await program.methods.claimSkill().accountsPartial({ game: gamePda, vault: vaultPda, player: P, owner: a.kp.publicKey, actor: a.kp.publicKey,
            stats: statsPda(a.kp.publicKey), treasury: treasuryPda,
            stakeMint: asset.mint, ownerToken: a.ata, tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
        log(`  ${a.name}: settled (${st.points} skill pts)`);
      } catch (e) { log(`  ${a.name} settle failed: ${e.message?.slice(0, 80)}`); }
    }
    try {
      await program.methods.collectFees().accountsPartial({ config: configPda, game: gamePda, vault: vaultPda,
        treasury: treasuryPda, treasuryVault: tvaultPda, stakeMint: asset.mint,
        tokenProgram: asset.tokenProgram, cranker: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
      // reclaim the house half of the rake (payer is the treasury authority);
      // the jackpot half stays and funds future INSANE rounds.
      const t = await program.account.treasury.fetch(treasuryPda);
      if (t.houseBalance.toNumber() > 0) {
        const houseAta = await getOrCreateAssociatedTokenAccount(connection, payer, asset.mint,
          payer.publicKey, false, undefined, undefined, asset.tokenProgram);
        await program.methods.withdrawHouse(t.houseBalance).accountsPartial({
          treasury: treasuryPda, treasuryVault: tvaultPda, stakeMint: asset.mint,
          authorityToken: houseAta.address, authority: payer.publicKey,
          tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId }).rpc();
        log(`  house cut reclaimed: ${t.houseBalance.toNumber()} ${asset.name}`);
      }
    } catch {}
    // RENT RECOVERY: close every per-game PDA so its rent-exempt lamports come
    // back (player -> agent wallet, circle -> creator agent, game -> payer),
    // then sweep the agents. Order matters: players, then circles, then game.
    try {
      for (const a of agents) {
        try {
          await program.methods.closePlayer()
            .accountsPartial({ game: gamePda, player: playerPda(a.kp.publicKey), owner: a.kp.publicKey, cranker: payer.publicKey })
            .rpc(); // permissionless: agents are fully settled by this point
        } catch (e) { log(`  close player ${a.name}: ${String(e.message).slice(0, 50)}`); }
      }
      for (const id of taken) {
        const creator = agents.find((a) => a.createdCircle === id);
        if (!creator) continue;
        try {
          await program.methods.closeCircle()
            .accountsPartial({ game: gamePda, circle: circlePda(id), creator: creator.kp.publicKey, cranker: payer.publicKey })
            .rpc(); // permissionless: kappa already claimed / circle dead
        } catch (e) { log(`  close circle ${id}: ${String(e.message).slice(0, 50)}`); }
      }
      await program.methods.closeGame().accountsPartial({
          game: gamePda, vault: vaultPda, treasury: treasuryPda, treasuryVault: tvaultPda,
          stakeMint: asset.mint, tokenProgram: asset.tokenProgram,
          authority: payer.publicKey, cranker: payer.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
      log(`  rent reclaimed (all per-game accounts closed)`);
    } catch (e) { log(`  close sweep: ${String(e.message).slice(0, 60)}`); }
  } finally {
    await sweepBack(agents);
  }
  log(`game ${gid}: done. funds + rent swept back to swarm payer`);
}

// Config, mints and per-mint treasuries are created once by setup-devnet.mjs.
// Verify they exist rather than half-creating them here.
async function ensureSetup() {
  try { await program.account.gameConfig.fetch(configPda); }
  catch { throw new Error("config missing: run `node agents/setup-devnet.mjs` first"); }
  for (const a of ASSETS) {
    try { await program.account.treasury.fetch(pda(Buffer.from("treasury"), a.mint.toBuffer())); }
    catch { throw new Error(`treasury missing for ${a.name}: run setup-devnet.mjs`); }
  }
  log(`assets in play: ${ASSETS.map((a) => a.name).join(", ")}`);
}

const bal = await connection.getBalance(payer.publicKey);
log(`swarm payer ${payer.publicKey.toBase58()}, ${bal / LAMPORTS_PER_SOL} SOL`);
if (bal < FUND * N_AGENTS + 0.05 * LAMPORTS_PER_SOL) {
  console.error("payer underfunded; airdrop to it first: solana airdrop 2 " + payer.publicKey.toBase58() + " -u devnet");
  process.exit(1);
}
await ensureSetup();
// Keep up to MAX_CONCURRENT games live at once. Each playGame is fully
// self-contained (its own agents, PDAs and settlement), so running several is a
// scheduling question rather than a shared-state one. Starts are staggered so
// three games do not crank in lockstep and spike the RPC.
const inflight = new Set();
let started = 0;
const launch = (n) => {
  const task = (async () => {
    try { await withDeadline(playGame(n), GAME_DEADLINE_MS, `game ${n}`); }
    catch (e) { log(`game failed: ${e.message?.slice(0, 200)}`); }
  })().finally(() => { inflight.delete(task); lastProgress = Date.now(); });
  inflight.add(task);
  return task;
};

while (N_GAMES === 0 || started < N_GAMES) {
  while (inflight.size < MAX_CONCURRENT && (N_GAMES === 0 || started < N_GAMES)) {
    launch(started++);
    if (inflight.size < MAX_CONCURRENT) await sleep(STAGGER_MS);
  }
  // Promise.race on an empty set never settles, and node exits 13 on an
  // unsettled top-level await. That is reachable: if every game fails fast the
  // set drains before we get here.
  if (inflight.size) await Promise.race(inflight);
  else await sleep(5_000);
  if (N_GAMES === 0 || started < N_GAMES) await sleep(GAME_INTERVAL);
}
await Promise.all(inflight);
