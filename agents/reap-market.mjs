// Reclaim the rent a decided book leaves behind.
//
//   PAYER=~/.config/solana/id.json node agents/reap-market.mjs
//
// A settled book leaves a Market, its token vault, a TargetPool per agent
// backed, and a Bet per position. None of them are ever read again, and
// together they were the one part of the system with no close instruction at
// all. Closing them is the tail of the rent problem `settle-reap.mjs` handles
// for games.
//
// The order is forced by the program: bets first, then pools, then the book,
// because close_market refuses while `targets` is above zero and close_bet
// pays its rent to the bettor rather than to us.
//
// What it will not touch:
//
//   * an unclaimed bet on a pool that could still pay. Its rent belongs to the
//     bettor and closing it would forfeit a payout nobody collected. Only the
//     bettor can sign that away.
//   * a pool that is not resolved, or that still has a bet on it that is worth
//     something. A pool is what claim_bet reads to decide a payout, so closing
//     one early would strand the money rather than the rent.
//
// A resolved pool that lost while somebody else won is a different case: every
// bet left on it pays exactly zero, so the pool is dead weight. Those close.
// The Bet accounts survive and their owners can still close them for the rent.
//
// Safe to stop and re-run: everything here is idempotent, and an account that
// is already gone answers AccountNotFound and is skipped.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { loadKeypair } from "../server/keypair.mjs";

const { AnchorProvider, Program, Wallet } = anchorPkg;

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PAUSE = Number(process.env.PAUSE_MS ?? 150);
const LIMIT = Number(process.env.LIMIT ?? 0);
const DRY = process.env.DRY === "1";

const payer = loadKeypair(process.env.PAYER, `${process.env.HOME}/.config/solana/id.json`);
const connection = new Connection(RPC, "confirmed");
const program = new Program(
  JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8")),
  new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" }));
const PID = program.programId;
const pda = (...s) => PublicKey.findProgramAddressSync(s, PID)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function decodeAll(name) {
  const raw = await connection.getProgramAccounts(PID, {
    filters: [{ memcmp: { offset: 0, bytes: program.coder.accounts.memcmp(name).bytes } }],
  });
  const out = [];
  for (const { pubkey, account } of raw) {
    try { out.push({ pubkey, data: program.coder.accounts.decode(name, account.data) }); }
    catch { /* an older layout; not ours to close */ }
  }
  return out;
}

const quiet = /AccountNotFound|could not find account|CirclesRemain|WrongPhase|Unauthorized|ConservationViolated/;
async function step(label, fn) {
  if (DRY) return true;
  try { await fn(); return true; }
  catch (e) {
    const m = String(e.message ?? e);
    if (!quiet.test(m)) log(`    ${label}: ${m.slice(0, 100)}`);
    return false;
  } finally { await sleep(PAUSE); }
}

/** Independent closes touching disjoint accounts, so they batch. */
async function batch(label, ixs) {
  if (!ixs.length || DRY) return DRY ? ixs.length : 0;
  const CHUNK = Number(process.env.BATCH ?? 7);
  let done = 0;
  for (let i = 0; i < ixs.length; i += CHUNK) {
    const slice = ixs.slice(i, i + CHUNK);
    const tx = new Transaction();
    for (const ix of slice) tx.add(ix);
    try { await program.provider.sendAndConfirm(tx, []); done += slice.length; }
    catch {
      // A batch fails as a unit, so one already-closed account would take the
      // rest of a good chunk down with it. Retry them singly.
      for (const ix of slice) {
        if (await step(label, () =>
          program.provider.sendAndConfirm(new Transaction().add(ix), []))) done++;
      }
    }
    await sleep(PAUSE);
  }
  return done;
}

const mintOwner = new Map();
async function tokenProgramOf(mint) {
  const k = mint.toBase58();
  if (!mintOwner.has(k)) {
    const acc = await connection.getAccountInfo(mint);
    mintOwner.set(k, acc?.owner ?? null);
    await sleep(PAUSE);
  }
  return mintOwner.get(k);
}

const before = await connection.getBalance(payer.publicKey);
log("reading the books…");
const markets = await decodeAll("market");
await sleep(PAUSE);
const pools = await decodeAll("targetPool");
await sleep(PAUSE);
const bets = await decodeAll("bet");
log(`${markets.length} books, ${pools.length} pools, ${bets.length} bets`);

// A book with no pool on it never took a bet, so nothing can be owed and
// `settled` never gets set on it. Those still hold rent, and there are far
// more of them than there are settled books. They close on the game's status
// instead: once the game is past Running nobody can bet into them again.
const games = await decodeAll("game");
const over = new Map(games.map(({ pubkey, data }) =>
  [pubkey.toBase58(), !(data.status.lobby || data.status.running)]));
const closable = ({ data }) =>
  // Its game is gone, so it was reaped and is certainly over.
  data.settled || (Number(data.targets) === 0 && (over.get(data.game.toBase58()) ?? true));

const settled = markets.filter(closable);
settled.sort((a, b) => a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()));
const work = LIMIT ? settled.slice(0, LIMIT) : settled;
log(`${settled.length} settled, working ${work.length}${DRY ? " (dry run)" : ""}\n`);

let closedBets = 0, closedPools = 0, closedBooks = 0, heldBets = 0, heldPools = 0;

for (const [n, { pubkey: market, data: m }] of work.entries()) {
  const myPools = pools.filter((p) => p.data.market.equals(market));
  const myBets = bets.filter((b) => b.data.market.equals(market));

  const betIxs = [];
  for (const { pubkey: B, data: b } of myBets) {
    // close_bet pays the rent to the bettor, and wants their signature unless
    // the bet is claimed. So a claimed bet we close for them as a courtesy,
    // and an unclaimed one stays: the lamports are theirs, and if it is still
    // owed a payout, closing it would forfeit that too.
    if (!b.claimed) { heldBets++; continue; }
    betIxs.push(await program.methods.closeBet().accountsPartial({
      market, bet: B, bettor: b.bettor, cranker: payer.publicKey }).instruction());
  }
  closedBets += await batch("closeBet", betIxs);

  const poolIxs = [];
  for (const { pubkey: P, data: p } of myPools) {
    const live = myBets.filter((b) => b.data.target.equals(p.target) && !b.data.claimed);
    // Only once nothing unclaimed is left on it.
    //
    // This used to also close a pool that had lost while somebody else won, on
    // the grounds that every bet still on it pays zero. That was wrong in a way
    // that costs nothing and breaks something: claim_bet reads the pool, so
    // closing it early makes those bets permanently unclaimable, and a bet that
    // cannot be claimed cannot be closed for its rent either. It stranded one.
    const dead = p.resolved && !live.length;
    if (!dead) { heldPools++; continue; }
    poolIxs.push(await program.methods.closeTargetPool().accountsPartial({
      market, targetPool: P, cranker: payer.publicKey }).instruction());
  }
  const didPools = await batch("closeTargetPool", poolIxs);
  closedPools += didPools;

  // The book closes last, and only if every pool went. `targets` on chain is
  // the authority here, not our count: a pool somebody else closed already is
  // still a decrement we did not make.
  if (didPools === myPools.length) {
    // Cached: there are a handful of mints across hundreds of books, and
    // asking the RPC once per book is what gets us rate limited.
    const owner = await tokenProgramOf(m.stakeMint);
    if (!owner) continue;
    if (await step("closeMarket", () => program.methods.closeMarket().accountsPartial({
      market, marketVault: pda(Buffer.from("mvault"), market.toBuffer()),
      cranker: payer.publicKey, tokenProgram: owner }).rpc())) closedBooks++;
  }

  if ((n + 1) % 10 === 0) {
    // A rate-limited balance read is not a reason to lose the run. It is a
    // progress line.
    const now = await connection.getBalance(payer.publicKey).catch(() => null);
    log(`${n + 1}/${work.length} books | ${closedBets} bets, ${closedPools} pools, ` +
        `${closedBooks} books closed` +
        (now === null ? "" : ` | payer ${(now / LAMPORTS_PER_SOL).toFixed(3)} SOL`));
  }
}

const after = await connection.getBalance(payer.publicKey);
log(`\nclosed ${closedBets} bets, ${closedPools} pools, ${closedBooks} books`);
if (heldBets) log(`left ${heldBets} bets alone: their rent is the bettor's`);
if (heldPools) log(`left ${heldPools} pools alone: undecided, or still holding an unclaimed bet`);
log(`payer ${(before / LAMPORTS_PER_SOL).toFixed(4)} -> ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
    `(net ${((after - before) / LAMPORTS_PER_SOL).toFixed(4)})`);
