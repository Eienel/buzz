// BUZZ server: serves the static site and a cached game-state API.
//
// Why this exists: every spectator polling getProgramAccounts directly rate-limits
// the public RPC (the 429s we hit on devnet). One poller here, cached, means a
// thousand viewers cost one RPC subscription instead of a thousand.
//
//   PORT=3000 RPC=https://api.devnet.solana.com node server/index.mjs
//
// Set RUN_SWARM=1 to also run the agent swarm in this process.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import { makeArena, PRICE, challenge, registerAgent, authed, agentName } from "./arena-api.mjs";
import { makeAutoplay } from "./autoplay.mjs";
import { makeLimiter, LIMITS } from "./limits.mjs";
import { makeCranker } from "./cranker.mjs";
import { makeScheduler } from "./scheduler.mjs";
import { nameFor, houseWallets } from "./names.mjs";
import { verifyPayment } from "./x402.mjs";
import { loadRelayer, startDrain } from "./relayer.mjs";
import { DATA_DIR } from "./keypair.mjs";

const ROOT = fileURLToPath(new URL("../app/", import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID = process.env.PROGRAM_ID ?? "4TNbztSMd3zxG57M25y8WhpcKrQMJQVYEK6EnnkQy1Hw";
const POLL_MS = Number(process.env.POLL_MS ?? 5000);
const USDC_DEFAULT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // devnet USDC

const connection = new Connection(RPC, "confirmed");
const PID = new PublicKey(PROGRAM_ID);

// ---- account decoding (manual borsh; avoids pulling anchor into the server) --
const DISC = { game: [27,90,166,125,74,100,121,18], circle: [27,59,8,117,62,199,222,252],
               player: [205,222,112,7,165,155,206,218] };
const u8=(d,o)=>d[o], u16=(d,o)=>d[o]|d[o+1]<<8, u32=(d,o)=>(d[o]|d[o+1]<<8|d[o+2]<<16|d[o+3]<<24)>>>0;
const u64=(d,o)=>{let n=0n;for(let i=7;i>=0;i--)n=n<<8n|BigInt(d[o+i]);return n};
const eq=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const b58=(()=>{const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return (bytes)=>{let n=0n;for(const b of bytes)n=n<<8n|BigInt(b);let s="";
    while(n>0n){s=A[Number(n%58n)]+s;n/=58n}
    for(const b of bytes){if(b===0)s="1"+s;else break}return s||"1"};})();

function decodeGame(d){let o=8;const g={};
  g.gameId=String(u64(d,o));o+=8;o+=32;g.status=u8(d,o);o+=1;g.numCircles=u8(d,o);o+=1;
  g.lockInstance=u16(d,o);o+=2;g.instance=u16(d,o);o+=2;g.phase=u8(d,o);o+=1;
  g.phaseEndsAt=Number(u64(d,o));o+=8;g.instanceSeconds=u32(d,o);o+=4;
  g.doomed=u8(d,o);o+=1;g.circleCount=u8(d,o);o+=1;g.aliveCircles=u8(d,o);o+=1;
  g.players=u32(d,o);o+=4;g.leftover=String(u64(d,o));o+=8;g.fees=String(u64(d,o));o+=8;
  g.deposited=String(u64(d,o));o+=8;g.points=String(u64(d,o));o+=8;
  o+=16;                                   // entropy_slot + insane_entropy_slot
  // Three Game layouts are live on devnet: pre-multi-mint (no stake_mint),
  // pre-fee-snapshot (no fee_bps), and current. Decode by size rather than
  // assuming the newest, or every older account throws the poller off.
  // Games written before the multi-mint upgrade cannot be deserialized by the
  // current program at all: they are stranded, not merely old. Flag them so the
  // cranker stops retrying them forever and the public board stops showing them
  // as live games that never advance.
  g.legacy = d.length < 170;
  if(d.length>=166){
    g.createdAt=Number(u64(d,o));o+=8;
    g.stakeMint=b58(d.slice(o,o+32));o+=32; // one mint per game; the pot never mixes
    if(d.length>=170){ g.feeBps=u16(d,o);o+=2; }
    o+=1;o+=1;o+=1;                         // require_vrf, creator_cut_paid, insane_rolled
    g.insane=!!u8(d,o);
  }
  return g;}

function decodeCircle(d){let o=8;const c={};
  c.game=b58(d.slice(o,o+32));o+=32;c.id=u8(d,o);o+=1;
  c.creator=b58(d.slice(o,o+32));o+=32;
  c.members=u32(d,o);o+=4;c.stake=String(u64(d,o));o+=8;c.alive=!!u8(d,o);o+=1;
  c.refundBps=u16(d,o);return c;}

function decodePlayer(d){let o=8;const p={};
  p.game=b58(d.slice(o,o+32));o+=32;p.owner=b58(d.slice(o,o+32));o+=32;
  // Same story as Game: players staked before the delegate field exist without
  // one, and every field after would be read 32 bytes off if we assumed it.
  if(d.length>=188){ p.delegate=b58(d.slice(o,o+32));o+=32; }
  else { p.delegate=p.owner; }
  p.stake=String(u64(d,o));o+=8;p.comb=u8(d,o);o+=1;
  p.points=u32(d,o);o+=4;p.status=u8(d,o);return p;}

// ---- history: what happened, kept past the reaper ---------------------------
// Finished games get closed for rent, taking their accounts with them. A
// spectator arriving after that would see an arena with no past, so the poller
// snapshots each game the first time it reads as decided, and that snapshot is
// the record from then on.
// $BUZZ is a mainnet token; the arena is on devnet. The two are unrelated on
// chain and only meet here, on the page.
// The two assets the arena stakes, each with its own treasury PDA.
const TREASURY_MINTS = { BUZZ: "7yPdd9WxE3zwYQWK5a6bobwfDpQpzst6J7j5tVDPw1q8",
                         ANSEM: "BxrMzNFPmftcNgn5v4PuUoXAiezZTN7edjXFRqJTusuA" };
const BUZZ_MINT = process.env.BUZZ_MINT ?? "DoTMzBpSRPEwaycrSUzgSaDEs42PaiQVvYXAmLkcHr5X";
const CLAW_URL = `https://clawpump.tech/tokens/${BUZZ_MINT}`;
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS ?? 30_000);
let tokenCache = { at: 0, data: null };

const HISTORY_FILE = join(DATA_DIR, "history.json");   // DATA_DIR is a volume in production
const HISTORY_MAX = Number(process.env.HISTORY_MAX ?? 200);
let history = [];
try { history = JSON.parse(readFileSync(HISTORY_FILE, "utf8")); } catch {}
const recorded = new Set(history.map((h) => h.gameId));
let historyDirty = false;

/**
 * Best available end time for a decided game, in ms.
 *
 * phase_ends_at is the deadline of the last phase the game ran, which is the
 * closest thing on chain to an end time. It is sanity-bounded: a game cannot
 * have ended before it was created (game_id is its creation time in ms) and
 * cannot end in the future, so a nonsense value falls back to now.
 */
function endedAtOf(g){
  const now = Date.now();
  const created = Number(g.gameId);
  const ended = Number(g.phaseEndsAt) * 1000;
  if(!Number.isFinite(ended) || ended <= 0) return now;
  if(ended < created || ended > now + 60_000) return now;
  return ended;
}

function record(g, players){
  if(recorded.has(g.gameId)) return;
  const winning = (g.combs ?? []).find((c) => c.alive);
  if(!winning) return;                       // decided means exactly one comb left
  const mine = players.filter((p) => p.game === g.pubkey);
  recorded.add(g.gameId);
  history.unshift({
    gameId: g.gameId,
    // When the game ended, not when we noticed. The poller records a game the
    // first time it reads as decided, so Date.now() dates a six-hour-old game
    // to this minute and a restart re-dates a whole backlog to the same one.
    // phase_ends_at is the chain's own clock for the last phase that ran.
    endedAt: endedAtOf(g),
    winningComb: winning.id,
    stakeMint: g.stakeMint,
    creator: winning.creator,
    arena: g.numCircles,
    players: Math.max(g.players, mine.length),
    pot: g.deposited,
    // Whether the jackpot roll fired for this game. Without it the record
    // cannot answer "has the jackpot ever paid", and reading g.insane off a
    // history entry silently returns undefined, which counts as no.
    insane: !!g.insane,
    // True when the rent reaper closed the player accounts before we saw the
    // game decided. The winner is still right (it comes off the game itself);
    // the per-agent columns are simply gone, and saying so beats printing zero.
    partial: mine.length === 0,
    // Skill is the interesting column: it says who read the board, not who
    // happened to sit in the comb that lived.
    // Everyone who actually sat down. Without this the leaderboard can only
    // count winners, and games-played collapses into wins.
    entrants: mine.map((p) => p.owner),
    survivors: mine.filter((p) => p.comb === winning.id).map((p) => p.owner),
    topSkill: mine.filter((p) => p.points > 0)
      .sort((a, b) => b.points - a.points).slice(0, 5)
      .map((p) => ({ agent: p.owner, points: p.points })),
  });
  history = history.slice(0, HISTORY_MAX);
  historyDirty = true;
}

/** Wins and skill points per agent, derived from the recorded games. */
const label = (wallet) => {
  const { name, house } = nameFor(wallet, agentName);
  return { agent: wallet, name, house };
};

function leaderboard(){
  const board = new Map();
  const bump = (k, f) => {
    const e = board.get(k) ?? { agent: k, games: 0, wins: 0, points: 0, ranked: 0, rWins: 0, rPoints: 0 };
    f(e); board.set(k, e);
  };
  for(const h of history){
    // Only games that recorded their full field can produce a rate. Older
    // records remember the winner and the top scorers and nobody else, so
    // deriving a rate from them would read every agent as near-perfect.
    const field = h.entrants;
    const survivors = h.survivors ?? [], skill = h.topSkill ?? [];
    if(field) for(const p of field) bump(p, (e) => { e.games++; e.ranked++; });
    for(const w of survivors) bump(w, (e) => { e.wins++; if(field) e.rWins++; });
    for(const t of skill) bump(t.agent, (e) => { e.points += t.points; if(field) e.rPoints += t.points; });
  }
  return [...board.values()]
    .map((e) => ({
      ...e,
      ...label(e.agent),
      // null, not zero: an agent with no ranked games has no rate, and a zero
      // would sort and read as a bad one.
      winRate: e.ranked ? e.rWins / e.ranked : null,
      // Points across agents that played different numbers of games are not
      // comparable. This is the column that ranks reasoning against heuristics.
      ppg: e.ranked ? e.rPoints / e.ranked : null,
    }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins)   // skill first: it is what the season pays on
    .slice(0, 20);
}

// ---- poller: one RPC scan, cached for every viewer ---------------------------
let snapshot = { ok:false, updatedAt:0, games:[], error:"starting" };

async function poll(){
  try{
    const accs = await connection.getProgramAccounts(PID, { encoding:"base64" });
    const games=[], circles=[], players=[];
    for(const {pubkey, account} of accs){
      const d = account.data;
      const disc = Array.from(d.slice(0,8));
      if(eq(disc,DISC.game)) games.push({ pubkey: pubkey.toBase58(), ...decodeGame(d) });
      else if(eq(disc,DISC.circle)) circles.push(decodeCircle(d));
      else if(eq(disc,DISC.player)) players.push(decodePlayer(d));
    }
    for(const g of games) g.combs = circles.filter(c=>c.game===g.pubkey).sort((a,b)=>a.id-b.id);
    games.sort((a,b)=>Number(BigInt(b.gameId)-BigInt(a.gameId)));
    for(const g of games) if(g.status>=2) record(g, players);
    if(historyDirty){
      historyDirty = false;
      try{ writeFileSync(HISTORY_FILE, JSON.stringify(history)); }
      catch(e){ console.log("history write failed:", e.message); }
    }
    snapshot = { ok:true, updatedAt:Date.now(), programId:PROGRAM_ID, cluster:RPC.includes("devnet")?"devnet":"mainnet",
                 live:games.filter(g=>(g.status===0||g.status===1) && !g.legacy), finished:history.length,
                 recent: history.slice(0, 10) };
    autoplay.tick(snapshot);          // walk easy-mode intents through the phases
    limiter.reconcile(games.filter(g=>g.status===0||g.status===1).map(g=>g.gameId));
    cranker?.once(snapshot);
    scheduler?.once(snapshot);
    pollRelayer();
  }catch(e){
    snapshot = { ...snapshot, ok:false, error:String(e.message).slice(0,120), updatedAt:Date.now() };
  }
}
poll(); setInterval(poll, POLL_MS);

// ---- static + api ------------------------------------------------------------
const MIME = {".html":"text/html; charset=utf-8",".css":"text/css",".js":"text/javascript",
  ".png":"image/png",".svg":"image/svg+xml",".json":"application/json",".ico":"image/x-icon"};

// ---- agent action queue -----------------------------------------------------
// Actions land here from the x402 surface and a relayer drains them on chain.
// Kept in memory deliberately: a queue that survives a restart would imply we
// owe an action we may no longer be able to honour.
let actionSeq = 0;
const actions = new Map();
const enqueue = (a) => {
  const id = `a${++actionSeq}`;
  actions.set(id, { ...a, id, state: "queued", at: Date.now() });
  return id;
};
const queuedCount = () => {
  let n = 0;
  for (const a of actions.values()) if (a.state === "queued") n++;
  return n;
};
// Finished actions were kept forever, which is a slow leak on a long-running
// service. An hour is long enough for any agent to have polled its result.
setInterval(() => {
  const cut = Date.now() - 3_600_000;
  for (const [id, a] of actions) {
    if (a.state !== "queued" && a.state !== "relaying" && (a.settledAt ?? a.at) < cut) actions.delete(id);
  }
}, 300_000);

const limiter = makeLimiter();
// Nothing was advancing games this process did not create, so a restart left
// them stalled with players inside. Every crank is permissionless; this just
// uses that.
let cranker = null;
let scheduler = null;
// The relayer's own balance, refreshed alongside the state poll. Joins stop
// before it runs dry rather than after, because a game it cannot settle is
// worse than a seat it refused.
let relayerSol = null;
async function pollRelayer(){
  if(!relayer) return;
  try { relayerSol = (await connection.getBalance(relayer.pubkey)) / 1e9; }
  catch { /* leave the last reading */ }
}
const arena = makeArena({ snapshot: () => snapshot, enqueue });

// Easy mode: agents declare an intent, this walks it through commit and reveal
// as the poller watches the phases turn.
const gamePdaFor = (gameId) => {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(gameId));
  return PublicKey.findProgramAddressSync([Buffer.from("game"), id], PID)[0].toBase58();
};
const autoplay = makeAutoplay({ enqueue, gamePdaFor });

// The relayer signs for agents that cannot. Without RELAYER_KEYPAIR the arena
// still reads and quotes, but paid actions would queue forever, so we refuse
// them up front instead of taking money for work we cannot do.
const relayer = loadRelayer(connection);
startDrain(relayer, actions);
if (relayer) cranker = makeCranker({ program: relayer.program, payer: relayer.kp });
// Off by default: turning it on while the swarm still creates its own games
// would double the arena rather than replace it.
if (relayer && process.env.RUN_SCHEDULER === "1") {
  scheduler = makeScheduler({
    program: relayer.program, payer: relayer.kp,
    assets: [{ name: "BUZZ", mint: new PublicKey(TREASURY_MINTS.BUZZ),
               tokenProgram: new PublicKey(process.env.BUZZ_TOKEN_PROGRAM
                 ?? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") }],
  });
  console.log("scheduler on");
}
if (relayer) relayer.ready().then((r) =>
  console.log(`relayer ${r.pubkey} ${r.allowed ? "allowed" : "NOT ON THE ALLOW-LIST: run agents/allow-relayer.mjs"}`));
else console.log("no RELAYER_KEYPAIR: agent actions disabled");

const ROUTES = new Set(["join", "move", "predict", "revealMove", "revealPrediction", "settle"]);
const routeName = (seg) => seg.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const readBody = (req) => new Promise((resolve) => {
  let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
});
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json",
    "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};

createServer(async (req,res)=>{
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);

  // ---- agent surface -------------------------------------------------------
  if(p === "/api/agent/lobbies"){
    const r = arena.lobbies(); return send(res, r.status, r.body);
  }
  if(p.startsWith("/api/agent/action/")){
    const a = actions.get(p.split("/").pop());
    return a ? send(res,200,a) : send(res,404,{error:"unknown action"});
  }
  if(p === "/api/agent/register"){
    const r = registerAgent(await readBody(req));
    return send(res, r.status, r.body);
  }
  // Easy mode. One call says what to do; commit, reveal and timing are handled.
  if(p === "/api/agent/play"){
    if(!relayer) return send(res, 503, { error: "arena is read-only: no relayer configured" });
    const body = await readBody(req);
    const a = authed(body);
    if(!a.ok) return send(res, 401, { error: a.error });
    const { gameId, move, predict } = body;
    if(gameId == null) return send(res, 400, { error: "gameId is required" });
    if(move == null && predict == null) return send(res, 400, { error: "give a move, a predict, or both" });
    for(const [k,v] of [["move",move],["predict",predict]]){
      if(v != null && (!Number.isInteger(v) || v < 0 || v > 11))
        return send(res, 400, { error: `${k} must be a comb id 0-11` });
    }
    const gate = limiter.check("play", body.agentWallet, gameId, { queued: queuedCount(), relayerSol });
    if(!gate.ok) return send(res, 429, { error: gate.error, retryAfter: gate.retryAfter ?? null });
    const plan = autoplay.plan({ agentWallet: body.agentWallet, gameId, move, predict });
    return send(res, 202, { accepted: true, gameId, move: plan.move, predict: plan.predict,
      note: "committed and revealed for you each instance until you change it or the game ends" });
  }
  if(p === "/api/agent/relayer"){
    if(!relayer) return send(res, 503, { error: "no relayer configured" });
    return send(res, 200, { ...await relayer.ready(), sol: relayerSol,
                            queued: queuedCount(), limits: LIMITS, ...limiter.stats() });
  }
  if(p.startsWith("/api/agent/") && ROUTES.has(routeName(p.split("/").pop()))){
    const kind = routeName(p.split("/").pop());
    if(!relayer) return send(res, 503, { error: "arena is read-only: no relayer configured" });
    const price = PRICE[kind] ?? 0;
    const paid = req.headers["x-payment"];        // x402 payment proof
    if(price > 0 && !paid){
      return challenge(res, `https://${req.headers.host}${p}`, price,
        `BUZZ arena: ${kind}`);
    }
    const body = await readBody(req);
    // Registration binds the wallet to whoever claimed it. Payment binds it
    // economically on top, but devnet play is free, so without this anyone
    // could act as anyone else's wallet and wreck their record.
    const who = authed(body);
    if(!who.ok) return send(res, 401, { error: who.error });
    const gate = limiter.check(kind, body.agentWallet, body.gameId,
      { queued: queuedCount(), relayerSol });
    if(!gate.ok) return send(res, 429, { error: gate.error, retryAfter: gate.retryAfter ?? null });
    if(price > 0){
      const v = await verifyPayment(connection, paid, { usd: price,
        payTo: process.env.ARENA_PAY_TO, usdcMint: process.env.USDC_MINT ?? USDC_DEFAULT,
        agentWallet: body.agentWallet });
      if(!v.ok) return send(res, 402, { error: v.error });
      body.paymentSignature = v.signature;
    }
    const r = arena[kind](body);
    if(r.status === 202) r.body.paymentSignature = body.paymentSignature ?? null;
    return send(res, r.status, r.body);
  }

  // the card desk: its own record, kept beside the arena rather than inside it
  if(p === "/api/tcg"){
    try{
      const [{ scorecard, all }, { mode }] = await Promise.all([
        import("../tcg/store.mjs"), import("../tcg/client.mjs")]);
      return send(res, 200, { ok:true, mode: mode(), scorecard: scorecard(),
        picks: all().slice(0, 60),
        spentUsdc: Number(process.env.TCG_SPENT_USDC ?? 0),
        // The vault starts empty on purpose. It fills from fees earned AFTER the
        // desk opened, not from what the token made before it existed, so the
        // bar only ever measures what this actually caused. The split is stated
        // rather than implied: most of it buys cards, the rest is ours.
        ...(() => {
          const since = Number(process.env.TCG_FEES_SINCE_USD ?? 0);
          const bps = Number(process.env.TCG_VAULT_BPS ?? 7500);
          return { feesSinceUsd: since, vaultBps: bps,
                   fundUsd: +(since * bps / 10000).toFixed(2),
                   fundGoalUsd: Number(process.env.TCG_FUND_GOAL_USD ?? 40) };
        })() });
    }catch(e){
      // the desk is optional; the arena must not fall over because it is absent
      return send(res, 200, { ok:false, mode:"none", scorecard:{picks:0}, picks:[],
                              error:String(e.message).slice(0,120) });
    }
  }

  // ---- $BUZZ market data ---------------------------------------------------
  // Proxied rather than fetched from the page: the browser would hit CORS and
  // every viewer would be a separate call against someone else's rate limit.
  // One cached read here serves the whole arena.
  if(p === "/api/token"){
    const now = Date.now();
    if(!tokenCache.at || now - tokenCache.at > TOKEN_TTL_MS){
      try{
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${BUZZ_MINT}`,
                              { signal: AbortSignal.timeout(6000) });
        const pair = (await r.json())?.pairs?.[0];
        // Keep the last good reading on a bad one. A ticker that blanks out
        // every time an upstream hiccups reads as broken rather than as quiet.
        if(pair) tokenCache = { at: now, data: {
          mint: BUZZ_MINT, priceUsd: Number(pair.priceUsd), change24h: pair.priceChange?.h24 ?? null,
          volume24h: pair.volume?.h24 ?? null, liquidity: pair.liquidity?.usd ?? null,
          mcap: pair.marketCap ?? pair.fdv ?? null, dex: pair.url, claw: CLAW_URL,
        }};
        else tokenCache.at = now;
      }catch{ tokenCache.at = now; }
    }
    return tokenCache.data
      ? send(res, 200, { ...tokenCache.data, asOf: tokenCache.at })
      : send(res, 503, { error: "no market data yet" });
  }

  // ---- treasury buckets -----------------------------------------------------
  // What the house cut has accrued, per asset. Deliberately reported as accrued
  // rather than spent: converting to SOL and buying back happen off chain and
  // have not run, so any "spent" figure here would be invented.
  // What is due next, so the board can say it rather than a lobby appearing
  // from nowhere.
  if(p === "/api/schedule"){
    return send(res, 200, scheduler
      ? { on: true, upcoming: scheduler.upcoming() }
      : { on: false, upcoming: [] });
  }

  if(p === "/api/treasury"){
    const out = [];
    for(const [symbol, mint] of Object.entries(TREASURY_MINTS)){
      try{
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from("treasury"), new PublicKey(mint).toBuffer()], PID);
        const acc = await connection.getAccountInfo(pda);
        if(!acc || acc.data.length < 104) continue;
        const d = acc.data;
        let o = 8 + 32;                     // discriminator + authority
        const house = u64(d,o); o += 8;
        const jackpot = u64(d,o); o += 8;
        o += 2;                             // vault_bump, bump
        const toSol = u64(d,o); o += 8;
        const burn = u64(d,o); o += 8;
        const lbAccruing = u64(d,o); o += 8;
        const lbClaimable = u64(d,o); o += 8;
        o += 8 + 8;                       // pts_accruing, pts_claimable
        const season = d[o] | d[o+1] << 8;
        const n = (v) => Number(v) / 1e6;
        out.push({ symbol, mint, season, house:n(house), jackpot:n(jackpot), toSol:n(toSol),
                   burn:n(burn), lbAccruing:n(lbAccruing), lbClaimable:n(lbClaimable) });
      }catch{}
    }
    return send(res, 200, { cluster: RPC.includes("devnet") ? "devnet" : "mainnet", accrued: out,
      note: "Accrued on chain. Conversion to SOL and buy-and-burn happen off chain and have not run on devnet." });
  }

  if(p === "/api/history"){
    // The board polls this every 15s, and a full page of records is ~120KB, so
    // the caller says how many it wants and gets `total` to know if asking for
    // more is worth it. Default stays small; the cap is what we actually retain.
    const want = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(want) && want > 0 ? Math.min(want, HISTORY_MAX) : 50;
    return send(res, 200, { games: history.slice(0, limit), total: history.length,
                            leaderboard: leaderboard(), houseAgents: houseWallets() });
  }
  if(p === "/api/state"){
    res.writeHead(200,{ "content-type":"application/json",
      "cache-control":"no-store", "access-control-allow-origin":"*" });
    return res.end(JSON.stringify(snapshot));
  }
  if(p === "/healthz"){
    res.writeHead(snapshot.ok?200:503,{ "content-type":"text/plain" });
    return res.end(snapshot.ok ? "ok" : "rpc: "+snapshot.error);
  }

  // home is the front door now; the long-form docs move to /docs
  if(p === "/")      p = "/home.html";
  if(p === "/docs")  p = "/index.html";
  if(p === "/arena") p = "/arena.html";
  if(p === "/play")  p = "/play.html";
  if(p === "/agents")p = "/agents.html";
  if(p === "/tcg")   p = "/tcg.html";
  // contain path traversal: resolve inside ROOT only
  const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if(!file.startsWith(ROOT) || !existsSync(file)){
    res.writeHead(404,{ "content-type":"text/plain" });
    return res.end("not found");
  }
  try{
    const body = await readFile(file);
    res.writeHead(200,{ "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": extname(file)===".html" ? "no-cache" : "public, max-age=3600" });
    res.end(body);
  }catch{
    res.writeHead(500,{ "content-type":"text/plain" }); res.end("read error");
  }
}).listen(PORT, ()=>console.log(`buzz server on :${PORT} (rpc ${RPC}, poll ${POLL_MS}ms)`));

// ---- optional: run the agent swarm alongside the web service -----------------
if(process.env.RUN_SWARM === "1"){
  const start = () => {
    console.log("[swarm] starting");
    const c = spawn("node", [fileURLToPath(new URL("../agents/swarm.mjs", import.meta.url))],
      { stdio:"inherit", env: process.env });
    c.on("exit", (code)=>{ console.log(`[swarm] exited ${code}, restarting in 20s`); setTimeout(start, 20000); });
  };
  start();
}
