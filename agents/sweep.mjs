// Pull rent out of the house agent wallets and back to the payer.
//
//   PAYER=~/.config/solana/id.json node agents/sweep.mjs
//
// close_player pays a player's rent to its owner and close_circle pays a
// comb's to its creator, and both of those are agent wallets rather than the
// payer. So a long reap drains the payer on fees while the recovered rent
// piles up somewhere else. This moves it back, and is safe to run at any time,
// including while a reap is still going.
//
// The payer is the fee payer on every transfer, so an agent never needs a
// balance of its own to give one up.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import jsSha3 from "js-sha3";
import { loadKeypair } from "../server/keypair.mjs";
import { houseWallets } from "../server/names.mjs";

const { keccak_256 } = jsSha3;
const { AnchorProvider, Wallet } = anchorPkg;
const SEED = process.env.SWARM_SEED ?? "buzz-devnet-swarm-v1";
const payer = loadKeypair(process.env.PAYER, `${process.env.HOME}/.config/solana/id.json`);
const connection = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const agentKey = (name) => Keypair.fromSeed(
  Uint8Array.from(Buffer.from(keccak_256.arrayBuffer(`${SEED}:${name}`)).subarray(0, 32)));

const before = await connection.getBalance(payer.publicKey);
let swept = 0, from = 0;
for (const { name } of houseWallets()) {
  const kp = agentKey(name);
  const bal = await connection.getBalance(kp.publicKey);
  if (bal <= 0) continue;
  try {
    // The whole balance, down to zero. The payer covers the fee, so the agent
    // does not need to keep lamports back to pay for its own transfer, and is
    // never left with sub-rent-exempt dust the runtime would reject.
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: kp.publicKey, toPubkey: payer.publicKey, lamports: bal }));
    tx.feePayer = payer.publicKey;
    await provider.sendAndConfirm(tx, [kp]);
    swept += bal; from++;
    console.log(`  ${name.padEnd(14)} ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (e) { console.log(`  ${name}: ${String(e.message).slice(0, 70)}`); }
}
const after = await connection.getBalance(payer.publicKey);
console.log(`\nswept ${(swept / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${from} wallets`);
console.log(`payer ${(before / LAMPORTS_PER_SOL).toFixed(4)} -> ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
