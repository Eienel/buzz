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
import { makeConnection, surviveRateLimits } from "../server/rpc.mjs";
import { getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync } from "@solana/spl-token";
import jsSha3 from "js-sha3";
const { keccak_256 } = jsSha3;
import { readFileSync, writeFileSync } from "node:fs";
import { decide, reasoningEnabled, modelFor, personaFor } from "./reason.mjs";
import * as feed from "./feed.mjs";
import { makeBudget, totalPointsOf } from "./budget.mjs";
import { loadKeypair, DATA_DIR } from "../server/keypair.mjs";
import { join } from "node:path";

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
// One reasoning agent per model, not four over three.
//
// modelFor cycles the model list, so a fourth pod agent is a second copy of
// whatever sits at index 0: the benchmark quietly sampled llama twice a game
// and the other two once. That is a flaw in the comparison, which is the whole
// claim here, and it cost a quarter of the inference bill to produce.
//
// Cost is the reason it got looked at. Measured over 60 calls: haiku answered
// 12 of 20 at 11.5s and is 74% of spend, mistral and llama sit at 28 and 29
// seconds against a 30.6s deadline and between them produced 15 of the 16
// aborts. So the cheap models are cheap partly because half their answers never
// arrive, and lowering max_tokens saves nothing because it is a cap rather than
// a charge. Matching the agent count to the model count is the one cut that
// takes no measurement away.
const POD_AGENTS = Number(process.env.POD_AGENTS ?? (reasoningEnabled() ? 3 : 0));
// Measured UsePod latency is 0.5s to 21s, routing variance rather than model
// choice, so on a 24s instance the model will often miss the commit window.
// That is no longer a reason to sit the game out: a reasoning agent that misses
// stays in its comb and skips only the prediction, so it is still exposed to
// the board and still counted. Set POD_MIN_TEMPO to gate them off fast games
// again if the miss rate makes those games uninteresting.
// A 24s instance leaves a 6.5s think budget, which these models almost never
// make, so a reasoning agent in a two minute game is a reasoning agent that
// abstains all game and drags its own record down for nothing. It plays the
// five minute games, where a slow answer still lands.
const POD_MIN_TEMPO = Number(process.env.POD_MIN_TEMPO ?? 60);
// Gap between one reasoning agent's call and the next, so they do not race.
//
// Off by default. It was added on the theory that concurrency was why nobody
// answered; the real cause was a ReferenceError, and every later pod pays for
// the gap out of its own commit window. Set it if contention is ever shown to
// be the problem.
const POD_STAGGER_MS = Number(process.env.POD_STAGGER_MS ?? 0);
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
// Per-agent funding: fixed headroom for PDA rent and tx fees. The stake is a
// token, not SOL, so this scales with account sizes rather than with the stake.
//
// Measured against devnet rather than derived: Player 0.00220, Circle 0.00151,
// AgentStats 0.00136 (created with `payer = actor` on an agent's FIRST claim),
// and the agent wallet's own minimum 0.00089. A circle creator making a first
// claim therefore needs about 0.0060 plus fees, so the old 0.008 fitted, but
// with roughly 0.002 of slack for every account this program might add later.
// Sweeping returns whatever is unspent, so headroom is float, not cost.
const FUND = 12_000_000; // 0.012 SOL: fees, PDA rent, and room for a first claim

const payer = loadKeypair(process.env.PAYER, `${process.env.HOME}/.config/solana/id.json`);
// Falls back to public devnet when the primary rate-limits. The swarm used to
// build a plain Connection here, and a 429 on its very first read threw out of
// the process: it died, restarted twenty seconds later, hit the same wall and
// died again, for ten hours, while the web service stayed up and the board sat
// empty. See server/rpc.mjs.
const connection = makeConnection(RPC, { label: "swarm" });
surviveRateLimits("swarm");
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8"));
const program = new Program(idl, provider);
const PID = program.programId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// What a budget looks like from outside. Flattened here because the budget
// object exposes `left` as a getter, and a getter does not survive JSON.
const budgetShape = (b) => b ? { granted: b.granted, left: b.left, spent: b.spent() } : null;

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
// Settlement reads nine player accounts in a burst, which is when a public RPC
// starts answering 429. One retry turns a transient refusal into a delay
// rather than a game that never pays out.
const fetchPlayer = async (p) => {
  try { return await program.account.player.fetch(p); }
  catch { await sleep(1200); return program.account.player.fetch(p); }
};
/**
 * Crank a phase, tolerating having lost the race to crank it.
 *
 * The swarm cranks the games it plays, and so does the server's cranker, and
 * both are supposed to: cranking is permissionless precisely so no game depends
 * on one process staying alive. But these calls had no error handling, so
 * whenever the cranker got there first the swarm threw WrongPhase, fell out of
 * the try that wraps the whole game, and skipped settlement entirely.
 *
 * That is why 7,136 Player accounts sit Active with unclaimed points and their
 * rent cannot be reclaimed: close_player rightly refuses to close away an
 * entitlement nobody collected. The arena was losing about 0.035 SOL a game and
 * never getting it back, which is what finally took it down.
 *
 * WrongPhase here means somebody already advanced this phase, which is the
 * outcome we wanted. PhaseNotOver means we are early, so wait. Anything else is
 * a real failure and still throws.
 */
const crankStep = async (label, gid, fn, tries = 12) => {
  for (let i = 0; i < tries; i++) {
    try { await fn(); return true; }
    catch (e) {
      const m = String(e.message ?? e);
      if (/WrongPhase/.test(m)) return false;          // someone else did it
      if (/PhaseNotOver/.test(m)) { await sleep(1200); continue; }
      throw e;
    }
  }
  log(`game ${gid}: ${label} never opened after ${tries} tries`);
  return false;
};

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
 * The oldest unfilled lobby the scheduler opened, whatever it is staked in.
 *
 * It used to take an asset and only adopt a lobby matching it, which quietly
 * defeated the whole arrangement: the swarm picks its asset first, the
 * scheduler only opens BUZZ, so every ANSEM game found nothing to adopt and
 * created its own. Two independent creators, no coordination, and the number
 * of games on the board became the sum of both instead of the schedule. The
 * scheduler exists precisely so concurrency is a number rather than an
 * emergent property.
 *
 * So the lobby is chosen first and the asset comes from it. The asset a game
 * is staked in is fixed at creation anyway, exactly like its tempo, so this is
 * the same rule applied to the other field.
 *
 * Returns null on anything unexpected, and the caller opens its own game. A
 * swarm that cannot reach the arena should keep playing, not stop.
 */
async function findScheduledLobby() {
  if (!ADOPT_SCHEDULED) return null;
  try {
    const r = await fetch(`${ARENA_URL}/api/state`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const known = new Set(ASSETS.map((a) => a.mint.toBase58()));
    const open = (await r.json()).live?.filter((g) =>
      g.status === 0 && known.has(g.stakeMint) && (g.players ?? 0) === 0) ?? [];
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

/**
 * Say what the swarm is doing, somewhere outside the swarm.
 *
 * The arena spent 25 minutes today with every lobby at zero players and no
 * inference calls at all, and there was no way to tell a hung swarm from a
 * slow one without a log viewer: the supervisor only restarts a process that
 * exits, and this one was alive the whole time. `running.swarm` on /api/version
 * says a child was spawned, which is a different fact and the one that was
 * already true.
 *
 * So each turn of the loop writes what it is doing to the volume the thoughts
 * already use, and the server serves it. Best effort in both directions: a
 * write that fails must never cost a game a round, and a stale file is itself
 * the answer, because the timestamp says how long ago the loop last moved.
 */
const BEAT = join(DATA_DIR, "swarm.json");
let beatErr = null;
function beat(state, extra = {}) {
  try {
    writeFileSync(BEAT, JSON.stringify({ at: Date.now(), state, pid: process.pid,
                                         bootedAt: BOOTED, ...extra }));
  } catch (e) { beatErr = String(e.message ?? e).slice(0, 80); }
}
const BOOTED = Date.now();
beat("booting");

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
  beat("stalled, exiting", { stalledMs: Date.now() - lastProgress });
  process.exit(1);
}, 30_000).unref();

async function playGame(gameNo) {
  // Adopt first, then take the asset from what was adopted. Only when there is
  // nothing to adopt does the swarm choose, and then mostly BUZZ, because only
  // BUZZ has an open season and ranked play is the reason people are here.
  // ANSEM still gets a share so it stays exercised rather than becoming dead
  // code.
  const adopted = await findScheduledLobby();
  const asset = adopted
    ? (ASSETS.find((a) => a.mint.toBase58() === adopted.stakeMint) ?? ASSETS[0])
    : ASSETS[gameNo % BUZZ_EVERY === 0 && ASSETS.length > 1 ? 1 : 0];
  const treasuryPda = pda(Buffer.from("treasury"), asset.mint.toBuffer());
  const tvaultPda = pda(Buffer.from("tvault"), asset.mint.toBuffer());
  const allowedPda = pda(Buffer.from("allowed"), asset.mint.toBuffer());
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
        ? async (fog, self, instance) => {
          // Four calls fired at once contend and every one of them runs to the
          // timeout. Spacing the starts is what makes the budget spendable
          // rather than nominal.
          const stagger = podIx * POD_STAGGER_MS;
          if (stagger) await sleep(stagger);
          return decide(fog, self, {
            instance, instanceSeconds: tempo, history: fogHistory, stagger,
            model: modelFor(podIx), persona: personaFor(podIx), budget: budgets.get(name),
            // spread across the range so four pods on one board do not converge
            temperature: 0.5 + podIx * 0.15,
            // A call that did not answer is still a call. Published for the
            // same reason the answers are: an agent that ran out of budget or
            // missed the window is the metering working, and a feed that shows
            // only the good rounds is a highlight reel.
            onSkip: (reason, ms) => feed.thought({
              game: String(gid), instance, agent: name, model: modelFor(podIx),
              comb: self, fog, skipped: reason, ms: ms ?? null,
              budget: budgetShape(budgets.get(name)),
            }),
          });
        }
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

  // Every past fog, so a reasoning agent can see which combs are bleeding and
  // which just took a crowd. One snapshot alone has no trend in it.
  //
  // Declared here rather than beside readFog below, because the strategy
  // closures are built above and everything below is inside a try block. A
  // const in that block is invisible to them, so every reasoning call threw
  // ReferenceError, the swarm logged "strategy failed" and moved on, and the
  // agent held its comb. Which is indistinguishable, from the outside, from a
  // model that declined to answer.
  const fogHistory = [];

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
  // Filling is nine transactions, one per agent, and the lobby can be started
  // out from under us between any two of them: the scheduler used to start a
  // lobby the instant it reached four combs, which is the fourth agent, so the
  // fifth got WrongPhase from create_circle. That threw out of this loop, past
  // everything below, and the swarm walked away from a game it had just staked
  // four agents into. The scheduler waits for the fill to go quiet now, and
  // this loop no longer treats one agent's failure as the game's.
  const taken = new Set();
  let started = false;
  for (const a of agents) {
    if (started) { a.dead = true; continue; }
    const stake = new BN(String(BigInt(STAKE_UNITS) * BigInt(10) ** BigInt(asset.decimals)));
    const acc = { config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(a.circle),
      player: playerPda(a.kp.publicKey), owner: a.kp.publicKey, payer: a.kp.publicKey, relayer: null,
      stakeMint: asset.mint, payerToken: a.ata, tokenProgram: asset.tokenProgram,
      systemProgram: SystemProgram.programId };
    try {
      if (!taken.has(a.circle)) {
        await program.methods.createCircle(a.circle, stake).accountsPartial(acc).signers([a.kp]).rpc();
        taken.add(a.circle);
        a.createdCircle = a.circle; // this agent is the circle's fixed creator (κ claimant)
      } else {
        await program.methods.joinCircle(stake).accountsPartial(acc).signers([a.kp]).rpc();
      }
      log(`  ${a.name} staked into circle ${a.circle}`);
    } catch (e) {
      const m = String(e.message ?? e);
      a.dead = true;                     // never played, so never plays or scores
      // WrongPhase here means the lobby is already running. Nobody else can get
      // in, so stop trying, and play with the agents that did.
      if (/WrongPhase/.test(m)) {
        started = true;
        log(`  ${a.name}: lobby already started, playing with ${taken.size} combs`);
      } else {
        log(`  ${a.name} could not stake: ${m.slice(0, 70)}`);
      }
    }
  }
  // Below the comb floor the game cannot legally start and never will, so the
  // honest move is to stop here and let the finally sweep the wallets back,
  // rather than block on a lobby that is not going anywhere.
  if (taken.size < MIN_COMBS) throw new Error(`only ${taken.size} combs filled, below the floor of ${MIN_COMBS}`);
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
      // The signature of the commit this reasoning produced. Held so the feed
      // can put the model's sentence and the transaction it caused side by
      // side, which is the only thing that makes the inference checkable by
      // someone who does not trust us.
      let sig = null, failed = null;
      try {
        if (plan.move !== null && fog[plan.move] !== undefined)
          await program.methods.commitMove([...moveHash(plan.move, mvNonce, a.kp.publicKey, gamePda, instance)])
            .accountsPartial({ game: gamePda, player: playerPda(a.kp.publicKey), owner: a.kp.publicKey, actor: a.kp.publicKey }).signers([a.kp]).rpc();
        sig = await program.methods.commitPrediction([...moveHash(plan.predict, pdNonce, a.kp.publicKey, gamePda, instance)])
          .accountsPartial({ game: gamePda, player: playerPda(a.kp.publicKey), owner: a.kp.publicKey, actor: a.kp.publicKey }).signers([a.kp]).rpc();
      } catch (e) {
        failed = e.message?.slice(0, 80);
        log(`  ${a.name} commit failed: ${failed}`);
      }
      if (a.pod) feed.thought({
        game: String(gid), instance, agent: a.name, model: plan.model ?? a.model,
        comb: a.circle, fog, mine: plan.mine, move: plan.move, predict: plan.predict,
        why: plan.why, thinkNext: plan.thinkNext, ms: plan.ms,
        cost: plan.cost, tokensIn: plan.tokensIn, tokensOut: plan.tokensOut,
        provider: plan.provider, route: plan.route,
        budget: budgetShape(budgets.get(a.name)), sig, failed,
      });
    }
    await waitPhaseEnd(gamePda);
    await crankStep("advanceToReveal", gid, () => program.methods.advanceToReveal()
      .accountsPartial({ game: gamePda, cranker: payer.publicKey }).rpc());

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

    // death: select (retry until the entropy slot passes), then execute
    await crankStep("selectDeath", gid, () => program.methods.selectDeath()
      .accountsPartial({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, randomness: null, cranker: payer.publicKey })
      .remainingAccounts([...taken].filter((i) => fog[i] !== undefined).map((i) => ({ pubkey: circlePda(i), isSigner: false, isWritable: false })))
      .rpc());
    g = await fetchGame(gamePda);
    const doomed = g.doomedCircle;
    await crankStep("executeDeath", gid, () => program.methods.executeDeath(doomed)
      .accountsPartial({ game: gamePda, circle: circlePda(doomed), cranker: payer.publicKey }).rpc());
    log(`game ${gid}: instance ${instance}, circle ${doomed} died`);
    // Scores this round's published predictions. Without it the feed shows
    // what the models said and never whether they were right, which is the
    // half that costs something to admit.
    feed.resolved(gid, instance, doomed);

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
    await crankStep("advanceInstance", gid, () => program.methods.advanceInstance()
      .accountsPartial({ game: gamePda, cranker: payer.publicKey }).rpc());

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
      try {
        // Inside the try, deliberately. This fetch used to sit above it, so a
        // single RPC hiccup on one agent threw out of the whole loop and NOBODY
        // settled that game: no claim_winnings, no claim_skill, no cash_out.
        // Settlement is the burstiest moment in a game (nine agents, three
        // calls each, back to back), which is exactly when a public RPC answers
        // 429, so this was not rare. An agent that never got into the lobby has
        // no Player account either, and that is the same shape of failure: one
        // agent's, not the game's.
        const st = await fetchPlayer(P);
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

// A balance we could not read is not a balance of zero.
//
// This used to be a bare getBalance, and when the RPC quota ran out the 429
// threw straight out of the process. The supervisor restarted it, the next read
// hit the same wall, and the swarm crash-looped for ten hours. A read that
// fails tells us nothing about the payer, so the boot check now skips itself
// rather than deciding the wallet is empty.
const bal = await connection.getBalance(payer.publicKey).catch((e) => {
  log(`could not read the payer balance (${String(e.message ?? e).slice(0, 60)}); starting anyway`);
  return null;
});
if (bal !== null) {
  log(`swarm payer ${payer.publicKey.toBase58()}, ${bal / LAMPORTS_PER_SOL} SOL`);
  if (bal < FUND * N_AGENTS + 0.05 * LAMPORTS_PER_SOL) {
    console.error("payer underfunded; airdrop to it first: solana airdrop 2 " + payer.publicKey.toBase58() + " -u devnet");
    process.exit(1);
  }
}

/**
 * Enough to fund one more game and still be able to settle it.
 *
 * The balance was only ever checked at startup, so the swarm played until the
 * payer was empty and then kept trying: it drained 3.5 SOL overnight, took the
 * arena down for six hours, and left the last games unsettled because there was
 * nothing left to pay the fees that would have settled them. Running out is not
 * an emergency if you stop before it happens, and a game you cannot settle is
 * worse than a game you never started, because an unsettled game locks its rent
 * behind claims nobody can make.
 *
 * So this is a floor, not an alarm. Below it the swarm waits and says so, and
 * picks up on its own once somebody tops the payer up.
 */
const FLOOR = Number(process.env.SWARM_FLOOR_SOL ?? 0.4) * LAMPORTS_PER_SOL;
let saidBroke = false;
async function fuelled() {
  // Same reasoning as the boot check: a failed read is not an empty wallet.
  // It holds off for one round and asks again, which is the safe answer both
  // ways round. Starting a game we cannot settle strands its rent, and dying
  // here strands the whole arena.
  const now = await connection.getBalance(payer.publicKey).catch(() => null);
  if (now === null) return false;
  const ok = now >= Math.max(FLOOR, FUND * N_AGENTS + 0.05 * LAMPORTS_PER_SOL);
  if (!ok && !saidBroke) {
    saidBroke = true;
    log(`payer at ${(now / LAMPORTS_PER_SOL).toFixed(3)} SOL, under the ` +
        `${(FLOOR / LAMPORTS_PER_SOL).toFixed(2)} floor: holding off until it is topped up`);
  }
  if (ok && saidBroke) {
    saidBroke = false;
    log(`payer back to ${(now / LAMPORTS_PER_SOL).toFixed(3)} SOL, playing again`);
  }
  return ok;
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

const since = () => Math.round((Date.now() - lastProgress) / 1000);
while (N_GAMES === 0 || started < N_GAMES) {
  while (inflight.size < MAX_CONCURRENT && (N_GAMES === 0 || started < N_GAMES)) {
    // Checked before every game, not once at boot. A game started on an empty
    // payer cannot be settled, and an unsettled game strands its rent for good.
    beat("checking fuel", { started, inflight: inflight.size, sinceProgressSeconds: since() });
    if (!(await fuelled())) { beat("unfuelled", { started, inflight: inflight.size }); break; }
    launch(started++);
    beat("launched", { started, inflight: inflight.size, sinceProgressSeconds: since() });
    if (inflight.size < MAX_CONCURRENT) await sleep(STAGGER_MS);
  }
  // Nothing running and no fuel is the one state that waits forever without
  // saying so: fuelled() returns false for a read it could not make as well as
  // for a wallet that is genuinely empty, and both look like silence.
  if (!inflight.size && !(await fuelled())) {
    beat("idle, no fuel", { started, sinceProgressSeconds: since() });
    await sleep(30_000); continue;
  }
  beat("playing", { started, inflight: inflight.size, sinceProgressSeconds: since() });
  // Promise.race on an empty set never settles, and node exits 13 on an
  // unsettled top-level await. That is reachable: if every game fails fast the
  // set drains before we get here.
  if (inflight.size) await Promise.race(inflight);
  else await sleep(5_000);
  if (N_GAMES === 0 || started < N_GAMES) await sleep(GAME_INTERVAL);
}
await Promise.all(inflight);
