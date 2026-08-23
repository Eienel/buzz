// The relayer pays for everything an agent asks it to do: PDA rent, an ATA,
// the stake, the fees. A worst-case join costs it about 0.0058 SOL, so an
// unmetered relayer holding 0.15 SOL is roughly 25 requests from empty, and one
// agent in a loop empties it in seconds. Free play means there is no cost to
// the caller either, so nothing self-limits.
//
// So: a quota per wallet, a cap on the queue, one join per game per wallet, and
// a solvency floor that stops taking joins before the relayer cannot honour the
// ones it already took. Refusing a join is recoverable. Accepting a game it
// cannot settle is not.

const WINDOW_MS = 60_000;

export const LIMITS = {
  // Joins are the expensive verb. A game runs 5 to 25 minutes and only three
  // are live at once, so an honest agent never needs many.
  joinsPerHour: Number(process.env.LIMIT_JOINS_PER_HOUR ?? 12),
  liveGamesPerAgent: Number(process.env.LIMIT_LIVE_GAMES ?? 4),
  // Moves, predictions, reveals and settles are one cheap transaction each.
  actionsPerMinute: Number(process.env.LIMIT_ACTIONS_PER_MIN ?? 60),
  // Total work waiting on the relayer, across everyone.
  maxQueued: Number(process.env.LIMIT_MAX_QUEUED ?? 400),
  // Stop accepting joins while the relayer is this close to empty.
  minRelayerSol: Number(process.env.LIMIT_MIN_RELAYER_SOL ?? 0.05),
  // What one wallet may ever cost the relayer. The count caps above happen to
  // work out near this, but that is arithmetic rather than a promise: state the
  // budget directly so it holds even if the cost of a seat changes.
  solBudgetPerAgent: Number(process.env.LIMIT_SOL_PER_AGENT ?? 0.1),
};

// What the relayer actually pays out, measured on devnet rather than guessed.
export const COST = {
  join: 0.005754,     // player PDA + associated token account + comb PDA + fee
  action: 0.000005,   // one signature
};

export function makeLimiter() {
  const joins = new Map();      // wallet -> [timestamps]
  const acts = new Map();       // wallet -> [timestamps]
  const joined = new Map();     // wallet -> Set(gameId)
  const spent = new Map();      // wallet -> SOL the relayer has paid on its behalf

  const prune = (list, window) => {
    const cut = Date.now() - window;
    while (list.length && list[0] < cut) list.shift();
    return list;
  };

  /**
   * @returns {{ok:true} | {ok:false, error:string, retryAfter?:number}}
   */
  function check(kind, wallet, gameId, ctx = {}) {
    if (ctx.queued >= LIMITS.maxQueued) {
      return { ok: false, error: "arena is saturated, try again shortly" };
    }

    // A wallet's lifetime budget. Checked before the cheaper limits so an agent
    // that has used its allowance is told that, rather than a rate limit that
    // implies waiting would help.
    const used = spent.get(wallet) ?? 0;
    const cost = kind === "join" ? COST.join : COST.action;
    if (used + cost > LIMITS.solBudgetPerAgent) {
      return { ok: false, error:
        `spend limit reached: this wallet has used its ${LIMITS.solBudgetPerAgent} SOL relayer allowance` };
    }

    const a = prune(acts.get(wallet) ?? [], WINDOW_MS);
    acts.set(wallet, a);
    if (a.length >= LIMITS.actionsPerMinute) {
      return { ok: false, error: `rate limit: ${LIMITS.actionsPerMinute} actions per minute`, retryAfter: 60 };
    }
    a.push(Date.now());

    if (kind === "join") {
      const seen = joined.get(wallet) ?? new Set();
      if (seen.has(String(gameId))) {
        // The chain would reject this anyway, since the player PDA exists.
        // Catching it here means the relayer does not pay a fee to find out.
        return { ok: false, error: "already joined this game" };
      }
      if (seen.size >= LIMITS.liveGamesPerAgent) {
        return { ok: false, error: `already in ${LIMITS.liveGamesPerAgent} games, settle one first` };
      }
      const j = prune(joins.get(wallet) ?? [], 3_600_000);
      joins.set(wallet, j);
      if (j.length >= LIMITS.joinsPerHour) {
        return { ok: false, error: `rate limit: ${LIMITS.joinsPerHour} joins per hour`, retryAfter: 600 };
      }
      if (ctx.relayerSol != null && ctx.relayerSol < LIMITS.minRelayerSol) {
        return { ok: false, error: "relayer is low on funds and is not taking new seats right now" };
      }
      j.push(Date.now());
      seen.add(String(gameId));
      joined.set(wallet, seen);
    }
    spent.set(wallet, used + cost);
    return { ok: true };
  }

  /** A game ended, so its seat no longer counts against the live cap. */
  function release(wallet, gameId) {
    joined.get(wallet)?.delete(String(gameId));
  }

  /** Drop seats for games that are no longer live, so caps self-heal. */
  function reconcile(liveGameIds) {
    const live = new Set(liveGameIds.map(String));
    for (const [w, set] of joined) {
      for (const g of set) if (!live.has(g)) set.delete(g);
      if (!set.size) joined.delete(w);
    }
  }

  const stats = () => ({
    wallets: acts.size,
    seated: joined.size,
    solCommitted: Number([...spent.values()].reduce((a, b) => a + b, 0).toFixed(4)),
  });
  const budget = (wallet) => ({
    used: Number((spent.get(wallet) ?? 0).toFixed(6)),
    limit: LIMITS.solBudgetPerAgent,
  });
  return { check, release, reconcile, stats, budget };
}
