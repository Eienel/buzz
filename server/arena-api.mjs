// BUZZ Arena: the x402 surface ClawPump agents play through.
//
// ClawPump agents cannot sign an arbitrary Anchor instruction: their skill set
// covers swaps, transfers and launches, not raw program calls. What they CAN do
// is call any x402 endpoint and pay for it from their own wallet, hard-capped
// by the caller. So the arena is exposed as x402: an agent pays to act, and a
// relayer puts the action on chain with that agent registered as the player.
//
// Honest limitation: between the agent's payment and its payout, the stake is
// held by the relayer. That is custodial for the length of one game. It is
// bounded by MAX_GAME_DEPOSITS in the program and by the agent's own
// max_amount_usd cap, and it is stated plainly rather than papered over.
// Non-custodial agent play needs ClawPump to expose transaction signing or SPL
// `approve`; neither exists today.

import { PublicKey } from "@solana/web3.js";

const PRICE = {
  join:    Number(process.env.PRICE_JOIN    ?? 0.10), // USD, becomes the stake
  move:    Number(process.env.PRICE_MOVE    ?? 0.00), // free: moves should not be taxed
  predict: Number(process.env.PRICE_PREDICT ?? 0.00),
};
const PAY_TO = process.env.ARENA_PAY_TO ?? "";
const NETWORK = process.env.X402_NETWORK ?? "solana-devnet";
const USDC = process.env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // devnet USDC

/** x402 challenge: what the caller must pay before we will act. */
function challenge(res, resource, usd, description) {
  res.writeHead(402, { "content-type": "application/json" });
  res.end(JSON.stringify({
    x402Version: 1,
    error: "payment required",
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      resource,
      description,
      mimeType: "application/json",
      maxAmountRequired: String(Math.round(usd * 1e6)), // USDC has 6 decimals
      payTo: PAY_TO,
      asset: USDC,
      maxTimeoutSeconds: 120,
    }],
  }));
}

const isPubkey = (s) => {
  try { new PublicKey(s); return true; } catch { return false; }
};

/**
 * Actions an agent can take. Each returns {status, body}. Payment is verified
 * by the caller before these run.
 */
export function makeArena({ snapshot, enqueue }) {
  return {
    /** What is playable right now, and what it costs to enter. */
    lobbies() {
      const live = (snapshot().live ?? []).filter((g) => g.status === 0 || g.status === 1);
      return {
        status: 200,
        body: {
          arena: "BUZZ / Last Comb Standing",
          cluster: snapshot().cluster ?? "devnet",
          program: snapshot().programId,
          priceUsd: PRICE,
          openLobbies: live.map((g) => ({
            gameId: g.gameId,
            status: ["lobby", "running"][g.status],
            instance: g.instance,
            phase: ["commit", "reveal", "resolving", "scoring"][g.phase],
            combs: (g.combs ?? []).map((c) => ({
              id: c.id,
              alive: c.alive,
              // the fog: a band, never a live headcount
              band: c.members === 0 ? "empty" : c.members <= 1 ? "thin"
                  : c.members <= 3 ? "healthy" : "crowded",
            })),
            joinable: g.status === 0 || (g.status === 1 && g.instance < g.lockInstance),
          })),
        },
      };
    },

    /** Enter a game. The x402 payment is the stake. */
    join({ agentWallet, gameId, combId }) {
      if (!isPubkey(agentWallet ?? "")) return { status: 400, body: { error: "agentWallet must be a base58 pubkey" } };
      if (combId == null || combId < 0 || combId > 11) return { status: 400, body: { error: "combId must be 0-11" } };
      const id = enqueue({ kind: "join", agentWallet, gameId, combId });
      return { status: 202, body: { accepted: true, actionId: id,
        note: "queued for on-chain relay; poll /api/agent/action/<id>" } };
    },

    /** Commit a hashed move for this instance. The hash keeps the fog intact. */
    move({ agentWallet, gameId, commitHash }) {
      if (!isPubkey(agentWallet ?? "")) return { status: 400, body: { error: "agentWallet must be a base58 pubkey" } };
      if (!/^[0-9a-f]{64}$/i.test(commitHash ?? "")) return { status: 400, body: { error: "commitHash must be 32 bytes hex" } };
      const id = enqueue({ kind: "move", agentWallet, gameId, commitHash });
      return { status: 202, body: { accepted: true, actionId: id } };
    },

    /** Commit a hashed prediction of which comb dies. Correct calls earn skill points. */
    predict({ agentWallet, gameId, commitHash }) {
      if (!isPubkey(agentWallet ?? "")) return { status: 400, body: { error: "agentWallet must be a base58 pubkey" } };
      if (!/^[0-9a-f]{64}$/i.test(commitHash ?? "")) return { status: 400, body: { error: "commitHash must be 32 bytes hex" } };
      const id = enqueue({ kind: "predict", agentWallet, gameId, commitHash });
      return { status: 202, body: { accepted: true, actionId: id } };
    },
  };
}

export { PRICE, challenge, isPubkey };
