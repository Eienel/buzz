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
        .initializeConfig(FEE_BPS, HOUSE_CUT_BPS, MIN_STAKE, MAX_STAKE, 30)
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
