// Sweep round books whose game is done with them, reclaiming their rent.
//
// Written after the round book ran for a day with no way to close anything.
// open_round inits a RoundMarket and a token vault per round per game, so
// without this the board costs roughly 0.003 SOL per round forever: 2217
// accounts in one day, and a payer that went from 15.06 SOL to 1.03.
//
// Usage: KP=<payer keypair> [LIMIT=n] [RPC=url] node agents/sweep-rounds.mjs
//
// close_round needs the book settled or void and its vault empty. Most of
// these were never settled, because the ticker that would have settled them
// was turned off with them. void_round is the path for exactly that: nobody
// decided it while the game was still on that round, so every stake comes
// back and the book can then close.
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
const { AnchorProvider, Program, Wallet } = anchor;
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KP, "utf8"))));
const c = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const program = new Program(JSON.parse(fs.readFileSync("./agents/idl/last_circle.json","utf8")),
  new AnchorProvider(c, new Wallet(kp), { commitment: "confirmed" }));
const PID = program.programId;
const pda = (...s) => PublicKey.findProgramAddressSync(s, PID)[0];

/**
 * Retry a call through a rate limit.
 *
 * The public devnet endpoint answers 429 under a sweep this size, and the
 * first full run treated that as fatal: it closed 900 accounts, hit a 429 on
 * the websocket, and threw with 1300 still open. A sweep is by nature a long
 * sequence of small identical calls, so the rate limit is the expected
 * condition, not the exceptional one.
 */
async function patiently(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const m = String(e.message ?? e);
      if (!/429|Too Many Requests|rate limit|blockhash not found/i.test(m) || attempt >= 6) throw e;
      const wait = Math.min(1000 * 2 ** attempt, 20_000);
      if (attempt >= 3) console.log(`  ${label}: rate limited, waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const disc = program.coder.accounts.memcmp("roundMarket").bytes;
const raw = await c.getProgramAccounts(PID, { filters: [{ memcmp: { offset: 0, bytes: disc } }] });
console.log(`${raw.length} round books on chain`);

const before = await c.getBalance(kp.publicKey);
let closed = 0, voided = 0, skipped = 0, failed = 0;
const LIMIT = Number(process.env.LIMIT ?? 400);
for (const { pubkey, account } of raw) {
  if (closed >= LIMIT) break;
  let r;
  try { r = program.coder.accounts.decode("roundMarket", account.data); } catch { skipped++; continue; }
  const vault = pda(Buffer.from("rvault"), pubkey.toBuffer());
  try {
    if (!r.settled && !r.void) {
      // void_round takes the Game account, so a book outliving its game cannot
      // be voided at all. That is not fatal here: close_round already accepts a
      // book nobody bet in, and a failed void must not skip the close, which is
      // what stranded the last 15 of the backlog behind a counter that only
      // said "failed".
      try {
        await patiently(() => program.methods.voidRound()
          .accountsPartial({ game: r.game, round: pubkey }).rpc(), "void");
        voided++;
      } catch (e) {
        if (r.totalPool.toString() !== "0") throw e;   // real money: leave it alone
      }
    }
    // A book with stakes still in it is not ours to close: those are somebody's
    // to claim, and an empty vault is the conservation guard.
    const bal = await patiently(() => c.getTokenAccountBalance(vault), "balance").catch(() => null);
    if (bal && BigInt(bal.value.amount) > 0n) { skipped++; continue; }
    const owner = (await patiently(() => c.getAccountInfo(vault), "vault")).owner;
    await patiently(() => program.methods.closeRound().accountsPartial({
      round: pubkey, roundVault: vault, cranker: kp.publicKey,
      tokenProgram: owner }).rpc(), "close");
    closed++;
    if (closed % 25 === 0)
      console.log(`  ${closed} closed, ${((await patiently(() => c.getBalance(kp.publicKey), "bal")) - before)/1e9} SOL back`);
    // Paced rather than as fast as the RPC will take it. A sweep has nowhere
    // to be, and going flat out is what earns the 429 in the first place.
    await new Promise((r) => setTimeout(r, Number(process.env.PACE_MS ?? 120)));
  } catch (e) {
    failed++;
    if (failed <= 3) console.log("  fail:", String(e.message ?? e).split("\n")[0].slice(0, 110));
  }
}
const after = await patiently(() => c.getBalance(kp.publicKey), "final");
console.log(`\nclosed ${closed}  voided ${voided}  skipped ${skipped}  failed ${failed}`);
console.log(`recovered ${(after - before) / 1e9} SOL  (payer now ${after / 1e9})`);
