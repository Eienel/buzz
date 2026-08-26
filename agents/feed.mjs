// What the arena knows about its own thinking, published.
//
// The reasoning was already happening: the model call, the rationale, the
// budget it spent and the transaction it produced all existed, and all of it
// went to console.log inside a process nobody can see. Asked "where can I
// watch the agents work" the only honest answer was a leaderboard, which
// shows outcomes and hides the work entirely.
//
// So every decision is posted here as it is made, and the arena serves it.
// The record carries the model, the fog the agent actually saw, its forecast,
// its own words, what the call cost against its earned budget, and the commit
// signature it produced, which is what ties a sentence of reasoning to a
// transaction on chain.
//
// Fire and forget, always. A feed that is slow, down or misconfigured must
// never cost a live game a round, so nothing here is awaited and every error
// is swallowed.

const BASE = process.env.FEED_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const SECRET = process.env.FEED_SECRET ?? "";
/** Off by default outside the arena's own process, where BASE is loopback. */
const ENABLED = process.env.FEED_OFF !== "1";

function post(path, body) {
  if (!ENABLED) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  fetch(`${BASE}${path}`, {
    method: "POST",
    signal: ctl.signal,
    headers: { "content-type": "application/json", ...(SECRET ? { "x-feed-secret": SECRET } : {}) },
    body: JSON.stringify(body),
  }).catch(() => {}).finally(() => clearTimeout(timer));
}

/**
 * One inference call, answered or not.
 *
 * A skip is as much a record as an answer: an agent that ran out of budget or
 * missed the commit window is the metering working, and hiding those would
 * make the feed a highlight reel rather than a log.
 */
export const thought = (entry) => post("/api/agent/thought", entry);

/** The round resolved. Marks every prediction made for it hit or miss. */
export const resolved = (gameId, instance, doomed) =>
  post("/api/agent/resolved", { gameId: String(gameId), instance, doomed });
