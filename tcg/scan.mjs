// The sourcing pass.
//
// tcgapi.dev sells reference prices, not live listings, and neither traded.gg
// nor Collector Crypt publishes a documented API. So the signal has to be built
// out of what reference data can honestly support:
//
//   spread     low far under market means somebody is selling cheap
//   depth      a spread across one listing is noise; across many it is a market
//   momentum   a card already moving up makes a cheap listing likelier to close
//
// That is weaker than seeing real listings and it is stated as such. The point
// of v1 is a public record of calls, not a claim to have closed the loop.

import { search, mode } from "./client.mjs";
import { record, settle, scorecard, all } from "./store.mjs";

const num = (v) => {
  const n = typeof v === "string" ? Number(v.replace(/[^0-9.\-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const pick = (o, ...names) => {
  for (const n of names) {
    const v = n.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
    if (v != null && v !== "") return v;
  }
  return null;
};

/**
 * The API's field names are not documented anywhere we can read, so normalise
 * defensively rather than hard-coding a shape we have guessed at. Anything we
 * cannot find comes back null and the card is skipped, which is the correct
 * outcome for a card we cannot actually price.
 */
export function normalise(c) {
  return {
    id:      pick(c, "id", "cardId", "productId", "uuid"),
    name:    pick(c, "name", "cardName", "title"),
    set:     pick(c, "set", "setName", "set.name", "expansion"),
    game:    pick(c, "game", "gameName", "category"),
    market:  num(pick(c, "marketPrice", "prices.market", "market", "price.market")),
    low:     num(pick(c, "lowPrice", "prices.low", "low", "price.low")),
    listings: num(pick(c, "listingsCount", "listings", "prices.listings", "quantity")),
    d7:      num(pick(c, "priceChange7d", "changes.7d", "change7d")),
    d30:     num(pick(c, "priceChange30d", "changes.30d", "change30d")),
  };
}

/**
 * How mispriced, in basis points, tempered by whether the discount is real.
 * A huge spread on a single listing is one optimistic seller, not an edge.
 */
export function score(card, opts = {}) {
  const { minListings = 3, minSpreadBps = 1500 } = opts;
  if (!card.market || !card.low || card.low >= card.market) return null;
  if (card.listings != null && card.listings < minListings) return null;

  const spreadBps = Math.round(((card.market - card.low) / card.market) * 10000);
  if (spreadBps < minSpreadBps) return null;

  // depth caps out: past a handful of listings, more does not make it truer
  const depth = card.listings == null ? 0.6 : Math.min(1, card.listings / 10);
  // a card already drifting up is likelier to close the gap than one bleeding
  const drift = Math.max(-1, Math.min(1, ((card.d7 ?? 0) + (card.d30 ?? 0)) / 100));
  const conviction = +(depth * 0.7 + (drift + 1) / 2 * 0.3).toFixed(3);

  return { spreadBps, conviction, edgeBps: Math.round(spreadBps * conviction) };
}

const WATCH = (process.env.TCG_WATCH ??
  "charizard:pokemon,pikachu:pokemon,black lotus:magic,blue-eyes:yugioh,luffy:onepiece,elsa:lorcana"
).split(",").map((s) => { const [q, game] = s.split(":"); return { q: q.trim(), game: game?.trim() }; });

/** One pass over the watchlist. Returns what it called and what it spent. */
export async function run({ limit = 5 } = {}) {
  if (mode() === "none") return { ok: false, error: "set TCG_API_KEY or TCG_WALLET_SECRET" };

  const called = [];
  let spent = 0, looked = 0, skipped = 0;

  for (const w of WATCH) {
    const r = await search(w.q, w.game);
    spent += r.spentUsdc; looked++;
    if (!r.ok) { skipped++; continue; }

    const rows = Array.isArray(r.data) ? r.data
               : r.data?.data ?? r.data?.results ?? r.data?.cards ?? [];
    for (const raw of rows.slice(0, limit)) {
      const c = normalise(raw);
      c.game ??= w.game;
      if (!c.name || !c.market) { skipped++; continue; }

      // an existing call on this card gets marked to the fresh price first
      settle(c.game, c.id ?? c.name, c.market);

      const s = score(c);
      if (!s) continue;
      const added = record({
        game: c.game, id: c.id, name: c.name, set: c.set,
        calledAt: c.low, market: c.market, listings: c.listings,
        ...s,
        reason: `low ${(s.spreadBps / 100).toFixed(1)}% under market` +
                (c.listings ? ` across ${c.listings} listings` : ""),
      });
      if (added) called.push({ name: c.name, set: c.set, ...s });
    }
  }
  return { ok: true, looked, called, skipped, spentUsdc: +spent.toFixed(3), scorecard: scorecard() };
}

export { scorecard, all };
