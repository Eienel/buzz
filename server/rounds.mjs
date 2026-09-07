// The round book: a market on which comb dies THIS round.
//
// The game book asks one question per game and answers it eight minutes later,
// and it shuts halfway through. A spectator who arrives late has nothing to do
// but watch, and one who arrives early gets a single decision for the whole
// visit. This asks a question every round, on the one fact the game turns on,
// and settles it sixty seconds later.
//
// Everything here is permissionless on chain. This process cranks it because
// somebody has to and we are already awake; if it dies, anyone can send the
// same instructions, and the money is safe either way (see voidRound below).

import anchorPkg from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const { BN } = anchorPkg;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[round]", ...a);

/** Phases, as the program numbers them. */
const COMMIT = 0, SCORING = 3;

export function makeRounds({ program, payer, connection }) {
  const PID = program.programId;
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PID)[0];
  const gamePda = (id) => pda(Buffer.from("game"), new BN(id).toArrayLike(Buffer, "le", 8));
  const roundPda = (game, instance) =>
    pda(Buffer.from("round"), game.toBuffer(), Buffer.from(new Uint16Array([instance]).buffer));
  const rvaultPda = (r) => pda(Buffer.from("rvault"), r.toBuffer());

  // Books this process has opened or found, so a tick does not re-send an
  // instruction the chain has already accepted. The account itself is the real
  // guard: open_round is `init`, so a second one is rejected.
  const open = new Map();              // "<gameId>:<instance>" -> true
  const settled = new Set();
  // Books that are decided and whose rent is therefore owed back. A book is
  // only removed once it is actually closed, or once closing it has failed
  // enough times that retrying is just noise.
  const closable = new Map();          // key -> attempts
  let busy = false;

  const tokenProgramFor = async (mint) => {
    const acc = await connection.getAccountInfo(new PublicKey(mint));
    return acc?.owner ?? TOKEN_2022_PROGRAM_ID;
  };

  /** Open the book for the round this game is in, during its commit phase. */
  async function openFor(g) {
    const key = `${g.gameId}:${g.instance}`;
    if (open.has(key)) return;
    const game = gamePda(g.gameId);
    const round = roundPda(game, g.instance);
    // Already there is the common case after a restart, and finding out costs
    // one account read against one failed transaction.
    if (await connection.getAccountInfo(round)) { open.set(key, true); return; }
    try {
      await program.methods.openRound().accountsPartial({
        game, round, roundVault: rvaultPda(round),
        stakeMint: new PublicKey(g.stakeMint), payer: payer.publicKey,
        tokenProgram: await tokenProgramFor(g.stakeMint),
        systemProgram: SystemProgram.programId,
      }).rpc();
      open.set(key, true);
      log(`opened ${g.gameId} round ${g.instance}`);
    } catch (e) {
      const m = String(e.message ?? e);
      if (/already in use|custom program error: 0x0/.test(m)) { open.set(key, true); return; }
      // The game moved on between the snapshot and the send. Next round.
      if (!/WrongPhase|BadParam/.test(m)) log(`open ${key}: ${m.slice(0, 80)}`);
    }
  }

  /**
   * Record which comb died, while the game is still on that round.
   *
   * `doomed_circle` is one field the game overwrites every instance, so this is
   * only truthful during the round it describes. Missing that window is not a
   * disaster, it is a refund: see voidFor.
   */
  async function settleFor(g) {
    const key = `${g.gameId}:${g.instance}`;
    if (settled.has(key) || !open.has(key)) return;
    const game = gamePda(g.gameId);
    try {
      await program.methods.settleRound()
        .accountsPartial({ game, round: roundPda(game, g.instance) }).rpc();
      closable.set(key, 0);
      settled.add(key);
      log(`settled ${g.gameId} round ${g.instance}, comb ${g.doomed} died`);
    } catch (e) {
      const m = String(e.message ?? e);
      if (/AlreadyClaimed/.test(m)) { settled.add(key); return; }
      if (!/WrongPhase/.test(m)) log(`settle ${key}: ${m.slice(0, 80)}`);
    }
  }

  /**
   * Refund a book nobody settled in time.
   *
   * Without this a missed crank strands every stake in the round vault for
   * good. A book that can eat your money when this server has a bad minute is
   * not a book anyone should use, and this server has had several bad minutes.
   */
  async function voidFor(gameId, instance) {
    const key = `${gameId}:${instance}`;
    if (settled.has(key)) return;
    const game = gamePda(gameId);
    try {
      await program.methods.voidRound()
        .accountsPartial({ game, round: roundPda(game, instance) }).rpc();
      settled.add(key);
      closable.set(key, 0);
      log(`voided ${key}: nobody settled it in time, every stake refunded`);
    } catch (e) {
      const m = String(e.message ?? e);
      if (/AlreadyClaimed|WrongPhase/.test(m)) settled.add(key);
      else log(`void ${key}: ${m.slice(0, 80)}`);
    }
  }

  /**
   * Give a decided book's rent back.
   *
   * This is the half that did not exist when the round book was first turned
   * on, and its absence is the whole reason it had to be turned off again:
   * open_round inits a RoundMarket and a token vault every round of every
   * game, and in one day that was 2217 accounts and about 9 SOL that nothing
   * could reclaim. A book that costs rent per round needs its reaper on the
   * same tick that opens it, not in a script somebody remembers to run.
   *
   * Closing is attempted rather than scheduled, because the program decides
   * whether it is allowed: close_round refuses while the vault still holds
   * tokens, which is exactly the window where bettors have positions they have
   * not claimed. So a book with money still in it fails here and is tried
   * again next tick, and that failure is the safety property working.
   */
  async function closeFor(key) {
    const [gameId, instStr] = key.split(":");
    const game = gamePda(gameId);
    const round = roundPda(game, Number(instStr));
    const vault = rvaultPda(round);
    try {
      const acc = await connection.getAccountInfo(vault);
      // Already gone: somebody else closed it, which is the permissionless
      // design working rather than a problem.
      if (!acc) { closable.delete(key); open.delete(key); return; }
      await program.methods.closeRound().accountsPartial({
        round, roundVault: vault, cranker: payer.publicKey,
        tokenProgram: acc.owner,
      }).rpc();
      closable.delete(key); open.delete(key);
      log(`closed ${key}, rent back`);
    } catch (e) {
      const m = String(e.message ?? e);
      // Bettors still hold stakes here. Not an error, just not yet.
      if (/ConservationViolated/.test(m)) { closable.set(key, 0); return; }
      const tries = (closable.get(key) ?? 0) + 1;
      // Ten ticks of the same refusal is a book this process cannot close, and
      // saying so once beats saying so forever.
      if (tries >= 10) {
        closable.delete(key);
        log(`close ${key}: giving up after ${tries}: ${m.slice(0, 70)}`);
        return;
      }
      closable.set(key, tries);
    }
  }

  return {
    /** Read one round's book for the page. Null when there is none. */
    async read(gameId, instance) {
      const game = gamePda(gameId);
      const round = roundPda(game, instance);
      const acc = await connection.getAccountInfo(round);
      if (!acc) return null;
      let r;
      try { r = program.coder.accounts.decode("roundMarket", acc.data); } catch { return null; }
      const pools = (r.pools ?? []).map((n) => n.toString());
      return {
        round: r.instance,
        pools,
        totalPool: r.totalPool.toString(),
        bettors: r.bettors,
        // 255 is "not decided". Exposed as null, because a comb id of 255 on a
        // six comb board reads as data rather than as absence.
        doomed: r.doomed === 255 ? null : r.doomed,
        settled: r.settled, void: r.void,
        market: round.toBase58(), vault: rvaultPda(round).toBase58(),
        stakeMint: r.stakeMint.toBase58(),
      };
    },
    roundPdaFor: (gameId, instance) => roundPda(gamePda(gameId), instance).toBase58(),

    async once(snapshot) {
      if (busy) return;
      busy = true;
      try {
        const live = (snapshot?.live ?? []).filter((g) => g.status === 1 && g.instance >= 1);
        for (const g of live) {
          if (g.phase === COMMIT) await openFor(g);
          // Scoring means the comb is dead and the death is on chain, which is
          // the only phase where the answer is both known and still current.
          if (g.phase === SCORING) await settleFor(g);
        }
        // Anything opened for a round the board has moved past, and never
        // settled, is refunded rather than left to rot.
        const at = new Map(live.map((g) => [String(g.gameId), g.instance]));
        for (const key of open.keys()) {
          if (settled.has(key)) continue;
          const [gameId, instStr] = key.split(":");
          const inst = Number(instStr);
          const now = at.get(gameId);
          if (now === undefined || now > inst) await voidFor(gameId, inst);
        }
        // Hand back the rent on everything already decided. A few per tick:
        // the tick runs every 2.5 seconds and there is no hurry, and closing a
        // whole backlog in one pass is how a sweep earns a rate limit.
        for (const key of [...closable.keys()].slice(0, 4)) await closeFor(key);
      } catch (e) {
        log("tick:", String(e.message ?? e).slice(0, 100));
      } finally { busy = false; }
    },
  };
}
