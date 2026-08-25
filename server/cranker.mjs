// Advances any running game, not just the ones this process started.
//
// Every phase transition is permissionless by design, but nothing was actually
// exercising that: the swarm cranked the games it created and no one cranked
// the rest. So a swarm restart stranded every game in flight, and an outside
// agent that had joined one was stuck with it. On a hosted arena that is the
// difference between a game and a trap.
//
// It is deliberately not clever. It reads the phase, calls the one crank that
// phase allows, and lets the program reject anything it got wrong: every crank
// is guarded on chain, so a wrong guess costs a failed transaction and nothing
// else.

import anchorPkg from "@coral-xyz/anchor";
import { PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";

const { BN } = anchorPkg;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[crank]", ...a);
const LOBBY_TIMEOUT = 3600;
// A lobby that has enough combs and has sat this long is not still filling, it
// is orphaned. Long enough that a healthy swarm always wins the race to its own
// startGame, short enough that stakes are not parked for an hour.
const STRANDED_AFTER = Number(process.env.STRANDED_AFTER ?? 120);
// Mirrors MIN_CIRCLES in lib.rs: below this, start_game refuses.
const MIN_CIRCLES = 4;          // mirrors LOBBY_TIMEOUT_SECONDS in lib.rs

export function makeCranker({ program, payer, starter }) {
  const PID = program.programId;
  const warnedAuth = new Set();
  const pda = (...s) => PublicKey.findProgramAddressSync(s, PID)[0];
  const gamePda = (id) => pda(Buffer.from("game"), new BN(id).toArrayLike(Buffer, "le", 8));
  const combPda = (g, i) => pda(Buffer.from("circle"), g.toBuffer(), Buffer.from([i]));
  let busy = false;

  async function once(snapshot) {
    if (busy) return;
    busy = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      for (const g of snapshot.live ?? []) {
        // A lobby only starts itself while the process that opened it is still
        // alive. Every deploy that lands between createGame and startGame
        // strands one forever, and they pile up: the arena was advertising 20
        // live games when 2 were being played. Aborting is permissionless an
        // hour in, and it lets the deposits be reclaimed.
        if (g.status === 0) {
          // Aborting is the last resort, not the first. A stranded lobby
          // usually has players and their stakes in it: the swarm created the
          // game, agents joined, and the process died before startGame. Those
          // deposits sit locked for the whole timeout for no reason, because
          // the game is perfectly startable. The cranker signs with the same
          // key the swarm creates games with, so it is that game's authority
          // and can start it.
          if (g.aliveCircles >= MIN_CIRCLES && now >= g.createdAt + STRANDED_AFTER) {
            // start_game is has_one = authority, so only the key that created
            // the game can start it. The cranker signs as the relayer, and the
            // swarm creates with PAYER: two different keys. Rescuing a swarm
            // lobby therefore needs the swarm's own key, and without it the
            // attempt is pointless rather than merely unlucky.
            const signer = starter ?? payer;
            try {
              await program.methods.startGame()
                .accountsPartial({ game: gamePda(g.gameId), authority: signer.publicKey })
                .signers(signer === payer ? [] : [signer]).rpc();
              log(`game ${g.gameId}: lobby stranded ${Math.round((now - g.createdAt) / 60)}m with ` +
                  `${g.players} players, started`);
              continue;
            } catch (e) {
              const m = String(e.message ?? e);
              // Unauthorized used to be swallowed here, which hid the fact that
              // this rescue could never fire at all. Say it once per game.
              if (/Unauthorized/.test(m)) {
                if (!warnedAuth.has(g.gameId)) {
                  warnedAuth.add(g.gameId);
                  log(`start ${g.gameId}: not this key's game to start (no PAYER for the rescue)`);
                }
              } else if (!/WrongPhase|NotEnoughCircles/.test(m)) {
                log(`start ${g.gameId}: ${m.slice(0, 70)}`);
              }
            }
          }
          if (now < g.createdAt + LOBBY_TIMEOUT) continue;
          try {
            await program.methods.abortLobby()
              .accountsPartial({ game: gamePda(g.gameId), cranker: payer.publicKey }).rpc();
            log(`game ${g.gameId}: lobby abandoned ${Math.round((now - g.createdAt) / 60)}m, aborted`);
          } catch (e) {
            const m = String(e.message ?? e);
            if (!/TooEarly|WrongPhase/.test(m)) log(`abort ${g.gameId}: ${m.slice(0, 70)}`);
          }
          continue;
        }
        if (g.status !== 1) continue;
        if (now < g.phaseEndsAt) continue;             // the window is still open
        const game = gamePda(g.gameId);
        const alive = (g.combs ?? []).filter((c) => c.alive).map((c) => c.id);
        try {
          if (g.phase === 0) {
            await program.methods.advanceToReveal()
              .accountsPartial({ game, cranker: payer.publicKey }).rpc();
          } else if (g.phase === 1) {
            if (alive.length < 2) continue;
            await program.methods.selectDeath()
              .accountsPartial({ game, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
                                 randomness: null, cranker: payer.publicKey })
              // every alive comb must be presented, or the minimum is gameable
              .remainingAccounts(alive.map((i) => ({
                pubkey: combPda(game, i), isSigner: false, isWritable: false })))
              .rpc();
          } else if (g.phase === 2) {
            await program.methods.executeDeath(g.doomed)
              .accountsPartial({ game, circle: combPda(game, g.doomed), cranker: payer.publicKey }).rpc();
            log(`game ${g.gameId}: comb ${g.doomed} died`);
          } else {
            await program.methods.advanceInstance()
              .accountsPartial({ game, cranker: payer.publicKey }).rpc();
          }
        } catch (e) {
          const m = String(e.message ?? e);
          // PhaseNotOver and WrongPhase are the normal outcome of racing the
          // swarm to the same crank. Anything else is worth seeing.
          if (!/PhaseNotOver|WrongPhase|TooEarly|AlreadyClaimed/.test(m)) {
            log(`game ${g.gameId} phase ${g.phase}: ${m.slice(0, 110)}`);
          }
        }
      }
    } finally { busy = false; }
  }

  return { once };
}
