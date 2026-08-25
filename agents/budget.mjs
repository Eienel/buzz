// What an agent may spend on thinking, and where that right comes from.
//
// Reasoning was free, which made it decorative: switch the models off and the
// arena runs identically, so the inference was a line item rather than
// something the game depends on. Here it costs, and the budget is earned.
//
// UsePod is prepaid behind an Authorization header rather than x402 (an
// unauthenticated call answers 401, not 402), so the arena fronts the API cost
// and meters the agent against its own on-chain record. The rail is prepaid;
// the entitlement is not, and the entitlement is the part that matters: an
// agent that reads the board badly runs out and drops to the heuristic floor,
// and one that reads it well earns the right to keep thinking.

import { PublicKey } from "@solana/web3.js";

/** Calls every agent gets regardless, so a new agent can play at all. */
const BASE_CALLS = Number(process.env.INFER_BASE_CALLS ?? 6);
/** Extra calls bought by each skill point already earned on chain. */
const CALLS_PER_POINT = Number(process.env.INFER_CALLS_PER_POINT ?? 2);
/** Nobody gets an unbounded budget, however good their record. */
const MAX_CALLS = Number(process.env.INFER_MAX_CALLS ?? 60);

const u64 = (d, o) => { let n = 0n; for (let i = 7; i >= 0; i--) n = n << 8n | BigInt(d[o + i]); return n; };

/**
 * Read an agent's earned skill straight off chain.
 *
 * Decoded by hand rather than through Anchor: a program upgrade never rewrites
 * account data, so devnet still holds AgentStats from older layouts and an
 * eager decode throws before any budget is computed. A missing or unreadable
 * account means a new agent, which is zero points, not an error.
 */
export async function totalPointsOf(connection, programId, owner) {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), new PublicKey(owner).toBuffer()], programId);
    const acc = await connection.getAccountInfo(pda);
    if (!acc || acc.data.length < 8 + 32 + 2 + 8 + 8) return 0;
    const d = acc.data;
    // discriminator, owner, season, season_points, then total_points
    return Number(u64(d, 8 + 32 + 2 + 8));
  } catch { return 0; }
}

export const callsFor = (points) =>
  Math.max(0, Math.min(MAX_CALLS, BASE_CALLS + Math.floor(points) * CALLS_PER_POINT));

/**
 * One game's thinking allowance for one agent. Spent per model call, never
 * refilled mid-game: the budget is what the agent walked in with.
 */
export function makeBudget(points) {
  let left = callsFor(points);
  const granted = left;
  return {
    granted,
    get left() { return left; },
    /** True if a call may be made, and charges for it. */
    spend() { if (left <= 0) return false; left -= 1; return true; },
    spent() { return granted - left; },
  };
}
