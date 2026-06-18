import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LastCircle } from "../target/types/last_circle";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";

describe("last-circle — milestone 1: lobby + escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;

  const FEE_BPS = 400; // 4%
  const HOUSE_CUT_BPS = 5000; // 50% of rake
  const MIN_STAKE = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
  const MAX_STAKE = new anchor.BN(5 * LAMPORTS_PER_SOL);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const gameId = new anchor.BN(Date.now());
  const [gamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), gameId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), gamePda.toBuffer()],
    program.programId
  );

  it("initializes config (idempotent-safe)", async () => {
    try {
      await program.methods
        .initializeConfig(FEE_BPS, HOUSE_CUT_BPS, MIN_STAKE, MAX_STAKE, 10)
        .accounts({ config: configPda, authority: authority.publicKey })
        .rpc();
    } catch (_) {
      // already initialized on a re-run of the validator — fine
    }
    const cfg = await program.account.gameConfig.fetch(configPda);
    assert.equal(cfg.feeBps, FEE_BPS);
  });

  it("creates a game in Lobby", async () => {
    await program.methods
      .createGame(gameId, 6)
      .accounts({
        config: configPda,
        game: gamePda,
        vault: vaultPda,
        authority: authority.publicKey,
      })
      .rpc();
    const g = await program.account.game.fetch(gamePda);
    assert.equal(g.numCircles, 6);
    assert.deepEqual(g.status, { lobby: {} });
  });

  it("creates a circle, escrows the stake, records the rake", async () => {
    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    const [circlePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([0])],
      program.programId
    );
    const [playerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), gamePda.toBuffer(), authority.publicKey.toBuffer()],
      program.programId
    );
    await program.methods
      .createCircle(0, stake)
      .accounts({
        config: configPda,
        game: gamePda,
        vault: vaultPda,
        circle: circlePda,
        player: playerPda,
        owner: authority.publicKey,
      })
      .rpc();

    const circle = await program.account.circle.fetch(circlePda);
    const expectedNet = stake.muln(10000 - FEE_BPS).divn(10000);
    assert.ok(circle.totalStake.eq(expectedNet), "net stake = deposit - rake");
    assert.equal(circle.memberCount, 1);

    const vaultBal = await provider.connection.getBalance(vaultPda);
    assert.ok(vaultBal >= stake.toNumber(), "vault holds the full deposit");
  });
});

import { Keypair, SystemProgram } from "@solana/web3.js";
import { keccak_256 } from "js-sha3";

describe("last-circle — milestone 2: instance loop (commit-reveal move)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;
  const FEE_BPS = 400;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const gameId = new anchor.BN(Date.now() + 1);
  const [gamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), gameId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), gamePda.toBuffer()],
    program.programId
  );
  const circlePda = (id: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id])],
      program.programId
    )[0];
  const playerPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("player"), gamePda.toBuffer(), owner.toBuffer()],
      program.programId
    )[0];

  const player2 = Keypair.generate();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("sets up a 2-circle game and starts it", async () => {
    // fund player2
    const sig = await provider.connection.requestAirdrop(player2.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    await program.methods
      .createGame(gameId, 6)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, authority: authority.publicKey })
      .rpc();

    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    // authority -> circle 0
    await program.methods
      .createCircle(0, stake)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(0), player: playerPda(authority.publicKey), owner: authority.publicKey })
      .rpc();
    // player2 -> circle 1
    await program.methods
      .createCircle(1, stake)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(1), player: playerPda(player2.publicKey), owner: player2.publicKey })
      .signers([player2])
      .rpc();

    await program.methods
      .startGame()
      .accounts({ game: gamePda, authority: authority.publicKey })
      .rpc();

    const g = await program.account.game.fetch(gamePda);
    assert.equal(g.instance, 1);
    assert.deepEqual(g.phase, { commit: {} });
    assert.deepEqual(g.status, { running: {} });
  });

  it("commits, reveals, and applies a move (circle 0 -> circle 1)", async () => {
    const targetCircle = 1;
    const nonce = new anchor.BN(123456789);
    const g0 = await program.account.game.fetch(gamePda);
    const instance = g0.instance;

    const preimage = Buffer.concat([
      Buffer.from([targetCircle]),
      nonce.toArrayLike(Buffer, "le", 8),
      authority.publicKey.toBuffer(),
      gamePda.toBuffer(),
      Buffer.from(new Uint16Array([instance]).buffer), // u16 LE
    ]);
    const hash = Buffer.from(keccak_256.arrayBuffer(preimage));

    // commit (authority is currently in circle 0)
    await program.methods
      .commitMove(Array.from(hash))
      .accounts({ game: gamePda, player: playerPda(authority.publicKey), owner: authority.publicKey })
      .rpc();

    // wait out the commit window (instance_seconds=10 -> commit 6s), then crank
    await sleep(6500);
    await program.methods
      .advanceToReveal()
      .accounts({ game: gamePda, cranker: authority.publicKey })
      .rpc();

    // reveal the move
    await program.methods
      .revealMove(targetCircle, nonce)
      .accounts({
        game: gamePda,
        player: playerPda(authority.publicKey),
        fromCircle: circlePda(0),
        toCircle: circlePda(1),
        owner: authority.publicKey,
      })
      .rpc();

    const c0 = await program.account.circle.fetch(circlePda(0));
    const c1 = await program.account.circle.fetch(circlePda(1));
    const p = await program.account.player.fetch(playerPda(authority.publicKey));
    assert.equal(c0.memberCount, 0, "circle 0 emptied");
    assert.equal(c1.memberCount, 2, "circle 1 now holds both players");
    assert.equal(p.currentCircle, 1, "player moved to circle 1");
  });

  it("resolves the instance and advances to the next commit phase", async () => {
    await sleep(4200); // reveal window (4s) + buffer
    await program.methods
      .resolveInstance()
      .accounts({ game: gamePda, cranker: authority.publicKey })
      .rpc();
    const g = await program.account.game.fetch(gamePda);
    assert.equal(g.instance, 2, "advanced to instance 2");
    assert.deepEqual(g.phase, { commit: {} });
  });
});
