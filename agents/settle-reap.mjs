// Settle the backlog, then reclaim its rent.
//
//   PAYER=~/.config/solana/id.json node agents/settle-reap.mjs
//
// `reap.mjs` closes accounts. It cannot touch most of the backlog, because
// close_player refuses to close a player that is still Active with unclaimed
// points, and it is right to: closing one would forfeit an entitlement its
// owner never collected. Thousands of games were left that way by a crank race
// that made the swarm skip settlement (see crankStep in swarm.mjs), so the
// rent sat locked behind claims nobody had made.
//
// This settles first and closes second. Every claim is signed by the agent
// that owns it, derived from the same seed the swarm uses, so nothing here can
// pay anybody but the wallet the program already says is owed.
//
// Safe to stop and re-run: every step is idempotent, and anything already done
// answers AlreadyClaimed or WrongPhase and is skipped.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import jsSha3 from "js-sha3";
import { loadKeypair } from "../server/keypair.mjs";
import { houseWallets } from "../server/names.mjs";
import { makeConnection, surviveRateLimits } from "../server/rpc.mjs";

const { keccak_256 } = jsSha3;
const { AnchorProvider, Program, Wallet, BN } = anchorPkg;

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PAUSE = Number(process.env.PAUSE_MS ?? 150);
const LIMIT = Number(process.env.LIMIT ?? 0);          // 0 = the whole backlog
const SEED = process.env.SWARM_SEED ?? "buzz-devnet-swarm-v1";

const payer = loadKeypair(process.env.PAYER, `${process.env.HOME}/.config/solana/id.json`);
const connection = makeConnection(RPC, { label: "settle-reap" });
surviveRateLimits("settle-reap");
const program = new Program(
  JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8")),
  new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" }));
const PID = program.programId;
const pda = (...s) => PublicKey.findProgramAddressSync(s, PID)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The agent wallets are seed-derived, so we can sign for the ones we own. A
// player owned by anything else is somebody's own agent and is left alone: its
// claim is theirs to make.
const agentKey = (name) => Keypair.fromSeed(
  Uint8Array.from(Buffer.from(keccak_256.arrayBuffer(`${SEED}:${name}`)).subarray(0, 32)));
const nameOf = new Map(houseWallets().map((h) => [h.wallet, h.name]));

/** Decode per account rather than eagerly: older layouts are still on chain. */
async function decodeAll(name) {
  const raw = await connection.getProgramAccounts(PID, {
    filters: [{ memcmp: { offset: 0, bytes: program.coder.accounts.memcmp(name).bytes } }],
  });
  const out = [];
  for (const { pubkey, account } of raw) {
    try { out.push({ pubkey, data: program.coder.accounts.decode(name, account.data) }); }
    catch { /* predates this program; not ours to settle */ }
  }
  return out;
}

const quiet = /AlreadyClaimed|NothingToClaim|WrongPhase|PlayerInactive|Unauthorized|PlayersRemain|CirclesRemain/;
async function step(label, fn) {
  try { await fn(); return true; }
  catch (e) {
    const m = String(e.message ?? e);
    if (!quiet.test(m)) log(`    ${label}: ${m.slice(0, 90)}`);
    return false;
  } finally { await sleep(PAUSE); }
}

/**
 * Send several instructions as one transaction.
 *
 * One close per transaction meant one round trip per account, and at roughly
 * a game a minute the backlog was a seventeen hour job. The closes are cheap,
 * independent, and touch disjoint accounts, so they batch: eight players and
 * six combs go in two transactions instead of fourteen.
 *
 * On any failure it falls back to sending them one at a time, because a batch
 * fails as a unit and one already-closed account would otherwise take thirteen
 * good closes down with it.
 */
async function batch(label, ixs, signers = []) {
  if (!ixs.length) return 0;
  const { Transaction } = await import("@solana/web3.js");
  const CHUNK = Number(process.env.BATCH ?? 7);
  let done = 0;
  for (let i = 0; i < ixs.length; i += CHUNK) {
    const slice = ixs.slice(i, i + CHUNK);
    const tx = new Transaction();
    for (const ix of slice) tx.add(ix);
    try {
      await program.provider.sendAndConfirm(tx, signers);
      done += slice.length;
    } catch {
      for (const ix of slice) {
        if (await step(label, () =>
          program.provider.sendAndConfirm(new Transaction().add(ix), signers))) done++;
      }
    }
    await sleep(PAUSE);
  }
  return done;
}

const before = await connection.getBalance(payer.publicKey);
log("reading the backlog…");
const games = await decodeAll("game");
await sleep(PAUSE);
const players = await decodeAll("player");
await sleep(PAUSE);
const circles = await decodeAll("circle");

// Aborted lobbies count too. They never ran, so nobody thinks of them as a
// backlog, but there are hundreds of them and each one holds a Game, its combs
// and its players: 2.449 SOL when this was measured. They settle differently,
// through claim_abort_refund rather than a cash-out, and they owe no rake.
// ABORTED=1 opts in. Deployed to devnet on 28 August, signature H4fpzNR8oxWV,
// so this is on for the arena. It stays a flag because the same script runs
// against whatever program a local validator happens to have: without the
// upgrade every close answers WrongPhase, and the refunds land while the rent
// does not.
const DO_ABORTED = process.env.ABORTED === "1";
const settling = games.filter((g) =>
  g.data.status.settling || (DO_ABORTED && g.data.status.aborted));
const aborted = settling.filter((g) => g.data.status.aborted).length;
log(`${games.length} games, ${settling.length - aborted} in Settling, ${aborted} aborted, ` +
    `${players.length} players, ${circles.length} circles`);

// Newest first: the recent backlog is the part somebody might still claim.
settling.sort((a, b) => Number(b.data.gameId) - Number(a.data.gameId));
const work = LIMIT ? settling.slice(0, LIMIT) : settling;
log(`working ${work.length} games\n`);

let settled = 0, closed = 0, skippedForeign = 0;

for (const [n, { pubkey: gamePda, data: g }] of work.entries()) {
  const mine = players.filter((p) => p.data.game.equals(gamePda));
  const combs = circles.filter((c) => c.data.game.equals(gamePda));
  const winner = combs.find((c) => c.data.alive)?.data.circleId ?? null;
  const mint = g.stakeMint;
  const mintAcc = await connection.getAccountInfo(mint);
  if (!mintAcc) continue;
  const tokenProgram = mintAcc.owner;
  const vault = pda(Buffer.from("vault"), gamePda.toBuffer());
  const treasury = pda(Buffer.from("treasury"), mint.toBuffer());
  const comb = (id) => pda(Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id]));

  const abortedGame = !!g.status.aborted;
  const closeIxs = [];
  for (const { pubkey: P, data: p } of mine) {
    const name = nameOf.get(p.owner.toBase58());
    if (!name) { skippedForeign++; continue; }         // not ours to claim for
    const kp = agentKey(name);
    const ownerToken = getAssociatedTokenAddressSync(mint, kp.publicKey, false, tokenProgram);
    const base = { game: gamePda, vault, player: P, owner: kp.publicKey, actor: kp.publicKey,
                   stakeMint: mint, ownerToken, tokenProgram,
                   systemProgram: SystemProgram.programId };
    if (abortedGame && p.status.active) {
      // The lobby timed out, so the deposit comes back gross: the rake goes
      // with it, because the house takes nothing from a game that never ran.
      await step("claimAbortRefund", () => program.methods.claimAbortRefund().accountsPartial({
        ...base, config: pda(Buffer.from("config")) }).signers([kp]).rpc());
    } else if (p.status.active && winner !== null && p.currentCircle === winner) {
      await step("claimWinnings", () => program.methods.claimWinnings().accountsPartial({
        ...base, winningCircle: comb(winner),
        stats: pda(Buffer.from("agent"), kp.publicKey.toBuffer()), treasury }).signers([kp]).rpc());
    } else if (p.status.active) {
      await step("cashOut", () => program.methods.cashOut().accountsPartial({
        ...base, circle: comb(p.currentCircle) }).signers([kp]).rpc());
    }
    if (p.points > 0 && !p.skillClaimed) {
      await step("claimSkill", () => program.methods.claimSkill().accountsPartial({
        ...base, stats: pda(Buffer.from("agent"), kp.publicKey.toBuffer()), treasury,
      }).signers([kp]).rpc());
    }
    settled++;
    // Collected and sent together below: nothing is owed to these any more, so
    // the order among them does not matter.
    closeIxs.push(await program.methods.closePlayer().accountsPartial({
      game: gamePda, player: P, owner: kp.publicKey, cranker: payer.publicKey }).instruction());
  }
  closed += await batch("closePlayer", closeIxs);

  // The rake has to be swept before close_game will accept the game. An
  // aborted game has no rake to sweep: claim_abort_refund already handed each
  // player's share back with their deposit, so collect_fees here would be the
  // house taking a cut of a game nobody played.
  if (!abortedGame && Number(g.feesCollected) > 0) {
    await step("collectFees", () => program.methods.collectFees().accountsPartial({
      config: pda(Buffer.from("config")), game: gamePda, vault, treasury,
      treasuryVault: pda(Buffer.from("tvault"), mint.toBuffer()), stakeMint: mint,
      tokenProgram, cranker: payer.publicKey, systemProgram: SystemProgram.programId }).rpc());
  }

  const plainCombs = [];
  for (const { pubkey: C, data: cc } of combs) {
    const creatorName = nameOf.get(cc.creator.toBase58());
    const signer = creatorName ? agentKey(creatorName) : null;
    // A live comb whose creator never claimed kappa needs that creator's
    // signature, which is an explicit forfeit. Only sign for wallets we own.
    const needsCreator = cc.alive && !g.creatorCutPaid;
    if (needsCreator && !signer) continue;
    if (!needsCreator) {
      plainCombs.push(await program.methods.closeCircle().accountsPartial({
        game: gamePda, circle: C, creator: cc.creator, cranker: payer.publicKey }).instruction());
      continue;
    }
    if (await step("closeCircle", async () => {
      const m = program.methods.closeCircle().accountsPartial({
        game: gamePda, circle: C, creator: cc.creator, cranker: payer.publicKey });
      if (!needsCreator) return m.rpc();
      // The IDL declares `creator` as an UncheckedAccount, so Anchor builds the
      // meta with isSigner false and then rejects the keypair as an unknown
      // signer. The program still requires the signature when the comb is alive
      // and kappa is unclaimed, so the meta is flipped by hand. This is written
      // down in CLAUDE.md and I hit it anyway.
      const ix = await m.instruction();
      for (const k of ix.keys) if (k.pubkey.equals(cc.creator)) k.isSigner = true;
      const { Transaction } = await import("@solana/web3.js");
      return program.provider.sendAndConfirm(new Transaction().add(ix), [signer]);
    })) closed++;
  }
  closed += await batch("closeCircle", plainCombs);

  await step("closeGame", () => program.methods.closeGame().accountsPartial({
    game: gamePda, vault, treasury, treasuryVault: pda(Buffer.from("tvault"), mint.toBuffer()),
    authority: g.authority, cranker: payer.publicKey,
    stakeMint: mint, tokenProgram, systemProgram: SystemProgram.programId }).rpc());

  if ((n + 1) % 10 === 0) {
    const now = await connection.getBalance(payer.publicKey);
    log(`${n + 1}/${work.length} games | ${settled} players settled, ${closed} accounts closed ` +
        `| payer ${(now / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  }
}

// Rent from players and circles lands in the agent wallets, not here. Sweep it
// back with the payer as fee payer, so no agent needs a balance of its own.
//
// SWEEP=0 leaves them alone. The swarm funds an agent before it plays and
// sweeps it afterwards, so a sweep that lands in the middle of a live game
// takes the lamports that agent was about to spend on its own accounts. Fine
// for a one-off reap of a dead backlog, not fine on a timer next to a running
// arena, which is why the periodic reaper turns it off.
let swept = 0;
if (process.env.SWEEP === "0") log("\nleaving the agent wallets alone (SWEEP=0)");
else {
log("\nsweeping the agent wallets…");
const { Transaction } = await import("@solana/web3.js");
for (const { wallet, name } of houseWallets()) {
  const kp = agentKey(name);
  const bal = await connection.getBalance(kp.publicKey);
  if (bal <= 0) continue;
  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: kp.publicKey, toPubkey: payer.publicKey, lamports: bal }));
    tx.feePayer = payer.publicKey;
    await program.provider.sendAndConfirm(tx, [kp]);
    swept += bal;
    log(`  ${name}: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (e) { log(`  sweep ${name}: ${String(e.message).slice(0, 60)}`); }
  await sleep(PAUSE);
}
}

const after = await connection.getBalance(payer.publicKey);
log(`\nsettled ${settled} players, closed ${closed} accounts`);
if (skippedForeign) log(`left ${skippedForeign} players alone: not our wallets to claim for`);
log(`swept ${(swept / LAMPORTS_PER_SOL).toFixed(4)} SOL from agent wallets`);
log(`payer ${(before / LAMPORTS_PER_SOL).toFixed(4)} -> ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
    `(net ${((after - before) / LAMPORTS_PER_SOL).toFixed(4)})`);
