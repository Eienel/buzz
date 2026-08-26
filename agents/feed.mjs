// What the arena knows about its own thinking, published.
//
// The reasoning was already happening: the model call, the rationale, the
// budget it spent and the transaction it produced all existed, and all of it
// went to console.log inside a process nobody can reach. Asked "where can I
// watch the agents work" the only honest answer was a leaderboard, which
// shows outcomes and hides the work entirely.
//
// So every decision is posted here as it is made, and the arena serves it at
// /thinking. The record carries the model, the fog the agent actually saw, its
// forecast, its own words, what the call cost against its earned budget, and
// the commit signature it produced, which is what ties a sentence of reasoning
// to a transaction on chain.
//
// Fire and forget, always. A feed that is slow, down or misconfigured must
// never cost a live game a round, so nothing here is awaited and every error
// is swallowed after the first one is named.

import jsSha3 from "js-sha3";
const { keccak_256 } = jsSha3;

// Where the arena is, worked out rather than configured.
//
// With RUN_SWARM=1 the swarm is a child of the arena and loopback is right.
// Run as its own service it is not, and the loopback post goes nowhere: that
// is exactly the silence this had in production, with pods playing 22 of 40
// games and the page empty. So a failure on loopback is taken as proof the
// swarm is somewhere else, and it falls through to the hosted arena for good.
// Trailing slash stripped, because a URL pasted from a browser bar has one and
// the join would then ask for //api/agent/thought, which is a 404 that reads
// like the endpoint is missing rather than like the URL has a spare slash.
// mcp/index.mjs has done this since it was written; this did not, and cost a
// round trip to find out.
const trim = (u) => u ? u.trim().replace(/\/+$/, "") : null;
const EXPLICIT = trim(process.env.FEED_URL) ?? trim(process.env.BUZZ_URL) ?? null;
const LOOPBACK = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const PUBLIC = "https://lastbuzz.fun";
// Hosted, the arena is the public one, full stop.
//
// Loopback was the default because RUN_SWARM=1 makes the swarm a child of the
// arena and a local hop is free. But a swarm on its own service boots its own
// copy of the server, so loopback answers, succeeds, and swallows every record
// into a buffer nobody can read. That is not a failure the client can detect:
// it looks exactly like working. Discovery cannot fix it, so it does not try.
// A local hop was never worth a page that silently shows nothing.
//
// Off Railway this still defaults to loopback, so running the swarm on a
// laptop cannot post test traces into production by accident.
const HOSTED = !!(process.env.RAILWAY_ENVIRONMENT ?? process.env.RAILWAY_ENVIRONMENT_NAME
  ?? process.env.RAILWAY_PROJECT_ID ?? process.env.RAILWAY_SERVICE_ID);
let base = EXPLICIT ?? (HOSTED ? PUBLIC : LOOPBACK);
let fellBack = false;

// Derived, not configured. Both processes already share SWARM_SEED, because
// it is what the agent keypairs come from and what lets the board name them,
// so a secret derived from it needs nothing set anywhere. It is worth exactly
// what that seed is worth: with the seed at its public default this stops
// nothing, but neither does anything else, since the same default hands over
// the agent keys themselves. FEED_SECRET still overrides it.
const SEED = process.env.SWARM_SEED ?? "buzz-devnet-swarm-v1";
const SECRET = process.env.FEED_SECRET ?? keccak_256(`buzz-feed:${SEED}`);

/** Off with FEED_OFF=1, for a swarm that should not publish. */
const ENABLED = process.env.FEED_OFF !== "1";

// Swallowing every error keeps a broken feed from costing a game a round, and
// it also made a feed that never worked look identical to one with nothing to
// say. The first outcome of each kind is logged, once, then it goes quiet.
const said = { ok: false, fail: false };

function send(url, path, body, onFail) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  return fetch(`${url}${path}`, {
    method: "POST",
    signal: ctl.signal,
    headers: { "content-type": "application/json", "x-feed-secret": SECRET },
    body: JSON.stringify(body),
  }).then((r) => {
    if (r.ok) {
      if (!said.ok) { said.ok = true; console.log(`[feed] publishing to ${url}`); }
      return;
    }
    if (!said.fail) {
      said.fail = true;
      console.log(`[feed] ${url} refused: ${r.status}` + (r.status === 401
        ? " (SWARM_SEED differs from the arena's, or FEED_SECRET is set on only one side)" : ""));
    }
    // The url it actually tried, not whatever `base` has become since: two
    // posts are usually in flight at once, and the second one failing on
    // loopback would otherwise be reported against the fallback it triggered.
  }).catch((e) => onFail ? onFail(url, e) : report(url, e))
    .finally(() => clearTimeout(timer));
}

function report(url, e) {
  // Posts overlap, so once loopback has been ruled out the other in-flight
  // ones fail on it too. That is the same fact, already reported.
  if (url === LOOPBACK && fellBack) return;
  if (said.fail) return;
  said.fail = true;
  console.log(`[feed] cannot reach ${url}: ${String(e.message ?? e).slice(0, 90)}`);
}

function post(path, body) {
  if (!ENABLED) return;
  send(base, path, body, (url, e) => {
    // Loopback failing with nothing configured means the arena is not in this
    // process. Say so once, switch, and do not keep paying for the discovery.
    if (fellBack || EXPLICIT || url !== LOOPBACK) return report(url, e);
    fellBack = true;
    base = PUBLIC;
    console.log(`[feed] no arena on ${LOOPBACK}, publishing to ${PUBLIC} instead`);
    send(base, path, body);
  });
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
