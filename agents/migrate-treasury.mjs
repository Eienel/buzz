// Grow the existing per-mint treasuries to the leaderboard layout.
//
//   PAYER=~/.config/solana/id.json node agents/migrate-treasury.mjs [--open-season BUZZ]
//
// A treasury is permanent and holds real balances, so unlike a game account it
// cannot be drained and rebuilt: its address is fixed by its seeds. The program
// reallocates it in place, preserving every existing balance and zeroing only
// the appended region.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { loadKeypair } from "../server/keypair.mjs";

const { AnchorProvider, Program, Wallet } = anchorPkg;
const connection = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const payer = loadKeypair(process.env.PAYER, `${process.env.HOME}/.config/solana/id.json`);
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const program = new Program(JSON.parse(
  readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8")), provider);
const pda = (...s) => PublicKey.findProgramAddressSync(s, program.programId)[0];

const openFor = process.argv.includes("--open-season")
  ? process.argv[process.argv.indexOf("--open-season") + 1] : null;
const mints = JSON.parse(readFileSync(new URL("./devnet-mints.json", import.meta.url), "utf8"));

for (const [name, m] of Object.entries(mints)) {
  const mint = new PublicKey(m.mint);
  const treasury = pda(Buffer.from("treasury"), mint.toBuffer());
  const before = await connection.getAccountInfo(treasury);
  if (!before) { console.log(`${name}: no treasury, skipping`); continue; }

  if (before.data.length < program.account.treasury.size) {
    await program.methods.migrateTreasury().accountsPartial({
      treasury, stakeMint: mint, authority: payer.publicKey,
      systemProgram: SystemProgram.programId,
    }).rpc();
    const after = await connection.getAccountInfo(treasury);
    console.log(`${name}: ${before.data.length} -> ${after.data.length} bytes`);
  } else {
    console.log(`${name}: already at ${before.data.length} bytes`);
  }

  const t = await program.account.treasury.fetch(treasury);
  console.log(`   jackpot ${t.jackpotPool} | to_sol ${t.toSolBalance} | burn ${t.burnBalance}`
            + ` | leaderboard ${t.lbAccruing} | season ${t.season}`);

  if (openFor === name && t.season === 0) {
    await program.methods.openSeason().accountsPartial({
      treasury, stakeMint: mint, authority: payer.publicKey,
    }).rpc();
    console.log(`   season 1 open: ${name} games are now ranked`);
  }
}
