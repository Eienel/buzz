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
import { isJoinable } from "./arena-api.mjs";
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
      const game = gamePdaFor(p.gameId);

      // Sit down first.
      //
      // This is the whole of easy mode's promise ("commit, reveal and timing
      // are handled") and it was the one step missing: tick committed and
      // revealed for a seat the caller never had. A lobby has instance 0, the
      // loop returned right here on `!instance`, and by the time the game
      // started the agent had never joined, so every later commit was for a
      // player account that does not exist. /api/agent/play answered
      // {"accepted":true} and nothing ever happened. Reproduced against the
      // live arena with the ClawPump agent's own wallet: accepted, queue 0,
      // seated 0, game started without it.
      //
      // The move is the comb to sit in, because that is what a move means
      // before there is a seat to move from. join creates the comb or joins
      // the existing one, so a first mover opens it and the rest fill it.
      const at = snapshot.seats?.get(`${game}:${p.agentWallet}`);
      const seated = at !== undefined;
      if (!seated) {
        // A lobby, or a running game still inside its join window. The program
        // takes both: join_circle allows a Running game in Commit before the
        // lock instance, and isJoinable is that rule written once. This used to
        // be `g.status === 0` alone, so easy mode ignored two thirds of the
        // seats the lobby listing was advertising: an agent that arrived a
        // minute into a game was accepted, queued, and never sat down.
        if (isJoinable(g) && !p.joinQueued) {
          p.joinQueued = true;
          // Comb 0 is not a neutral default. An agent that sent only a
          // prediction was seated in comb 0 every time, which is one of the
          // reasons comb 0 won 60% of the last 200 games: the program kills
          // the comb with the fewest members, so a comb everybody defaults
          // into is the safest seat on the board. Random when unstated.
          const seat = p.move ?? Math.floor(Math.random() * (g.numCircles ?? 6));
          enqueue({ kind: "join", agentWallet: p.agentWallet, gameId: p.gameId,
                    combId: seat });
        }
        continue;                                   // nothing to commit yet
      }
      // Seated now, so a later game for the same agent gets its own join.
      p.joinQueued = false;

      const instance = g.instance;
      if (!instance) continue;                      // seated, waiting for the start

      // phase 0 commit, 1 reveal, 2 resolving, 3 scoring
      if (g.phase === 0 && p.committedFor !== instance) {
        // What was actually played this round, kept so the agent can be told
        // afterwards. Its plan carries only the current choice, and by the time
        // a round is graded the agent may have changed it, so "was I right"
        // cannot be answered from the plan alone.
        (p.log ??= {})[instance] = { move: p.move ?? null, predict: p.predict ?? null };
        const mv = randomNonce(), pd = randomNonce();
        p.nonces[instance] = { mv, pd };
        // Staying put is a play, and it is not a move.
        //
        // `move` names the comb to sit in when the agent joins, and the comb to
        // move to every round after. Those are the same number for anyone who
        // picks a comb and stays there, and reveal_move requires the target to
        // differ from the current circle, so the commit landed and the reveal
        // came back NotAMove every single round. Measured on the ClawPump
        // agent's first real game: join, move and predict all confirmed, then
        // "Error Code: NotAMove" on the reveal.
        //
        // So no move is committed when the agent is already where it wants to
        // be. Its prediction still goes in, which is where the points are
        // anyway.
        p.movingTo = p.move != null && p.move !== at ? p.move : null;
        if (p.movingTo != null) {
          enqueue({ kind: "move", agentWallet: p.agentWallet, gameId: p.gameId,
                    commitHash: commitHash(p.movingTo, mv, p.agentWallet, game, instance) });
        }
        if (p.predict != null) {
          enqueue({ kind: "predict", agentWallet: p.agentWallet, gameId: p.gameId,
                    commitHash: commitHash(p.predict, pd, p.agentWallet, game, instance) });
        }
        p.committedFor = instance;
      }

      // Reveals what was committed, not what was asked for: with no move
      // committed there is nothing to reveal, and revealing anyway is the
      // NotAMove above.
      if (g.phase === 1 && p.committedFor === instance && p.revealedFor !== instance
          && p.movingTo != null && p.nonces[instance]) {
        enqueue({ kind: "revealMove", agentWallet: p.agentWallet, gameId: p.gameId,
                  targetComb: p.movingTo, nonce: String(p.nonces[instance].mv) });
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

  /**
   * The game this wallet is already playing, if any.
   *
   * tick deletes a plan the moment its game leaves the board, so a plan here
   * means a game still running. The waiter needs this: the skill tells an agent
   * to send the same request again, and without this a retry after a queued but
   * unseated play would pick a second game and stake twice.
   */
  /** What this wallet committed, round by round, in the game it is playing. */
  const logOf = (wallet, gameId) => {
    const p = plans.get(key(wallet, gameId));
    return p?.log ?? {};
  };

  const gameOf = (wallet) => {
    for (const p of plans.values()) if (p.agentWallet === wallet) return String(p.gameId);
    return null;
  };
  return { plan, forget, tick, pending, gameOf, logOf };
}
