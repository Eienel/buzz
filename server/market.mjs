// The book: open one on every running game, and decide it when the game does.
//
// Both halves are permissionless on chain, which is deliberate: anyone can open
// a book and anyone can resolve one, so a spectator's bet does not depend on us
// staying alive. This module is just the thing that makes sure somebody does it
// promptly, the same way the cranker is not the only party allowed to crank.
//
// Nothing here can touch a game. open_market and resolve_target read the game
// and write only to market accounts, so the worst a bug in this file can do is
// leave a book unopened or undecided. It cannot cost a player their pot.

import anchorPkg from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

const { BN } = anchorPkg;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[book]", ...a);

/**
 * How far into a game betting stays open.
 *
 * A comb dies every instance, so a book left open to the end would let somebody
 * buy a near-certainty at full odds off the backs of everyone who committed
 * while it was still a question. Two instances is enough time for a spectator to
 * see the board and still early enough that most of the field is alive.
 */
const LOCK_AFTER = Number(process.env.MARKET_LOCK_AFTER ?? 2);

export function makeMarket({ program, payer, connection }) {
  const PID = program.programId;
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PID)[0];
  const gamePda = (id) => pda(Buffer.from("game"), new BN(id).toArrayLike(Buffer, "le", 8));
  const marketPda = (g) => pda(Buffer.from("market"), g.toBuffer());
  const mvaultPda = (m) => pda(Buffer.from("mvault"), m.toBuffer());
  const playerPda = (g, o) => pda(Buffer.from("player"), g.toBuffer(), o.toBuffer());
  const circlePda = (g, id) => pda(Buffer.from("circle"), g.toBuffer(), Buffer.from([id]));

  // Games whose book we have already opened or found, and what we need to know
  // to decide them later. The real guard against opening twice is the account
  // itself (open_market is `init`, so a second one is rejected), this only
  // avoids paying for that lesson on every tick.
  //
  // It is a map rather than a set because a settled game leaves `live`, and the
  // settling list the cranker uses only carries games that still owe the
  // treasury their rake. A book on a game whose fees were already swept would
  // otherwise appear in neither list and never be decided, which strands every
  // bet on it: claim_bet needs `settled`, and `settled` needs every target
  // resolved. So the book remembers its own games until they are finished.
  const watching = new Map();   // gameId -> numCircles
  let busy = false;

  const tokenProgramFor = async (mint) => {
    const acc = await connection.getAccountInfo(new PublicKey(mint));
    // Both stake mints happen to be Token-2022, but the rent recovery already
    // paid once for assuming that, so it is read rather than assumed.
    return acc?.owner ?? new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  };

  async function openFor(g) {
    if (watching.has(g.gameId)) return;
    const game = gamePda(g.gameId);
    const market = marketPda(game);
    // A book that already exists is the common case after a restart, and
    // finding out costs one account read against one failed transaction.
    if (await connection.getAccountInfo(market)) { watching.set(g.gameId, g.numCircles ?? 6); return; }
    const lock = (g.instance ?? 0) + LOCK_AFTER;
    try {
      await program.methods.openMarket(lock).accountsPartial({
        game, market, marketVault: mvaultPda(market),
        stakeMint: new PublicKey(g.stakeMint), payer: payer.publicKey,
        tokenProgram: await tokenProgramFor(g.stakeMint),
        systemProgram: SystemProgram.programId,
      }).rpc();
      watching.set(g.gameId, g.numCircles ?? 6);
      log(`opened on ${g.gameId}, bets close after instance ${lock}`);
    } catch (e) {
      const m = String(e.message ?? e);
      // Somebody else opened it first. That is the design working.
      if (/already in use|custom program error: 0x0/.test(m)) { watching.set(g.gameId, g.numCircles ?? 6); return; }
      // The game moved on between the snapshot and the send. Next tick.
      if (!/WrongPhase|BadParam/.test(m)) log(`open ${g.gameId}: ${m.slice(0, 80)}`);
    }
  }

  /** Every TargetPool on this book that still needs deciding. */
  async function unresolvedPools(market) {
    const disc = program.coder.accounts.memcmp("targetPool").bytes;
    const raw = await connection.getProgramAccounts(PID, {
      filters: [{ memcmp: { offset: 0, bytes: disc } },
                { memcmp: { offset: 8, bytes: market.toBase58() } }],
    });
    const out = [];
    for (const { pubkey, account } of raw) {
      try {
        const p = program.coder.accounts.decode("targetPool", account.data);
        if (!p.resolved) out.push({ pubkey, target: p.target });
      } catch { /* a layout we do not recognise is not ours to decide */ }
    }
    return out;
  }

  /** The comb still standing, which is how the program reads a survivor. */
  async function winningComb(game, numCircles) {
    for (let id = 0; id < numCircles; id++) {
      const acc = await connection.getAccountInfo(circlePda(game, id));
      if (!acc) continue;
      try {
        const c = program.coder.accounts.decode("circle", acc.data);
        if (c.alive) return id;
      } catch { /* stale layout from an older deploy */ }
    }
    return null;
  }

  async function resolveFor(gameId, numCircles) {
    const game = gamePda(gameId);
    const market = marketPda(game);
    const acc = await connection.getAccountInfo(market);
    if (!acc) { watching.delete(gameId); return; }      // no book on this game
    let m;
    try { m = program.coder.accounts.decode("market", acc.data); }
    catch { watching.delete(gameId); return; }
    if (m.settled) { watching.delete(gameId); return; }
    // Nobody bet. There is nothing to decide and no payout to unblock, so the
    // book is finished even though `settled` stays false: settled means the
    // denominator is final, and with no targets there is no denominator.
    if (m.targets === 0) { watching.delete(gameId); return; }

    const pools = await unresolvedPools(market);
    if (!pools.length) { watching.delete(gameId); return; }
    const comb = await winningComb(game, numCircles);
    if (comb == null) return;                          // not decided yet, try again

    for (const p of pools) {
      try {
        await program.methods.resolveTarget().accountsPartial({
          game, market, targetPool: p.pubkey,
          targetPlayer: playerPda(game, p.target),
          winningCircle: circlePda(game, comb),
          cranker: payer.publicKey,
        }).rpc();
      } catch (e) {
        const m2 = String(e.message ?? e);
        if (!/AlreadyClaimed|WrongPhase/.test(m2))
          log(`resolve ${gameId} ${p.target.toBase58().slice(0, 8)}: ${m2.slice(0, 70)}`);
      }
    }
    log(`decided ${pools.length} backed agent(s) on ${gameId}, comb ${comb} survived`);
  }

  return {
    /** Read a book for the page. Null when there is none. */
    async read(gameId) {
      const game = gamePda(gameId);
      const market = marketPda(game);
      const acc = await connection.getAccountInfo(market);
      if (!acc) return null;
      let m;
      try { m = program.coder.accounts.decode("market", acc.data); } catch { return null; }
      const pools = {};
      const disc = program.coder.accounts.memcmp("targetPool").bytes;
      const raw = await connection.getProgramAccounts(PID, {
        filters: [{ memcmp: { offset: 0, bytes: disc } },
                  { memcmp: { offset: 8, bytes: market.toBase58() } }],
      });
      for (const { account } of raw) {
        try {
          const p = program.coder.accounts.decode("targetPool", account.data);
          pools[p.target.toBase58()] = {
            total: p.total.toString(), resolved: p.resolved, won: p.won };
        } catch { /* not ours */ }
      }
      return {
        market: market.toBase58(),
        vault: mvaultPda(market).toBase58(),
        stakeMint: m.stakeMint.toBase58(),
        totalPool: m.totalPool.toString(),
        winningPool: m.winningPool.toString(),
        lockInstance: m.lockInstance,
        targets: m.targets, resolved: m.resolved, settled: m.settled,
        pools,
      };
    },
    marketPdaFor: (gameId) => marketPda(gamePda(gameId)).toBase58(),
    /** What the book is tracking, for /healthz-style visibility. */
    watching: () => watching.size,
    async once(snapshot) {
      if (busy) return;
      busy = true;
      try {
        const running = new Set();
        for (const g of snapshot?.live ?? []) {
          if (g.status !== 1) continue;
          running.add(g.gameId);
          await openFor(g);
        }
        // Anything we hold a book on that is no longer running has either
        // settled or gone away, and both want the same call: try to decide it,
        // and stop watching once there is nothing left to decide.
        for (const [gameId, numCircles] of [...watching]) {
          if (running.has(gameId)) continue;
          await resolveFor(gameId, numCircles);
        }
      } catch (e) {
        log("tick:", String(e.message ?? e).slice(0, 100));
      } finally { busy = false; }
    },
  };
}
