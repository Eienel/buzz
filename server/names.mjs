// Who is who on the board.
//
// A leaderboard of base58 blobs tells you nothing about who is winning. Two
// kinds of name resolve here: the house agents, whose wallets are derived from
// a seed so their names can be recomputed rather than stored, and outside
// agents, who choose a display name when they register.

import jsSha3 from "js-sha3";
import { Keypair } from "@solana/web3.js";
const { keccak_256 } = jsSha3;

const SWARM_SEED = process.env.SWARM_SEED ?? "buzz-devnet-swarm-v1";
const STRATS = ["herd", "contrarian", "random"];
const N_AGENTS = Number(process.env.AGENTS ?? 5);
const SLOTS = Number(process.env.MAX_CONCURRENT ?? 3);

/** Same derivation the swarm uses, so the two can never drift apart. */
const agentKey = (name) => Keypair.fromSeed(
  Uint8Array.from(Buffer.from(keccak_256.arrayBuffer(`${SWARM_SEED}:${name}`)).subarray(0, 32)));

// Built once at boot: every wallet the swarm can ever play as.
//
// Reasoning agents are named pod-<slot><i> and take indices after the
// heuristics, so they were missing from this map entirely and showed on the
// board as unnamed rows indistinguishable from a stranger's wallet. The range
// is deliberately generous: POD_AGENTS can be raised on the server without
// this file having to be kept in lockstep, and a name that never plays costs
// one unused map entry.
const POD_SPAN = Number(process.env.POD_AGENTS ?? 4) + 4;
const house = new Map();
for (let slot = 0; slot < SLOTS; slot++) {
  for (let i = 0; i < N_AGENTS; i++) {
    const name = `${STRATS[i % STRATS.length]}-${slot}${i}`;
    house.set(agentKey(name).publicKey.toBase58(), name);
  }
  for (let i = N_AGENTS; i < N_AGENTS + POD_SPAN; i++) {
    const name = `pod-${slot}${i}`;
    house.set(agentKey(name).publicKey.toBase58(), name);
  }
}

/**
 * @param {string} wallet
 * @param {(w:string)=>string|null} lookupRegistered  names agents chose themselves
 */
export function nameFor(wallet, lookupRegistered) {
  const h = house.get(wallet);
  if (h) return { name: h, house: true };
  const r = lookupRegistered?.(wallet);
  if (r) return { name: r, house: false };
  return { name: null, house: false };
}

export const houseWallets = () => [...house.entries()].map(([wallet, name]) => ({ wallet, name }));
