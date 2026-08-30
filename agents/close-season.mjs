// Close the open season on a mint and start the next one.
//
//   PAYER=~/.config/solana/id.json node agents/close-season.mjs BUZZ
//
// Snapshots the pool and the point total, zeroes the accruing counters, and
// advances the season number. Whatever the previous season's claimants left
// behind rolls into the new pool rather than sitting unreachable in the vault.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { loadKeypair } from "../server/keypair.mjs";
import { makeConnection, surviveRateLimits } from "../server/rpc.mjs";

const { AnchorProvider, Program, Wallet } = anchorPkg;
const which = (process.argv[2] ?? "BUZZ").toUpperCase();
const connection = makeConnection(process.env.RPC ?? "https://api.devnet.solana.com", { label: "close-season" });
surviveRateLimits("close-season");
const payer = loadKeypair(process.env.PAYER, `${process.env.HOME}/.config/solana/id.json`);
const program = new Program(
  JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8")),
  new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" }));
const pda = (...s) => PublicKey.findProgramAddressSync(s, program.programId)[0];

const mints = JSON.parse(readFileSync(new URL("./devnet-mints.json", import.meta.url), "utf8"));
if (!mints[which]) { console.error(`unknown mint ${which}; have ${Object.keys(mints).join(", ")}`); process.exit(1); }
const mint = new PublicKey(mints[which].mint);
const treasury = pda(Buffer.from("treasury"), mint.toBuffer());

const before = await program.account.treasury.fetch(treasury);
if (before.season === 0) { console.error(`${which} is not ranked; open a season first`); process.exit(1); }
console.log(`${which} season ${before.season}: pool ${before.lbAccruing} | points ${before.ptsAccruing}`);

await program.methods.closeSeason()
  .accountsPartial({ treasury, stakeMint: mint, authority: payer.publicKey }).rpc();

const after = await program.account.treasury.fetch(treasury);
console.log(`closed. season ${after.season} now open.`);
console.log(`  claimable pool  ${after.lbClaimable}`);
console.log(`  over points     ${after.ptsClaimable}`);
if (Number(after.ptsClaimable) === 0) console.log("  (nobody scored, so the pool rolls forward)");
