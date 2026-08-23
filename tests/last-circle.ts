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
    const waitPhase = async () => {
      const gg = await program.account.game.fetch(g);
      const ms = gg.phaseEndsAt.toNumber() * 1000 - Date.now() + 1200;
      if (ms > 0) await sleep(ms);
    };
    let alive = players.map((_, i) => i);
    let doomed = -1;
    const firstDoomed = { id: -1 };
    for (let guard = 0; guard < 12; guard++) {
      const gnow = await program.account.game.fetch(g);
      if (!gnow.status.running) break;

      await waitPhase();
      await program.methods.advanceToReveal()
        .accountsPartial({ game: g, cranker: authority.publicKey }).rpc();
      await waitPhase();

      // selectDeath must be handed EVERY alive comb, or the minimum is gameable
      for (let t = 0; t < 15; t++) {
        try {
          await program.methods.selectDeath()
            // randomness: null takes the committed-slot-hash fallback, legal
            // here because these games are created with require_vrf false.
            .accountsPartial({ game: g, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
                               randomness: null, cranker: authority.publicKey })
            .remainingAccounts(alive.map((i) => ({ pubkey: combPda(g, i), isSigner: false, isWritable: false })))
            .rpc();
          break;
        } catch (e) {
          if (!String(e).includes("PhaseNotOver")) throw e;
          await sleep(1200);
        }
      }
      doomed = (await program.account.game.fetch(g)).doomedCircle;
      if (firstDoomed.id < 0) firstDoomed.id = doomed;
      await program.methods.executeDeath(doomed)
        .accountsPartial({ game: g, circle: combPda(g, doomed), cranker: authority.publicKey }).rpc();
      alive = alive.filter((i) => i !== doomed);
      await waitPhase();
      await program.methods.advanceInstance()
        .accountsPartial({ game: g, cranker: authority.publicKey }).rpc();
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
    assert.ok(t.houseBalance.toNumber() > 0, "house revenue booked for this mint");
    assert.ok(t.jackpotPool.toNumber() > 0, "jackpot funded for this mint");
  });
});
