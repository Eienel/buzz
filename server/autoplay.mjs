// Easy mode: an agent says "move to comb 3, predict comb 1" and this handles
// the commit-reveal for it.
//
// The real barrier to an outside agent is not wallets, it is that a move must
// be committed as keccak(target ‖ nonce ‖ owner ‖ game ‖ instance), held, and
// revealed inside a window measured in seconds. Almost nobody will implement
// that to try a game once.
//
// The tradeoff, stated plainly rather than buried: in easy mode the relayer
// learns your move at commit time instead of at reveal. That costs less than it
// sounds. The relayer already executes everything you ask of it and already
// holds the reveal, so it was never the party the fog protected you from. The
// fog exists to hide you from the OTHER PLAYERS, and easy mode keeps that
// intact: what lands on chain is still only a hash until the reveal window.
//
// An agent that wants the relayer blind too can commit its own hashes through
// the raw endpoints and skip this entirely.

import jsSha3 from "js-sha3";
import { PublicKey } from "@solana/web3.js";
const { keccak_256 } = jsSha3;

/** Must mirror the program's hash exactly or the reveal is rejected on chain. */
export function commitHash(target, nonce, owner, game, instance) {
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(BigInt(nonce));
  const inst = Buffer.alloc(2);
  inst.writeUInt16LE(instance);
  return Buffer.from(keccak_256.arrayBuffer(Buffer.concat([
    Buffer.from([target]), n, new PublicKey(owner).toBuffer(),
    new PublicKey(game).toBuffer(), inst,
  ]))).toString("hex");
}

const randomNonce = () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
const key = (wallet, gameId) => `${wallet}:${gameId}`;

/**
 * Holds one intent per agent per game and walks it through the phases as the
 * poller sees them change. Intents are per instance: a plan for instance 4 is
 * committed in 4's commit phase and revealed in 4's, never carried into 5.
 */
export function makeAutoplay({ enqueue, gamePdaFor }) {
  const plans = new Map();

  /** Record what the agent wants to do next instance. */
  function plan({ agentWallet, gameId, move, predict }) {
    const k = key(agentWallet, gameId);
    const prev = plans.get(k) ?? {};
    plans.set(k, {
      ...prev, agentWallet, gameId,
      move: move ?? prev.move ?? null,
      predict: predict ?? prev.predict ?? null,
      committedFor: prev.committedFor ?? null,
      revealedFor: prev.revealedFor ?? null,
      nonces: prev.nonces ?? {},
    });
    return plans.get(k);
  }

  function forget(agentWallet, gameId) { plans.delete(key(agentWallet, gameId)); }

  /**
   * Called on every poll tick with the current snapshot. Commit during Commit,
   * reveal during Reveal (moves) and Scoring (predictions), each once.
   */
  function tick(snapshot) {
    const live = new Map((snapshot.live ?? []).map((g) => [String(g.gameId), g]));
    for (const [k, p] of plans) {
      const g = live.get(String(p.gameId));
      if (!g) { plans.delete(k); continue; }        // game gone: nothing to do
      const instance = g.instance;
      if (!instance) continue;                      // still in the lobby
      const game = gamePdaFor(p.gameId);

      // phase 0 commit, 1 reveal, 2 resolving, 3 scoring
      if (g.phase === 0 && p.committedFor !== instance) {
        const mv = randomNonce(), pd = randomNonce();
        p.nonces[instance] = { mv, pd };
        if (p.move != null) {
          enqueue({ kind: "move", agentWallet: p.agentWallet, gameId: p.gameId,
                    commitHash: commitHash(p.move, mv, p.agentWallet, game, instance) });
        }
        if (p.predict != null) {
          enqueue({ kind: "predict", agentWallet: p.agentWallet, gameId: p.gameId,
                    commitHash: commitHash(p.predict, pd, p.agentWallet, game, instance) });
        }
        p.committedFor = instance;
      }

      if (g.phase === 1 && p.committedFor === instance && p.revealedFor !== instance
          && p.move != null && p.nonces[instance]) {
        enqueue({ kind: "revealMove", agentWallet: p.agentWallet, gameId: p.gameId,
                  targetComb: p.move, nonce: String(p.nonces[instance].mv) });
        p.revealedFor = instance;
      }

      if (g.phase === 3 && p.committedFor === instance && p.predict != null
          && p.nonces[instance] && !p.nonces[instance].pdDone) {
        enqueue({ kind: "revealPrediction", agentWallet: p.agentWallet, gameId: p.gameId,
                  predictedComb: p.predict, nonce: String(p.nonces[instance].pd) });
        p.nonces[instance].pdDone = true;
      }
    }
  }

  const pending = () => plans.size;
  return { plan, forget, tick, pending };
}
