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

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
// At least MIN_COMBS agents, one per comb, or the game cannot legally start.
const MIN_COMBS = 4;
const N_AGENTS = Math.max(MIN_COMBS, Number(process.env.AGENTS ?? 5));
// How many games may be live at once, and how long to wait between starting
// them so three lobbies do not all crank on the same second.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 3);
const STAGGER_MS = Number(process.env.STAGGER_SECONDS ?? 25) * 1000;
// Tempos a game may be dealt. A fast lobby and a slow one running side by side
// is the point: spectators always have something resolving, and agents have to
// handle both a 60 second and a 5 minute think.
const TEMPOS = (process.env.TEMPOS ?? "60,90,300").split(",").map(Number);
const N_GAMES = Number(process.env.GAMES ?? 1); // 0 = forever
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

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.PAYER ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
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

async function playGame(gameNo) {
  const asset = ASSETS[gameNo % ASSETS.length];
  const treasuryPda = pda(Buffer.from("treasury"), asset.mint.toBuffer());
  const tvaultPda = pda(Buffer.from("tvault"), asset.mint.toBuffer());
  const allowedPda = pda(Buffer.from("allowed"), asset.mint.toBuffer());
  const gid = new BN(Date.now());
  const gamePda = gamePdaOf(gid);
  const vaultPda = pda(Buffer.from("vault"), gamePda.toBuffer());
  const circlePda = (id) => pda(Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id]));
  const playerPda = (o) => pda(Buffer.from("player"), gamePda.toBuffer(), o.toBuffer());

  const tempo = TEMPOS[Math.floor(Math.random() * TEMPOS.length)];
  const agents = Array.from({ length: N_AGENTS }, (_, i) => ({
    kp: Keypair.generate(),
    name: `${stratNames[i % stratNames.length]}-${i}`,
    strat: strategies[stratNames[i % stratNames.length]],
    // one agent per comb for the first MIN_COMBS, so the comb floor is met by
    // construction rather than by luck; the rest spread over the six
    circle: i < MIN_COMBS ? i : i % 6, dead: false,
  }));
  log(`game ${gid}: ${asset.name}, ${tempo}s instances, funding ${N_AGENTS} agents…`);
  await fundAgents(agents, asset);

  // Everything after funding is wrapped so sweepBack ALWAYS runs, a throw
  // anywhere in the lobby, instance loop, or settlement would otherwise strand
  // the ephemeral agent wallets' balances (their keypairs live only in memory).
  try {
  // lobby: keeper (payer) creates the game; agents create/join circles 0..5
  await program.methods.createGame(gid, 6, tempo, false).accountsPartial({
    config: configPda, stakeMint: asset.mint, allowed: allowedPda, game: gamePda, vault: vaultPda,
    authority: payer.publicKey, tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId,
  }).rpc();
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
  await program.methods.startGame().accountsPartial({ game: gamePda, authority: payer.publicKey }).rpc();
  log(`game ${gid}: started (${taken.size} circles)`);

  // fog = previous instance's finalized member counts
  let fog = {};
  const readFog = async () => {
    fog = {};
    for (const id of taken) {
      const c = await program.account.circle.fetch(circlePda(id));
      if (c.alive) fog[id] = c.memberCount;
    }
  };
  await readFog();

  // instance loop
  for (;;) {
    let g = await fetchGame(gamePda);
    if (g.status.settling) break;
    const instance = g.instance;

    // commit phase: every live agent commits a move + prediction
    const plans = new Map();
    for (const a of agents) {
      if (a.dead) continue;
      const plan = a.strat(fog, a.circle);
      const mvNonce = new BN(Math.floor(Math.random() * 1e9));
      const pdNonce = new BN(Math.floor(Math.random() * 1e9));
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
            stakeMint: asset.mint, ownerToken: a.ata, tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
        else if (st.status.active)
          await program.methods.cashOut().accountsPartial({ game: gamePda, vault: vaultPda, circle: circlePda(st.currentCircle), player: P, owner: a.kp.publicKey, actor: a.kp.publicKey,
            stakeMint: asset.mint, ownerToken: a.ata, tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
        if (st.points > 0)
          await program.methods.claimSkill().accountsPartial({ game: gamePda, vault: vaultPda, player: P, owner: a.kp.publicKey, actor: a.kp.publicKey,
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
    try { await playGame(n); }
    catch (e) { log(`game failed: ${e.message?.slice(0, 200)}`); }
  })().finally(() => inflight.delete(task));
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
