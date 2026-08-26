// Opens games on a published clock, and nothing else.
//
// The swarm used to create the games it played. That coupling is what strands
// lobbies: a lobby only starts itself while the process that opened it is
// alive, so every deploy landing between createGame and startGame leaves one
// behind holding other people's stakes. It also made the board unreadable,
// because how many games exist was an accident of how many swarm slots times
// tempos times assets happened to be running.
//
// Here creation is a schedule instead. Slots are fixed points on the wall
// clock, so the next game is a fact the page can state rather than a surprise,
// and concurrency is a number rather than an emergent property.
//
// It never plays. It holds no stake, and if it dies mid-slot the cranker can
// still start what it opened, because starting is guarded on the game itself.

import anchorPkg from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const { BN } = anchorPkg;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[sched]", ...a);

// Mirrors MIN_CIRCLES in lib.rs: start_game refuses below this.
const MIN_CIRCLES = 4;

/**
 * The schedule. One entry per tempo: `every` seconds between openings.
 *
 * Deliberately sparse. Three concurrent games that fill are worth more than
 * fifteen that sit half empty, and an empty lobby is the thing that made the
 * board read as busy when it was not.
 */
const TEMPOS = (process.env.SCHED_TEMPOS ?? "24:120,60:240")
  .split(",").map((s) => {
    const [tempo, every] = s.split(":").map(Number);
    return { tempo, every };
  }).filter((t) => t.tempo > 0 && t.every > 0);

/** A slot is the wall-clock instant a game was due to open. */
const slotFor = (nowMs, everyS) => Math.floor(nowMs / (everyS * 1000)) * everyS * 1000;

/**
 * How many lobbies of one tempo may sit unfilled before the schedule pauses.
 *
 * The schedule alone is open-loop: it opened a game every slot whether or not
 * anything joined the last one. The swarm adopts at most one lobby per game it
 * plays, so when creation outruns adoption the surplus does not disappear, it
 * accumulates. Twenty-one empty lobbies against two running games, each one
 * costing the opener rent, and the board reading as busy when it was not.
 *
 * So the tick is closed-loop now: the clock decides WHEN a game may open, the
 * backlog decides WHETHER. A slot skipped for backpressure is skipped for
 * good, it is not queued, because a queue is how you get the pile-up back.
 */
const MAX_OPEN = Number(process.env.SCHED_MAX_OPEN ?? 1);

export function makeScheduler({ program, payer, assets }) {
  const PID = program.programId;
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PID)[0];
  const configPda = pda(Buffer.from("config"));
  const gamePda = (id) => pda(Buffer.from("game"), new BN(id).toArrayLike(Buffer, "le", 8));
  const vaultPda = (g) => pda(Buffer.from("vault"), g.toBuffer());
  const allowedPda = (mint) => pda(Buffer.from("allowed"), mint.toBuffer());

  // Slots already attempted this process. The real guard against duplicates is
  // the game id itself, which is derived from the slot: a second scheduler
  // computing the same slot builds the same PDA and its createGame is rejected.
  // This just avoids paying for that lesson every tick.
  const tried = new Set();
  let busy = false;

  async function openSlot(t, asset, nowMs, waiting) {
    if (waiting >= MAX_OPEN) {
      // Mark the slot tried anyway: it is past, and a later tick finding the
      // backlog drained should open the CURRENT slot, not backfill this one.
      tried.add(`${asset.name}:${new BN(String(slotFor(nowMs, t.every) + t.tempo)).toString()}`);
      return;
    }
    const slot = slotFor(nowMs, t.every);
    // The id encodes the slot and the tempo, so it is the same number in every
    // process that computes it, and still a plausible millisecond timestamp.
    const gid = new BN(String(slot + t.tempo));
    const key = `${asset.name}:${gid.toString()}`;
    if (tried.has(key)) return;
    tried.add(key);
    const game = gamePda(gid);
    try {
      await program.methods.createGame(gid, 6, t.tempo, false).accountsPartial({
        config: configPda, stakeMint: asset.mint, allowed: allowedPda(asset.mint),
        game, vault: vaultPda(game), authority: payer.publicKey,
        tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId,
      }).rpc();
      log(`opened ${asset.name} ${t.tempo}s game ${gid.toString()}`);
    } catch (e) {
      const m = String(e.message ?? e);
      // Another scheduler got this slot first. That is the design working.
      if (!/already in use|custom program error: 0x0/.test(m))
        log(`open ${gid.toString()}: ${m.slice(0, 80)}`);
    }
  }

  /** Start anything that has filled. Cheap, and it is what makes the schedule real. */
  async function startFilled(snapshot) {
    for (const g of snapshot.live ?? []) {
      if (g.status !== 0) continue;
      if ((g.aliveCircles ?? 0) < MIN_CIRCLES) continue;
      try {
        await program.methods.startGame()
          .accountsPartial({ game: gamePda(g.gameId), authority: payer.publicKey }).rpc();
        log(`started ${g.gameId} with ${g.aliveCircles} combs`);
      } catch (e) {
        const m = String(e.message ?? e);
        if (!/WrongPhase|NotEnoughCircles|Unauthorized/.test(m))
          log(`start ${g.gameId}: ${m.slice(0, 80)}`);
      }
    }
  }

  return {
    /** What is due next, for the page to say so out loud. */
    upcoming(nowMs = Date.now()) {
      return TEMPOS.map((t) => {
        const next = slotFor(nowMs, t.every) + t.every * 1000;
        return { tempo: t.tempo, everySeconds: t.every, opensAt: next,
                 inSeconds: Math.max(0, Math.round((next - nowMs) / 1000)) };
      }).sort((a, b) => a.opensAt - b.opensAt);
    },
    async once(snapshot) {
      if (busy) return;
      busy = true;
      try {
        const now = Date.now();
        // Unfilled lobbies per tempo, from the snapshot the poller just took.
        // A lobby with MIN_CIRCLES combs is not backlog: it is about to start.
        const waiting = new Map();
        for (const g of snapshot?.live ?? []) {
          if (g.status !== 0) continue;
          if ((g.aliveCircles ?? 0) >= MIN_CIRCLES) continue;
          waiting.set(g.instanceSeconds, (waiting.get(g.instanceSeconds) ?? 0) + 1);
        }
        for (const t of TEMPOS) {
          // Ranked play is the point, so the ranked asset gets the schedule and
          // the others ride along less often rather than half the arena being
          // unranked at the moment ranked play became the reason to show up.
          const asset = assets[0];
          await openSlot(t, asset, now, waiting.get(t.tempo) ?? 0);
        }
        await startFilled(snapshot);
      } catch (e) {
        log("tick:", String(e.message ?? e).slice(0, 100));
      } finally { busy = false; }
    },
  };
}
