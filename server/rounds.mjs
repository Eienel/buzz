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
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
         createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";

const { BN } = anchorPkg;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[round]", ...a);

/** Phases, as the program numbers them. */
const COMMIT = 0, SCORING = 3;

/** How often to ask the chain what we have forgotten. See reconcile(). */
const RECONCILE_MS = Number(process.env.ROUND_RECONCILE_MS ?? 5 * 60_000);

/** How long to leave a book alone when its bettors have not claimed yet. */
const CLAIM_WAIT_MS = Number(process.env.ROUND_CLAIM_WAIT_MS ?? 60_000);

/**
 * The house takes the other side of the first bet in a round.
 *
 * A parimutuel with one participant pays that participant their own stake back:
 * they are the whole winning pool and the whole total pool, so the ratio is 1.
 * Measured, not reasoned: two real bets have ever been placed on this arena and
 * both returned exactly what went in. That is the round book's arrival problem,
 * and no amount of marketing fixes a market that cannot pay.
 *
 * The game book solves this by seeding every backable agent when the book
 * opens. The round book cannot copy that, and the reason is worth writing down
 * so nobody tries: RoundBet is seeded [b"rbet", round, bettor], one position
 * per bettor per round, and place_round_bet enforces `bet.comb == comb`. One
 * identity can therefore hold exactly one comb. Seeding every comb would take
 * one distinct identity per comb, those identities hold no key, and
 * close_round_bet sends rent to the bettor, so their rent would be stranded at
 * 0.00105 SOL a seat. At five combs across four games every sixty seconds that
 * is about 30 SOL a day burnt into keyless accounts, which is the same rent
 * leak this file already has a comment about, for the third time.
 *
 * So the house matches instead of seeding: nothing is staked until a real
 * bettor is in the book, and then the house puts the same size on the emptiest
 * living comb, which is the one that most improves what that bettor collects if
 * they are right. It costs nothing on an empty arena, which is the arena we
 * have, and it turns the market on the moment somebody shows up.
 *
 * The house here is the relayer's own key rather than the game book's keyless
 * HOUSE, for the rent reason above: the payer funds the position and
 * close_round_bet hands it back to the same account. The arena says which comb
 * the house is on and how much, because a counterparty that is not disclosed is
 * just an operator betting against its users.
 *
 * ROUND_HOUSE_MATCH=0 turns it off.
 */
const MATCH_MAX = Number(process.env.ROUND_HOUSE_MATCH ?? 5);

/**
 * How often to ask a live book whether anyone has bet into it.
 *
 * The tick runs every 2.5 seconds and a round lasts sixty, so asking every tick
 * would be twenty-four account reads per round per game to learn "still nobody"
 * twenty-three times. This arena already runs at 75 requests a second and that
 * is its most pressing cost, so the match is worth a few seconds of latency.
 */
const MATCH_POLL_MS = Number(process.env.ROUND_MATCH_POLL_MS ?? 10_000);

export function makeRounds({ program, payer, connection }) {
  const PID = program.programId;
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PID)[0];
  const gamePda = (id) => pda(Buffer.from("game"), new BN(id).toArrayLike(Buffer, "le", 8));
  const roundPda = (game, instance) =>
    pda(Buffer.from("round"), game.toBuffer(), Buffer.from(new Uint16Array([instance]).buffer));
  const rvaultPda = (r) => pda(Buffer.from("rvault"), r.toBuffer());
  const rbetPda = (r, bettor) => pda(Buffer.from("rbet"), r.toBuffer(), bettor.toBuffer());
  const combPda = (g, id) => pda(Buffer.from("circle"), g.toBuffer(), Buffer.from([id]));
  // The program takes this as proof we are allowed to act for a bettor who
  // holds no key, the same way the game book's claims do.
  const relayerPda = pda(Buffer.from("relayer"), payer.publicKey.toBuffer());

  // Books this process has opened or found, so a tick does not re-send an
  // instruction the chain has already accepted. The account itself is the real
  // guard: open_round is `init`, so a second one is rejected.
  // Everything here is keyed by the round account's own address, which is the
  // book's identity. Two key spaces was a bug: reconcile keyed by game pubkey
  // and the tick by game id, so reconcile re-adopted books already being
  // tracked, closed them under the other key, and the tick then asked to void
  // a closed account on every pass forever.
  const open = new Map();              // round pubkey -> { gameId, instance }
  const settled = new Set();
  // Rounds the house has already matched into, so a tick does not stack a
  // second position on the same book. Keyed by the round account, like
  // everything else here.
  const matched = new Set();
  // When each open book was last asked whether a bettor had turned up.
  const lastLook = new Map();          // round pubkey -> ms
  // Books that are decided and whose rent is therefore owed back. A book is
  // only removed once it is actually closed, or once closing it has failed
  // enough times that retrying is just noise.
  const closable = new Map();          // key -> { round, tries }
  // Books adopted from a previous run, so reconcile does not re-send a void
  // every time it sweeps.
  const adoptedKeys = new Set();
  // First sweep happens on the first tick, because a restart is exactly when
  // there is something to adopt.
  let lastReconcile = 0;
  let busy = false;

  const tokenProgramFor = async (mint) => {
    const acc = await connection.getAccountInfo(new PublicKey(mint));
    return acc?.owner ?? TOKEN_2022_PROGRAM_ID;
  };

  /** Open the book for the round this game is in, during its commit phase. */
  async function openFor(g) {
    const game = gamePda(g.gameId);
    const round = roundPda(game, g.instance);
    const key = round.toBase58();
    if (open.has(key)) return;
    // Already there is the common case after a restart, and finding out costs
    // one account read against one failed transaction.
    if (await connection.getAccountInfo(round)) {
      open.set(key, { gameId: String(g.gameId), instance: g.instance });
      return;
    }
    try {
      await program.methods.openRound().accountsPartial({
        game, round, roundVault: rvaultPda(round),
        stakeMint: new PublicKey(g.stakeMint), payer: payer.publicKey,
        tokenProgram: await tokenProgramFor(g.stakeMint),
        systemProgram: SystemProgram.programId,
      }).rpc();
      open.set(key, { gameId: String(g.gameId), instance: g.instance });
      log(`opened ${g.gameId} round ${g.instance}`);
    } catch (e) {
      const m = String(e.message ?? e);
      if (/already in use|custom program error: 0x0/.test(m)) {
        open.set(key, { gameId: String(g.gameId), instance: g.instance });
        return;
      }
      // The game moved on between the snapshot and the send. Next round.
      if (!/WrongPhase|BadParam/.test(m)) log(`open ${key}: ${m.slice(0, 80)}`);
    }
  }

  /**
   * Take the other side of the first real bet in this round.
   *
   * Reads the book rather than trusting the tick: `bettors` and `pools` are the
   * chain's own count, so a bet placed by anyone, through the page or straight
   * at the program, is what triggers this. Nothing is staked on an empty book.
   *
   * See MATCH_MAX above for why this matches rather than seeding every comb.
   */
  async function matchFor(g, round, key) {
    if (MATCH_MAX <= 0 || matched.has(key)) return;
    if (Date.now() - (lastLook.get(key) ?? 0) < MATCH_POLL_MS) return;
    lastLook.set(key, Date.now());
    const acc = await connection.getAccountInfo(round);
    if (!acc) return;
    let r;
    try { r = program.coder.accounts.decode("roundMarket", acc.data); } catch { return; }
    if (r.settled || r.void) { matched.add(key); return; }
    // Only a real bettor opens the position. Our own match would otherwise
    // qualify the next tick and the house would trade with itself forever.
    if (r.bettors < 1) return;
    const pools = (r.pools ?? []).map((n) => BigInt(n.toString()));
    const alive = (g.combs ?? []).filter((c) => c.alive !== false && c.id < (g.numCircles ?? 6))
                                 .map((c) => c.id);
    const comb = houseComb(pools, alive);
    if (comb === null) { matched.add(key); return; }
    // Match the size that is already in the book, capped: the point is to make
    // the first bettor's ticket pay, not to outweigh them.
    const decimals = await decimalsOf(g.stakeMint);
    const staked = Number(pools.reduce((a, b) => a + b, 0n)) / 10 ** decimals;
    const amount = Math.min(MATCH_MAX, Math.max(1, Math.round(staked)));
    matched.add(key);                 // before the send: one attempt per round
    try {
      await placeAs(g, round, comb, amount, decimals);
      log(`matched ${g.gameId} round ${g.instance}: ${amount} on comb ${comb}`);
    } catch (e) {
      log(`match ${key.slice(0, 8)}: ${String(e.message ?? e).slice(0, 70)}`);
    }
  }

  const decimalsCache = new Map();
  async function decimalsOf(mint) {
    const k = String(mint);
    if (!decimalsCache.has(k)) {
      decimalsCache.set(k, (await connection.getTokenSupply(new PublicKey(mint))).value.decimals);
    }
    return decimalsCache.get(k);
  }

  /** Put the house's own money on one comb of one round. */
  async function placeAs(g, round, comb, amount, decimals) {
    const game = gamePda(g.gameId);
    const mint = new PublicKey(g.stakeMint);
    const tokenProgram = await tokenProgramFor(mint);
    const units = new BN(String(BigInt(Math.round(amount)) * 10n ** BigInt(decimals)));
    // Bettor and payer are the same key on purpose: close_round_bet returns the
    // position's rent to the bettor, so anything else strands it. See MATCH_MAX.
    const me = payer.publicKey;
    const myToken = getAssociatedTokenAddressSync(mint, me, false, tokenProgram);
    return program.methods.placeRoundBet(comb, units).accountsPartial({
      game, round, roundVault: rvaultPda(round),
      circle: combPda(game, comb),
      roundBet: rbetPda(round, me),
      payerToken: myToken,
      bettor: me, payer: me, relayer: relayerPda,
      stakeMint: mint, tokenProgram, systemProgram: SystemProgram.programId,
    }).rpc();
  }

  /**
   * Record which comb died, while the game is still on that round.
   *
   * `doomed_circle` is one field the game overwrites every instance, so this is
   * only truthful during the round it describes. Missing that window is not a
   * disaster, it is a refund: see voidFor.
   */
  async function settleFor(g) {
    const game = gamePda(g.gameId);
    const round = roundPda(game, g.instance);
    const key = round.toBase58();
    if (settled.has(key) || !open.has(key)) return;
    try {
      await program.methods.settleRound()
        .accountsPartial({ game, round: roundPda(game, g.instance) }).rpc();
      closable.set(key, { round, tries: 0 });
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
    const game = gamePda(gameId);
    const round = roundPda(game, instance);
    const key = round.toBase58();
    if (settled.has(key)) return;
    try {
      await program.methods.voidRound()
        .accountsPartial({ game, round }).rpc();
      settled.add(key);
      closable.set(key, { round, tries: 0 });
      log(`voided ${key}: nobody settled it in time, every stake refunded`);
    } catch (e) {
      const m = String(e.message ?? e);
      // Gone already means somebody closed it, which is the permissionless
      // design working: drop it rather than asking about it forever.
      if (/AccountNotInitialized/.test(m)) { settled.add(key); open.delete(key); return; }
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
    const entry = closable.get(key);
    if (!entry?.round) { closable.delete(key); return; }
    // A book waiting on its bettors does not need asking every 2.5 seconds.
    if (entry.after && Date.now() < entry.after) return;
    const { round } = entry;
    const vault = rvaultPda(round);
    try {
      const acc = await connection.getAccountInfo(vault);
      // Already gone: somebody else closed it, which is the permissionless
      // design working rather than a problem.
      if (!acc) { closable.delete(key); open.delete(key); matched.delete(key); lastLook.delete(key); return; }
      // Positions first, and this order is the whole point. close_round_bet
      // derives `round` from seeds, so once the book is closed every RoundBet
      // on it is unreachable and its rent is gone for good. Measured on devnet
      // before this existed: both RoundBets that have ever been placed on this
      // arena are orphaned exactly this way, 0.0021 SOL that nothing can now
      // recover. Nothing called close_round_bet at all, which is the same
      // omission claim_round_bet had, in the same file.
      await closeBetsFor(round);
      await program.methods.closeRound().accountsPartial({
        round, roundVault: vault, cranker: payer.publicKey,
        tokenProgram: acc.owner,
      }).rpc();
      closable.delete(key); open.delete(key);
      matched.delete(key); lastLook.delete(key);
      log(`closed ${key}, rent back`);
    } catch (e) {
      const m = String(e.message ?? e);
      // Bettors still hold stakes here. Not an error, just not yet, so it
      // keeps its place in the queue but stops being asked on every tick: an
      // unclaimed book would otherwise cost two RPC calls every 2.5 seconds
      // for as long as it went unclaimed, which is the sort of quiet spend
      // that only shows up on the bill.
      if (/ConservationViolated/.test(m)) {
        closable.set(key, { round, tries: 0, after: Date.now() + CLAIM_WAIT_MS });
        return;
      }
      const tries = (closable.get(key)?.tries ?? 0) + 1;
      // Ten ticks of the same refusal is a book this process cannot close, and
      // saying so once beats saying so forever.
      if (tries >= 10) {
        closable.delete(key);
        log(`close ${key}: giving up after ${tries}: ${m.slice(0, 70)}`);
        return;
      }
      closable.set(key, { round, tries });
    }
  }

  /**
   * Hand back the rent on every settled position in one book.
   *
   * Only claimed positions: close_round_bet demands the bettor's signature to
   * close one that has not claimed, which is the program refusing to let a
   * cranker forfeit somebody's ticket on their behalf. sweepClaims marks them,
   * including losing tickets, so in the normal course everything here is
   * closable by the time a book is.
   *
   * Rent goes to the bettor, which for the house's own match is the payer that
   * funded it. Failures are logged and dropped: the book still wants closing,
   * and a position we could not close is one bettor's rent rather than a stuck
   * crank.
   */
  async function closeBetsFor(round) {
    let bets;
    try {
      bets = await connection.getProgramAccounts(PID, {
        filters: [{ memcmp: { offset: 0, bytes: program.coder.accounts.memcmp("roundBet").bytes } },
                  { memcmp: { offset: 8, bytes: round.toBase58() } }],
      });
    } catch (e) { log(`bets on ${round.toBase58().slice(0, 8)}: ${String(e.message ?? e).slice(0, 60)}`); return 0; }
    let closed = 0, held = 0;
    for (const { pubkey, account } of bets) {
      let bet;
      try { bet = program.coder.accounts.decode("roundBet", account.data); } catch { continue; }
      if (!bet.claimed) { held++; continue; }
      try {
        await program.methods.closeRoundBet().accountsPartial({
          round, roundBet: pubkey, bettor: bet.bettor, cranker: payer.publicKey,
        }).rpc();
        closed++;
      } catch (e) {
        log(`close bet ${pubkey.toBase58().slice(0, 8)}: ${String(e.message ?? e).slice(0, 60)}`);
      }
    }
    if (closed || held)
      log(`${round.toBase58().slice(0, 8)}: closed ${closed} position${closed === 1 ? "" : "s"}` +
          (held ? `, ${held} unclaimed and left alone` : ""));
    return closed;
  }

  /**
   * Adopt books this process did not open.
   *
   * Everything above is driven by `open`, which is in memory, so a restart
   * forgets every book in flight. The board moves on, those books are never
   * settled, never voided and never closed, and nothing ever looks at them
   * again: the reaper only reaps what it opened in this run.
   *
   * Measured rather than reasoned: killing the ticker mid-game and restarting
   * it left a book at round 3 sitting there while the restarted process opened
   * and closed rounds 4 and 5 around it. One orphan per in-flight game per
   * restart, and a deploy is a restart.
   *
   * So the chain is asked directly, on a slow timer. getProgramAccounts is the
   * most expensive call we make and the only one that can answer "what exists
   * that I have forgotten", which is why this runs every few minutes rather
   * than every tick.
   */
  async function reconcile() {
    const raw = await connection.getProgramAccounts(PID, {
      filters: [{ memcmp: { offset: 0, bytes: program.coder.accounts.memcmp("roundMarket").bytes } }],
    });
    let adopted = 0;
    for (const { pubkey, account } of raw) {
      let r;
      try { r = program.coder.accounts.decode("roundMarket", account.data); } catch { continue; }
      const key = pubkey.toBase58();
      if (closable.has(key) || adoptedKeys.has(key)) continue;
      adoptedKeys.add(key);
      adopted++;
      // Decided already: it only needs its rent handing back.
      if (r.settled || r.void) { closable.set(key, { round: pubkey, tries: 0 }); continue; }
      // Undecided and forgotten. void_round refuses while the game is still on
      // this round, which is the guard against voiding a live book, so a book
      // the board has not passed yet simply fails here and is retried.
      try {
        await program.methods.voidRound()
          .accountsPartial({ game: r.game, round: pubkey }).rpc();
        closable.set(key, { round: pubkey, tries: 0 });
        log(`adopted and voided ${key}`);
      } catch { adoptedKeys.delete(key); adopted--; }
    }
    if (adopted) log(`adopted ${adopted} book${adopted === 1 ? "" : "s"} left by a previous run`);
  }

  /**
   * Pay the winners of decided rounds without being asked.
   *
   * claim_round_bet existed and nothing called it: no route, no sweep, no
   * control on the page. A winning round bet could therefore never be
   * collected, and because close_round refuses while the vault holds tokens,
   * one unclaimed win also pinned its book open forever. The game book already
   * learned this: eleven of its first thirteen winning bets went unclaimed,
   * because people do not come back to press a button for money they are
   * already owed.
   *
   * The claim pays to the bettor's own token account and nowhere else, which
   * the program enforces, so doing it on their behalf can only put money where
   * it was already going.
   *
   * Works from the round accounts alone. ClaimRoundBet seeds from round.game
   * and carries its own stake_mint, so a book whose game has been reaped still
   * pays out, which is exactly when a bettor would otherwise be stranded.
   */
  async function sweepClaims() {
    const bets = await connection.getProgramAccounts(PID, {
      filters: [{ memcmp: { offset: 0, bytes: program.coder.accounts.memcmp("roundBet").bytes } }],
    });
    let paid = 0;
    for (const { pubkey, account } of bets) {
      let bet;
      try { bet = program.coder.accounts.decode("roundBet", account.data); } catch { continue; }
      if (bet.claimed) continue;
      const roundAcc = await connection.getAccountInfo(bet.round).catch(() => null);
      if (!roundAcc) continue;
      let r;
      try { r = program.coder.accounts.decode("roundMarket", roundAcc.data); } catch { continue; }
      if (!r.settled && !r.void) continue;                  // not decided yet
      // A losing bet has nothing to collect. Claiming it would still mark it
      // claimed, which is what lets its book close, so it is worth doing.
      try {
        const tokenProgram = await tokenProgramFor(r.stakeMint);
        const bettorToken = getAssociatedTokenAddressSync(r.stakeMint, bet.bettor, true, tokenProgram);
        await program.methods.claimRoundBet().accountsPartial({
          round: bet.round, roundVault: rvaultPda(bet.round), roundBet: pubkey,
          bettorToken, bettor: bet.bettor, payer: payer.publicKey, relayer: relayerPda,
          stakeMint: r.stakeMint, tokenProgram,
        }).preInstructions([createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, bettorToken, bet.bettor, r.stakeMint, tokenProgram)]).rpc();
        paid++;
      } catch (e) {
        const m = String(e.message ?? e);
        if (!/AlreadyClaimed/.test(m)) log(`claim ${pubkey.toBase58().slice(0, 8)}: ${m.slice(0, 70)}`);
      }
    }
    if (paid) log(`settled ${paid} round bet${paid === 1 ? "" : "s"} for their bettors`);
    return paid;
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
      // What of this is ours. A counterparty that is not disclosed is just an
      // operator betting against its users, so the page is given the number
      // rather than left to infer it. Absent when the house is not in.
      let house = null;
      try {
        const mine = await connection.getAccountInfo(rbetPda(round, payer.publicKey));
        if (mine) {
          const b = program.coder.accounts.decode("roundBet", mine.data);
          house = { comb: b.comb, amount: b.amount.toString() };
        }
      } catch { /* the disclosure is best effort; the pools are the truth */ }
      return {
        round: r.instance,
        pools,
        house,
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
    sweepClaims,
    roundPdaFor: (gameId, instance) => roundPda(gamePda(gameId), instance).toBase58(),

    async once(snapshot) {
      if (busy) return;
      busy = true;
      try {
        const live = (snapshot?.live ?? []).filter((g) => g.status === 1 && g.instance >= 1);
        for (const g of live) {
          if (g.phase === COMMIT) {
            await openFor(g);
            // Only while the round still takes bets, and only once a real
            // bettor is in the book. See MATCH_MAX.
            const round = roundPda(gamePda(g.gameId), g.instance);
            if (open.has(round.toBase58())) await matchFor(g, round, round.toBase58());
          }
          // Scoring means the comb is dead and the death is on chain, which is
          // the only phase where the answer is both known and still current.
          if (g.phase === SCORING) await settleFor(g);
        }
        // Anything opened for a round the board has moved past, and never
        // settled, is refunded rather than left to rot.
        const at = new Map(live.map((g) => [String(g.gameId), g.instance]));
        for (const [key, where] of open) {
          if (settled.has(key)) continue;
          const now = at.get(where.gameId);
          if (now === undefined || now > where.instance)
            await voidFor(where.gameId, where.instance);
        }
        // Hand back the rent on everything already decided. A few per tick:
        // the tick runs every 2.5 seconds and there is no hurry, and closing a
        // whole backlog in one pass is how a sweep earns a rate limit.
        for (const key of [...closable.keys()].slice(0, 4)) await closeFor(key);
        // And pick up anything a previous run left behind. Slow on purpose:
        // getProgramAccounts is the most expensive call we make, and the books
        // it finds have already been sitting there, so a few minutes more
        // costs nothing.
        if (Date.now() - lastReconcile > RECONCILE_MS) {
          lastReconcile = Date.now();
          await reconcile();
        }
      } catch (e) {
        log("tick:", String(e.message ?? e).slice(0, 100));
      } finally { busy = false; }
    },
  };
}

/**
 * Which comb the house takes, given the money already in the book.
 *
 * The emptiest living comb, lowest id breaking ties. Mechanical and published
 * so nobody has to take our word for it, and it is the choice that pays the
 * bettor most if they are right: their ticket is worth
 * `stake * total / winning`, so money on a comb that is not theirs is the only
 * thing that makes it worth more than the stake itself.
 *
 * Null when there is nothing to take: no living comb, or the book already has
 * money spread over every one of them, in which case it needs no help.
 */
export function houseComb(pools, alive) {
  if (!alive?.length) return null;
  const empty = alive.filter((id) => (pools[id] ?? 0n) === 0n);
  if (!empty.length) return null;
  return empty[0];
}
