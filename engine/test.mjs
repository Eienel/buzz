// Reference-engine test: drives the Game state machine with fog-reading agents,
// runs a full season over a persistent population, and asserts:
//   (1) money conservation invariant (engine throws if violated)
//   (2) soft-landing floor holds (nobody loses everything)
//   (3) house profit ~ 2% of volume
//   (4) skill edge present (high-skill ROI > low-skill ROI)
import { Casino, Rng } from "./game.mjs";

const BASE_NOISE = 3.0;
const POP = 200, GAMES = 2000, SEED = 2024;

// ---- fog perception + agent policy (this is the "client", not the engine) ----
function perceive(g, p, rng) {
  const alive = g.aliveIds();
  const noisy = {};
  for (const b of alive) noisy[b] = Math.max(0, (g.prevCounts[b] ?? 0) + gauss(rng) * BASE_NOISE * (1 - p.skill));
  return alive.sort((a, b) => noisy[a] - noisy[b]); // ascending perceived count
}
let _spare = null;
function gauss(rng) { // Box-Muller
  if (_spare !== null) { const s = _spare; _spare = null; return s; }
  const u = Math.max(1e-9, rng.next()), v = rng.next();
  const r = Math.sqrt(-2 * Math.log(u)); _spare = r * Math.sin(2 * Math.PI * v);
  return r * Math.cos(2 * Math.PI * v);
}

function makePolicy(rng) {
  const leanSafe = (rank) => { const k = Math.max(1, Math.floor(rank.length / 3));
    const safe = rank.length > k ? rank.slice(k) : rank.slice(-1); return safe; };
  return {
    lobbyTarget(g, p) { const r = perceive(g, p, rng); const safe = leanSafe(r);
      return rng.next() < p.skill ? safe[0] : r[r.length - 1]; },
    moves(g) {
      const mv = {}; const alive = g.aliveIds();
      const k = Math.max(1, Math.floor(alive.length / 3));
      for (const [id, p] of g.players) {
        if (p.status !== "active") continue;
        const rank = perceive(g, p, rng); const danger = new Set(rank.slice(0, k));
        let act = false;
        if (danger.has(p.block)) act = rng.next() < (0.4 + 0.6 * p.skill);
        else if (p.block === rank[rank.length - 1] && alive.length > 3) act = rng.next() < p.skill * 0.30;
        if (act) { const opts = rank.filter(b => b !== p.block); if (!opts.length) continue;
          const safe = leanSafe(opts); const tgt = rng.next() < p.skill ? safe[0] : opts[opts.length - 1];
          if (tgt !== p.block) mv[id] = tgt; }
      }
      return mv;
    },
    predictions(g) { // predict the circle you think dies = your perceived smallest
      const pr = {};
      for (const [id, p] of g.players) if (p.status === "active") { const r = perceive(g, p, rng); pr[id] = r[0]; }
      return pr;
    },
    onDeath(g, id) {
      const p = g.players.get(id);
      if (rng.next() < Math.min(0.7, 0.10 + 0.45 * p.skill)) return { action: "cashout" };
      const r = perceive(g, p, rng); const k = Math.max(1, Math.floor(r.length / 3));
      const safe = r.length > k ? r.slice(k) : r.slice(-1);
      return { action: "land", target: rng.next() < p.skill ? safe[0] : r[r.length - 1] };
    },
  };
}

// ---- persistent population --------------------------------------------------
const popRng = new Rng(7);
const pop = [];
for (let i = 0; i < POP; i++) pop.push({
  id: i, skill: Math.round(popRng.next() * 100) / 100,
  style: [25, 50, 100, 200, 500, 1000, 2000][Math.floor(popRng.next() * 7)],
  net: 0, wag: 0, games: 0, wins: 0,
});

// ---- run the season ---------------------------------------------------------
const casino = new Casino(SEED);
const policy = makePolicy(casino.rng);
let insaneCount = 0, bestEver = 0, keepFloors = [], posEntries = 0, totEntries = 0;
const sampleRng = new Rng(99);

for (let game = 0; game < GAMES; game++) {
  const n = 36 + Math.floor(sampleRng.next() * 13);
  const idxs = new Set(); while (idxs.size < n) idxs.add(sampleRng.int(POP));
  const chosen = [...idxs];
  const roster = chosen.map((pid, i) => ({
    id: pid, skill: pop[pid].skill, gross: pop[pid].style,
    joinInstance: i < 14 ? 0 : (sampleRng.next() < 0.5 ? 0 : 1 + sampleRng.int(2)),
  }));
  // reset per-game transient flags
  for (const r of roster) r._in = false;
  const res = casino.runGame(roster, policy);
  if (res.insane) insaneCount++;

  // per-game stats
  let worstRatio = 0;
  for (const r of roster) {
    const payout = res.payouts.get(r.id) || 0;
    const net = payout - r.gross;
    pop[r.id].net += net; pop[r.id].wag += r.gross; pop[r.id].games++; pop[r.id].wins += net > 0 ? 1 : 0;
    bestEver = Math.max(bestEver, net);
    worstRatio = Math.min(worstRatio, net / r.gross);
    totEntries++; if (net > 0) posEntries++;
  }
  keepFloors.push(100 * (1 + worstRatio));
}

// ---- report -----------------------------------------------------------------
const active = pop.filter(p => p.wag > 0);
const roi = p => p.net / p.wag * 100;
active.sort((a, b) => a.skill - b.skill);
const q = Math.floor(active.length / 4);
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const loROI = mean(active.slice(0, q).map(roi));
const hiROI = mean(active.slice(-q).map(roi));
const sk = active.map(p => p.skill), rs = active.map(roi);
const ms = mean(sk), mr = mean(rs);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const corr = mean(sk.map((s, i) => (s - ms) * (rs[i] - mr))) / (sd(sk) * sd(rs));

const pass = (c) => c ? "PASS ✓" : "FAIL ✗";
console.log(`=== REFERENCE ENGINE — ${GAMES} games, ${POP} traders ===\n`);
console.log(`[1] money invariant     max error = ${casino.invariantMaxErr.toExponential(2)}   ${pass(casino.invariantMaxErr < 1e-6)}`);
console.log(`[2] soft-landing floor  avg worst-case keeps ${mean(keepFloors).toFixed(0)}% of stake   ${pass(mean(keepFloors) > 30)}`);
console.log(`[3] house profit        $${casino.houseProfit.toFixed(0)} on $${casino.volume.toFixed(0)} volume = ${(casino.houseProfit/casino.volume*100).toFixed(1)}%   ${pass(Math.abs(casino.houseProfit/casino.volume-0.02)<0.002)}`);
console.log(`[4] skill edge          low-skill ROI ${loROI.toFixed(1)}%  ->  high-skill ROI ${hiROI.toFixed(1)}%   (corr ${corr.toFixed(2)})   ${pass(hiROI > loROI)}`);
console.log(`\nDEGEN: ${(posEntries/totEntries*100).toFixed(0)}% of entries net positive | biggest single win $${bestEver.toFixed(0)} | insane rounds ${insaneCount} | jackpot pool $${casino.jackpotPool.toFixed(0)}`);
const top = active.reduce((a, b) => b.net > a.net ? b : a);
console.log(`TOP TRADER: skill ${top.skill}, ${top.games} games, ${top.wins} wins, net $${top.net.toFixed(0)}`);
