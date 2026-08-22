// Last Circle Standing — devnet agent swarm.
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
import jsSha3 from "js-sha3";
const { keccak_256 } = jsSha3;
import { readFileSync } from "node:fs";

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const N_AGENTS = Number(process.env.AGENTS ?? 5);
const N_GAMES = Number(process.env.GAMES ?? 1); // 0 = forever
const STAKE = Number(process.env.STAKE_SOL ?? 0.05) * LAMPORTS_PER_SOL;
const FUND = Math.floor(STAKE * 1.4); // stake + fee headroom per agent

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

async function fundAgents(agents) {
  const tx = new Transaction();
  for (const a of agents) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: a.kp.publicKey, lamports: FUND }));
  await provider.sendAndConfirm(tx, []);
}

async function sweepBack(agents) {
  for (const a of agents) {
    try {
      const bal = await connection.getBalance(a.kp.publicKey);
      const back = bal - 6000; // leave dust for the fee
      if (back > 0) {
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: a.kp.publicKey, toPubkey: payer.publicKey, lamports: back }));
        // agent pays + signs its own sweep — provider.sendAndConfirm would
        // inject the payer wallet as signer (it isn't one) -> "unknown signer".
        await sendAndConfirmTransaction(connection, tx, [a.kp], { commitment: "confirmed" });
      }
    } catch (e) { log(`sweep ${a.name} failed: ${e.message}`); }
  }
}

const fetchGame = (g) => program.account.game.fetch(g);
const waitPhaseEnd = async (gamePda, margin = 1500) => {
  const g = await fetchGame(gamePda);
  const ms = g.phaseEndsAt.toNumber() * 1000 - Date.now() + margin;
  if (ms > 0) await sleep(ms);
};

async function playGame(gameNo) {
  const gid = new BN(Date.now());
  const gamePda = gamePdaOf(gid);
  const vaultPda = pda(Buffer.from("vault"), gamePda.toBuffer());
  const circlePda = (id) => pda(Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id]));
  const playerPda = (o) => pda(Buffer.from("player"), gamePda.toBuffer(), o.toBuffer());

  const agents = Array.from({ length: N_AGENTS }, (_, i) => ({
    kp: Keypair.generate(),
    name: `${stratNames[i % stratNames.length]}-${i}`,
    strat: strategies[stratNames[i % stratNames.length]],
    circle: i % 6, dead: false,
  }));
  log(`game ${gid}: funding ${N_AGENTS} agents…`);
  await fundAgents(agents);

  // Everything after funding is wrapped so sweepBack ALWAYS runs — a throw
  // anywhere in the lobby, instance loop, or settlement would otherwise strand
  // the ephemeral agent wallets' balances (their keypairs live only in memory).
  try {
  // lobby: keeper (payer) creates the game; agents create/join circles 0..5
  await program.methods.createGame(gid, 6).accounts({ config: configPda, game: gamePda, vault: vaultPda, authority: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
  const taken = new Set();
  for (const a of agents) {
    const stake = new BN(STAKE);
    const acc = { config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(a.circle), player: playerPda(a.kp.publicKey), owner: a.kp.publicKey, systemProgram: SystemProgram.programId };
    if (!taken.has(a.circle)) {
      await program.methods.createCircle(a.circle, stake).accounts(acc).signers([a.kp]).rpc();
      taken.add(a.circle);
      a.createdCircle = a.circle; // this agent is the circle's fixed creator (κ claimant)
    } else {
      await program.methods.joinCircle(stake).accounts(acc).signers([a.kp]).rpc();
    }
    log(`  ${a.name} staked into circle ${a.circle}`);
  }
  await program.methods.startGame().accounts({ game: gamePda, authority: payer.publicKey }).rpc();
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
            .accounts({ game: gamePda, player: playerPda(a.kp.publicKey), owner: a.kp.publicKey }).signers([a.kp]).rpc();
        await program.methods.commitPrediction([...moveHash(plan.predict, pdNonce, a.kp.publicKey, gamePda, instance)])
          .accounts({ game: gamePda, player: playerPda(a.kp.publicKey), owner: a.kp.publicKey }).signers([a.kp]).rpc();
      } catch (e) { log(`  ${a.name} commit failed: ${e.message?.slice(0, 80)}`); }
    }
    await waitPhaseEnd(gamePda);
    await program.methods.advanceToReveal().accounts({ game: gamePda, cranker: payer.publicKey }).rpc();

    // reveal phase
    for (const [a, p] of plans) {
      if (p.move === null || fog[p.move] === undefined) continue;
      try {
        await program.methods.revealMove(p.move, p.mvNonce)
          .accounts({ game: gamePda, player: playerPda(a.kp.publicKey), fromCircle: circlePda(a.circle), toCircle: circlePda(p.move), owner: a.kp.publicKey })
          .signers([a.kp]).rpc();
        a.circle = p.move;
      } catch (e) { log(`  ${a.name} reveal failed: ${e.message?.slice(0, 80)}`); }
    }
    await waitPhaseEnd(gamePda);

    // death: select (retry until entropy slot passes), execute
    for (;;) {
      try {
        await program.methods.selectDeath()
          .accounts({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: payer.publicKey })
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
    await program.methods.executeDeath(doomed).accounts({ game: gamePda, circle: circlePda(doomed), cranker: payer.publicKey }).rpc();
    log(`game ${gid}: instance ${instance} — circle ${doomed} died`);

    // scoring: reveal predictions; casualties land in the fullest surviving circle
    for (const [a, p] of plans) {
      try {
        await program.methods.revealPrediction(p.predict, p.pdNonce)
          .accounts({ game: gamePda, player: playerPda(a.kp.publicKey), owner: a.kp.publicKey }).signers([a.kp]).rpc();
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
            .accounts({ game: gamePda, player: playerPda(a.kp.publicKey), fromCircle: circlePda(doomed), toCircle: circlePda(target), owner: a.kp.publicKey })
            .signers([a.kp]).rpc();
          a.circle = target;
          log(`  ${a.name} landed in circle ${target} (haircut applied)`);
          continue;
        } catch {}
      }
      a.dead = true;
    }
    await waitPhaseEnd(gamePda);
    await program.methods.advanceInstance().accounts({ game: gamePda, cranker: payer.publicKey }).rpc();

    g = await fetchGame(gamePda);
    if (g.status.running && g.instance >= g.lockInstance && !g.insaneRolled) {
      const treasuryPda = pda(Buffer.from("treasury"));
      const treasuryVaultPda = pda(Buffer.from("treasury_vault"));
      await sleep(3000);
      try {
        await program.methods.rollInsane()
          .accounts({ config: configPda, game: gamePda, vault: vaultPda, treasury: treasuryPda, treasuryVault: treasuryVaultPda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: payer.publicKey, systemProgram: SystemProgram.programId })
          .rpc();
        if ((await fetchGame(gamePda)).insane) log(`game ${gid}: 🔥 INSANE ROUND — jackpot injected`);
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
          .accounts({ game: gamePda, vault: vaultPda, winningCircle: circlePda(winner), owner: winnerCreator.kp.publicKey, systemProgram: SystemProgram.programId })
          .signers([winnerCreator.kp]).rpc();
      } catch (e) { log(`  creator-cut claim failed: ${e.message?.slice(0, 80)}`); }
    }
    for (const a of agents) {
      const P = playerPda(a.kp.publicKey);
      const st = await program.account.player.fetch(P);
      try {
        if (st.status.active && st.currentCircle === winner)
          await program.methods.claimWinnings().accounts({ game: gamePda, vault: vaultPda, winningCircle: circlePda(winner), player: P, owner: a.kp.publicKey, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
        else if (st.status.active)
          await program.methods.cashOut().accounts({ game: gamePda, vault: vaultPda, circle: circlePda(st.currentCircle), player: P, owner: a.kp.publicKey, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
        if (st.points > 0)
          await program.methods.claimSkill().accounts({ game: gamePda, vault: vaultPda, player: P, owner: a.kp.publicKey, systemProgram: SystemProgram.programId }).signers([a.kp]).rpc();
        log(`  ${a.name}: settled (${st.points} skill pts)`);
      } catch (e) { log(`  ${a.name} settle failed: ${e.message?.slice(0, 80)}`); }
    }
    try {
      const treasuryPda = pda(Buffer.from("treasury"));
      const treasuryVaultPda = pda(Buffer.from("treasury_vault"));
      await program.methods.collectFees().accounts({ config: configPda, game: gamePda, vault: vaultPda, treasury: treasuryPda, treasuryVault: treasuryVaultPda, cranker: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    } catch {}
  } finally {
    await sweepBack(agents);
  }
  log(`game ${gid}: done — funds swept back to swarm payer`);
}

// one-time setup if this cluster has no config/treasury yet
async function ensureSetup() {
  try { await program.account.gameConfig.fetch(configPda); }
  catch {
    log("initializing config…");
    const instanceSecs = Number(process.env.INSTANCE_SECONDS ?? 20);
    await program.methods.initializeConfig(400, 5000, new BN(0.01 * LAMPORTS_PER_SOL), new BN(5 * LAMPORTS_PER_SOL), instanceSecs, 200)
      .accounts({ config: configPda, authority: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
  }
  const treasuryPda = pda(Buffer.from("treasury"));
  try { await program.account.treasury.fetch(treasuryPda); }
  catch {
    log("initializing treasury…");
    await program.methods.initTreasury().accounts({ treasury: treasuryPda, treasuryVault: pda(Buffer.from("treasury_vault")), authority: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
  }
}

const bal = await connection.getBalance(payer.publicKey);
log(`swarm payer ${payer.publicKey.toBase58()} — ${bal / LAMPORTS_PER_SOL} SOL`);
if (bal < FUND * N_AGENTS + 0.05 * LAMPORTS_PER_SOL) {
  console.error("payer underfunded; airdrop to it first: solana airdrop 2 " + payer.publicKey.toBase58() + " -u devnet");
  process.exit(1);
}
await ensureSetup();
for (let i = 0; N_GAMES === 0 || i < N_GAMES; i++) {
  try { await playGame(i); } catch (e) { log(`game failed: ${e.message?.slice(0, 200)}`); await sleep(10_000); }
}
