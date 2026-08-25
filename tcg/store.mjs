// The pick log.
//
// The whole claim of this agent is that it calls mispriced cards before it owns
// any, so the record has to be append-only and timestamped, and it has to keep
// the losers. A track record you can edit is not a track record.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DIR = process.env.TCG_DATA_DIR ?? new URL("./data/", import.meta.url).pathname;
const FILE = join(DIR, "picks.json");

let picks = [];
try { picks = JSON.parse(readFileSync(FILE, "utf8")); } catch { /* first run */ }

const key = (p) => `${p.game}:${p.id ?? p.name}`;
const seen = new Set(picks.map(key));

/** Append a call. Silently ignores one we have already made for that card. */
export function record(pick) {
  if (seen.has(key(pick))) return false;
  seen.add(key(pick));
  picks.unshift({ ...pick, at: Date.now() });
  picks = picks.slice(0, Number(process.env.TCG_MAX_PICKS ?? 2000));
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(picks));
  } catch (e) { console.log("[tcg] could not persist picks:", e.message); }
  return true;
}

/**
 * Mark up a pick with what happened since. Called on a later scan, when the
 * same card comes back with a fresh price: the delta against the price we
 * called it at is the only score that matters.
 */
export function settle(game, id, nowPrice) {
  const p = picks.find((x) => x.game === game && (x.id ?? x.name) === id);
  if (!p || nowPrice == null) return null;
  p.lastPrice = nowPrice;
  p.lastSeen = Date.now();
  p.moveBps = p.calledAt ? Math.round(((nowPrice - p.calledAt) / p.calledAt) * 10000) : null;
  try { writeFileSync(FILE, JSON.stringify(picks)); } catch {}
  return p;
}

export const all = () => picks;

/** Honest summary: hit rate on settled picks only, and how many are still open. */
export function scorecard() {
  const settled = picks.filter((p) => p.moveBps != null);
  const hits = settled.filter((p) => p.moveBps > 0).length;
  const avg = settled.length
    ? Math.round(settled.reduce((s, p) => s + p.moveBps, 0) / settled.length) : 0;
  return {
    picks: picks.length,
    settled: settled.length,
    open: picks.length - settled.length,
    hitRate: settled.length ? +(hits / settled.length).toFixed(3) : null,
    avgMoveBps: avg,
  };
}
