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
      await program.methods.voidRound()
        .accountsPartial({ game: r.game, round: pubkey }).rpc();
      voided++;
    }
    // A book with stakes still in it is not ours to close: those are somebody's
    // to claim, and an empty vault is the conservation guard.
    const bal = await c.getTokenAccountBalance(vault).catch(() => null);
    if (bal && BigInt(bal.value.amount) > 0n) { skipped++; continue; }
    await program.methods.closeRound().accountsPartial({
      round: pubkey, roundVault: vault, cranker: kp.publicKey,
      tokenProgram: (await c.getAccountInfo(vault)).owner }).rpc();
    closed++;
    if (closed % 25 === 0)
      console.log(`  ${closed} closed, ${((await c.getBalance(kp.publicKey)) - before)/1e9} SOL back`);
  } catch (e) {
    failed++;
    if (failed <= 3) console.log("  fail:", String(e.message ?? e).split("\n")[0].slice(0, 110));
  }
}
const after = await c.getBalance(kp.publicKey);
console.log(`\nclosed ${closed}  voided ${voided}  skipped ${skipped}  failed ${failed}`);
console.log(`recovered ${(after - before) / 1e9} SOL  (payer now ${after / 1e9})`);
