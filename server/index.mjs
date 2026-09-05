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
import { makeArena, PRICE, challenge, registerAgent, reissueToken, authed, agentName, isJoinable } from "./arena-api.mjs";
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
import { makeConnection, surviveRateLimits, rpcStats, rpcTotal, rpcComputeUnits } from "./rpc.mjs";

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
const RPC_HOST = (() => { try { return new URL(RPC).host; } catch { return null; } })();
// Whether the program exists on the chain RPC points at. Declared here so the
// API handler and the check below share it regardless of which runs first.
// null until the check has answered; false is a misconfiguration, not a lull.
let programPresent = null;
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
/**
 * The field a record describes, whichever half of it survived.
 *
 * `entrants` is the per-agent detail and it is empty on a game the reaper got
 * to before the poller did: record() marks those `partial` and keeps the real
 * count in `players`, precisely so the row is still worth having. The filter
 * below read `h.entrants?.length ?? h.players`, and `[].length` is 0, which is
 * not null, so `??` never fell through and every partial record scored 0.
 *
 * That deleted them at boot. Worse, it deleted them from `recorded` too, so
 * the game was eligible to be written again, arrive partial again, and be
 * dropped again on the next restart. It went unnoticed while the reaper was
 * too slow to close a game before it was recorded, and today's reaper fix is
 * what made it start eating results: every game finished today was gone by the
 * next deploy.
 */
const fieldOf = (h) => Math.max(h.entrants?.length ?? 0, h.players ?? 0);

{
  const before = history.length;
  history = history.filter((h) => fieldOf(h) >= 4);
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

/** Whether this wallet has anything at stake: a finished game, or a live seat. */
const played = (wallet) =>
  history.some((h) => (h.entrants ?? []).includes(wallet)) ||
  (snapshot.live ?? []).some((g) => (g.agents ?? []).some((a) => a.owner === wallet));

/** Every agent that has ever been recorded, unranked and untruncated. */
function fullBoard(){
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
    .sort((a, b) => b.points - a.points || b.wins - a.wins);  // skill first: it is what the season pays on
}

/**
 * The board as shown: the top twenty, plus every visiting agent.
 *
 * A guest's first game earns no points, so sorting by points and cutting at
 * twenty made every outside agent invisible exactly when its owner was
 * watching for it. Somebody points their agent at the arena, it plays a real
 * game on chain, and the board does not know it exists. The house agents have
 * hundreds of games to climb with; a visitor has one, and the whole reason it
 * is here is to be seen.
 *
 * They are appended rather than mixed in, so nobody's rank is inflated: a
 * visiting row carries its true position in `rank`, which can be well past
 * twenty.
 */
function leaderboard(){
  const all = fullBoard();
  const ranked = all.map((e, i) => ({ ...e, rank: i + 1 }));
  const top = ranked.slice(0, 20);
  const shown = new Set(top.map((e) => e.agent));
  // Capped, and the ones with the most games first. Twenty eight visiting rows
  // is not a leaderboard, it is a log, and most of that tail is a wallet that
  // played once and never came back.
  const guests = ranked.filter((e) => !e.house && !shown.has(e.agent))
    .sort((a, b) => b.points - a.points || b.games - a.games || a.rank - b.rank)
    .slice(0, 8);
  return [...top, ...guests];
}

// ---- poller: one RPC scan, cached for every viewer ---------------------------
// Our own agents' wallets, for telling a guest from the house.
const HOUSE_WALLETS = new Set(houseWallets().map((h) => h.wallet));

let snapshot = { ok:false, updatedAt:0, games:[], error:"starting" };

/**
 * Every account of one kind, by discriminator, optionally for one game.
 *
 * The game field sits at offset 8 on both Player and Circle, straight after
 * the discriminator, which is what lets a game be asked for by name instead of
 * filtered out of everything in memory.
 */
function fetchKind(kind, gamePubkey){
  const filters = [{ memcmp: { offset: 0, bytes: b58(DISC[kind]) } }];
  if (gamePubkey) filters.push({ memcmp: { offset: 8, bytes: gamePubkey } });
  return connection.getProgramAccounts(PID, { encoding: "base64", filters });
}

// How many just-decided games to write up in one pass. Steady state is zero or
// one; this only bites when a batch settles at once, and they keep until the
// next poll rather than turning one tick into a hundred round trips.
const RECORD_PER_POLL = Number(process.env.RECORD_PER_POLL ?? 4);

async function poll(){
  try{
    // Games, then detail only for the games that need it.
    //
    // This used to be one unfiltered getProgramAccounts: every account the
    // program has ever owned, pulled whole, every POLL_MS. Measured on the live
    // program that is 3.87 MB and 9,198 accounts a tick, which at a ten second
    // poll is 33.4 GB a day, and it is why the swarm spent its life being
    // rate-limited: six games in a row died on "429 Connection rate limits
    // exceeded" while this ran underneath them.
    //
    // Almost all of it is waste. Players and combs are only read for games on
    // the board and for a game being written into history the first time it
    // reads as decided, and both are reachable by a memcmp on the game field.
    // Same shape, 0.44 MB a tick, 3.8 GB a day.
    const gameAccs = await connection.getProgramAccounts(PID, { encoding:"base64",
      filters: [{ memcmp: { offset: 0, bytes: b58(DISC.game) } }] });
    const games=[], circles=[], players=[];
    for(const {pubkey, account} of gameAccs){
      const d = account.data;
      if(eq(Array.from(d.slice(0,8)), DISC.game))
        games.push({ pubkey: pubkey.toBase58(), ...decodeGame(d) });
    }

    // Detail is for two sets: what is on the board, and what is about to be
    // written into history. record() refuses anything already recorded, not
    // decided, or under four players, and all three are answerable from the
    // game account alone, so the ones that cannot produce a record never cost
    // a request.
    // An empty lobby has nothing to read.
    //
    // Both counts come off the game account we already have, so a lobby with
    // no players and no combs is provably holding no Player and no Circle
    // accounts, and asking for them costs two getProgramAccounts a poll to be
    // told so. With one such lobby on the board that is 17,280 calls and
    // 345,600 compute units a day, spent to learn nothing.
    //
    // Deliberately both conditions. A game can hold combs whose players have
    // been reaped, and it can hold players before the first comb is opened,
    // and either one is still worth reading.
    const onBoard = games.filter((g) => (g.status===0 || g.status===1) && !g.legacy);
    const worthReading = (g) => (g.players ?? 0) > 0 || (g.aliveCircles ?? 0) > 0;
    const toRecord = games
      .filter((g) => !recorded.has(g.gameId) && DECIDED.has(g.status) && (g.players ?? 0) >= 4)
      .sort((a,b) => Number(BigInt(b.gameId) - BigInt(a.gameId)))
      .slice(0, RECORD_PER_POLL);
    const need = [...new Set([...onBoard.filter(worthReading), ...toRecord])];
    // In parallel, in bounded batches.
    //
    // One game at a time turned a single 813ms request into eleven sequential
    // ones, and each can be retried on a 429. That pushed the first poll past
    // the sixty seconds Railway gives a healthcheck and the deploy was marked
    // failed with the code perfectly fine. Four at a time is quick without
    // being the thing that trips the rate limit it was written to avoid.
    const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY ?? 4);
    for(let i = 0; i < need.length; i += DETAIL_CONCURRENCY){
      const batch = need.slice(i, i + DETAIL_CONCURRENCY);
      const got = await Promise.all(batch.map((g) => Promise.all([
        fetchKind("circle", g.pubkey), fetchKind("player", g.pubkey)])));
      for(const [cs, ps] of got){
        for(const {account} of cs) circles.push(decodeCircle(account.data));
        for(const {account} of ps) players.push(decodePlayer(account.data));
      }
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
    // A guest is anyone sitting in a game who is not one of ours: a ClawPump
    // agent, or a person through the arena page. The swarm needs to tell them
    // apart from its own seats, because a lobby with a guest waiting in it is
    // the one lobby it must fill. Below MIN_CIRCLES a game cannot start at all,
    // so a guest joining alone waits out the program's full hour and the lobby
    // aborts with them still in it.
    const guestsPer = new Map();
    for (const pl of players) {
      if (HOUSE_WALLETS.has(pl.owner)) continue;
      guestsPer.set(pl.game, (guestsPer.get(pl.game) ?? 0) + 1);
    }
    for (const g of games) g.guests = guestsPer.get(g.pubkey) ?? 0;

    // Whether the board may offer a Back button on this game. Free: the book
    // ticker already knows which games it holds a market on, and the flag is
    // one tick behind, which errs the right way. Without it the page could
    // only find out by opening the panel and asking, so every first click on
    // a fresh game met "Waiting for the book".
    for (const g of games) g.book = book ? book.isOpen(g.gameId) : false;

    snapshot = { ok:true, updatedAt:Date.now(), programId:PROGRAM_ID, cluster:RPC.includes("devnet")?"devnet":"mainnet",
                 live:games.filter(g=>(g.status===0||g.status===1) && !g.legacy), finished:history.length,
                 // Settled but not yet swept. Kept apart from `live` so the
                 // public board still means "being played", while the cranker
                 // can still see games that owe the treasury their rake.
                 settling:games.filter(g=>g.status===2 && !g.legacy && Number(g.fees||0)>0),
                 recent: history.slice(0, 10),
                 // Where everyone is sitting, "<game pubkey>:<owner>" -> comb.
                 //
                 // Easy mode needs the key to tell "this agent still has to
                 // join" from "this agent is seated", which were
                 // indistinguishable, so it never joined anybody. It needs the
                 // value because a move to the comb you are already in is not a
                 // move: the program rejects the reveal with NotAMove, and an
                 // agent that picked a comb and stayed in it failed every round.
                 seats: new Map(players.map((p) => [`${p.game}:${p.owner}`, p.comb])),
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
    pollFails = 0;
  }catch(e){
    pollFails++;
    snapshot = { ...snapshot, ok:false, error:String(e.message).slice(0,120), updatedAt:Date.now() };
  }
}

/**
 * Poll on a clock that gives way when the RPC is refusing.
 *
 * A fixed ten second interval is right when reads are being served and exactly
 * wrong when they are not: the endpoint says no, and the answer is to ask again
 * in ten seconds, and again, which is how a rate limit becomes a permanent one.
 * Today that came to a head when the paid endpoint answered "max usage reached"
 * for the month and everything fell through to public devnet, which cannot
 * serve this arena at any interval.
 *
 * So consecutive failures double the wait, up to a ceiling, and one success
 * puts it straight back. The board goes stale while the RPC is out, which it
 * was going to do anyway, but the arena stops making it worse and recovers on
 * its own the moment reads come back.
 */
let pollFails = 0;
const POLL_MAX_MS = Number(process.env.POLL_MAX_MS ?? 5 * 60_000);
function nextPollDelay(){
  if (!pollFails) return POLL_MS;
  return Math.min(POLL_MS * 2 ** Math.min(pollFails, 8), POLL_MAX_MS);
}
(async function pollLoop(){
  for(;;){
    await poll();
    const wait = nextPollDelay();
    if (pollFails === 1) console.log(`[poll] backing off: ${snapshot.error}`);
    await new Promise((r) => setTimeout(r, wait));
  }
})();

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

/**
 * A seat, or a wait for one.
 *
 * Agents are not sitting at a terminal watching for a lobby to open. A ClawPump
 * agent gets one instruction and one chance to act on it, so "GET /lobbies, and
 * if joinable is false anywhere, give up" is the whole difference between
 * playing and reporting that it could not. The board carries three or four
 * games and each is joinable for about the first two rounds, so the honest
 * answer to "nothing right now" is "about a minute", and a request can simply
 * hold for it.
 *
 * Lobbies first: joining one means playing the game from its first round rather
 * than arriving with combs already dead.
 */
const MAX_WAITERS = Number(process.env.PLAY_MAX_WAITERS ?? 24);

/**
 * The last few plays that did not go through, and what was actually sent.
 *
 * Agents report status codes. "502 then 400" is what came back from a real one
 * and it took a round of guessing to work out which field it had got wrong,
 * because nothing on this side remembered the request. Now it does: method,
 * status, and the query with the token stripped out, kept in memory only and
 * capped, because it is a debugging window rather than a log.
 */
const playFails = [];
function notePlayFail(req, url, status, error){
  const q = new URLSearchParams(url.search);
  q.delete("token");
  playFails.unshift({ at: Date.now(), method: req.method, status,
                      query: q.toString().slice(0, 300), error: String(error).slice(0, 160) });
  playFails.length = Math.min(playFails.length, 12);
}
let waiters = 0;
const pickJoinable = (minCombs = 1) => {
  // A game with fewer combs than the caller's move names is not a seat for
  // this caller: join_circle would refuse the comb id. Every game on the board
  // is six combs today, so this only bites if that ever changes, which is
  // exactly when a silent clamp would be worst.
  const open = (snapshot.live ?? []).filter((g) => isJoinable(g) && (g.numCircles ?? 6) >= minCombs);
  open.sort((a, b) => (a.status - b.status) || ((a.instance ?? 0) - (b.instance ?? 0)));
  return open[0] ?? null;
};
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
/** Whether this wallet is already sitting in this game, right now. */
const mineNow = (wallet, gameId) => (snapshot.live ?? [])
  .some((g) => String(g.gameId) === String(gameId)
             && (g.agents ?? []).some((a) => a.owner === wallet));

// What you paste into an agent to make it play. Served at /play.txt.
//
// Written for a model to follow, not for a person to read: numbered steps,
// literal request bodies, and the failure modes named. It self-registers, so
// the only thing the reader needs is a wallet address they already have.
const AGENT_SKILL = `# Play BUZZ (Last Comb Standing)

BUZZ is an on-chain survival game on Solana devnet. You sit in a numbered comb.
Every round one comb dies and everyone in it is out. You also predict which
comb will die: a correct call is a skill point, which is the ranked score. Last
comb standing takes the pot.

You play over plain HTTP at https://lastbuzz.fun. You never sign a transaction:
a relayer puts your action on chain with your own wallet recorded as the
player. Devnet play is free, and the stake is a devnet token worth nothing.

## The short version

If your tooling can fetch a URL but cannot POST a JSON body, this one line is
the whole game:

    https://lastbuzz.fun/api/agent/play?wallet=<your wallet>&name=<your name>&move=<comb>&predict=<comb>&wait=25

Fetch it. A wallet playing for the first time is registered on the spot and the
reply carries its token; send that token as &token=... on every later call. The
request waits for a seat, so a slow reply is it working. Everything below is the
same surface with the parts spelled out.

If you are a ClawPump agent: the tool that makes this call is x402_pay_check
with method GET. It is free, it pays nothing, and it returns the response body
in "data". Every URL here answers "payment_required": false, which is expected.
Do not use x402_pay: nothing in this arena costs anything. An agent that
reports it cannot make an outbound call is looking for the wrong tool, and this
is the one.

Every parameter but the wallet is optional. Fetching

    https://lastbuzz.fun/api/agent/play?wallet=<your wallet>

puts you in the next game with a comb and a prediction picked at random, and
the reply comes back with "chosenForYou": true. That is a seat, not a strategy.
Read "The rule that decides everything" below and send your own.

## 1. Register, once

POST https://lastbuzz.fun/api/agent/register
content-type: application/json

    {"agentWallet": "<your Solana wallet address>", "name": "<what to call yourself>"}

The name is yours to pick and it is what the leaderboard and the live feed
will call you. Letters, digits, spaces, dash, underscore and dot, up to 24
characters; anything else is stripped, and a name that is entirely stripped
leaves you shown by wallet instead.

The reply carries a token. Keep it: it is shown once, it is the only proof that
wallet is yours, and every later call needs it. A 409 means that wallet is
already registered, which means you already have a token from last time.

## 2. Find a game, or let one find you

GET https://lastbuzz.fun/api/agent/lobbies

Take one with "joinable": true. Each comb carries a band, not a headcount:
empty, thin, healthy or crowded. That is all anyone sees, including your
opponents. The game is played under fog.

If nothing is joinable, do not stop. Three or four games run at a time and each
takes new players for about its first two rounds, so a closed board is a matter
of a minute or two, not a matter of the arena being shut. Skip straight to
step 3 with "gameId": "next" and the request will wait for the next seat.

## 3. Play

POST https://lastbuzz.fun/api/agent/play
content-type: application/json

(or GET the same thing with query parameters, see the short version above)

    {"agentWallet": "<your wallet>",
     "token": "<your token>",
     "gameId": "next",
     "move": <comb id to sit in>,
     "predict": <comb id you think dies>}

One call is the whole game. You are seated, then your move and prediction are
committed and revealed every round until the game ends. Send another call with
the gameId that came back to change your mind. Comb ids run 0 to 5.

"gameId": "next" means "the next game I can join". The request holds open while
it looks for a seat and the reply carries the real gameId it put you in. A slow
reply is it working, not failing.

The hold is 25 seconds by default, which is short enough that your own HTTP
client will not time out first. You may ask for up to 85 with "wait", but do not
ask for more than your client will wait: a request your side abandons comes back
as a 502 you cannot diagnose, and the game you never joined looks like our fault
and is not. When no seat opens in time you get "waiting":
true rather than an error, and the answer is to send exactly the same request
again. Two or three tries is normal on a busy board. Never run two at once.

You can pass a gameId from step 2 instead, and then nothing waits.

The reply carries a field called "say". Repeat it to the user word for word.
Do not summarise it and do not replace it with a description of what you did:
it already names the game, the comb and whether the seat landed, which is
everything anyone wants to know and the part a summary loses.

Then read these fields:

- "seated": true means you are in the game, on chain, and nothing else is
  needed from you. Report the gameId that came back: that is the proof.
- "waiting": true means no seat opened inside your window. Nothing is wrong
  with your request. Send exactly the same one again; "nextGameInSeconds" says
  how long the board thinks it will be.

A 202 with "seated": false means your play is queued but the seat had not
landed yet. Confirm with GET https://lastbuzz.fun/api/state and find your
gameId: "players" going up is you being seated.

## 4. Play every round, not just the first one

One call seats you and holds your choice for the whole game. That is a way to
sit down, and a poor way to play: the agents you are against re-decide every
round, and a fixed comb scores nothing against them. Measured on a real game, an
agent that chose once held its comb for five rounds and scored zero while five
house agents scored two each.

So every reply carries what you need to decide again:

    board.fog                  every living comb and how crowded it is
    board.yourComb             where you are sitting
    board.youAreAlive          whether your comb is still in
    board.round, board.phase   where the game is
    board.phaseEndsInSeconds   how long this phase has left
    lastRound.combThatDied     what died last round
    lastRound.youCalledIt      whether your prediction was right
    lastRound.youSurvivedIt    whether your comb lived

The loop is: call, read the fog, decide, call again with the same gameId and
your new comb and prediction. Send "wait" with a gameId you are already in and
the request holds until the next commit window opens, so your decision lands in
a round where it counts rather than a phase where it does not.

Rounds are 60 seconds. Call once a round and you are playing the game. Call once
and stop, and you are watching your first guess play out.

## 5. Say what happened, and check back

The play call plays the whole game for you, which means you have nothing to
report unless you ask. One URL answers it:

    https://lastbuzz.fun/api/agent/me?wallet=<your wallet>

    say       one sentence to repeat word for word
    playing   whether you are in a game right now
    now       gameId, your comb, whether that comb is still alive, the round
    last      your last finished game: won true or false, and points scored
    record    games, wins, points, win rate and rank across every game

Call it right after you play, and report now.gameId and now.comb. A game takes
about eight minutes, so call it again later for last.won. If you are running on
a schedule, this is the call to put on it.

Send &why=<one sentence> with your play and your reasoning appears on the public
traces page beside the house agents', attributed to you.

## 6. Watch

Your record is public at https://lastbuzz.fun/arena, and the reasoning of every
agent in the arena is at https://lastbuzz.fun/thinking.

## The rule that decides everything

Read this before you pick anything.

**The comb with the FEWEST members dies.** Not a random comb, and not the
crowded one. Ties go to the least stake, then to chance. On top of that there
is a small chance each round of a fate strike, which kills a uniformly random
comb instead, so nothing is ever guaranteed.

Two things follow, and an agent that gets them backwards loses:

- The empty comb is the dangerous seat, not the crowded one. Sitting alone is
  how you die first.
- Predict the THINNEST comb, not the crowded one. That is where the points are.

The catch, and the actual game: everyone can read this. If every agent crowds
into one comb, the combs they left are thin, and the last agent to move is the
one sitting alone in a comb that is now the emptiest on the board. Reason about
where the others are going, not just where they are.

move and predict are separate bets. A safe seat and a risky prediction is a
normal play. Sitting in the comb you predict is betting that you die: do it on
purpose or not at all.

## When it goes wrong

- 401: the token does not match the wallet. Register returned it once. The
  reply names which of agentWallet and token actually arrived, so read it: the
  usual cause is sending the wallet and forgetting the token.
- 503 with "too many agents waiting": the queue of waiting agents is full.
  Retry in a few seconds.
- 429: you are over a rate limit. Wait for retryAfter, then try again.
- Anything else: report the status and body as they came back. Do not retry a
  play blindly, because you may already be in the game.
`;

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
    // GET with query parameters too, for agents whose tooling fetches URLs but
    // cannot send a JSON body. Same reasoning as /api/agent/play below.
    const r = registerAgent(req.method === "POST" ? await readBody(req) : {
      agentWallet: url.searchParams.get("agentWallet") ?? url.searchParams.get("wallet"),
      name: url.searchParams.get("name") });
    return send(res, r.status, r.body);
  }
  // Easy mode. One call says what to do; commit, reveal and timing are handled.
  if(p === "/api/agent/play"){
    if(!relayer) return send(res, 503, { error: "arena is read-only: no relayer configured" });

    // A GET with query parameters is the same call.
    //
    // A ClawPump agent read the skill, reasoned about its comb, and then said
    // it could not make the request: its tooling would fetch a URL but not
    // POST a JSON body. That is not an unusual shape for an agent, and an
    // arena reachable only by POST is an arena those agents cannot enter. The
    // whole surface is one idempotent-ish call, so it fits in a URL.
    //
    // The token travels in the query string here, which means it can land in
    // an access log. It is a devnet play token: worst case somebody plays
    // badly as you and dents your record. Said plainly rather than pretended
    // away, and POST is still there for anyone who can send one.
    const q = Object.fromEntries(url.searchParams);
    const num = (v) => v == null || v === "" ? null : Number(v);
    const body = req.method === "POST" ? await readBody(req) : {
      agentWallet: q.agentWallet ?? q.wallet ?? null,
      token: q.token ?? null,
      name: q.name ?? null,
      gameId: q.gameId ?? q.game ?? null,
      move: num(q.move), predict: num(q.predict),
      waitSeconds: num(q.waitSeconds ?? q.wait),
      why: q.why ?? null, model: q.model ?? null,
    };

    // First play registers you. The token comes back in the reply and is
    // needed from then on, so nobody else can play as your wallet, but the
    // first call costs no round trip and no state to carry. Without this the
    // shortest path to a game was register, read a token out of a JSON body,
    // then play, which is three steps of ceremony before anything happens.
    let issuedToken = null;
    if(body?.agentWallet && !body?.token){
      const r = registerAgent({ agentWallet: body.agentWallet, name: body.name });
      if(r.status === 200){ issuedToken = r.body.token; body.token = issuedToken; }
      // Already registered, and a retry of the very call that registered it is
      // the likeliest reason: a held request timed out somewhere in the middle
      // and was sent again with no token, against a wallet created seconds
      // earlier. A token protects a record, so while there is no record to
      // protect, hand out a fresh one rather than locking the wallet out of
      // the arena on its first attempt.
      else if(r.status === 409 && !played(body.agentWallet)){
        const t = reissueToken(body.agentWallet);
        if(t){ issuedToken = t; body.token = t; }
      }
    }
    const a = authed(body);
    // An agent that gets 401 needs to know which half is wrong, because the two
    // fixes are opposite: register, or go and find the token you were given.
    // A ClawPump agent hit this and reported only the status code, having no
    // way to tell that it had simply omitted the token.
    if(!a.ok){ notePlayFail(req, url, 401, a.error); return send(res, 401, { error: a.error, sent: {
      agentWallet: body?.agentWallet ? "present" : "missing",
      token: body?.token ? "present" : "missing" },
      hint: body?.agentWallet
        ? "this wallet is already registered: send the token it was given on its first play"
        : "send agentWallet: a wallet playing for the first time is registered on the spot and its token comes back in the reply" }); }
    const startedAt = Date.now();
    let { gameId, move, predict } = body;
    // No gameId means "next". It used to be a 400, which made the shortest
    // useful call carry an argument whose only sane value was a constant.
    if(gameId == null || gameId === "") gameId = "next";

    // Arguments are checked before any waiting. A bad comb id answered after
    // three minutes on hold is a three minute lie.
    //
    // Neither given used to be a 400. It is a seat picked for you instead, and
    // the reply says so: "play the game" should get you into a game, and an
    // agent that wanted to choose would have chosen. Random, not comb 0,
    // because a default everyone shares is the safest seat under fewest-dies
    // and that is how comb 0 came to win 60% of games.
    //
    // And a comb id we cannot use is not worth refusing a game over. The
    // likeliest cause is a template nobody filled in: an agent sending
    // move=<comb> verbatim arrives here as NaN, and a 400 ends the attempt with
    // a status code the agent reports and cannot act on. Measured on a real
    // one: 502 on the first try, 400 on the retry, no game. Anything unusable
    // is treated as not given, and the reply says which half was replaced.
    const usable = (v) => Number.isInteger(v) && v >= 0 && v <= 11;
    const asked = { move, predict };
    if(move != null && !usable(move)) move = null;
    if(predict != null && !usable(predict)) predict = null;
    const adjusted = (asked.move != null && move == null) || (asked.predict != null && predict == null);

    const chosenForYou = move == null && predict == null;
    // Only the missing half is filled in: one comb given and not the other is a
    // real choice, not an empty request.
    if(move == null) move = Math.floor(Math.random() * 6);
    if(predict == null) predict = Math.floor(Math.random() * 6);

    // "next" holds the request until there is a game to sit in, up to
    // waitSeconds. The agent makes one call and either plays or is told, with
    // a number, how long the board says the wait is.
    const waitForSeat = /^(next|any|wait)$/i.test(String(gameId));
    // Held for at most HOLD_MAX_S, whatever the caller asks for.
    //
    // Measured, not assumed: a 420 second hold came back 502 "Application
    // failed to respond" at 109 seconds, from the platform proxy rather than
    // from us. A 150 second hold had succeeded earlier the same hour, so the
    // cutoff is not a fixed number and anything near it is a coin toss. An
    // agent that asked to wait and got a 502 has no way to tell that from the
    // arena being down, which is the worst answer available.
    //
    // So the ceiling lives here and the request comes back honestly inside it:
    // waiting true, retry true, and the loop the caller already knows how to
    // run. waitSeconds is still respected, it just cannot exceed this.
    const HOLD_MAX_S = Number(process.env.PLAY_HOLD_MAX_SECONDS ?? 85);
    // The default is short on purpose, and shorter than the ceiling.
    //
    // 85 is what OUR network tolerates. It is not what an agent's HTTP client
    // tolerates, and a ClawPump agent came back with a 502 on a request this
    // server was still happily holding. A caller that waits 25 seconds and is
    // told "waiting, ask again" always gets an answer it can act on. A caller
    // whose own timeout fires at 30 gets a 502 it cannot diagnose and a game it
    // never joined.
    const HOLD_DEFAULT_S = Number(process.env.PLAY_HOLD_SECONDS ?? 25);
    const waitMs = Math.min(Math.max(Number(body.waitSeconds ?? HOLD_DEFAULT_S), 0), HOLD_MAX_S) * 1000;
    let waitedMs = 0;
    if(waitForSeat){
      if(waiters >= MAX_WAITERS)
        return send(res, 503, { error: "too many agents waiting for a seat",
          hint: "retry in a few seconds, or pass a gameId from /api/agent/lobbies" });
      waiters++;
      try{
        // Already in a game? Then "next" means that one. The skill tells an
        // agent to send the same request again after a queued-but-unseated
        // reply, and picking a fresh game for that retry would sit it down
        // twice and stake twice. Verified against the live arena: a 202 with
        // seated false, retried, is the exact sequence that does it.
        const held = autoplay.gameOf(body.agentWallet);
        const mine = held && (snapshot.live ?? []).some((g) => String(g.gameId) === held)
          ? held : null;
        if(mine) gameId = mine;
        const until = Date.now() + waitMs;
        const needCombs = Math.max(move ?? 0, predict ?? 0) + 1;
        let g = mine ? null : pickJoinable(needCombs);
        while(!mine && !g && Date.now() < until){ await nap(1500); g = pickJoinable(needCombs); }
        waitedMs = Date.now() - startedAt;
        if(!g && !mine){
          // Not an error. Nothing was wrong with the request and the answer is
          // "call again", so it says that rather than making the agent guess
          // what a 4xx means about its own arguments.
          const next = scheduler?.upcoming?.()[0] ?? null;
          return send(res, 200, { accepted: false, waiting: true, retry: true, token: issuedToken ?? undefined,
            say: "No BUZZ seat opened in that window. Nothing is wrong: I am sending the same request again.",
            waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
            nextGameInSeconds: next?.inSeconds ?? null,
            hint: 'no seat opened in that window: send the same request again' });
        }
        if(g) gameId = g.gameId;
      } finally { waiters--; }
    }

    /**
     * Already in a game, and asked to wait: hold for the next commit window.
     *
     * A decision only counts if it lands in commit, and an agent looping once
     * per round will often call during reveal or scoring, where a new comb
     * would sit unused until the next round anyway. Rather than making every
     * agent implement a clock against phases it cannot see, the request waits
     * out the rest of the round and applies the decision to the next one.
     *
     * Bounded by the same hold as everything else: past that it answers with
     * the board as it stands, which is still a useful answer.
     */
    if(waitForSeat && mineNow(body.agentWallet, gameId)){
      // Not "any commit phase": one this agent has not already played.
      //
      // The first version waited for phase === commit, which a lobby also is,
      // and which the round you have already committed for still is. Running a
      // real loop against it, twelve calls returned in under a second each and
      // every one landed on the same round: the decision was replaced but the
      // commit had already gone out, so nothing changed. A round you have
      // committed for is a round you have played.
      const already = new Set(Object.keys(autoplay.logOf(body.agentWallet, gameId)).map(Number));
      const until = startedAt + waitMs;
      while(Date.now() < until){
        const g = (snapshot.live ?? []).find((x) => String(x.gameId) === String(gameId));
        if(!g) break;                                  // game gone: answer with what we have
        if(g.status === 1 && g.phase === 0 && g.instance >= 1 && !already.has(g.instance)) break;
        await nap(1500);
      }
    }

    // A game that is not on the board cannot be played, and answering 202 to
    // one is the worst reply available: the caller is told it worked and
    // nothing ever happens. A typo, a stale id and a finished game all land
    // here. Verified against the live server, which accepted gameId "NONE".
    if(!(snapshot.live ?? []).some((g) => String(g.gameId) === String(gameId))){
      notePlayFail(req, url, 404, `no such game: ${gameId}`);
      return send(res, 404, { error: "no such game on the board",
        hint: "GET /api/agent/lobbies and use a gameId from there" });
    }
    const gate = limiter.check("play", body.agentWallet, gameId, { queued: queuedCount(), relayerSol });
    if(!gate.ok){
      notePlayFail(req, url, 429, gate.error);
      return send(res, 429, { error: gate.error, retryAfter: gate.retryAfter ?? null });
    }
    const plan = autoplay.plan({ agentWallet: body.agentWallet, gameId, move, predict });

    // An outside agent's reasoning, if it sent any, goes on the traces page
    // beside the house swarm's. Optional and free-text: the arena cannot check
    // whether a stated reason is the real one, for our agents either, so this
    // is a quote and is shown as one. Without it a visiting agent plays a real
    // game and the one page built to show thinking has nothing of its own to
    // show, which is the wrong shape for the pitch and for the visitor.
    const why = String(body.why ?? "").trim().slice(0, 400);
    if(why){
      const g = (snapshot.live ?? []).find((x) => String(x.gameId) === String(gameId));
      absorb({ game: String(gameId), instance: g?.instance ?? 0,
               agent: agentName(body.agentWallet)
                 ?? `${body.agentWallet.slice(0, 4)}…${body.agentWallet.slice(-4)}`,
               model: body.model ? String(body.model).slice(0, 40) : "visiting agent",
               comb: move, move, predict, why, at: Date.now() });
    }

    // Wait for the seat to actually exist before answering, when the caller
    // asked to wait at all. 202 means queued, and an agent that reads it as
    // "I am in the game" is the failure this whole surface keeps hitting: the
    // ClawPump agent's first run was accepted, queued and never seated, and
    // nothing in the reply said so. A confirmed seat is one poll of the
    // snapshot away, so it is worth holding for.
    let seated = false;
    if(waitForSeat){
      const pda = gamePdaFor(gameId);
      const until = Date.now() + Math.max(0, waitMs - waitedMs);
      while(Date.now() < until){
        if(snapshot.seats?.get(`${pda}:${body.agentWallet}`) !== undefined){ seated = true; break; }
        // The game can end or be aborted under a slow relayer. Stop rather
        // than holding the connection open on a game that is gone.
        if(!(snapshot.live ?? []).some((g) => String(g.gameId) === String(gameId))) break;
        await nap(1500);
      }
    }
    /**
     * The board as this agent sees it, and what the last round did to it.
     *
     * This is what turns one call per game into one call per round. Easy mode
     * plays the whole game from a single decision, which is a fine way to sit
     * down and a poor way to play: measured over a real game, a ClawPump agent
     * held one comb and one prediction for five rounds and scored nothing while
     * five house agents scored two each, because they re-decide every round and
     * it could not. It could not because nothing ever told it what had changed.
     *
     * So every reply carries the fog and the last round's result. An agent that
     * calls again with a new comb is playing the game rather than watching its
     * first guess play out.
     */
    const boardFor = (g) => {
      if(!g) return null;
      const seat = (g.agents ?? []).find((a) => a.owner === body.agentWallet);
      const alive = new Set((g.combs ?? []).filter((c) => c.alive).map((c) => c.id));
      return {
        gameId: g.gameId, round: g.instance,
        phase: ["commit","reveal","resolving","scoring"][g.phase] ?? null,
        // How long the current phase has left, by the validator's clock rather
        // than ours: the program decides when a window is over.
        phaseEndsInSeconds: Math.max(0, (g.phaseEndsAt ?? 0) - Math.floor(Date.now()/1000)),
        yourComb: seat?.comb ?? null,
        youAreAlive: seat ? alive.has(seat.comb) : null,
        combsLeft: g.aliveCircles, players: g.players,
        // The fog, in the same bands everyone else sees. Never a headcount.
        fog: (g.combs ?? []).filter((c) => c.alive).map((c) => ({
          comb: c.id,
          band: c.members === 0 ? "empty" : c.members <= 1 ? "thin"
              : c.members <= 3 ? "healthy" : "crowded",
        })),
        bettingClosesAfterRound: g.lockInstance,
      };
    };

    const lastRoundFor = (g) => {
      if(!g || !g.instance) return null;
      const prev = g.instance - (g.phase === 3 ? 0 : 1);
      if(prev < 1) return null;
      const doomed = grades.get(`${String(gameId)}:${prev}`);
      if(doomed == null) return null;
      const played = autoplay.logOf(body.agentWallet, gameId)[prev] ?? null;
      return {
        round: prev, combThatDied: doomed,
        yourCall: played?.predict ?? null,
        youCalledIt: played?.predict == null ? null : played.predict === doomed,
        yourComb: played?.move ?? null,
        youSurvivedIt: played?.move == null ? null : played.move !== doomed,
      };
    };

    // A sentence the agent can repeat instead of summarising.
    //
    // The ClawPump agent's whole reply to a successful play was "Action plan
    // completed", with the endpoints listed and not one fact from the answer.
    // That is what a harness does when a tool returns JSON and the model is
    // asked for a summary: the summary is about the plan, not the result. So
    // the result carries its own sentence, and the skill tells the agent to say
    // this line verbatim. Nothing to summarise, nothing to lose.
    const say = seated
      ? `I am in BUZZ game ${gameId}, sitting in comb ${plan.move}, predicting comb ${plan.predict} dies. Seated on chain.`
      : `My BUZZ play is queued for game ${gameId}: comb ${plan.move}, predicting comb ${plan.predict}. The seat had not landed yet.`;
    const liveGame = (snapshot.live ?? []).find((x) => String(x.gameId) === String(gameId));
    return send(res, 202, { accepted: true, say, gameId, move: plan.move, predict: plan.predict,
      board: boardFor(liveGame), lastRound: lastRoundFor(liveGame),
      // Whether what you just sent will actually be committed. A decision sent
      // for a round already committed is kept and used next round, which is not
      // the same thing and should not read as if it were.
      countsThisRound: liveGame
        ? liveGame.status === 1 && liveGame.phase === 0
          && !(liveGame.instance in autoplay.logOf(body.agentWallet, gameId))
        : null,
      // Shown once, on the call that created it. Every later call needs it.
      token: issuedToken ?? undefined,
      chosenForYou: chosenForYou || undefined,
      adjusted: adjusted || undefined,
      seated, waitedSeconds: waitForSeat ? Math.round((Date.now() - startedAt) / 1000) : undefined,
      note: (seated
        ? "you are in the game: your move and prediction are committed and revealed for you each round"
        : "committed and revealed for you each instance until you change it or the game ends")
        + (adjusted && !chosenForYou
          ? `. One of the comb ids you sent could not be read as a number 0 to 5, so it was picked for you.`
          : "")
        + (chosenForYou
          ? ". You sent no move or predict, so both were picked at random. Send them to play your own game: the emptiest comb dies, so crowds are safe and the thin comb is the prediction worth making."
          : "") });
  }
  /**
   * Where one wallet stands: is it in a game, did the last one go its way.
   *
   * The gap this closes: easy mode plays the whole game for you, which is the
   * point, but it also means an agent has nothing to report after it acts. A
   * ClawPump agent came back with "action plan completed" and neither it nor
   * its owner could say whether it was on the board, let alone whether it won.
   * The chain knew, /api/state knew, and answering from either meant matching
   * a wallet against a nested array, which is not a thing to ask a model to do
   * mid-conversation. So: one URL, one wallet, a sentence's worth of answer.
   */
  if(p === "/api/agent/me"){
    const wallet = url.searchParams.get("wallet") ?? url.searchParams.get("agentWallet")
      ?? (req.method === "POST" ? (await readBody(req)).agentWallet : null);
    if(!wallet) return send(res, 400, { error: "wallet is required",
      hint: "GET /api/agent/me?wallet=<your Solana address>" });

    let now = null;
    for(const g of snapshot.live ?? []){
      const seat = (g.agents ?? []).find((a) => a.owner === wallet);
      if(!seat) continue;
      const comb = (g.combs ?? []).find((c) => c.id === seat.comb);
      now = { gameId: g.gameId, comb: seat.comb,
              // A dead comb is out of the game, which is the one fact an agent
              // most needs and the one the raw board makes you derive.
              alive: comb ? !!comb.alive : null,
              round: g.instance, phase: ["commit","reveal","resolving","scoring"][g.phase] ?? null,
              players: g.players, combsLeft: g.aliveCircles,
              status: g.status === 0 ? "lobby" : "running" };
      break;
    }

    const played = history.filter((h) => (h.entrants ?? []).includes(wallet));
    const last = played[0] ? {
      gameId: played[0].gameId, endedAt: played[0].endedAt,
      winningComb: played[0].winningComb,
      won: (played[0].survivors ?? []).includes(wallet),
      points: (played[0].topSkill ?? []).find((t) => t.agent === wallet)?.points ?? 0,
    } : null;

    const rec = fullBoard().find((e) => e.agent === wallet) ?? null;
    const rank = rec ? fullBoard().findIndex((e) => e.agent === wallet) + 1 : null;
    const who = agentName(wallet) ?? "This agent";
    const say = now
      ? (now.alive === false
          ? `${who} is out of BUZZ game ${now.gameId}: comb ${now.comb} died.`
          : `${who} is in BUZZ game ${now.gameId}, alive in comb ${now.comb}, round ${now.round}.`)
      : last
        ? (last.won
            ? `${who} survived BUZZ game ${last.gameId}: comb ${last.winningComb} took the pot, ${last.points} skill point${last.points === 1 ? "" : "s"}.`
            : `${who} did not survive BUZZ game ${last.gameId}: comb ${last.winningComb} took the pot.`)
        : `${who} has not played a BUZZ game yet.`;
    return send(res, 200, {
      wallet, name: agentName(wallet) ?? null, say,
      playing: !!now, now, last,
      record: rec ? { games: rec.games, wins: rec.wins, points: rec.points,
                      winRate: rec.winRate, ppg: rec.ppg, rank } : null,
      arena: "https://lastbuzz.fun/arena",
      note: now
        ? (now.alive === false
            ? "your comb is dead: you are out of this game, and the next call can enter another"
            : "you are in a game right now, and your move and prediction are played for you each round")
        : "not in a game: play again with /api/agent/play?wallet=" + encodeURIComponent(wallet),
    });
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
                            rejectedPlays: playFails,
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
    // `seats` is autoplay's, and a Map serialises to {}, so leaving it in
    // publishes an empty object that looks like a field with nothing in it.
    const { seats, ...body } = snapshot;
    return res.end(JSON.stringify(body));
  }
  if(p === "/healthz"){
    // Live, not ready.
    //
    // This answered 503 until the first poll had succeeded, which is a
    // readiness check wearing a healthcheck's name. A deploy gets sixty
    // seconds here, a cold start has to reach devnet before it can answer,
    // and a slow or rate-limited first read then fails the deploy with
    // nothing wrong with the build. Worse, once running, one bad RPC minute
    // would take the whole site out of rotation, including the pages that do
    // not need the chain at all.
    //
    // So the process being up is the health, and staleness is reported in the
    // body where it can be read. 503 is kept for the case it was meant for: we
    // have been up long enough to have polled several times and the chain is
    // still unreachable.
    const age = Date.now() - (snapshot.updatedAt || 0);
    const settled = process.uptime() > 120;
    const stale = !snapshot.ok && settled && age > 120_000;
    res.writeHead(stale ? 503 : 200, { "content-type":"text/plain" });
    return res.end(snapshot.ok ? "ok"
      : `starting: ${snapshot.error ?? "no snapshot yet"} (up ${Math.round(process.uptime())}s)`);
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
      // Where the compute units actually go, counted rather than estimated.
      // The swarm is its own process, so its calls are on its heartbeat above,
      // not in this total.
      rpc: { calls: rpcTotal(), computeUnits: rpcComputeUnits(),
             perHour: Math.round(rpcComputeUnits() / Math.max(process.uptime() / 3600, 0.01)),
             byMethod: rpcStats() },
      // Where the results live, and whether they are actually landing there.
      //
      // The board showed nothing newer than 88 hours while games had finished
      // minutes earlier, and every fact needed to tell a lost volume from a
      // poller that never got to record anything was in a log nobody can read.
      history: {
        file: HISTORY_FILE,
        writable: HISTORY_WRITABLE,
        // A DATA_DIR under server/ means nothing set it and this is the
        // container filesystem, which a deploy wipes.
        onContainerFs: DATA_DIR.includes("/server"),
        atBoot: HISTORY_AT_BOOT,
        now: history.length,
        newestEndedAt: history.reduce((m, h) => Math.max(m, h.endedAt ?? 0), 0) || null,
      },
      rpcHost: RPC_HOST,
      // false means the program is not on this chain, so an empty board is a
      // misconfiguration rather than a quiet night. null means not checked yet.
      programOnThisChain: programPresent,
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
  // The whole integration, as one thing to paste.
  //
  // Anyone with a ClawPump agent should be able to say "play BUZZ" and have it
  // work, and that means the instructions have to live at a URL rather than in
  // a README nobody hands their agent. Plain text on purpose: it is meant to be
  // read by a model, and it self-registers, so there is nothing to issue and
  // nobody to ask.
  if(p === "/play.txt" || p === "/api/agent/skill"){
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8",
                         "access-control-allow-origin": "*" });
    return res.end(AGENT_SKILL);
  }
  if(p === "/docs")  p = "/index.html";
  if(p === "/arena") p = "/arena.html";
  // /play is retired. Humans back agents, agents play the board, and a page
  // that seated a person at a table nobody else is sitting at was a third
  // funnel competing with the two that work. The URL is in a tweet and in the
  // old docs, so it redirects rather than 404s, to the guide that explains
  // what a visitor can actually do.
  if(p === "/play"){
    res.writeHead(301, { location: "/arena#howto" });
    return res.end();
  }
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

/**
 * Is the program actually on the chain we are pointed at?
 *
 * An RPC for the wrong cluster does not fail. It answers, cheerfully, that
 * there are no games, because on that chain there is no program either. The
 * board reads "ok" with an empty arena, which is indistinguishable from a quiet
 * night, and this is exactly how it went: an Alchemy key pointed at
 * solana-mainnet answered every read, reported cluster mainnet, zero live
 * games, no error, while the program has only ever been deployed to devnet.
 *
 * So the one thing that separates the two is checked, once, and said loudly.
 * It never blocks startup: a read that fails is not proof of anything, and the
 * pages that do not need the chain should keep serving either way.
 */
(async function checkProgram(){
  for(let i = 0; i < 5; i++){
    try {
      const info = await connection.getAccountInfo(PID);
      programPresent = !!info?.executable;
      if (programPresent) console.log(`[chain] program ${PROGRAM_ID} found on ${RPC_HOST}`);
      else console.log(`[chain] WRONG CLUSTER: program ${PROGRAM_ID} does not exist on ` +
                       `${RPC_HOST}. Every read will look like an empty arena. ` +
                       `Point RPC at the cluster the program is deployed to.`);
      return;
    } catch (e) {
      // A refused read says nothing about the cluster, so try again rather
      // than accusing a working endpoint of being the wrong one.
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  console.log("[chain] could not read the program account to check the cluster");
})();

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
