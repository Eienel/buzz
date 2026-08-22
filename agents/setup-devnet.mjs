// One-time devnet setup: create the test stake assets, enable them for play,
// and open their per-mint treasuries. Writes agents/devnet-mints.json.
//
//   PAYER=~/.config/solana/id.json node agents/setup-devnet.mjs
//
// These are devnet stand-ins. Real BUZZ is a mainnet Token-2022 mint and real
// ANSEM is a mainnet token; neither exists on devnet, so we mint look-alikes
// with the same decimals to exercise the identical code path.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";

const { AnchorProvider, Program, Wallet } = anchorPkg;
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  readFileSync(process.env.PAYER ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8"));
const program = new Program(idl, provider);
const PID = program.programId;
const pda = (...s) => PublicKey.findProgramAddressSync(s, PID)[0];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const configPda = pda(Buffer.from("config"));
const DECIMALS = 6;

// config must exist before mints can be allowed
try {
  await program.account.gameConfig.fetch(configPda);
  log("config already initialised");
} catch {
  log("initialising config");
  await program.methods
    .initializeConfig(400, 5000, new anchorPkg.BN(1_000_000), new anchorPkg.BN(500_000_000),
      Number(process.env.INSTANCE_SECONDS ?? 20), 200)
    .accountsPartial({ config: configPda, authority: payer.publicKey }).rpc();
}

const out = {};
for (const name of ["BUZZ", "ANSEM"]) {
  const mint = await createMint(connection, payer, payer.publicKey, null,
    DECIMALS, undefined, undefined, TOKEN_2022_PROGRAM_ID);
  log(`${name} devnet mint: ${mint.toBase58()}`);

  await program.methods.allowMint(true).accountsPartial({
    config: configPda, mint, allowed: pda(Buffer.from("allowed"), mint.toBuffer()),
    authority: payer.publicKey, systemProgram: SystemProgram.programId,
  }).rpc();
  log(`  enabled for play`);

  await program.methods.initTreasury().accountsPartial({
    stakeMint: mint,
    treasury: pda(Buffer.from("treasury"), mint.toBuffer()),
    treasuryVault: pda(Buffer.from("tvault"), mint.toBuffer()),
    authority: payer.publicKey,
    tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
  log(`  treasury opened`);

  out[name] = { mint: mint.toBase58(), decimals: DECIMALS, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() };
}

writeFileSync(new URL("./devnet-mints.json", import.meta.url), JSON.stringify(out, null, 2));
log("wrote agents/devnet-mints.json");
