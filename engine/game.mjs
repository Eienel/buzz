// Last Circle Standing — reference engine (Spec v1.0)
// Pure state machine. Each public method maps 1:1 to a planned on-chain instruction.
// No agent logic here (that lives in the test harness / client). The engine only
// enforces rules and money conservation.

export const PARAMS = {
  RAKE: 0.04, HOUSE_CUT: 0.50,         // 4% rake, half kept as house profit
  R_LO: 0.55, R_HI: 0.80,             // refund floor/ceiling
  KAPPA: 0.15, SIGMA: 0.50,           // creator cut, skill-pool fraction
  EPS: 0.15, INSANE_PROB: 0.02,       // fate-strike prob, insane-round prob
  MIN_STAKE: 10, MAX_STAKE: 2000,
};

// Deterministic RNG standing in for on-chain VRF (mulberry32). Seedable + replayable.
export class Rng {
  constructor(seed) { this.s = seed >>> 0; }
  next() { // [0,1)
    this.s |= 0; this.s = (this.s + 0x6D2B79F5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n); }
  pick(arr) { return arr[this.int(arr.length)]; }
}

// One game instance: lobby -> running -> settled.
export class Game {
  constructor(numCircles, rng, params = PARAMS) {
    this.P = params; this.rng = rng; this.numCircles = numCircles;
    this.circles = new Map();            // id -> { creator, alive }
    this.players = new Map();            // id -> { skill, stake, block, points, status }
    this.L = 0;                          // leftover pot
    this.t = 0; this.phase = "lobby";
    this.netDeposited = 0;               // sum of net (post-rake) stakes that entered
    this.prevCounts = {};
    for (let b = 0; b < numCircles; b++) this.circles.set(b, { creator: null, alive: true });
  }

  // --- lobby / join instructions -------------------------------------------
  // stakeNet = deposit already net of rake (casino computes rake). Returns nothing.
  _add(id, skill, stakeNet, block, isCreator) {
    if (this.players.has(id)) throw new Error("dup player " + id);
    this.players.set(id, { skill, stake: stakeNet, block, points: 0, status: "active" });
    if (isCreator) this.circles.get(block).creator = id;
    this.netDeposited += stakeNet;
  }
  lobbyCreate(id, skill, stakeNet, block) { this._add(id, skill, stakeNet, block, true); }
  lobbyJoin(id, skill, stakeNet, block)   { this._add(id, skill, stakeNet, block, false); }
  // join allowed only before the 50% lock (enforced by harness/runtime via canJoin)
  windowJoin(id, skill, stakeNet, block)  { this._add(id, skill, stakeNet, block, false); }

  begin() { this.phase = "running"; this.prevCounts = this.counts(); }
  aliveIds() { return [...this.circles].filter(([, c]) => c.alive).map(([b]) => b); }
  counts() { const c = {}; for (const b of this.aliveIds()) c[b] = 0;
    for (const p of this.players.values()) if (p.status === "active") c[p.block]++; return c; }
  halfMark() { return Math.max(1, Math.floor((this.numCircles - 1) / 2)); }
  canJoin() { return this.t < this.halfMark(); } // open-join window = first 50%

  // --- instance: apply simultaneous moves (already revealed) ----------------
  applyMoves(moveMap) { // moveMap: id -> targetCircle
    for (const [id, tgt] of Object.entries(moveMap)) {
      const p = this.players.get(+id); if (!p || p.status !== "active") continue;
      if (!this.circles.get(tgt)?.alive) continue;
      p.block = tgt;
    }
  }

  // --- instance resolve: score predictions, pick dead circle, refund --------
  // predictions: id -> predictedDeadCircle. Returns { dead, fate, r, eliminated:[ids] }.
  resolveInstance(predictions = {}) {
    this.t++;
    const alive = this.aliveIds();
    const cnt = this.counts();
    // death pick
    let fate = false, dead;
    if (this.rng.next() < this.P.EPS) { fate = true; dead = this.rng.pick(alive); }
    else {
      const min = Math.min(...alive.map(b => cnt[b]));
      let cand = alive.filter(b => cnt[b] === min);
      if (cand.length > 1) { // tie -> least money -> VRF
        const money = b => [...this.players.values()].filter(p => p.status==="active" && p.block===b)
                            .reduce((s,p)=>s+p.stake,0);
        const mm = Math.min(...cand.map(money)); cand = cand.filter(b => money(b) === mm);
      }
      dead = this.rng.pick(cand);
    }
    // score predictions for all active players (skill engine)
    for (const [id, guess] of Object.entries(predictions)) {
      const p = this.players.get(+id);
      if (p && p.status === "active" && guess === dead) p.points++;
    }
    // refund rate rises with survival time
    const T_MAX = this.numCircles + 4;
    const r = this.P.R_LO + (this.P.R_HI - this.P.R_LO) * Math.min(1, this.t / T_MAX);
    // kill circle, haircut members, mark them pending a land/cashout decision
    this.circles.get(dead).alive = false;
    const eliminated = [];
    for (const [id, p] of this.players) {
      if (p.status === "active" && p.block === dead) {
        this.L += p.stake * (1 - r); p.stake *= r; p.status = "pending"; eliminated.push(id);
      }
    }
    this.prevCounts = this.counts();
    return { dead, fate, r, eliminated };
  }

  // --- eliminated player's decision instructions ---------------------------
  land(id, targetCircle) { // re-enter a surviving circle, carry refunded stake
    const p = this.players.get(id);
    if (!p || p.status !== "pending") throw new Error("land: not pending " + id);
    if (!this.circles.get(targetCircle)?.alive) throw new Error("land: dead target");
    p.block = targetCircle; p.status = "active";
  }
  cashout(id) { // bank refund, leave game
    const p = this.players.get(id);
    if (!p || p.status !== "pending") throw new Error("cashout: not pending " + id);
    p.status = "cashed"; p.payout = p.stake; // recorded; collected at settle
  }
  // auto-resolve any still-pending after the decision window (default: land biggest)
  autoResolvePending() {
    const alive = this.aliveIds();
    for (const [id, p] of this.players) if (p.status === "pending") {
      if (alive.length === 0) { p.status = "cashed"; p.payout = p.stake; }
      else { const big = alive.reduce((a,b)=> this.counts()[b] >= this.counts()[a] ? b : a, alive[0]);
             this.land(id, big); }
    }
  }

  over() { return this.aliveIds().length <= 1; }

  // --- settle: distribute pot, return payouts map. injection = insane jackpot.
  settle(injection = 0) {
    this.phase = "settling";
    this.autoResolvePending();
    this.L += injection;
    const alive = this.aliveIds();
    const winB = alive[0];
    const survivors = [...this.players].filter(([, p]) => p.status === "active" && p.block === winB);
    const { KAPPA, SIGMA } = this.P;
    const creatorCut = KAPPA * this.L;
    const luckPool   = (1 - KAPPA) * this.L * (1 - SIGMA);
    const skillPool  = (1 - KAPPA) * this.L * SIGMA;

    const payouts = new Map();
    const add = (id, amt) => payouts.set(id, (payouts.get(id) || 0) + amt);

    // cashed-out players already locked their refund
    for (const [id, p] of this.players) if (p.status === "cashed") add(id, p.payout);

    // survivors: stake back + stake-weighted luck pool
    const totStake = survivors.reduce((s, [, p]) => s + p.stake, 0) || 1;
    for (const [id, p] of survivors) add(id, p.stake + luckPool * (p.stake / totStake));
    // creator of winning circle: extra cut
    const creator = this.circles.get(winB).creator;
    const creatorId = (creator != null && payouts.has(creator)) ? creator
                      : survivors.reduce((a,[id,p]) => p.stake > this.players.get(a).stake ? id : a, survivors[0]?.[0]);
    if (creatorId != null) add(creatorId, creatorCut);

    // skill pool: split by points across ALL players who played
    const totPts = [...this.players.values()].reduce((s, p) => s + p.points, 0);
    if (totPts > 0) {
      for (const [id, p] of this.players) if (p.points) add(id, skillPool * (p.points / totPts));
    } else {
      add(creatorId, skillPool); // degenerate: nobody predicted — give to creator
    }

    this.phase = "closed";
    this._lastL = this.L;
    return payouts;
  }
}

// Casino: persistent house profit + jackpot pool, runs many games, splits rake,
// rolls the insane round, and ENFORCES the global money invariant each game.
export class Casino {
  constructor(seed, params = PARAMS) {
    this.P = params; this.rng = new Rng(seed);
    this.houseProfit = 0; this.jackpotPool = 0; this.volume = 0;
    this.invariantMaxErr = 0;
  }
  // roster: [{id, skill, gross, joinInstance(0=lobby)}]. policy: agent decision fns.
  runGame(roster, policy) {
    const numCircles = this.rng.next() < 0.5 ? 6 : 12;
    const g = new Game(numCircles, this.rng, this.P);

    // --- deposits + rake split (lobby creators first to open all circles) ---
    let grossTotal = 0, rakeJackpotThisGame = 0;
    const deposit = (pl) => {
      const rake = pl.gross * this.P.RAKE, net = pl.gross - rake;
      this.houseProfit += rake * this.P.HOUSE_CUT;
      rakeJackpotThisGame += rake * (1 - this.P.HOUSE_CUT);
      grossTotal += pl.gross; this.volume += pl.gross;
      return net;
    };
    const lobby = roster.filter(p => p.joinInstance === 0);
    const creators = lobby.slice(0, numCircles);
    const lobbyJoiners = lobby.slice(numCircles);
    creators.forEach((p, b) => g.lobbyCreate(p.id, p.skill, deposit(p), b));
    for (const p of lobbyJoiners) g.lobbyJoin(p.id, p.skill, deposit(p), policy.lobbyTarget(g, p));
    g.begin();

    const laterJoiners = roster.filter(p => p.joinInstance > 0);

    // --- instance loop ------------------------------------------------------
    while (!g.over()) {
      // window joins (new outside wallets) only before 50% lock
      for (const p of laterJoiners) if (p.joinInstance === g.t + 1 && !g._joined && g.canJoin()) {
        if (!p._in) { g.windowJoin(p.id, p.skill, deposit(p), policy.lobbyTarget(g, p)); p._in = true; }
      }
      g.applyMoves(policy.moves(g));
      const predictions = policy.predictions(g);
      const { eliminated } = g.resolveInstance(predictions);
      for (const id of eliminated) {
        const d = policy.onDeath(g, id);     // {action:'land'|'cashout', target}
        if (d.action === "cashout") g.cashout(id); else g.land(id, d.target);
      }
    }

    // --- insane round (post-lock VRF roll, pays out existing pool) ----------
    const insane = this.rng.next() < this.P.INSANE_PROB;
    const injection = insane ? this.jackpotPool : 0;
    const poolBefore = this.jackpotPool;

    const payouts = g.settle(injection);

    // pool bookkeeping: paid out if insane, then this game's contribution accrues
    if (insane) this.jackpotPool = 0;
    this.jackpotPool += rakeJackpotThisGame;
    const poolAfter = this.jackpotPool;

    // --- INVARIANT: deposits == payouts + houseProfitΔ + Δpool --------------
    const paid = [...payouts.values()].reduce((s, v) => s + v, 0);
    const houseDelta = grossTotal * this.P.RAKE * this.P.HOUSE_CUT;
    const err = Math.abs(grossTotal - (paid + houseDelta + (poolAfter - poolBefore)));
    this.invariantMaxErr = Math.max(this.invariantMaxErr, err);
    if (err > 1e-6) throw new Error(`INVARIANT VIOLATION: err=${err} game circles=${numCircles}`);

    return { numCircles, payouts, insane, injection, L: g._lastL, players: g.players };
  }
}
