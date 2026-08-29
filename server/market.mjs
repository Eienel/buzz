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
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync,
         createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";

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
  const tpoolPda = (m, t) => pda(Buffer.from("tpool"), m.toBuffer(), t.toBuffer());
  const betPda = (m, b, t) => pda(Buffer.from("bet"), m.toBuffer(), b.toBuffer(), t.toBuffer());
  const backablePda = (t) => pda(Buffer.from("backable"), t.toBuffer());
  // The book already runs on the relayer key, so this is the allow-list entry
  // that lets it act for a bettor. claim_bet checks it and nothing else.
  const relayerPda = pda(Buffer.from("relayer"), payer.publicKey.toBuffer());

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

  /**
   * Pay out every decided bet, without asking the bettor to come back.
   *
   * The first weekend the book was live, twelve wallets placed thirteen bets
   * and eleven of them won. Not one was ever claimed. Nobody had misunderstood
   * the game: they had done the hard part, found the arena, worked out the
   * mechanic and staked, and then been asked to return to a devnet page a
   * second time to collect. That is where the funnel broke, so the step goes
   * away.
   *
   * Safe because it cannot pay anybody but the bettor. claim_bet sends the
   * payout to the bettor's own associated token account, derived on chain from
   * the Bet's own bettor field, and resolve_delegate lets the relayer sign for
   * them without ever being able to redirect a token. The worst this can do is
   * spend our own fees paying somebody what they are already owed.
   *
   * Losing bets are claimed too. The payout is zero either way, and marking one
   * claimed is what lets close_bet return its rent to them later.
   */
  async function claimBets(market, m, bets) {
    let paid = 0, zero = 0;
    const mint = m.stakeMint;
    const tokenProgram = await tokenProgramFor(mint);
    for (const b of bets) {
      if (b.claimed) continue;
      const bettorToken = getAssociatedTokenAddressSync(mint, b.bettor, true, tokenProgram);
      const win = Number(m.winningPool), total = Number(m.totalPool);
      const won = poolWon.has(tpoolPda(market, b.target).toBase58());
      const payout = win === 0 ? Number(b.amount) : won ? Number(b.amount) * total / win : 0;
      try {
        // A bettor who paid with their own wallet already has this account, and
        // a relayer bettor got one when they staked. Created anyway when it is
        // missing, because the alternative to spending the rent is not paying
        // them at all.
        if (!(await connection.getAccountInfo(bettorToken))) {
          await program.provider.sendAndConfirm(new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(
              payer.publicKey, bettorToken, b.bettor, mint, tokenProgram)), []);
        }
        await program.methods.claimBet().accountsPartial({
          market, marketVault: mvaultPda(market),
          targetPool: tpoolPda(market, b.target), bet: b.pubkey,
          bettorToken, bettor: b.bettor,
          payer: payer.publicKey, relayer: relayerPda,
          stakeMint: mint, tokenProgram,
        }).rpc();
        if (payout > 0) paid++; else zero++;
      } catch (e) {
        const msg = String(e.message ?? e);
        // AccountNotInit: the pool is gone, so this bet can never be claimed.
        // Only reachable for bets whose pool an older reaper closed early.
        if (!/AlreadyClaimed|WrongPhase|AccountNotInit/.test(msg))
          log(`claim ${b.bettor.toBase58().slice(0, 8)}: ${msg.slice(0, 70)}`);
      }
    }
    if (paid || zero) log(`paid ${paid} winning bet(s), closed out ${zero} losing`);
    return paid;
  }

  // Which pools won, filled by sweepClaims before it claims so claimBets can
  // tell a payout from a write-off without another round trip per bet.
  const poolWon = new Map();

  /**
   * Find every decided bet nobody has claimed, anywhere, and pay it.
   *
   * Scans rather than tracks. A bet can outlive the tick that would have
   * noticed it: the server restarts, a book settles while we are not watching,
   * a payout fails once on a rate limit. The scan is three getProgramAccounts
   * calls and it is the only thing that makes a winner eventually get paid
   * regardless of what happened in between.
   */
  async function sweepClaims() {
    const load = async (name) => {
      const raw = await connection.getProgramAccounts(PID, {
        filters: [{ memcmp: { offset: 0, bytes: program.coder.accounts.memcmp(name).bytes } }],
      });
      const out = [];
      for (const { pubkey, account } of raw) {
        try { out.push({ pubkey, ...program.coder.accounts.decode(name, account.data) }); }
        catch { /* an older layout is not ours to pay */ }
      }
      return out;
    };
    const [bets, pools, markets] = await Promise.all(
      [load("bet"), load("targetPool"), load("market")]);
    poolWon.clear();
    for (const p of pools) if (p.resolved && p.won) poolWon.set(p.pubkey.toBase58(), true);

    const byMarket = new Map();
    for (const b of bets) {
      if (b.claimed) continue;
      const k = b.market.toBase58();
      if (!byMarket.has(k)) byMarket.set(k, []);
      byMarket.get(k).push(b);
    }
    if (!byMarket.size) return 0;

    let paid = 0;
    for (const m of markets) {
      // settled means the denominator is final. Claiming before that would be
      // pricing a bet against a pool that is still moving.
      if (!m.settled) continue;
      const mine = byMarket.get(m.pubkey.toBase58());
      if (mine?.length) paid += await claimBets(m.pubkey, m, mine);
    }
    return paid;
  }

  return {
    /** Pay out everything decided and unclaimed. Safe to call at any time. */
    sweepClaims,
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
      // The page formats these, and it cannot know how without being told:
      // BUZZ is six decimals, not the nine that is everyone's reflex, so a
      // hardcoded divisor rendered a 45 token pool as "0.045".
      let decimals = 6;
      try { decimals = (await connection.getTokenSupply(m.stakeMint)).value.decimals; } catch {}
      return {
        market: market.toBase58(),
        vault: mvaultPda(market).toBase58(),
        stakeMint: m.stakeMint.toBase58(),
        decimals,
        totalPool: m.totalPool.toString(),
        winningPool: m.winningPool.toString(),
        lockInstance: m.lockInstance,
        targets: m.targets, resolved: m.resolved, settled: m.settled,
        pools,
      };
    },
    marketPdaFor: (gameId) => marketPda(gamePda(gameId)).toBase58(),

    /**
     * Who is reading the agents best, computed from chain.
     *
     * Deliberately not from a ledger we keep. A prize decided by a number only
     * we can produce is a number people have to trust; this one anybody can
     * recompute from the same three account types and check against the payout
     * transaction. Every Bet carries its bettor, target and amount, every
     * TargetPool says whether that target survived, and the Market carries the
     * two totals the parimutuel divides by.
     *
     * Only decided books count. An open bet is not a result yet, and counting
     * it would rank people on positions rather than on outcomes.
     */
    async bettors() {
      const load = async (name) => {
        const raw = await connection.getProgramAccounts(PID, {
          filters: [{ memcmp: { offset: 0, bytes: program.coder.accounts.memcmp(name).bytes } }],
        });
        const out = [];
        for (const { pubkey, account } of raw) {
          try { out.push({ pubkey, ...program.coder.accounts.decode(name, account.data) }); }
          catch { /* an older layout is not ours to score */ }
        }
        return out;
      };
      const [bets, pools, markets] = await Promise.all(
        [load("bet"), load("targetPool"), load("market")]);
      const poolBy = new Map(pools.map((p) => [p.pubkey.toBase58(), p]));
      const marketBy = new Map(markets.map((m) => [m.pubkey.toBase58(), m]));
      const poolFor = (marketKey, target) =>
        poolBy.get(tpoolPda(new PublicKey(marketKey), target).toBase58());

      const by = new Map();
      let graded = 0;
      for (const b of bets) {
        const m = marketBy.get(b.market.toBase58());
        if (!m) continue;
        const pool = poolFor(b.market.toBase58(), b.target);
        if (!pool || !pool.resolved) continue;          // not a result yet
        const stake = Number(b.amount);
        const total = Number(m.totalPool), win = Number(m.winningPool);
        // Mirrors claim_bet exactly, including the refund branch: a book where
        // nobody backed a survivor hands everyone their stake back, which is a
        // break-even, not a loss.
        const payout = win === 0 ? stake : pool.won ? Math.floor(stake * total / win) : 0;
        const k = b.bettor.toBase58();
        const r = by.get(k) ?? { bettor: k, bets: 0, hits: 0, staked: 0, returned: 0 };
        r.bets += 1; r.hits += pool.won ? 1 : 0;
        r.staked += stake; r.returned += payout;
        by.set(k, r);
        graded += 1;
      }
      const bettors = [...by.values()].map((r) => ({
        ...r,
        pnl: r.returned - r.staked,
        hitRate: r.bets ? r.hits / r.bets : null,
      // Ranked on PnL, because hit rate alone rewards backing the favourite
      // every time, which a parimutuel already pays badly for. Hit rate is
      // shown next to it so a big number with two bets behind it is visible
      // as exactly that.
      })).sort((a, b) => b.pnl - a.pnl || b.hitRate - a.hitRate);
      // Bets can span mints, so the amounts are reported in the units they were
      // staked in along with the decimals for each, rather than summed into a
      // single number that would be adding ANSEM to BUZZ.
      const decimalsBy = {};
      for (const m of markets) {
        const k = m.stakeMint.toBase58();
        if (k in decimalsBy) continue;
        try { decimalsBy[k] = (await connection.getTokenSupply(m.stakeMint)).value.decimals; }
        catch { decimalsBy[k] = 6; }
      }
      return { on: true, bettors, graded, books: markets.length,
               decimals: Math.min(...Object.values(decimalsBy), 6) };
    },

    /**
     * An unsigned place_bet transaction for somebody with their own wallet.
     *
     * Built here rather than in the page so there is one definition of the
     * accounts this instruction takes. The browser needs no Anchor, no borsh
     * and no discriminators: it deserializes, hands it to the wallet, and the
     * wallet sends it. Nothing is signed on this side, and the only key that
     * can move the tokens is the one in the user's wallet.
     */
    async buildBet({ gameId, target, bettor, amount }) {
      const game = gamePda(gameId);
      const market = marketPda(game);
      const t = new PublicKey(target), b = new PublicKey(bettor);
      const g = await program.account.game.fetch(game);
      const mint = g.stakeMint;
      const tokenProgram = (await connection.getAccountInfo(mint)).owner;
      const decimals = (await connection.getTokenSupply(mint)).value.decimals;
      const units = new BN(String(BigInt(Math.round(Number(amount))) * 10n ** BigInt(decimals)));

      // Whether this wallet can actually pay, checked here rather than
      // discovered by the wallet at signing time.
      //
      // getAssociatedTokenAddressSync only derives an address, it does not ask
      // whether the account exists, so this happily built a transaction for a
      // wallet holding none of the stake token and handed it to the user to
      // sign. Phantom would then fail on a simulated transfer from an account
      // that is not there, which is both the most likely first-bet outcome and
      // the least actionable error. The stake is a token we mint on devnet, so
      // an empty wallet is the normal case, not the edge one.
      const payerToken = getAssociatedTokenAddressSync(mint, b, false, tokenProgram);
      const acc = await connection.getAccountInfo(payerToken);
      const held = acc ? BigInt((await connection.getTokenAccountBalance(payerToken)).value.amount) : 0n;
      if (held < BigInt(units.toString())) {
        return { needsFunding: true, held: held.toString(), required: units.toString(), decimals };
      }

      const tx = await program.methods.placeBet(units).accountsPartial({
        game, market, marketVault: mvaultPda(market),
        targetPlayer: playerPda(game, t), backable: backablePda(t),
        targetPool: tpoolPda(market, t), bet: betPda(market, b, t),
        payerToken,
        bettor: b, payer: b, relayer: null,
        stakeMint: mint, tokenProgram, systemProgram: SystemProgram.programId,
      }).transaction();
      tx.feePayer = b;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      return {
        tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        mint: mint.toBase58(), decimals,
        payerToken: payerToken.toBase58(),
      };
    },
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
