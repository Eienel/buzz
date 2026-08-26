// Put the reasoning agents on the book, and nobody else.
//
//   PAYER=<config authority> node agents/set-backable.mjs [--clear]
//
// Idempotent: set_backable is init_if_needed, so running it again after
// POD_AGENTS changes simply marks whatever is new.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import jsSha3 from "js-sha3";
import { loadKeypair } from "../server/keypair.mjs";

const { AnchorProvider, Program, Wallet } = anchorPkg;
const { keccak_256 } = jsSha3;

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const SWARM_SEED = process.env.SWARM_SEED ?? "buzz-devnet-swarm-v1";
const SLOTS = Number(process.env.MAX_CONCURRENT ?? 3);
const N_AGENTS = Number(process.env.AGENTS ?? 5);
// Wider than POD_AGENTS on purpose, the same way names.mjs is: marking a name
// that never plays costs one rent-exempt marker, and missing one costs a bet
// nobody can place.
const POD_SPAN = Number(process.env.POD_AGENTS ?? 4) + 4;

const agentKey = (name) => Keypair.fromSeed(
  Uint8Array.from(Buffer.from(keccak_256.arrayBuffer(`${SWARM_SEED}:${name}`)).subarray(0, 32)));

const pods = [];
for (let slot = 0; slot < SLOTS; slot++)
  for (let i = N_AGENTS; i < N_AGENTS + POD_SPAN; i++)
    pods.push({ name: `pod-${slot}${i}`, pubkey: agentKey(`pod-${slot}${i}`).publicKey });

const authority = loadKeypair(process.env.PAYER, `${process.env.HOME}/.config/solana/id.json`);
if (!authority) throw new Error("no PAYER: the config authority has to sign this");

const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(authority), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8"));
const program = new Program(idl, provider);

const clearing = process.argv.includes("--clear");
console.log(`${clearing ? "clearing" : "marking"} ${pods.length} reasoning agents, authority ${authority.publicKey.toBase58()}`);

let done = 0, already = 0;
for (const p of pods) {
  const [marker] = PublicKey.findProgramAddressSync(
    [Buffer.from("backable"), p.pubkey.toBuffer()], program.programId);
  try {
    const exists = await connection.getAccountInfo(marker);
    if (clearing && !exists) { already++; continue; }
    if (!clearing && exists) { already++; continue; }
    await program.methods[clearing ? "clearBackable" : "setBackable"](p.pubkey)
      .accountsPartial({ authority: authority.publicKey, backable: marker }).rpc();
    console.log(`  ${clearing ? "cleared" : "marked"} ${p.name} ${p.pubkey.toBase58()}`);
    done++;
  } catch (e) {
    console.log(`  ${p.name} failed: ${String(e.message ?? e).slice(0, 110)}`);
  }
}
console.log(`${done} changed, ${already} already in the wanted state`);
