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
import jsSha3 from "js-sha3";
import { Connection, PublicKey, SystemProgram, Transaction,
         sendAndConfirmTransaction } from "@solana/web3.js";
import { makeArena, PRICE, challenge, registerAgent, authed, agentName } from "./arena-api.mjs";
import { makeAutoplay } from "./autoplay.mjs";
import { makeLimiter, LIMITS } from "./limits.mjs";
import { loadKeypair } from "./keypair.mjs";
import { makeCranker } from "./cranker.mjs";
import { makeScheduler } from "./scheduler.mjs";
import { makeMarket } from "./market.mjs";
import { nameFor, houseWallets } from "./names.mjs";
import { verifyPayment } from "./x402.mjs";
import { loadRelayer, startDrain } from "./relayer.mjs";
import { DATA_DIR } from "./keypair.mjs";
import { makeConnection, surviveRateLimits } from "./rpc.mjs";

const { keccak_256 } = jsSha3;

const ROOT = fileURLToPath(new URL("../app/", import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID = process.env.PROGRAM_ID ?? "4TNbztSMd3zxG57M25y8WhpcKrQMJQVYEK6EnnkQy1Hw";
// 10s, not 5s. The poll is a whole-program getProgramAccounts, which is the
// single most expensive call the arena makes, and at 5s it ran 17,280 times a
// day. Instances are 60s long, so a board that refreshes twice a minute loses a
// viewer nothing and halves the bill.
const POLL_MS = Number(process.env.POLL_MS ?? 10_000);
const USDC_DEFAULT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // devnet USDC

// Falls back to public devnet when the primary rate-limits, so a spent quota
// degrades the arena instead of breaking it. See server/rpc.mjs.
const BOOTED_AT = Date.now();
const connection = makeConnection(RPC, { label: "rpc" });
// A 429 from inside the RPC client arrives as an unhandled rejection, and
// node kills the process on those. It took the whole arena down repeatedly.
surviveRateLimits("rpc");

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
// Drop what the bug above already wrote. An aborted lobby recorded as a game
// has a field too small to have ever started, and there is no way to repair
// the row because the game it claims to describe never happened.
{
  const before = history.length;
  history = history.filter((h) => (h.entrants?.length ?? h.players ?? 0) >= 4);
  if(history.length !== before){
    console.log(`[history] dropped ${before - history.length} aborted lobbies recorded as games`);
    // Written back now rather than on the next record(). Otherwise a quiet
    // arena keeps re-reading the wreckage from disk on every restart.
    try { writeFileSync(HISTORY_FILE, JSON.stringify(history)); }
    catch(e){ console.log("[history] could not rewrite:", e.message); }
  }
}
const recorded = new Set(history.map((h) => h.gameId));
const HISTORY_AT_BOOT = history.length;
// Proven by writing, not by checking a path. A mount that exists but is
// read-only fails in exactly the same way as one that is not there.
let HISTORY_WRITABLE = false;
try { writeFileSync(HISTORY_FILE, JSON.stringify(history)); HISTORY_WRITABLE = true; }
catch(e){ console.log(`[history] ${HISTORY_FILE} is not writable: ${e.message}`); }
console.log(`[history] ${HISTORY_AT_BOOT} records from ${HISTORY_FILE}` +
  `${HISTORY_WRITABLE ? "" : " (NOT WRITABLE)"}` +
  `${DATA_DIR.includes("/server") ? " (DATA_DIR unset: this is the container filesystem and a deploy will wipe it)" : ""}`);
let historyDirty = false;

/**
 * Best available end time for a decided game, in ms.
 *
 * phase_ends_at is the deadline of the last phase the game ran, which is the
 * closest thing on chain to an end time. It is sanity-bounded: a game cannot
 * have ended before it was created (game_id is its creation time in ms) and
 * cannot end in the future, so a nonsense value falls back to when the game
 * was created.
 */
function endedAtOf(g){
  const now = Date.now();
  const created = Number(g.gameId);
  const ended = Number(g.phaseEndsAt) * 1000;
  // Fall back to when the game was created, not to this minute. A game we
  // cannot date is old, and dating it "now" puts days-old wreckage at the top
  // of the board with every row reading the same age.
  const fallback = Number.isFinite(created) && created > 0 ? created : now;
  if(!Number.isFinite(ended) || ended <= 0) return fallback;
  if(ended < created || ended > now + 60_000) return fallback;
  return ended;
}

// GameStatus: Lobby 0, Running 1, Settling 2, Closed 3, Aborted 4.
// Only the middle two are games that were played to a decision.
const DECIDED = new Set([2, 3]);

function record(g, players){
  if(recorded.has(g.gameId)) return;
  // An aborted lobby is not a result. It reads like one from here (status is
  // past Running, and its combs are all still "alive" because none of them
  // ever died) so `status >= 2` swept every timed-out lobby into the history
  // as a finished game won by comb 0 with one player in it. The board filled
  // with days-old wreckage the moment a batch of them aged out.
  if(!DECIDED.has(g.status)) return;
  // A game cannot legally start below MIN_CIRCLES combs, so a smaller field is
  // a lobby that never ran, whatever status it ended up in.
  if((g.players ?? 0) < 4) return;
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
    // Who is actually playing each game, with the name and the record the
    // board already knows. A market on an agent is unsellable without this:
    // you cannot back something you cannot see, still less price it.
    const board = new Map(leaderboard().map((e) => [e.agent, e]));
    for(const g of games){
      g.agents = players.filter((p) => p.game === g.pubkey).map((p) => {
        const { name, house } = nameFor(p.owner, agentName);
        const rec = board.get(p.owner);
        return { owner: p.owner, name, house, comb: p.comb, stake: p.stake,
                 points: p.points ?? 0,
                 ranked: rec?.ranked ?? 0, winRate: rec?.winRate ?? null, ppg: rec?.ppg ?? null };
      }).sort((a, b) => (b.ppg ?? -1) - (a.ppg ?? -1));
    }
    games.sort((a,b)=>Number(BigInt(b.gameId)-BigInt(a.gameId)));
    for(const g of games) if(g.status>=2) record(g, players);
    if(historyDirty){
      historyDirty = false;
      try{ writeFileSync(HISTORY_FILE, JSON.stringify(history)); }
      catch(e){ console.log("history write failed:", e.message); }
    }
    snapshot = { ok:true, updatedAt:Date.now(), programId:PROGRAM_ID, cluster:RPC.includes("devnet")?"devnet":"mainnet",
                 live:games.filter(g=>(g.status===0||g.status===1) && !g.legacy), finished:history.length,
                 // Settled but not yet swept. Kept apart from `live` so the
                 // public board still means "being played", while the cranker
                 // can still see games that owe the treasury their rake.
                 settling:games.filter(g=>g.status===2 && !g.legacy && Number(g.fees||0)>0),
                 recent: history.slice(0, 10),
                 // Who is already sitting down, as "<game pubkey>:<owner>".
                 // Easy mode needs it to tell "this agent still has to join"
                 // from "this agent is seated and owes a commit", and those
                 // were indistinguishable, so it never joined anybody.
                 seats: new Set(players.map((p) => `${p.game}:${p.owner}`)),
                 // What is left in the tank. An arena with no games looks the
                 // same whether nobody is playing or the payer is empty, and
                 // those want opposite responses.
                 fuel };
    autoplay.tick(snapshot);          // walk easy-mode intents through the phases
    limiter.reconcile(games.filter(g=>g.status===0||g.status===1).map(g=>g.gameId));
    cranker?.once(snapshot);
    scheduler?.once(snapshot);
    book?.once(snapshot);
    pollRelayer().then(pollFuel).then(pollFloat);
  }catch(e){
    snapshot = { ...snapshot, ok:false, error:String(e.message).slice(0,120), updatedAt:Date.now() };
  }
}
poll(); setInterval(poll, POLL_MS);

/**
 * Crank on its own clock, without paying for a whole-program scan.
 *
 * The cranker used to ride the poll tick, which quietly made POLL_MS two
 * settings at once: how often the board refreshes, and how promptly a phase
 * advances. A game is about ten phase transitions, and each one waits for the
 * next tick, so raising the poll to save on reads stretched every game by
 * roughly half the interval times ten. Cheaper reads bought slower games.
 *
 * They are separate concerns, so they get separate clocks. The expensive scan
 * stays on POLL_MS because the board and the reaper genuinely need the whole
 * program. Cranking only needs the games currently being played and their
 * combs, which is a bounded handful: at sixteen live games that is about 112
 * accounts through getMultipleAccounts, against 10,743 through
 * getProgramAccounts.
 *
 * Deliberately best effort. It reuses the account list from the last full poll,
 * so a game that appeared since is simply cranked by the next full poll as it
 * always was, and any failure here leaves that backstop untouched. It never
 * writes `snapshot`: the board keeps showing what the last real poll saw,
 * because a partial view is a worse answer for a reader than a slightly old
 * complete one.
 */
const CRANK_MS = Number(process.env.CRANK_MS ?? 3000);
let fastBusy = false;

async function fastCrank(){
  if(fastBusy || !cranker) return;
  const live = (snapshot.live ?? []).filter(g => g.status === 1);
  if(!live.length) return;                    // nothing mid-game to advance
  fastBusy = true;
  try{
    // The games we are watching, plus their combs, and nothing else.
    // Comb addresses are derived, not remembered: decodeCircle keeps the
    // circle's fields but not its own key, and a PDA is cheaper to recompute
    // than to carry around.
    const keys = [];
    for(const g of live){
      const game = new PublicKey(g.pubkey);
      keys.push(game);
      for(const c of (g.combs ?? []))
        keys.push(PublicKey.findProgramAddressSync(
          [Buffer.from("circle"), game.toBuffer(), Buffer.from([c.id])], PID)[0]);
    }
    if(keys.length > 100) keys.length = 100;   // one request, no pagination
    const accs = await connection.getMultipleAccountsInfo(keys);
    const games = [], circles = [];
    accs.forEach((acc, i) => {
      if(!acc) return;
      const d = acc.data, disc = Array.from(d.slice(0,8));
      if(eq(disc, DISC.game)) games.push({ pubkey: keys[i].toBase58(), ...decodeGame(d) });
      else if(eq(disc, DISC.circle)) circles.push(decodeCircle(d));
    });
    if(!games.length) return;
    for(const g of games) g.combs = circles.filter(c => c.game === g.pubkey).sort((a,b)=>a.id-b.id);
    // settling is left empty on purpose: sweeping a finished game's rake is
    // not latency sensitive and belongs on the full poll.
    await cranker.once({ live: games, settling: [] });
  }catch(e){
    // A failed fast crank is not an incident. The full poll still cranks.
  }finally{ fastBusy = false; }
}
setInterval(fastCrank, CRANK_MS).unref?.();


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
let book = null;
// Small and unbounded is fine: one entry per game id the arena has asked about,
// and the arena only asks about games that are on the board.
const marketCache = new Map();
let bettorCache = { at: 0, body: null };
const BETTORS_TTL_MS = Number(process.env.BETTORS_TTL_MS ?? 20_000);
// A ceiling on a single bet, in stake-token units. The bet is staked in the
// game's SPL token, not in SOL: SOL only ever pays transaction fees here.
//
// Devnet tokens are valueless, so this is not about risk. It is that a
// parimutuel pool IS the odds, so one bet ten times everyone else's owns the
// pool outright and every other price in that game becomes noise. Agents stake
// 10 units a seat, so 100 is ten seats' worth: enough to matter, not enough to
// be the whole book.
const BET_MAX = Number(process.env.BET_MAX ?? 100);
// The relayer funds every bet on this path, so a bet costs the house rather
// than the bettor. That is what makes it playable with no wallet and no devnet
// BUZZ, and it is also what makes it farmable: nothing stops one person
// minting browser identities and backing every agent in every game. These caps
// do not fix that, they bound it. The real fix is skin in the game.
const BET_PER_IP_HOUR = Number(process.env.BET_PER_IP_HOUR ?? 40);
const BET_PER_ID_HOUR = Number(process.env.BET_PER_ID_HOUR ?? 20);
const betHits = new Map();                     // key -> array of timestamps
/**
 * Peek and record are separate on purpose.
 *
 * They used to be one call that counted the attempt. A faucet request that
 * died on an RPC 429 therefore spent the caller's one-per-wallet allowance and
 * locked them out of the only way to get a stake, permanently, over a failure
 * that was ours. An attempt is not a grant: only what actually landed counts.
 */
function overLimit(key, limit){
  const cut = Date.now() - 3600_000;
  const hits = (betHits.get(key) ?? []).filter((t) => t > cut);
  betHits.set(key, hits);
  return hits.length >= limit;
}
function recordHit(key){
  const hits = betHits.get(key) ?? [];
  hits.push(Date.now());
  betHits.set(key, hits);
}
// Bounded: without this the map grows one entry per identity, forever.
setInterval(() => {
  const cut = Date.now() - 3600_000;
  for(const [k, v] of betHits){
    const kept = v.filter((t) => t > cut);
    if(kept.length) betHits.set(k, kept); else betHits.delete(k);
  }
}, 600_000).unref();
// Base58, and the length range a 32-byte key encodes to.
const isPubkey = (v) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);

/**
 * Something legible out of whatever was thrown.
 *
 * A failed bet answered with an empty string, because several of the errors
 * that reach here carry their detail somewhere other than `.message`: Anchor
 * puts it in logs, web3's SendTransactionError leaves message blank and fills
 * transactionMessage. "Error: " with nothing after it is worse than no error,
 * because the user cannot tell whether anything happened at all.
 */
function reason(e){
  const parts = [
    e?.message,
    e?.transactionMessage,
    e?.error?.errorMessage,
    Array.isArray(e?.logs) ? e.logs.find((l) => /Error|failed/i.test(l)) : null,
    typeof e === "string" ? e : null,
    e?.name,
  ].filter((x) => typeof x === "string" && x.trim());
  return (parts[0] ?? "the transaction failed and said nothing about why").slice(0, 160);
}
// The relayer's own balance, refreshed alongside the state poll. Joins stop
// before it runs dry rather than after, because a game it cannot settle is
// worse than a seat it refused.
let relayerSol = null;
async function pollRelayer(){
  if(!relayer) return;
  try { relayerSol = (await connection.getBalance(relayer.pubkey)) / 1e9; }
  catch { /* leave the last reading */ }
}

// ---- fuel --------------------------------------------------------------------
// The payer funds every agent in every game, and when it empties the swarm stops
// opening games and the arena goes quiet. On the 26th that cost three hours and
// nothing reported it: /healthz answered ok, every page rendered, and the only
// symptom was a board with nothing on it. The relayer was holding 5.4 SOL the
// whole time.
//
// So the balance is published, the drop is logged once, and the relayer refills
// the payer itself rather than waiting for somebody to notice.
//
// Deliberately NOT wired into /healthz. A failing healthcheck on a hosted
// platform means restart, restarting does not add SOL, and a quiet arena would
// become a crash loop. This is a fuel gauge, not a liveness probe.
//
// The transfer runs BOTH ways. It used to only ever move relayer -> payer,
// from back when the swarm's payer was the only wallet that spent. Turning the
// scheduler on changed that: the relayer opens every game and pays its rent,
// so it is now the wallet that drains, and a one-way guard watched the wrong
// tank. It sat at 0.86 SOL, under its own reserve, while the payer held 5.6
// and the guard reported "nothing to spare".
const FUEL_FLOOR    = Number(process.env.FUEL_FLOOR    ?? 1.0);  // either wallet is low under this
const FUEL_TARGET   = Number(process.env.FUEL_TARGET   ?? 3.0);  // refill up to here
const FUEL_RESERVE  = Number(process.env.FUEL_RESERVE  ?? 1.0);  // the donor never goes under
const FUEL_EVERY_MS = Number(process.env.FUEL_EVERY_MS ?? 300_000);
const FUEL_AUTO     = process.env.FUEL_AUTO !== "0";

let fuel = { payer: null, payerSol: null, relayerSol: null, floor: FUEL_FLOOR,
             low: false, dry: false, lastTopUp: null, note: null };
let lastTopUpAt = 0, saidLow = false;

async function pollFuel(){
  if(!starter) return;                       // no PAYER here, nothing to watch
  try {
    fuel.payer = starter.publicKey.toBase58();
    fuel.payerSol = (await connection.getBalance(starter.publicKey)) / 1e9;
    fuel.relayerSol = relayerSol;
    // Low if EITHER tank is under the floor: the arena stops on whichever
    // empties first, so reporting only the payer's would have read "ok" all
    // the way through a relayer that could no longer open a game.
    fuel.low = fuel.payerSol < FUEL_FLOOR || (relayerSol != null && relayerSol < FUEL_FLOOR);
    // Under a hundredth of a SOL it cannot pay a fee, let alone fund a game.
    fuel.dry = fuel.payerSol < 0.01 || (relayerSol != null && relayerSol < 0.01);
    if(fuel.low && !saidLow){
      saidLow = true;
      console.log(`[fuel] payer ${fuel.payerSol.toFixed(4)} / relayer ${relayerSol?.toFixed(4) ?? "?"} SOL,` +
        ` under the ${FUEL_FLOOR} floor` +
        (fuel.dry ? " and effectively dry: the arena cannot open or fund a game" : ""));
    }
    if(!fuel.low && saidLow){
      saidLow = false;
      console.log(`[fuel] back to payer ${fuel.payerSol.toFixed(3)} / relayer ${relayerSol?.toFixed(3) ?? "?"} SOL`);
    }
    await topUp();
  } catch(e){ fuel.note = String(e.message ?? e).slice(0, 90); }
}

async function topUp(){
  if(!FUEL_AUTO || !fuel.low || !relayer || relayerSol == null || !starter) return;
  if(Date.now() - lastTopUpAt < FUEL_EVERY_MS) return;
  // Whichever tank is lower is the one to fill, and the other is the donor.
  // Picking by "which is lower" rather than by role means the guard keeps
  // working when the roles change again.
  const drained = fuel.payerSol <= relayerSol
    ? { name: "payer",   sol: fuel.payerSol, kp: starter,    to: starter.publicKey }
    : { name: "relayer", sol: relayerSol,    kp: relayer.kp, to: relayer.kp.publicKey };
  const donor = drained.name === "payer"
    ? { name: "relayer", sol: relayerSol,    kp: relayer.kp }
    : { name: "payer",   sol: fuel.payerSol, kp: starter };
  if(drained.sol >= FUEL_FLOOR) return;          // the low one is not this one
  // Only what the donor can give up without going under its own reserve, and
  // never more than the drained wallet is short.
  const move = Math.min(donor.sol - FUEL_RESERVE, FUEL_TARGET - drained.sol);
  if(move < 0.1){
    fuel.note = `${donor.name} has ${donor.sol.toFixed(3)} SOL, nothing to spare above its ${FUEL_RESERVE} reserve`;
    return;
  }
  lastTopUpAt = Date.now();
  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: donor.kp.publicKey, toPubkey: drained.to,
      lamports: Math.floor(move * 1e9),
    }));
    const sig = await sendAndConfirmTransaction(connection, tx, [donor.kp], { commitment: "confirmed" });
    fuel.lastTopUp = { at: Date.now(), sol: move, from: donor.name, to: drained.name, sig };
    fuel.note = null;
    console.log(`[fuel] moved ${move.toFixed(3)} SOL ${donor.name} -> ${drained.name} (${sig.slice(0,16)}…)`);
  } catch(e){
    fuel.note = `top-up failed: ${String(e.message ?? e).slice(0, 80)}`;
    console.log(`[fuel] ${fuel.note}`);
  }
}
// ---- the book's float --------------------------------------------------------
//
// The relayer stakes its own BUZZ on every bet placed through it, so the book
// runs on a float rather than on the bettor's money. A small bet cap would
// stretch that float; it would not stop it emptying, and a book that stops
// taking bets mid-promotion is worse than one that never opened.
//
// The payer holds mint authority on both devnet stake mints, so the honest fix
// is to top the float up rather than to ration it. This is a devnet-only move
// and deliberately so: it is exactly the thing that must not exist on mainnet,
// where the float has to be bought like everybody else's.
const FLOAT_FLOOR  = Number(process.env.FLOAT_FLOOR  ?? 2000);
const FLOAT_TOPUP  = Number(process.env.FLOAT_TOPUP  ?? 10000);
const FLOAT_EVERY_MS = Number(process.env.FLOAT_EVERY_MS ?? 300_000);
const FLOAT_AUTO   = process.env.FLOAT_AUTO !== "0";
let lastFloatAt = 0, floatNote = null;

async function pollFloat(){
  if(!FLOAT_AUTO || !relayer || !starter) return;
  if(Date.now() - lastFloatAt < FLOAT_EVERY_MS) return;
  lastFloatAt = Date.now();
  try{
    const mint = new PublicKey(TREASURY_MINTS.BUZZ);
    const mintAcc = await connection.getAccountInfo(mint);
    if(!mintAcc) return;
    const { getOrCreateAssociatedTokenAccount, mintTo, getMint } =
      await import("@solana/spl-token");
    const info = await getMint(connection, mint, undefined, mintAcc.owner);
    // Only the mint authority can do this, and on mainnet that will not be us.
    if(!info.mintAuthority || !info.mintAuthority.equals(starter.publicKey)){
      floatNote = "not the mint authority: the book's float cannot be topped up here";
      return;
    }
    const ata = await getOrCreateAssociatedTokenAccount(connection, starter, mint,
      relayer.kp.publicKey, false, undefined, undefined, mintAcc.owner);
    const held = Number(ata.amount) / 10 ** info.decimals;
    if(held >= FLOAT_FLOOR){ floatNote = null; return; }
    const units = BigInt(FLOAT_TOPUP) * 10n ** BigInt(info.decimals);
    await mintTo(connection, starter, mint, ata.address, starter.publicKey, units,
      [], undefined, mintAcc.owner);
    floatNote = null;
    console.log(`[float] book had ${held.toFixed(0)} BUZZ, minted ${FLOAT_TOPUP} to the relayer`);
  }catch(e){
    floatNote = String(e.message ?? e).slice(0, 90);
    console.log(`[float] ${floatNote}`);
  }
}

// What a newcomer is handed, once.
const FAUCET_BUZZ = Number(process.env.FAUCET_BUZZ ?? 200);
// Enough for a token account's rent (~0.002) and a long run of transactions,
// and small enough that the payer's balance is a few hundred newcomers deep.
const FAUCET_SOL = Number(process.env.FAUCET_SOL ?? 0.02);
const FAUCET_PER_IP_DAY = Number(process.env.FAUCET_PER_IP_DAY ?? 5);

/**
 * What the faucet may spend, and the floor it may never spend past.
 *
 * The faucet pays SOL out of the payer, and the payer is what funds the swarm.
 * So an emptied faucet is not an inconvenience, it is the arena going dark: the
 * swarm stops at its fuel floor and no games get played. Rate limiting alone
 * does not bound that, because the limits were per IP and an IP is the cheapest
 * thing on the internet to have more of.
 *
 * Three guards, of which only the reserve actually bounds the damage:
 *
 *   RESERVE   the payer's floor. Below it the faucet switches itself off and
 *             says so. However many wallets ask, however they are spread, the
 *             faucet cannot take the arena down. This is the one that matters.
 *   DAY_MAX   a daily ceiling, so an attack costs a day rather than a payer.
 *   once      genuinely once per wallet, written to the volume, so a deploy no
 *             longer hands everybody a fresh allowance.
 *
 * The old per-wallet check ran through overLimit, whose window is an hour, so
 * the message promising "One per wallet" was enforcing one per wallet per hour.
 */
const FAUCET_RESERVE_SOL = Number(process.env.FAUCET_RESERVE_SOL ?? 2);
const FAUCET_SOL_DAY_MAX = Number(process.env.FAUCET_SOL_DAY_MAX ?? 1);
const FAUCET_FILE = join(DATA_DIR, "faucet.json");

let faucetLog = { day: "", solToday: 0, wallets: {} };
try { faucetLog = { ...faucetLog, ...JSON.parse(readFileSync(FAUCET_FILE, "utf8")) }; } catch {}

const faucetDay = () => new Date().toISOString().slice(0, 10);
function faucetRoll(){
  if (faucetLog.day !== faucetDay()) { faucetLog.day = faucetDay(); faucetLog.solToday = 0; }
}
function faucetSave(){
  try { writeFileSync(FAUCET_FILE, JSON.stringify(faucetLog)); }
  catch (e) { console.log("[faucet] ledger write failed:", String(e.message).slice(0, 60)); }
}

/** Null when the faucet may pay, otherwise the reason it may not. */
async function faucetBlocked(wallet){
  faucetRoll();
  if (faucetLog.wallets[wallet]) return "this wallet has already been topped up";
  if (faucetLog.solToday + FAUCET_SOL > FAUCET_SOL_DAY_MAX)
    return "the faucet has given out its allowance for today, try tomorrow";
  // Asked last and cheaply: one balance read, and only when the rest passed.
  try {
    const bal = await connection.getBalance(starter.publicKey);
    if (bal - FAUCET_SOL * 1e9 < FAUCET_RESERVE_SOL * 1e9)
      return "the faucet is paused while the arena tops itself up";
  } catch { return "could not check the faucet balance, try again shortly"; }
  return null;
}


async function fundNewcomer(wallet){
  const who = new PublicKey(wallet);
  const mint = new PublicKey(TREASURY_MINTS.BUZZ);
  const mintAcc = await connection.getAccountInfo(mint);
  if(!mintAcc) throw new Error("stake mint not found");
  const { createAssociatedTokenAccountIdempotent, mintTo, getMint } = await import("@solana/spl-token");
  const info = await getMint(connection, mint, undefined, mintAcc.owner);
  if(!info.mintAuthority || !info.mintAuthority.equals(starter.publicKey))
    throw new Error("not the mint authority on this cluster");

  // SOL first: the token account below needs rent, and we pay it either way,
  // but a wallet that cannot then send a transaction has been given nothing.
  const have = await connection.getBalance(who);
  let solSig = null;
  if(have < FAUCET_SOL * 1e9){
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: starter.publicKey, toPubkey: who,
      lamports: Math.floor(FAUCET_SOL * 1e9),
    }));
    // One retry. A devnet blockhash going stale between fetch and send is
    // common enough that it took out this call on its first real test, and a
    // newcomer's only route to a stake should not turn on that.
    try { solSig = await sendAndConfirmTransaction(connection, tx, [starter], { commitment: "confirmed" }); }
    catch (e) {
      if (!/Blockhash not found|block height exceeded/i.test(String(e.message ?? e))) throw e;
      tx.recentBlockhash = undefined; tx.lastValidBlockHeight = undefined;
      solSig = await sendAndConfirmTransaction(connection, tx, [starter], { commitment: "confirmed" });
    }
  }
  // Idempotent for the same reason the book uses it: getOrCreate reads back the
  // account it just created and can miss it at `confirmed`, which turns a
  // successful top-up into an error.
  const ata = await createAssociatedTokenAccountIdempotent(connection, starter, mint, who,
    { commitment: "confirmed" }, mintAcc.owner);
  const units = BigInt(FAUCET_BUZZ) * 10n ** BigInt(info.decimals);
  const sig = await mintTo(connection, starter, mint, ata, starter.publicKey, units,
    [], undefined, mintAcc.owner);
  console.log(`[faucet] ${FAUCET_BUZZ} BUZZ + ${solSig ? FAUCET_SOL : 0} SOL to ${wallet.slice(0,8)}`);
  return { wallet, buzz: FAUCET_BUZZ, sol: solSig ? FAUCET_SOL : 0,
           token: ata.toBase58(), sig, solSig };
}

/**
 * Score a round's predictions, whoever cranked it.
 *
 * Cranking is permissionless and both the swarm and this server do it, but only
 * the swarm reported its deaths to /api/agent/resolved. Every round the server
 * won the race left its predictions ungraded forever, so the thinking page
 * showed what the models said and never whether they were right, which is the
 * half that costs something to admit. Measured before this existed: 106 of 143
 * answered calls carried a prediction nobody ever scored, the oldest twelve
 * hours old.
 *
 * Idempotent. Both parties may report the same round and the second call just
 * writes the same answer.
 */
function gradeRound(gameId, instance, doomed){
  const id = String(gameId);
  if (grades.get(`${id}:${instance}`) !== doomed) {
    grades.set(`${id}:${instance}`, doomed);
    gradesDirty = true;
  }
  for(const t of thoughts){
    if(t.game !== id || t.instance !== instance) continue;
    if(t.predict != null) t.hit = t.predict === doomed;
    t.doomed = doomed;
  }
}

/** The swarm's heartbeat, or why there isn't one. Never throws. */
const SWARM_BEAT = join(DATA_DIR, "swarm.json");
function swarmBeat(){
  try {
    if (!existsSync(SWARM_BEAT)) return { state: "no heartbeat yet" };
    const b = JSON.parse(readFileSync(SWARM_BEAT, "utf8"));
    // The age is the useful half. A loop that last moved eleven minutes ago is
    // wedged whatever its last state said it was doing.
    return { ...b, ageSeconds: Math.round((Date.now() - b.at) / 1000) };
  } catch (e) { return { state: "unreadable", error: String(e.message ?? e).slice(0, 80) }; }
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
// The swarm creates games with PAYER, and start_game is has_one = authority,
// so rescuing a stranded swarm lobby needs that key rather than the relayer's.
let starter = null;
try {
  if (process.env.PAYER) starter = loadKeypair(process.env.PAYER);
} catch { /* no PAYER here: the rescue simply cannot run, and says so */ }
if (relayer) cranker = makeCranker({ program: relayer.program, payer: relayer.kp, starter,
                                    onDeath: gradeRound });
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
// The book is independent of the scheduler: it opens on whatever is running,
// whoever created it. Both halves are permissionless on chain, so this is the
// thing that makes sure somebody does it promptly rather than the only party
// allowed to.
if (relayer && process.env.RUN_MARKET !== "0") {
  book = makeMarket({ program: relayer.program, payer: relayer.kp, connection });
  console.log("book on");

  // Winners get paid without being asked to come back for it.
  //
  // The first weekend the book was live, eleven of thirteen bets won and not
  // one was claimed. That is not people failing to understand the game: they
  // found the arena, worked out the mechanic and staked, and then were asked
  // to return to a devnet page a second time to collect. The step goes away.
  //
  // On a timer rather than on the settle tick, because a payout has to survive
  // a restart, a book that settles while nothing is watching, and a claim that
  // failed once on a rate limit. It scans, so any of those still ends in the
  // bettor being paid.
  const PAY_EVERY = Number(process.env.PAY_EVERY_MS ?? 5 * 60_000);
  let paying = false;
  const payout = async () => {
    if (paying) return;
    paying = true;
    try { await book.sweepClaims(); }
    catch (e) { console.log("[book] payout sweep:", String(e.message ?? e).slice(0, 100)); }
    finally { paying = false; }
  };
  setTimeout(payout, 45_000).unref?.();
  setInterval(payout, PAY_EVERY).unref?.();
  console.log(`auto-payout on, every ${Math.round(PAY_EVERY / 1000)}s`);
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
// ---- the reasoning feed ------------------------------------------------------
// A bounded in-memory window on what the agents are thinking right now. Not
// persisted: the chain already holds the outcomes, and this is the working,
// which is only interesting live.
const THOUGHTS_MAX = Number(process.env.THOUGHTS_MAX ?? 400);
const thoughts = [];
const txCache = new Map();
// Enough to answer "is the swarm reaching us at all" from outside, which
// otherwise takes a trip to the host's log viewer every single time.
const intake = { posts: 0, accepted: 0, rejected: 0, lastRejectAt: null, lastReject: null,
                 spooled: 0, spoolErr: null };

// The swarm writes every trace here as well as posting it. When it shares a
// container with the arena, which is how this is deployed, that file is the
// channel that cannot be misrouted: no host to get wrong, no slash, no second
// server answering on loopback. Read on a timer and merged by identity, so a
// record arriving both ways lands once.
// game:instance -> the comb that died. Survives a restart, which the grades on
// the thought records themselves do not: they are recomputed from this on load.
const GRADES = join(DATA_DIR, "grades.json");
const grades = new Map();
try { for (const [k, v] of JSON.parse(readFileSync(GRADES, "utf8"))) grades.set(k, v); } catch {}
let gradesDirty = false;
setInterval(() => {
  if (!gradesDirty) return;
  gradesDirty = false;
  // Bounded the same way the thought buffer is: the chain is the archive.
  const keep = [...grades.entries()].slice(-THOUGHTS_MAX * 2);
  if (keep.length < grades.size) { grades.clear(); for (const [k, v] of keep) grades.set(k, v); }
  try { writeFileSync(GRADES, JSON.stringify(keep)); }
  catch (e) { console.log("[grades] write failed:", e.message); }
}, 5000).unref?.();

const SPOOL = join(DATA_DIR, "thoughts.jsonl");
const seen = new Set();
const idOf = (t) => `${t.game}:${t.instance}:${t.agent}:${t.skipped ? "s" : "a"}`;

function absorb(t) {
  const id = idOf(t);
  if (seen.has(id)) return false;
  seen.add(id);
  const rec = { hit: null, ...t, at: t.at ?? Date.now() };
  // Grades are not in the spool: the swarm writes a trace at commit time, and
  // the answer arrives a phase later. Without this a restart reloaded every
  // thought with hit null, so the page's hit rate started again from zero
  // while showing a full window of calls beside it.
  const doomed = grades.get(`${rec.game}:${rec.instance}`);
  if (doomed != null) {
    if (rec.predict != null) rec.hit = rec.predict === doomed;
    rec.doomed = doomed;
  }
  thoughts.push(rec);
  if (thoughts.length > THOUGHTS_MAX) {
    for (const gone of thoughts.splice(0, thoughts.length - THOUGHTS_MAX)) seen.delete(idOf(gone));
  }
  return true;
}

function drainSpool() {
  try {
    if (!existsSync(SPOOL)) return;
    const lines = readFileSync(SPOOL, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-THOUGHTS_MAX)) {
      try { if (absorb(JSON.parse(line))) intake.spooled++; } catch { /* half-written line */ }
    }
    // Rewritten rather than grown forever. The chain is the archive; this is a
    // window, and the volume is shared with the results history.
    if (lines.length > THOUGHTS_MAX * 3)
      writeFileSync(SPOOL, lines.slice(-THOUGHTS_MAX).join("\n") + "\n");
  } catch (e) { intake.spoolErr = String(e.message ?? e).slice(0, 90); }
}
// The swarm's other half of the same channel. It cranks too, and when it wins
// the race the death is only ever announced here.
const RESOLVED_SPOOL = join(DATA_DIR, "resolved.jsonl");
function drainResolved() {
  try {
    if (!existsSync(RESOLVED_SPOOL)) return;
    const lines = readFileSync(RESOLVED_SPOOL, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-THOUGHTS_MAX * 2)) {
      try {
        const { gameId, instance, doomed } = JSON.parse(line);
        // Already known, and gradeRound walks the whole buffer, so skipping
        // here is what keeps a four second timer off a full rescan.
        if (grades.get(`${gameId}:${instance}`) === doomed) continue;
        gradeRound(gameId, instance, doomed);
      } catch { /* half-written line */ }
    }
    if (lines.length > THOUGHTS_MAX * 6)
      writeFileSync(RESOLVED_SPOOL, lines.slice(-THOUGHTS_MAX * 2).join("\n") + "\n");
  } catch (e) { intake.spoolErr = String(e.message ?? e).slice(0, 90); }
}

drainSpool(); setInterval(drainSpool, 4000);
drainResolved(); setInterval(drainResolved, 4000);
// Derived from the seed both processes already share, so a swarm running as
// its own Railway service authenticates with nothing configured. See the note
// in agents/feed.mjs: this is worth exactly what SWARM_SEED is worth, which is
// the same thing the agent keypairs are worth, so it adds no new exposure.
const FEED_SECRET = process.env.FEED_SECRET
  ?? keccak_256(`buzz-feed:${process.env.SWARM_SEED ?? "buzz-devnet-swarm-v1"}`);
// Named for the explorer links, which need to know which cluster to open.
const CLUSTER = /mainnet/.test(RPC) ? "mainnet-beta" : /testnet/.test(RPC) ? "testnet" : "devnet";

/**
 * Only the swarm may write to the feed.
 *
 * With FEED_SECRET set that is a shared secret, which is what to use in
 * production. Without one it falls back to loopback only, which holds when the
 * swarm runs in this process (RUN_SWARM=1) and is the reason a missing secret
 * is not fatal. The buffer is display-only and capped, so the worst a forged
 * write does is put a wrong line on a page, but set the secret anyway.
 */
const feedAuthed = (req) => {
  // A JSON content-type is not a CORS-simple request, so a browser must
  // preflight it. Nothing here answers a preflight, which is what keeps a page
  // on another origin from posting from a visitor's browser.
  if(req.method !== "POST") return false;
  if(!String(req.headers["content-type"] ?? "").startsWith("application/json")) return false;
  const got = String(req.headers["x-feed-secret"] ?? "");
  // Constant time, because this now runs against a value an attacker can
  // submit repeatedly rather than only from loopback.
  if(got.length !== FEED_SECRET.length) return false;
  let diff = 0;
  for(let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ FEED_SECRET.charCodeAt(i);
  return diff === 0;
};

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json",
    "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};

createServer(async (req,res)=>{
  // Leading slashes collapsed before parsing, not after: new URL("//api/x")
  // reads "//" as protocol-relative and hands back host "api" with path "/x",
  // so the doubled slash never reaches pathname to be cleaned up there. A
  // FEED_URL with a trailing slash asks for exactly that, and the 404 reads
  // like a missing endpoint rather than a spare character.
  const url = new URL(req.url.replace(/^\/{2,}/, "/"), "http://x");
  let p = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/");

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
    // The last few failures, so a diagnosis does not mean guessing action ids
    // one at a time against /api/agent/action. The ClawPump agent's first join
    // died on a 429 and finding that out took twenty five probes.
    const recent = [...actions.values()]
      .filter((a) => a.state === "failed" || a.tries > 0)
      .sort((a, b) => (b.settledAt ?? b.at) - (a.settledAt ?? a.at)).slice(0, 8)
      .map((a) => ({ kind: a.kind, state: a.state, tries: a.tries ?? 0,
                     wallet: String(a.agentWallet ?? "").slice(0, 8),
                     error: String(a.error ?? "").slice(0, 120), at: a.settledAt ?? a.at }));
    return send(res, 200, { ...await relayer.ready(), sol: relayerSol,
                            queued: queuedCount(), recentFailures: recent,
                            limits: LIMITS, ...limiter.stats() });
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

  // The book on one game: the pool, what sits on each agent, and when betting
  // closes. Cached briefly because the arena polls it per open card and the
  // pools only move when somebody bets.
  if(p === "/api/market"){
    if(!book) return send(res, 200, { on: false });
    const gameId = url.searchParams.get("game");
    if(!gameId || !/^[0-9]{1,20}$/.test(gameId))
      return send(res, 400, { error: "game must be a numeric game id" });
    const c = marketCache.get(gameId);
    if(c && Date.now() - c.at < 4000) return send(res, 200, c.body);
    try{
      const m = await book.read(gameId);
      const body = { on: true, game: gameId, market: m };
      marketCache.set(gameId, { at: Date.now(), body });
      return send(res, 200, body);
    }catch(e){
      // Odds a minute old beat no odds at all.
      //
      // This used to answer 502 and cache nothing, so once the RPC started
      // refusing, every retry hit the same failing read and the bet panel sat
      // on "Waiting for the book" forever. The pool moves slowly and the page
      // labels it as a rate rather than a promise, so serving the last good
      // answer is honest, and it means one successful read keeps the panel
      // alive through a rate-limit storm.
      if(c && Date.now() - c.at < 60_000)
        return send(res, 200, { ...c.body, stale: Math.round((Date.now() - c.at) / 1000) });
      return send(res, 502, { error: String(e.message ?? e).slice(0, 140) });
    }
  }

  // Build an unsigned place_bet for somebody with their own wallet. Nothing is
  // signed here, and the transaction can only move tokens out of an account the
  // signer already controls.
  if(p === "/api/bet/prepare"){
    if(!book) return send(res, 503, { error: "the book is not running" });
    if(req.method !== "POST") return send(res, 405, { error: "POST" });
    const b = await readBody(req);
    if(!/^[0-9]{1,20}$/.test(String(b.game ?? "")))
      return send(res, 400, { error: "game must be a numeric game id" });
    if(!isPubkey(b.target) || !isPubkey(b.bettor))
      return send(res, 400, { error: "target and bettor must be base58 addresses" });
    const amount = Number(b.amount);
    if(!Number.isFinite(amount) || amount <= 0 || amount > BET_MAX)
      return send(res, 400, { error: `amount must be between 1 and ${BET_MAX}` });
    try{
      return send(res, 200, await book.buildBet({
        gameId: String(b.game), target: b.target, bettor: b.bettor, amount }));
    }catch(e){ return send(res, 400, { error: reason(e) }); }
  }

  // Place or claim a bet for somebody with no wallet at all. The relayer signs
  // and stakes; the identity it acts for owns the payout account, and the
  // program will not let the payout go anywhere else.
  if(p === "/api/bet/relay" || p === "/api/bet/claim"){
    if(!relayer) return send(res, 503, { error: "no relayer configured" });
    if(req.method !== "POST") return send(res, 405, { error: "POST" });
    const b = await readBody(req);
    if(!/^[0-9]{1,20}$/.test(String(b.game ?? "")))
      return send(res, 400, { error: "game must be a numeric game id" });
    if(!isPubkey(b.target) || !isPubkey(b.bettor))
      return send(res, 400, { error: "target and bettor must be base58 addresses" });
    try{
      if(p === "/api/bet/claim")
        return send(res, 200, await relayer.handlers.claimBet({
          bettorWallet: b.bettor, gameId: String(b.game), targetWallet: b.target }));
      const amount = Number(b.amount);
      if(!Number.isFinite(amount) || amount <= 0 || amount > BET_MAX)
        return send(res, 400, { error: `amount must be between 1 and ${BET_MAX}` });
      const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()
        || req.socket.remoteAddress || "?";
      if(overLimit(`ip:${ip}`, BET_PER_IP_HOUR) || overLimit(`id:${b.bettor}`, BET_PER_ID_HOUR))
        return send(res, 429, { error: "that is a lot of bets in an hour. Try again later." });
      const placed = await relayer.handlers.bet({
        bettorWallet: b.bettor, gameId: String(b.game), targetWallet: b.target, amount });
      recordHit(`ip:${ip}`); recordHit(`id:${b.bettor}`);
      return send(res, 200, placed);
    }catch(e){ return send(res, 400, { error: reason(e) }); }
  }

  // Who is reading the agents best. Computed from chain rather than from a
  // ledger we keep, so anyone can recompute it and check the answer: every Bet
  // carries its bettor, target and amount, every TargetPool says whether that
  // target survived, and the market carries the two pool totals the payout
  // divides by. Cached because it walks every bet the program has ever taken.
  if(p === "/api/bettors"){
    if(!book) return send(res, 200, { on: false, bettors: [] });
    if(bettorCache.at && Date.now() - bettorCache.at < BETTORS_TTL_MS)
      return send(res, 200, bettorCache.body);
    try{
      const body = await book.bettors();
      bettorCache = { at: Date.now(), body };
      return send(res, 200, body);
    }catch(e){ return send(res, 502, { error: String(e.message ?? e).slice(0, 140) }); }
  }

  // Give a wallet something to stake with.
  //
  // The stake is BUZZ on devnet, a token we mint, so a stranger's wallet holds
  // none of it and cannot bet at all. Without this the wallet path is only
  // usable by us, which is why the relayer was carrying every bet.
  //
  // It also hands over a little SOL, because a wallet with tokens and no SOL
  // still cannot send a transaction or pay the rent on its own token account,
  // and "insufficient funds" would be the first thing a new player saw.
  if(p === "/api/faucet"){
    if(req.method !== "POST") return send(res, 405, { error: "POST" });
    if(!starter) return send(res, 503, { error: "no faucet key configured" });
    if(CLUSTER !== "devnet") return send(res, 403, { error: "devnet only" });
    const b = await readBody(req);
    if(!isPubkey(b.wallet)) return send(res, 400, { error: "wallet must be a base58 address" });
    const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()
      || req.socket.remoteAddress || "?";
    // A handful per address behind one IP, which slows a casual script and
    // nothing more: IPs are cheap. The guards that actually bound the damage
    // are in faucetBlocked, and the reserve is the one that cannot be evaded.
    if(overLimit(`faucet-ip:${ip}`, FAUCET_PER_IP_DAY))
      return send(res, 429, { error: "too many requests from here, try later" });
    const blocked = await faucetBlocked(b.wallet);
    if(blocked) return send(res, 429, { error: blocked });
    try{
      const funded = await fundNewcomer(b.wallet);
      recordHit(`faucet-ip:${ip}`);
      // Written before the response, so a crash between the two costs the
      // faucet an allowance rather than handing out an unbounded number.
      faucetLog.wallets[b.wallet] = faucetDay();
      faucetLog.solToday = Number((faucetLog.solToday + (funded.sol ?? 0)).toFixed(6));
      faucetSave();
      return send(res, 200, funded);
    }catch(e){ return send(res, 502, { error: reason(e) }); }
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

  // ---- the reasoning feed --------------------------------------------------
  // Written by the swarm as it plays, read by /thinking. Deliberately in
  // memory and bounded: this is a window on what the arena is doing right now,
  // not a second history file, and the on-chain record is already the archive.
  if(p === "/api/agent/thought"){
    intake.posts++;
    if(!feedAuthed(req)){
      intake.rejected++; intake.lastRejectAt = Date.now();
      intake.lastReject = req.headers["x-feed-secret"] ? "secret did not match" : "no secret sent";
      return send(res, 401, { error: "not the swarm" });
    }
    const b = await readBody(req);
    if(b.agent == null || b.game == null){
      intake.rejected++; intake.lastRejectAt = Date.now();
      intake.lastReject = "agent and game are required";
      return send(res, 400, { error: "agent and game are required" });
    }
    intake.accepted++;
    absorb({ ...b, at: Date.now() });
    return send(res, 202, { ok: true });
  }
  if(p === "/api/agent/resolved"){
    if(!feedAuthed(req)) return send(res, 401, { error: "not the swarm" });
    const { gameId, instance, doomed } = await readBody(req);
    gradeRound(gameId, instance, doomed);
    return send(res, 202, { ok: true });
  }
  // Every transaction an agent has ever sent, read straight off the chain.
  // The feed's buffer only knows the calls this process has seen; the wallet
  // outlives every restart, so this is the durable answer to what an agent has
  // actually done. Cached because getSignaturesForAddress is not free and the
  // page polls.
  if(p === "/api/agent-txs"){
    const name = url.searchParams.get("agent");
    const known = houseWallets().find((h) => h.name === name);
    if(!known) return send(res, 404, { error: "unknown agent" });
    const c = txCache.get(name);
    if(c && Date.now() - c.at < 20_000) return send(res, 200, c.body);
    try{
      const sigs = await connection.getSignaturesForAddress(new PublicKey(known.wallet), { limit: 25 });
      // Naming an instruction would cost a getParsedTransaction per signature.
      // The buffer already knows what it asked for, so anything it recognises
      // gets a label for free and the rest stay honestly unlabelled.
      const seen = new Map(thoughts.filter((t) => t.sig).map((t) => [t.sig, t]));
      const body = { agent: name, wallet: known.wallet, cluster: CLUSTER,
        txs: sigs.map((x) => {
          const t = seen.get(x.signature);
          return { sig: x.signature, slot: x.slot, err: !!x.err,
            at: x.blockTime ? x.blockTime * 1000 : null,
            kind: t ? "commit" : null, game: t?.game ?? null, instance: t?.instance ?? null };
        }) };
      txCache.set(name, { at: Date.now(), body });
      return send(res, 200, body);
    }catch(e){ return send(res, 502, { error: String(e.message ?? e).slice(0, 140) }); }
  }
  if(p === "/api/thoughts"){
    const want = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(want) && want > 0 ? Math.min(want, THOUGHTS_MAX) : 60;
    // Filtering happens here rather than in the page so a narrowed view gets a
    // full window of that agent's calls instead of whatever survived a slice
    // taken across all four.
    // Narrow by wallet or by model. Nine pod wallets run only three models
    // (each slot runs the same three), so a per-wallet view splits one model's
    // record three ways and reads as nine thin, noisy lines. Grouping by model
    // is the comparison anyone actually wants: which model plays this better.
    const who = url.searchParams.get("agent");
    const whichModel = url.searchParams.get("model");
    const all = who ? thoughts.filter((t) => t.agent === who)
              : whichModel ? thoughts.filter((t) => t.model === whichModel)
              : thoughts;
    const graded = all.filter((t) => t.hit !== null);
    const hits = graded.filter((t) => t.hit).length;
    const hour = Date.now() - 3600_000;
    const answered = all.filter((t) => !t.skipped);
    const latencies = answered.map((t) => t.ms).filter((v) => v > 0).sort((a, b) => a - b);
    const spend = answered.reduce((a, t) => a + (t.cost ?? 0), 0);
    return send(res, 200, {
      calls: all.slice(-limit).reverse(),
      // The chart reads this: oldest first, one point per call, trimmed to what
      // a sparkline can actually resolve.
      series: all.slice(-160).map((t) => ({
        at: t.at, agent: t.agent, model: t.model ?? null, instance: t.instance, game: t.game,
        left: t.budget?.left ?? null, granted: t.budget?.granted ?? null,
        cost: t.cost ?? 0, ms: t.ms ?? null, hit: t.hit, skipped: !!t.skipped,
      })),
      stats: {
        // Only what this buffer has seen, so it is a rate over the visible
        // window rather than an all-time figure the page cannot show its
        // working for. The leaderboard is where all-time lives.
        answered: answered.length,
        skipped: all.filter((t) => t.skipped).length,
        lastHour: all.filter((t) => t.at >= hour && !t.skipped).length,
        graded: graded.length,
        hitRate: graded.length ? hits / graded.length : null,
        spend,
        // Median, not mean: one 30s outlier drags a mean somewhere no call
        // actually went, and the tail is shown separately anyway.
        p50: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
        p95: latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : null,
        tokens: answered.reduce((a, t) => a + (t.tokensIn ?? 0) + (t.tokensOut ?? 0), 0),
        models: [...new Set(all.map((t) => t.model).filter(Boolean))],
        providers: [...new Set(all.map((t) => t.provider).filter(Boolean))].length,
        window: all.length,
      },
      // Always the unfiltered roster, so filtering to one agent cannot hide
      // the buttons that get you back to the others.
      agents: [...new Set(thoughts.map((t) => t.agent))].sort(),
      intake,
      cluster: CLUSTER,
    });
  }

  if(p === "/api/history"){
    // The board polls this every 15s, and a full page of records is ~120KB, so
    // the caller says how many it wants and gets `total` to know if asking for
    // more is worth it. Default stays small; the cap is what we actually retain.
    const want = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(want) && want > 0 ? Math.min(want, HISTORY_MAX) : 50;
    // Sorted, not just in insertion order. Records written before endedAt came
    // from the chain carry a "when we noticed" timestamp instead, so the array
    // order and the times disagree: the board showed 5m ago, then 51h, then 50h,
    // then 49h, walking backwards through the file.
    const ordered = [...history].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return send(res, 200, { games: ordered.slice(0, limit), total: history.length,
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

  // Where this process is actually keeping state, and whether it found
  // anything there at boot.
  //
  // Worth an endpoint because it cannot be answered from outside: past games
  // resetting looks identical whether the volume is unmounted, mounted
  // somewhere else, or mounted correctly and the records were never written.
  // Guessing at that from the outside wasted an afternoon.
  // Which commit is actually serving.
  //
  // Same reasoning as /api/storage: it cannot be answered from outside. Two
  // deploys today shipped only server-side changes, so the pages were
  // byte-identical either way and "is the fix live" came down to reading log
  // lines and inferring. That is a bad way to answer a question this simple,
  // especially during an incident, when it is the first thing you want to know.
  if(p === "/api/version"){
    return send(res, 200, {
      // Railway sets these on every deploy. Null locally, which is honest:
      // there is no commit serving a working tree.
      commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? null,
      branch: process.env.RAILWAY_GIT_BRANCH ?? null,
      message: process.env.RAILWAY_GIT_COMMIT_MESSAGE ?? null,
      deployedAt: process.env.RAILWAY_DEPLOYMENT_ID ? BOOTED_AT : null,
      bootedAt: BOOTED_AT,
      uptimeSeconds: Math.round((Date.now() - BOOTED_AT) / 1000),
      // What is switched on, so a missing env var is visible rather than
      // deduced from the absence of behaviour.
      running: {
        scheduler: process.env.RUN_SCHEDULER === "1",
        swarm: process.env.RUN_SWARM === "1",
        market: process.env.RUN_MARKET !== "0",
        reaper: process.env.RUN_REAPER === "1",
      },
      // What the swarm says it is doing, from the file it writes each turn of
      // its loop. `running.swarm` only says a child was spawned, which stayed
      // true through 25 minutes of a hung swarm and an empty arena.
      swarm: swarmBeat(),
      rpcHost: (() => { try { return new URL(RPC).host; } catch { return null; } })(),
      // The faucet spends the payer, so its remaining allowance is worth being
      // able to read without guessing from the outside.
      faucet: starter ? {
        day: faucetLog.day, solToday: faucetLog.solToday,
        dayMax: FAUCET_SOL_DAY_MAX, reserveSol: FAUCET_RESERVE_SOL,
        walletsFunded: Object.keys(faucetLog.wallets).length,
      } : null,
    });
  }
  if(p === "/api/storage"){
    return send(res, 200, {
      dataDir: DATA_DIR,
      historyFile: HISTORY_FILE,
      // Set at boot, before anything could have been recorded this run.
      recordsAtBoot: HISTORY_AT_BOOT,
      recordsNow: history.length,
      // A volume is a mount, so it is not inside the app directory. If these
      // are the same, DATA_DIR is unset and this is the container filesystem,
      // which a deploy replaces.
      persisted: !DATA_DIR.includes("/server"),
      writable: HISTORY_WRITABLE,
    });
  }

  // home is the front door now; the long-form docs move to /docs
  if(p === "/")      p = "/home.html";
  if(p === "/docs")  p = "/index.html";
  if(p === "/arena") p = "/arena.html";
  if(p === "/play")  p = "/play.html";
  if(p === "/agents")p = "/agents.html";
  if(p === "/thinking")p = "/thinking.html";
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

// ---- the reaper: settle and close what the swarm abandoned -------------------
//
// The swarm settles its own games at the end of one, which works right up until
// the process does not survive to get there. A deploy, an OOM, a container
// moving underneath it: the game reaches Settling with every player still
// Active, nobody claims, and the rent is locked behind claims that will never
// be made. Measured on devnet, five of the seven games that finished in one
// hour ended that way.
//
// So settlement cannot depend on the process that played the game. This runs
// the same two reapers on a clock, against the newest games first, which is
// where the abandoned ones are. Both are idempotent and both skip anything
// already done, so re-running costs a few reads and nothing else.
//
// Spawned rather than imported: they are scripts with top-level await that have
// been driving real money on devnet for days, and a child process cannot take
// the web service down with it.
if (process.env.RUN_REAPER === "1") {
  const EVERY = Number(process.env.REAP_EVERY_MS ?? 10 * 60_000);
  // 60 a pass, not 25. Each pass pays for three full account scans before it
  // closes anything, so that fixed cost wants spreading over as many games as
  // possible. Clearing 25 behind three scans of a 10,000 account program is
  // what let the backlog outrun the reaper in the first place.
  const NEWEST = Number(process.env.REAP_LIMIT ?? 60);
  let running = false;

  const run = (script, env) => new Promise((resolve) => {
    const c = spawn("node", [fileURLToPath(new URL(`../agents/${script}`, import.meta.url))],
      { stdio: "inherit", env: { ...process.env, ...env } });
    c.on("exit", (code) => resolve(code));
    c.on("error", () => resolve(-1));
  });

  const pass = async () => {
    // One pass at a time. A slow reap under a rate limit must not stack up
    // behind itself and turn into a dozen processes fighting for the same RPC.
    if (running) return;
    running = true;
    try {
      // The sweep is on, down to a float rather than to zero.
      //
      // It used to run with SWEEP=0 so a mid-game agent never lost the lamports
      // it was funded with. That made every pass a net loss: the closes pay
      // rent to the agent that owns the account while the fees come off the
      // payer, so the payer fell 0.18 SOL a pass while 4.36 SOL piled up across
      // 39 agent wallets it never took back. settle-reap now leaves each agent
      // twice its funding and sweeps the rest, which covers a game in flight
      // and still brings the rent home.
      await run("settle-reap.mjs", { LIMIT: String(NEWEST), ABORTED: "1" });
      await run("reap-market.mjs", { LIMIT: String(NEWEST) });
    } finally { running = false; }
  };

  console.log(`reaper on, every ${Math.round(EVERY / 1000)}s over the newest ${NEWEST}`);
  setTimeout(pass, 60_000).unref?.();       // let the service come up first
  setInterval(pass, EVERY).unref?.();
}

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
