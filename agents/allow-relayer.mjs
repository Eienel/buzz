// Put a relayer key on the program's allow-list (config authority only).
//
//   PAYER=~/.config/solana/id.json node agents/allow-relayer.mjs <pubkey> [off]
//
// Only an allowed key may stake on another wallet's behalf. Without this gate
// anyone could open a comb "as" any pubkey and squat its player PDA for a whole
// game, so the list is deliberately small and deliberately manual.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";

const { AnchorProvider, Program, Wallet } = anchorPkg;
const [target, off] = process.argv.slice(2);
if (!target) { console.error("usage: allow-relayer.mjs <pubkey> [off]"); process.exit(1); }

const connection = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  readFileSync(process.env.PAYER ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8"));
const program = new Program(idl, provider);

const relayer = new PublicKey(target);
const pda = (...s) => PublicKey.findProgramAddressSync(s, program.programId)[0];
const enabled = off !== "off";

const sig = await program.methods.allowRelayer(enabled).accountsPartial({
  config: pda(Buffer.from("config")),
  relayer,
  allowed: pda(Buffer.from("relayer"), relayer.toBuffer()),
  authority: payer.publicKey,
  systemProgram: SystemProgram.programId,
}).rpc();

console.log(`${enabled ? "allowed" : "revoked"} ${relayer.toBase58()}`);
console.log(sig);
