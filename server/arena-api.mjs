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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./keypair.mjs";

// A join relayed with only a second or two left loses the race to the crank.
const JOIN_MARGIN_SECONDS = 3;

const PRICE = {
  join:    Number(process.env.PRICE_JOIN    ?? 0.10), // USD, becomes the stake
  move:    Number(process.env.PRICE_MOVE    ?? 0.00), // free: moves should not be taxed
  predict: Number(process.env.PRICE_PREDICT ?? 0.00),
  revealMove: 0, revealPrediction: 0, settle: 0, // never charge to finish what you started
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

// Devnet play is free, so there is no payment to prove who is asking. Without
// something in its place anyone could act as anyone else's wallet and pollute
// a rival's record, which matters the moment a leaderboard has a prize on it.
// So a wallet is claimed once, first come, and every later action for it must
// carry the token issued at that moment. No signing needed, which matters
// because a ClawPump agent cannot sign an arbitrary message either.
// The registry has to outlive the process. It lived in memory, so every deploy
// or restart silently invalidated every token: a returning player still held a
// wallet and token in their browser, but the server no longer knew either, and
// every action came back "wallet not registered". DATA_DIR is a volume in
// production, the same one the history uses.
const AGENTS_FILE = join(DATA_DIR, "agents.json");
const agents = new Map();          // wallet -> { token, name, since }
try {
  for (const [w, a] of JSON.parse(readFileSync(AGENTS_FILE, "utf8"))) agents.set(w, a);
} catch { /* first boot, or no volume: start empty */ }
function persistAgents() {
  try { writeFileSync(AGENTS_FILE, JSON.stringify([...agents])); }
  catch (e) { console.log("agents write failed:", e.message); }
}
const randomToken = () =>
  Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");

/**
 * A name anyone may pick, reduced to something safe to print.
 *
 * Registration is open, so this is a string a stranger chooses and the arena
 * page renders. It reached the leaderboard and the bet menu through innerHTML
 * with no escaping, which is stored XSS against every visitor, and one of the
 * sites interpolated it into a data- attribute where a single quote is enough
 * to break out. The page escapes on render now as well; this is the half that
 * means the bad value never gets stored in the first place.
 *
 * Letters, digits, space, dash, underscore and dot. Enough for "clawpump-buzz"
 * or "Ava's Agent" minus the apostrophe, and nothing that means anything to an
 * HTML parser. Collapsed and trimmed so leading spaces cannot be used to sort
 * to the top of a board, and capped well under the column width.
 */
function cleanName(raw) {
  const s = String(raw ?? "").replace(/[^A-Za-z0-9 _.-]/g, "").replace(/\s+/g, " ").trim();
  return s.slice(0, 24) || null;
}

export function registerAgent({ agentWallet, name }) {
  if (!isPubkey(agentWallet ?? "")) return { status: 400, body: { error: "agentWallet must be a base58 pubkey" } };
  const existing = agents.get(agentWallet);
  if (existing) {
    return { status: 409, body: { error: "wallet already registered",
      hint: "keep the token from the first registration; it is the only proof this wallet is yours" } };
  }
  const token = randomToken();
  agents.set(agentWallet, { token, name: cleanName(name), since: Date.now() });
  persistAgents();
  return { status: 200, body: { agentWallet, token, name: name ?? null,
    note: "store this token, it is shown once and cannot be recovered" } };
}

export function authed(body) {
  const a = agents.get(body?.agentWallet);
  if (!a) return { ok: false, error: "wallet not registered: call register first" };
  if (a.token !== body?.token) return { ok: false, error: "wrong token for this wallet" };
  return { ok: true, agent: a };
}

export const agentName = (wallet) => agents.get(wallet)?.name ?? null;
export const agentCount = () => agents.size;

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
            // Must match join_circle exactly, or we advertise seats the program
            // will refuse: Lobby always, otherwise Running AND in Commit AND
            // before the lock instance AND still inside the phase window. A
            // margin keeps us from promising a seat that closes while the
            // relayer is still queuing the transaction.
            joinable:
              g.status === 0 ||
              (g.status === 1 &&
                g.phase === 0 &&
                g.instance < g.lockInstance &&
                Math.floor(Date.now() / 1000) + JOIN_MARGIN_SECONDS < g.phaseEndsAt),
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

    /** Open the move commitment. Skipping this forfeits the move, not the stake. */
    revealMove({ agentWallet, gameId, targetComb, nonce }) {
      if (!isPubkey(agentWallet ?? "")) return { status: 400, body: { error: "agentWallet must be a base58 pubkey" } };
      if (targetComb == null || targetComb < 0 || targetComb > 11) return { status: 400, body: { error: "targetComb must be 0-11" } };
      if (nonce == null) return { status: 400, body: { error: "nonce is required (the one you hashed)" } };
      const id = enqueue({ kind: "revealMove", agentWallet, gameId, targetComb, nonce: String(nonce) });
      return { status: 202, body: { accepted: true, actionId: id } };
    },

    /** Open the prediction. Only a revealed correct call scores a skill point. */
    revealPrediction({ agentWallet, gameId, predictedComb, nonce }) {
      if (!isPubkey(agentWallet ?? "")) return { status: 400, body: { error: "agentWallet must be a base58 pubkey" } };
      if (predictedComb == null || predictedComb < 0 || predictedComb > 11) return { status: 400, body: { error: "predictedComb must be 0-11" } };
      if (nonce == null) return { status: 400, body: { error: "nonce is required (the one you hashed)" } };
      const id = enqueue({ kind: "revealPrediction", agentWallet, gameId, predictedComb, nonce: String(nonce) });
      return { status: 202, body: { accepted: true, actionId: id } };
    },

    /** Sweep whatever this agent is owed into its own wallet. Free, always. */
    settle({ agentWallet, gameId }) {
      if (!isPubkey(agentWallet ?? "")) return { status: 400, body: { error: "agentWallet must be a base58 pubkey" } };
      const id = enqueue({ kind: "settle", agentWallet, gameId });
      return { status: 202, body: { accepted: true, actionId: id } };
    },
  };
}

export { PRICE, challenge, isPubkey };
