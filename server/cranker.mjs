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

export function makeCranker({ program, payer }) {
  const PID = program.programId;
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
        if (g.status !== 1) continue;                  // lobbies start themselves
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
