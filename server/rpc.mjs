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

export function makeConnection(rpc, opts = {}) {
  const fallbackUrl = opts.fallback ?? process.env.RPC_FALLBACK ?? "https://api.devnet.solana.com";
  const cooldown = Number(opts.cooldownMs ?? process.env.RPC_COOLDOWN_MS ?? 10 * 60_000);
  const commitment = opts.commitment ?? "confirmed";
  const label = opts.label ?? "rpc";

  const primary = new Connection(rpc, commitment);
  const fallback = fallbackUrl === rpc ? null : new Connection(fallbackUrl, commitment);
  let benchedUntil = 0;
  const benched = () => Date.now() < benchedUntil;

  if (!fallback) return primary;

  return new Proxy(primary, {
    get(target, prop, receiver) {
      const live = benched() ? fallback : target;
      const v = Reflect.get(live, prop, live);
      if (typeof v !== "function") return v;
      return function (...args) {
        const out = v.apply(live, args);
        // Only the primary's rejections bench anything, and only a promise
        // carries the answer that would tell us.
        if (live !== target || !out || typeof out.then !== "function") return out;
        return out.catch((e) => {
          if (!LIMITED.test(String(e?.message ?? e))) throw e;
          if (!benched())
            console.log(`[${label}] primary rate-limited, using ${fallbackUrl} for ${Math.round(cooldown / 1000)}s`);
          benchedUntil = Date.now() + cooldown;
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
