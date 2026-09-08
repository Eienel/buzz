// One RPC connection that knows where else to look.
//
// The primary is a paid endpoint with a monthly quota. When that quota goes,
// every read starts answering 429 at once, and everything downstream fails in
// its own way: the poller cannot refresh so the arena serves a stale board, the
// book cannot open, and the swarm dies on its very first call and restarts into
// the same wall twenty seconds later. That last one ran for ten hours.
//
// So a 429 is not a failure any more. It benches the primary for a while and
// the call is retried against public devnet, which is slower and rate-limits
// harder per call but is always there.
//
// It is a Proxy over the whole Connection rather than a wrapper around the
// methods we happen to use. Anchor, the poller, the book, the relayer and the
// swarm all take a Connection and call whatever they like on it, so
// intercepting the entire surface is the only version of this that cannot be
// defeated by a method nobody remembered to wrap.

import { Connection } from "@solana/web3.js";

const LIMITED = /429|Too Many Requests|max usage reached|rate limit/i;

/**
 * Every RPC method this process has called, and how often.
 *
 * Alchemy bills per call, not per byte, so the only way to know where the
 * budget goes is to count calls by method. Estimating it produced 42.5M CU a
 * day against a measured 7.5M, which is the kind of wrong that leads to
 * optimising the wrong loop: the poller looked like the problem and the
 * phase-wait loop turned out to already sleep on the chain's own clock.
 *
 * Counting only. Nothing here changes what is called or when.
 */
const rpcCalls = new Map();
export const rpcStats = () =>
  Object.fromEntries([...rpcCalls.entries()].sort((a, b) => b[1] - a[1]));
export const rpcTotal = () => [...rpcCalls.values()].reduce((a, b) => a + b, 0);

// Alchemy's Solana price list, so the counts can be turned into a bill without
// a spreadsheet. Anything unlisted is assumed 20, which is the common case.
const CU = { getAccountInfo: 10, getBalance: 10, getMultipleAccountsInfo: 20,
             getProgramAccounts: 20, sendTransaction: 20, getLatestBlockhash: 20,
             getSignatureStatuses: 20, simulateTransaction: 20, getTokenSupply: 20,
             getTransaction: 20, getSignaturesForAddress: 20, getSlot: 10 };
export const rpcComputeUnits = () =>
  [...rpcCalls.entries()].reduce((n, [m, c]) => n + c * (CU[m] ?? 20), 0);

/**
 * Whether the primary RPC is currently benched, and how often it has been.
 *
 * The fallback below only announced itself in the log, which means "is our
 * paid endpoint throttling us" could only be answered by someone with log
 * access. That is the same failure /api/version already fixed for env vars:
 * a condition that changes behaviour should be visible from outside rather
 * than deduced from the absence of it. Alchemy rate-limiting us and the public
 * endpoint being slow look identical from the arena, and they want different
 * fixes.
 */
const fallbackState = new Map();     // label -> { until, hits, url }
export const rpcHealth = () =>
  Object.fromEntries([...fallbackState.entries()].map(([label, s]) => [label, {
    onFallback: Date.now() < s.until,
    fallbackUrl: s.url,
    secondsLeft: Math.max(0, Math.round((s.until - Date.now()) / 1000)),
    timesBenched: s.hits,
  }]));

/**
 * What actually happened to a transaction whose confirmation gave up.
 *
 * Devnet routinely takes longer to confirm than clients wait, and the two
 * errors it raises disagree on wording and on capitalisation:
 *
 *   Transaction was not confirmed in 30.00 seconds. ... Check signature 5qj...
 *   Signature 5JS... has expired: block height exceeded.
 *
 * Both mean "unknown", not "failed", and the chain has the answer. Returns the
 * signature if it landed cleanly, null if it never landed or the error was not
 * one of these, and rethrows the original error if it landed and failed.
 *
 * Third call site for this logic, which is why it lives here: the swarm's
 * transactions, and the fuel top-up, which reported "top-up failed" for a
 * transfer that had gone through.
 */
export async function landedAnyway(connection, e, opts = {}) {
  const m = String(e?.message ?? e);
  const slow = /was not confirmed|Timed out awaiting/i.test(m);
  const expired = /block height exceeded/i.test(m);
  if (!slow && !expired) return null;
  // Case-insensitive: one message says "signature", the other "Signature",
  // and matching only one spelling meant the expired case, which is most of
  // them, never got checked at all.
  const sig = m.match(/signature ([1-9A-HJ-NP-Za-km-z]{80,90})/i)?.[1] ?? e?.signature;
  if (!sig) return null;
  // A slow confirmation is worth waiting out. An expired blockhash usually
  // means it never made it in, so it gets a shorter look.
  const tries = opts.tries ?? (slow ? 10 : 3);
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, opts.everyMs ?? 3000));
    const st = (await connection.getSignatureStatuses([sig])).value?.[0];
    if (!st) continue;
    if (st.err) throw e;                        // it landed and it failed
    return sig;
  }
  return null;
}

export function makeConnection(rpc, opts = {}) {
  const fallbackUrl = opts.fallback ?? process.env.RPC_FALLBACK ?? "https://api.devnet.solana.com";
  const cooldown = Number(opts.cooldownMs ?? process.env.RPC_COOLDOWN_MS ?? 10 * 60_000);
  const commitment = opts.commitment ?? "confirmed";
  const label = opts.label ?? "rpc";

  const primary = new Connection(rpc, commitment);
  const fallback = fallbackUrl === rpc ? null : new Connection(fallbackUrl, commitment);
  let benchedUntil = 0;
  const benched = () => Date.now() < benchedUntil;

  // Registered up front, so an empty report means "no fallback configured"
  // rather than "configured and never needed". Those are different facts and
  // nothing after the event can tell them apart.
  fallbackState.set(label, { until: 0, hits: 0, url: fallback ? fallbackUrl : null });

  if (!fallback) return primary;

  return new Proxy(primary, {
    get(target, prop, receiver) {
      const live = benched() ? fallback : target;
      const v = Reflect.get(live, prop, live);
      if (typeof v !== "function") return v;
      return function (...args) {
        if (typeof prop === "string") rpcCalls.set(prop, (rpcCalls.get(prop) ?? 0) + 1);
        const out = v.apply(live, args);
        // Only the primary's rejections bench anything, and only a promise
        // carries the answer that would tell us.
        if (live !== target || !out || typeof out.then !== "function") return out;
        return out.catch((e) => {
          if (!LIMITED.test(String(e?.message ?? e))) throw e;
          if (!benched())
            console.log(`[${label}] primary rate-limited, using ${fallbackUrl} for ${Math.round(cooldown / 1000)}s`);
          benchedUntil = Date.now() + cooldown;
          const st = fallbackState.get(label) ?? { hits: 0, url: fallbackUrl };
          fallbackState.set(label, { ...st, until: benchedUntil, hits: st.hits + 1 });
          // Answer the call rather than making the caller pay for the
          // discovery. Without this the first read after a quota runs out
          // still throws, which is exactly what killed the swarm.
          const again = Reflect.get(fallback, prop, fallback);
          if (typeof again === "function") return again.apply(fallback, args);
          throw e;
        });
      };
    },
  });
}

/**
 * Stop a rate limit from killing the process.
 *
 * The fallback above only catches what it wraps: a rejection from a method
 * called on the Connection. It cannot see a 429 thrown from inside the RPC
 * client's own callback, which arrives as an unhandled rejection, and node
 * kills the process on those. In production that read as a crash loop with a
 * different stack every time.
 *
 * A rate limit is not a fatal condition. It means try again later, and every
 * loop in this codebase already does: the poller polls, the cranker cranks, the
 * swarm asks about fuel before each game. Losing the whole process is the one
 * response guaranteed to make it worse, because it takes the arena down with
 * it. So these are logged and swallowed.
 *
 * Everything else still kills the process, deliberately. An unhandled rejection
 * that is not a rate limit is a bug, and a bug that keeps running is worse than
 * one that stops.
 */
export function surviveRateLimits(label = "rpc") {
  let last = 0;
  const handle = (err) => {
    const msg = String(err?.message ?? err);
    if (!LIMITED.test(msg)) throw err;              // not ours: die as before
    // Rate limits arrive in floods, so this would otherwise be the noisiest
    // line in the log by two orders of magnitude.
    const now = Date.now();
    if (now - last > 30_000) {
      last = now;
      console.log(`[${label}] rate limited (${msg.slice(0, 60)}), carrying on`);
    }
  };
  process.on("unhandledRejection", handle);
  process.on("uncaughtException", handle);
}

/**
 * The useful part of a transaction error, without another round trip.
 *
 * web3.js buries the cause. A SendTransactionError built without an `action`
 * renders its whole message as "Unknown action 'undefined'", which is what the
 * swarm's failure log was full of, while `transactionMessage` on the same
 * object said "Blockhash not found". The program logs are already there too,
 * as `transactionLogs`.
 *
 * So this reads what the error is already carrying rather than calling
 * getLogs(), which fetches the transaction again: another RPC call per
 * failure, on a budget measured in compute units, and nothing at all for a
 * simulation error because there is no signature to fetch by.
 *
 * Anchor's errors are handled by the same two fields, and its `logs` array is
 * checked as well since AnchorError puts them there instead.
 */
export function explainTxError(e) {
  const message = e?.transactionMessage ?? e?.message ?? String(e);
  const logs = Array.isArray(e?.transactionLogs) ? e.transactionLogs
             : Array.isArray(e?.logs) ? e.logs
             : null;
  if (!logs?.length) return String(message);
  // The lines that say why, not the whole program trace. A reveal that failed
  // on a constraint puts the reason in one line and the call stack in twelve.
  const why = logs.filter((l) => /error|failed|panicked|insufficient|constraint/i.test(l));
  return `${message} :: ${(why.length ? why : logs.slice(-2)).join(" | ")}`;
}
