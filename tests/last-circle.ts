import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LastCircle } from "../target/types/last_circle";
import {
  PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_SLOT_HASHES_PUBKEY,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { keccak_256 } from "js-sha3";
import { assert } from "chai";

// Stakes are SPL tokens now. These helpers mint a test asset, hand it to
// players, and enable it for play, so each suite reads like a real game.

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.LastCircle as Program<LastCircle>;
const authority = provider.wallet as anchor.Wallet;
const conn = provider.connection;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FEE_BPS = 400;
const HOUSE_CUT_BPS = 5000;
const DEC = 6;
const UNIT = 10 ** DEC;
const MIN_STAKE = new anchor.BN(1 * UNIT);
const MAX_STAKE = new anchor.BN(500 * UNIT);

const pda = (...seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const configPda = pda(Buffer.from("config"));
const allowedPda = (mint: PublicKey) => pda(Buffer.from("allowed"), mint.toBuffer());
const treasuryPda = (mint: PublicKey) => pda(Buffer.from("treasury"), mint.toBuffer());
const statsPda = (owner: PublicKey) => pda(Buffer.from("agent"), owner.toBuffer());
const tvaultPda = (mint: PublicKey) => pda(Buffer.from("tvault"), mint.toBuffer());
const gamePda = (gid: anchor.BN) => pda(Buffer.from("game"), gid.toArrayLike(Buffer, "le", 8));
const vaultPda = (g: PublicKey) => pda(Buffer.from("vault"), g.toBuffer());
const combPda = (g: PublicKey, id: number) => pda(Buffer.from("circle"), g.toBuffer(), Buffer.from([id]));
const playerPda = (g: PublicKey, o: PublicKey) => pda(Buffer.from("player"), g.toBuffer(), o.toBuffer());

async function ensureConfig() {
  try {
    await program.methods
      .initializeConfig(FEE_BPS, HOUSE_CUT_BPS, MIN_STAKE, MAX_STAKE, 10, 10000)
      .accountsPartial({ config: configPda, authority: authority.publicKey }).rpc();
  } catch { /* already initialised on a validator re-run */ }
}

/** Create a stake asset, enable it for play, and open its treasury. */
async function newStakeAsset(tokenProgram = TOKEN_PROGRAM_ID) {
  const mint = await createMint(conn, (authority as any).payer, authority.publicKey, null,
    DEC, undefined, undefined, tokenProgram);
  await program.methods.allowMint(true)
    .accountsPartial({ config: configPda, mint, allowed: allowedPda(mint), authority: authority.publicKey })
    .rpc();
  await program.methods.initTreasury()
    .accountsPartial({
      stakeMint: mint, treasury: treasuryPda(mint), treasuryVault: tvaultPda(mint),
      authority: authority.publicKey, tokenProgram, systemProgram: SystemProgram.programId,
    }).rpc();
  return { mint, tokenProgram };
}

/** A funded player holding `amount` of the asset. */
async function newPlayer(mint: PublicKey, tokenProgram: PublicKey, amount = 100 * UNIT) {
  const kp = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL));
  const ata = await getOrCreateAssociatedTokenAccount(conn, (authority as any).payer, mint,
    kp.publicKey, false, undefined, undefined, tokenProgram);
  await mintTo(conn, (authority as any).payer, mint, ata.address, authority.publicKey, amount,
    [], undefined, tokenProgram);
  return { kp, ata: ata.address };
}

const moveHash = (target: number, nonce: anchor.BN, owner: PublicKey, game: PublicKey, instance: number) =>
  Buffer.from(keccak_256.arrayBuffer(Buffer.concat([
    Buffer.from([target]), nonce.toArrayLike(Buffer, "le", 8),
    owner.toBuffer(), game.toBuffer(), Buffer.from(new Uint16Array([instance]).buffer),
  ])));

describe("buzz: token staking", () => {
  it("enables a mint and refuses one that is not allowed", async () => {
    await ensureConfig();
    const { mint, tokenProgram } = await newStakeAsset();
    const a = await program.account.allowedMint.fetch(allowedPda(mint));
    assert.ok(a.enabled, "mint enabled for play");
    assert.equal(a.mint.toBase58(), mint.toBase58());

    // a mint with no AllowedMint account cannot open a game
    const rogue = await createMint(conn, (authority as any).payer, authority.publicKey, null, DEC);
    const gid = new anchor.BN(Date.now());
    const g = gamePda(gid);
    let rejected = false;
    try {
      await program.methods.createGame(gid, 6, 10, false).accountsPartial({
        config: configPda, stakeMint: rogue, allowed: allowedPda(rogue), game: g, vault: vaultPda(g),
        authority: authority.publicKey, tokenProgram, systemProgram: SystemProgram.programId,
      }).rpc();
    } catch (e) { rejected = true; }
    assert.ok(rejected, "unlisted mint cannot open combs");
  });

  it("stakes tokens into a comb and escrows them in the game vault", async () => {
    await ensureConfig();
    const { mint, tokenProgram } = await newStakeAsset();
    const p1 = await newPlayer(mint, tokenProgram);
    const gid = new anchor.BN(Date.now() + 1);
    const g = gamePda(gid);

    await program.methods.createGame(gid, 6, 10, false).accountsPartial({
      config: configPda, stakeMint: mint, allowed: allowedPda(mint), game: g, vault: vaultPda(g),
      authority: authority.publicKey, tokenProgram, systemProgram: SystemProgram.programId,
    }).rpc();

    const stake = new anchor.BN(10 * UNIT);
    await program.methods.createCircle(0, stake).accountsPartial({
      config: configPda, game: g, vault: vaultPda(g), circle: combPda(g, 0),
      player: playerPda(g, p1.kp.publicKey), owner: p1.kp.publicKey, payer: p1.kp.publicKey, relayer: null,
      stakeMint: mint, payerToken: p1.ata, tokenProgram, systemProgram: SystemProgram.programId,
    }).signers([p1.kp]).rpc();

    const vault = await getAccount(conn, vaultPda(g), undefined, tokenProgram);
    assert.equal(Number(vault.amount), 10 * UNIT, "vault escrows the full deposit");

    const comb = await program.account.circle.fetch(combPda(g, 0));
    const expectedNet = (10 * UNIT * (10000 - FEE_BPS)) / 10000;
    assert.equal(comb.totalStake.toNumber(), expectedNet, "net stake = deposit - rake");

    const gs = await program.account.game.fetch(g);
    assert.equal(gs.stakeMint.toBase58(), mint.toBase58(), "game is denominated in the mint");
    assert.equal(gs.feesCollected.toNumber(), 10 * UNIT - expectedNet, "rake recorded");
  });

  it("works with a Token-2022 mint, which is what BUZZ is", async () => {
    await ensureConfig();
    const { mint, tokenProgram } = await newStakeAsset(TOKEN_2022_PROGRAM_ID);
    const p1 = await newPlayer(mint, tokenProgram);
    const gid = new anchor.BN(Date.now() + 2);
    const g = gamePda(gid);

    await program.methods.createGame(gid, 6, 10, false).accountsPartial({
      config: configPda, stakeMint: mint, allowed: allowedPda(mint), game: g, vault: vaultPda(g),
      authority: authority.publicKey, tokenProgram, systemProgram: SystemProgram.programId,
    }).rpc();
    await program.methods.createCircle(0, new anchor.BN(5 * UNIT)).accountsPartial({
      config: configPda, game: g, vault: vaultPda(g), circle: combPda(g, 0),
      player: playerPda(g, p1.kp.publicKey), owner: p1.kp.publicKey, payer: p1.kp.publicKey, relayer: null,
      stakeMint: mint, payerToken: p1.ata, tokenProgram, systemProgram: SystemProgram.programId,
    }).signers([p1.kp]).rpc();

    const vault = await getAccount(conn, vaultPda(g), undefined, tokenProgram);
    assert.equal(Number(vault.amount), 5 * UNIT, "Token-2022 stake escrowed");
  });

  it("refuses deposits past the per-game cap", async () => {
    await ensureConfig();
    const { mint, tokenProgram } = await newStakeAsset();
    const gid = new anchor.BN(Date.now() + 3);
    const g = gamePda(gid);
    await program.methods.createGame(gid, 6, 10, false).accountsPartial({
      config: configPda, stakeMint: mint, allowed: allowedPda(mint), game: g, vault: vaultPda(g),
      authority: authority.publicKey, tokenProgram, systemProgram: SystemProgram.programId,
    }).rpc();

    // MAX_GAME_DEPOSITS is 2_000_000_000 base units; max_stake is 500 * 1e6, so
    // repeated max deposits must eventually be refused rather than accepted.
    let capped = false;
    for (let i = 0; i < 6 && !capped; i++) {
      const p = await newPlayer(mint, tokenProgram, 500 * UNIT);
      try {
        await program.methods.createCircle(i, MAX_STAKE).accountsPartial({
          config: configPda, game: g, vault: vaultPda(g), circle: combPda(g, i),
          player: playerPda(g, p.kp.publicKey), owner: p.kp.publicKey, payer: p.kp.publicKey, relayer: null,
          stakeMint: mint, payerToken: p.ata, tokenProgram, systemProgram: SystemProgram.programId,
        }).signers([p.kp]).rpc();
      } catch (e) { capped = String(e).includes("GameCapReached"); }
    }
    assert.ok(capped, "deposits are refused past the per-game ceiling");
  });

  it("keeps two mints in separate pots", async () => {
    await ensureConfig();
    const a = await newStakeAsset();
    const b = await newStakeAsset();
    const pa = await newPlayer(a.mint, a.tokenProgram);
    const pb = await newPlayer(b.mint, b.tokenProgram);

    const mk = async (asset: any, p: any, salt: number) => {
      const gid = new anchor.BN(Date.now() + 100 + salt);
      const g = gamePda(gid);
      await program.methods.createGame(gid, 6, 10, false).accountsPartial({
        config: configPda, stakeMint: asset.mint, allowed: allowedPda(asset.mint), game: g,
        vault: vaultPda(g), authority: authority.publicKey,
        tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId,
      }).rpc();
      await program.methods.createCircle(0, new anchor.BN(7 * UNIT)).accountsPartial({
        config: configPda, game: g, vault: vaultPda(g), circle: combPda(g, 0),
        player: playerPda(g, p.kp.publicKey), owner: p.kp.publicKey, payer: p.kp.publicKey, relayer: null,
        stakeMint: asset.mint, payerToken: p.ata,
        tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId,
      }).signers([p.kp]).rpc();
      return g;
    };
    const ga = await mk(a, pa, 0);
    const gb = await mk(b, pb, 1);

    const va = await getAccount(conn, vaultPda(ga), undefined, a.tokenProgram);
    const vb = await getAccount(conn, vaultPda(gb), undefined, b.tokenProgram);
    assert.equal(va.mint.toBase58(), a.mint.toBase58(), "pot A holds only mint A");
    assert.equal(vb.mint.toBase58(), b.mint.toBase58(), "pot B holds only mint B");
    assert.notEqual(
      (await program.account.game.fetch(ga)).stakeMint.toBase58(),
      (await program.account.game.fetch(gb)).stakeMint.toBase58());
  });
});

describe("buzz: a full game in tokens", () => {
  it("runs lobby to settlement and drains the vault", async () => {
    await ensureConfig();
    const { mint, tokenProgram } = await newStakeAsset();
    // four combs minimum before a game may start, so four players
    const p0 = await newPlayer(mint, tokenProgram);
    const p1 = await newPlayer(mint, tokenProgram);
    const p2 = await newPlayer(mint, tokenProgram);
    const p3 = await newPlayer(mint, tokenProgram);
    const gid = new anchor.BN(Date.now() + 200);
    const g = gamePda(gid);
    const stake = new anchor.BN(10 * UNIT);

    await program.methods.createGame(gid, 6, 10, false).accountsPartial({
      config: configPda, stakeMint: mint, allowed: allowedPda(mint), game: g, vault: vaultPda(g),
      authority: authority.publicKey, tokenProgram, systemProgram: SystemProgram.programId,
    }).rpc();

    const players = [p0, p1, p2, p3];
    for (let i = 0; i < players.length; i++) {
      await program.methods.createCircle(i, stake).accountsPartial({
        config: configPda, game: g, vault: vaultPda(g), circle: combPda(g, i),
        player: playerPda(g, players[i].kp.publicKey), owner: players[i].kp.publicKey, payer: players[i].kp.publicKey, relayer: null,
        stakeMint: mint, payerToken: players[i].ata, tokenProgram,
        systemProgram: SystemProgram.programId,
      }).signers([players[i].kp]).rpc();
    }
    await program.methods.startGame().accountsPartial({ game: g, authority: authority.publicKey }).rpc();

    // Four combs now, so crank instances until exactly one is left rather than
    // assuming a single death decides it.
    // phaseEndsAt is the validator's clock; Date.now() is this process's. The
    // two drift, so sleeping until the wall clock passes the deadline is a
    // guess, not a guarantee, and a crank issued a moment early is rejected
    // with PhaseNotOver. That is what made this test fail on roughly half of
    // otherwise identical runs. Wait as before to keep the test quick, then
    // let the program itself say when the window is really over.
    const waitPhase = async () => {
      const gg = await program.account.game.fetch(g);
      const ms = gg.phaseEndsAt.toNumber() * 1000 - Date.now() + 1200;
      if (ms > 0) await sleep(ms);
    };
    const crank = async (call: () => Promise<string>) => {
      for (let t = 0; t < 15; t++) {
        try { return await call(); }
        catch (e) {
          if (!String(e).includes("PhaseNotOver")) throw e;
          await sleep(1200);
        }
      }
      throw new Error("phase never opened after 15 attempts");
    };
    let alive = players.map((_, i) => i);
    let doomed = -1;
    const firstDoomed = { id: -1 };
    for (let guard = 0; guard < 12; guard++) {
      const gnow = await program.account.game.fetch(g);
      if (!gnow.status.running) break;

      await waitPhase();
      await crank(() => program.methods.advanceToReveal()
        .accountsPartial({ game: g, cranker: authority.publicKey }).rpc());
      await waitPhase();

      // selectDeath must be handed EVERY alive comb, or the minimum is gameable
      await crank(() => program.methods.selectDeath()
        // randomness: null takes the committed-slot-hash fallback, legal
        // here because these games are created with require_vrf false.
        .accountsPartial({ game: g, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
                           randomness: null, cranker: authority.publicKey })
        .remainingAccounts(alive.map((i) => ({ pubkey: combPda(g, i), isSigner: false, isWritable: false })))
        .rpc());
      doomed = (await program.account.game.fetch(g)).doomedCircle;
      if (firstDoomed.id < 0) firstDoomed.id = doomed;
      await program.methods.executeDeath(doomed)
        .accountsPartial({ game: g, circle: combPda(g, doomed), cranker: authority.publicKey }).rpc();
      alive = alive.filter((i) => i !== doomed);
      await waitPhase();
      await crank(() => program.methods.advanceInstance()
        .accountsPartial({ game: g, cranker: authority.publicKey }).rpc());
    }

    const gs = await program.account.game.fetch(g);
    assert.deepEqual(gs.status, { settling: {} }, "one comb left, game settles");
    assert.equal(alive.length, 1, "exactly one comb survives");
    const winner = alive[0];

    // loser banks the refund in tokens
    const loser = players[firstDoomed.id];
    const before = Number((await getAccount(conn, loser.ata, undefined, tokenProgram)).amount);
    await program.methods.cashOut().accountsPartial({
      game: g, vault: vaultPda(g), circle: combPda(g, firstDoomed.id),
      player: playerPda(g, loser.kp.publicKey), owner: loser.kp.publicKey, actor: loser.kp.publicKey,
      stakeMint: mint, ownerToken: loser.ata, tokenProgram, systemProgram: SystemProgram.programId,
    }).signers([loser.kp]).rpc();
    const after = Number((await getAccount(conn, loser.ata, undefined, tokenProgram)).amount);
    assert.ok(after > before, "refund paid in the stake token");

    // winner claims, creator takes kappa, fees sweep to the per-mint treasury
    const w = players[winner];
    await program.methods.claimWinnings().accountsPartial({
      game: g, vault: vaultPda(g), winningCircle: combPda(g, winner),
      player: playerPda(g, w.kp.publicKey), owner: w.kp.publicKey, actor: w.kp.publicKey,
      stats: statsPda(w.kp.publicKey), treasury: treasuryPda(mint),
      stakeMint: mint, ownerToken: w.ata, tokenProgram, systemProgram: SystemProgram.programId,
    }).signers([w.kp]).rpc();
    await program.methods.claimCreatorCut().accountsPartial({
      game: g, vault: vaultPda(g), winningCircle: combPda(g, winner), owner: w.kp.publicKey, player: null, actor: w.kp.publicKey,
      stakeMint: mint, ownerToken: w.ata, tokenProgram, systemProgram: SystemProgram.programId,
    }).signers([w.kp]).rpc();
    await program.methods.collectFees().accountsPartial({
      config: configPda, game: g, vault: vaultPda(g),
      treasury: treasuryPda(mint), treasuryVault: tvaultPda(mint),
      stakeMint: mint, tokenProgram, cranker: authority.publicKey,
      systemProgram: SystemProgram.programId,
    }).rpc();

    const t = await program.account.treasury.fetch(treasuryPda(mint));
    assert.ok(t.jackpotPool.toNumber() > 0, "jackpot funded for this mint");

    // house cut divides 25 leaderboard / 50 SOL / 25 burn, and nothing rounds away
    const lb = t.lbAccruing.toNumber(), sol = t.toSolBalance.toNumber(), burn = t.burnBalance.toNumber();
    const house = lb + sol + burn;
    assert.ok(house > 0, "house cut booked into the buckets");
    assert.equal(lb, Math.floor(house * 0.25), "leaderboard takes 25%");
    assert.equal(burn, Math.floor(house * 0.25), "burn takes 25%");
    assert.equal(sol, house - lb - burn, "the rest goes to SOL, remainder included");

    // the winner's cross-game record exists and counted the win
    const st = await program.account.agentStats.fetch(statsPda(w.kp.publicKey));
    assert.equal(st.wins, 1, "a win is recorded once");
    assert.ok(st.owner.equals(w.kp.publicKey), "stats belong to the wallet");
  });

  it("pays a season pro rata by skill points, and only to whoever earned them", async () => {
    await ensureConfig();
    const { mint, tokenProgram } = await newStakeAsset();
    const T = treasuryPda(mint);
    let t = await program.account.treasury.fetch(T);
    assert.equal(t.season, 0, "a fresh mint is unranked until a season opens");

    await program.methods.openSeason().accountsPartial({
      treasury: T, stakeMint: mint, authority: authority.publicKey,
    }).rpc();
    t = await program.account.treasury.fetch(T);
    assert.equal(t.season, 1, "season one is open");

    // A second open must fail: it would silently reset the ranking.
    let reopened = false;
    try {
      await program.methods.openSeason().accountsPartial({
        treasury: T, stakeMint: mint, authority: authority.publicKey,
      }).rpc();
      reopened = true;
    } catch { /* expected */ }
    assert.ok(!reopened, "a season cannot be opened twice");

    // Closing with nothing earned still advances, and pays nobody.
    await program.methods.closeSeason().accountsPartial({
      treasury: T, stakeMint: mint, authority: authority.publicKey,
    }).rpc();
    t = await program.account.treasury.fetch(T);
    assert.equal(t.season, 2, "closing opens the next season");
    assert.equal(t.ptsClaimable.toNumber(), 0, "no points, no claimants");

    // Someone who never earned a point cannot invent a claim.
    const stranger = await newPlayer(mint, tokenProgram);
    let paid = false;
    try {
      await program.methods.claimSeasonReward().accountsPartial({
        treasury: T, treasuryVault: tvaultPda(mint), stats: statsPda(stranger.kp.publicKey),
        owner: stranger.kp.publicKey, actor: stranger.kp.publicKey,
        stakeMint: mint, ownerToken: stranger.ata, tokenProgram,
      }).signers([stranger.kp]).rpc();
      paid = true;
    } catch { /* expected */ }
    assert.ok(!paid, "no points, no reward");
  });
});

// ---------------------------------------------------------------------------
// Prediction market
// ---------------------------------------------------------------------------
//
// The properties worth proving are the ones that decide whether a market is
// safe to open: it cannot pay out more than it took in, it cannot pay before it
// knows who won, and losing everything is not the same as the book keeping it.

describe("buzz: backing an agent", () => {
  const marketPda = (g: PublicKey) => pda(Buffer.from("market"), g.toBuffer());
  const mvaultPda = (m: PublicKey) => pda(Buffer.from("mvault"), m.toBuffer());
  const tpoolPda = (m: PublicKey, t: PublicKey) => pda(Buffer.from("tpool"), m.toBuffer(), t.toBuffer());
  const betPda = (m: PublicKey, b: PublicKey, t: PublicKey) =>
    pda(Buffer.from("bet"), m.toBuffer(), b.toBuffer(), t.toBuffer());

  let asset: { mint: PublicKey; tokenProgram: PublicKey };
  let gid: anchor.BN, g: PublicKey, market: PublicKey;
  let players: { kp: Keypair; ata: PublicKey }[] = [];
  let bettors: { kp: Keypair; ata: PublicKey }[] = [];

  before(async () => {
    await ensureConfig();
    asset = await newStakeAsset();
    gid = new anchor.BN(Date.now());
    g = gamePda(gid);
    market = marketPda(g);

    await program.methods.createGame(gid, 6, 10, false).accountsPartial({
      config: configPda, stakeMint: asset.mint, allowed: allowedPda(asset.mint),
      game: g, vault: vaultPda(g), authority: authority.publicKey,
      tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId,
    }).rpc();

    // Four combs, one agent each, so the game is startable and every bettor has
    // something distinct to back.
    for (let i = 0; i < 4; i++) {
      const p = await newPlayer(asset.mint, asset.tokenProgram);
      players.push(p);
      await program.methods.createCircle(i, new anchor.BN(10 * UNIT)).accountsPartial({
        config: configPda, game: g, vault: vaultPda(g), circle: combPda(g, i),
        player: playerPda(g, p.kp.publicKey), owner: p.kp.publicKey, payer: p.kp.publicKey,
        relayer: null, stakeMint: asset.mint, payerToken: p.ata,
        tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId,
      }).signers([p.kp]).rpc();
    }
    await program.methods.startGame()
      .accountsPartial({ game: g, authority: authority.publicKey }).rpc();

    for (let i = 0; i < 2; i++) bettors.push(await newPlayer(asset.mint, asset.tokenProgram));
  });

  it("opens a book on a running game", async () => {
    await program.methods.openMarket(5).accountsPartial({
      game: g, market, marketVault: mvaultPda(market), stakeMint: asset.mint,
      payer: authority.publicKey, tokenProgram: asset.tokenProgram,
      systemProgram: SystemProgram.programId,
    }).rpc();
    const m = await program.account.market.fetch(market);
    assert.equal(m.totalPool.toNumber(), 0);
    assert.equal(m.settled, false);
  });

  const place = async (b: typeof bettors[number], target: PublicKey, amount: number) =>
    program.methods.placeBet(new anchor.BN(amount)).accountsPartial({
      game: g, market, marketVault: mvaultPda(market),
      targetPlayer: playerPda(g, target), targetPool: tpoolPda(market, target),
      bet: betPda(market, b.kp.publicKey, target), bettorToken: b.ata,
      bettor: b.kp.publicKey, stakeMint: asset.mint,
      tokenProgram: asset.tokenProgram, systemProgram: SystemProgram.programId,
    }).signers([b.kp]).rpc();

  it("takes bets, and the vault holds exactly what was staked", async () => {
    await place(bettors[0], players[0].kp.publicKey, 6 * UNIT);
    await place(bettors[1], players[1].kp.publicKey, 2 * UNIT);
    const m = await program.account.market.fetch(market);
    assert.equal(m.totalPool.toNumber(), 8 * UNIT, "pool is the sum of the bets");
    assert.equal(m.targets, 2, "two distinct agents backed");
    const vault = await getAccount(conn, mvaultPda(market), undefined, asset.tokenProgram);
    assert.equal(Number(vault.amount), 8 * UNIT, "vault holds the pool, no more and no less");
  });

  it("refuses to pay before every backed agent is decided", async () => {
    let threw = false;
    try {
      await program.methods.claimBet().accountsPartial({
        market, marketVault: mvaultPda(market),
        targetPool: tpoolPda(market, players[0].kp.publicKey),
        bet: betPda(market, bettors[0].kp.publicKey, players[0].kp.publicKey),
        bettorToken: bettors[0].ata, bettor: bettors[0].kp.publicKey,
        stakeMint: asset.mint, tokenProgram: asset.tokenProgram,
      }).signers([bettors[0].kp]).rpc();
    } catch { threw = true; }
    assert.isTrue(threw, "an unsettled book must not pay out");
  });
});
