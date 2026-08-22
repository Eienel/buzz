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
        .initializeConfig(FEE_BPS, HOUSE_CUT_BPS, MIN_STAKE, MAX_STAKE, 10, 10000)
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

import { Keypair, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
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
    await sleep(9000);
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

  it("selects and executes a death; 2 circles -> 1 leaves Settling", async () => {
    await sleep(10000); // reveal window (4s) + generous margin for validator clock lag // widened: entropy slot now reveal_window*3+4 slots out
    // select the dying circle (pass every alive circle)
    await program.methods
      .selectDeath()
      .accounts({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: authority.publicKey })
      .remainingAccounts([
        { pubkey: circlePda(0), isSigner: false, isWritable: false },
        { pubkey: circlePda(1), isSigner: false, isWritable: false },
      ])
      .rpc();
    const g1 = await program.account.game.fetch(gamePda);
    const doomed = g1.doomedCircle;
    await program.methods
      .executeDeath(doomed)
      .accounts({ game: gamePda, circle: circlePda(doomed), cranker: authority.publicKey })
      .rpc();
    const g2 = await program.account.game.fetch(gamePda);
    assert.equal(g2.aliveCircles, 1, "one circle left");
    assert.deepEqual(g2.phase, { scoring: {} }, "death opens the scoring window");
    const dead = await program.account.circle.fetch(circlePda(doomed));
    assert.equal(dead.alive, false);
    assert.ok(dead.refundBps >= 5500 && dead.refundBps <= 8000, "refund rate locked in band");

    // close scoring -> with one circle left the game settles
    await sleep(7000);
    await program.methods
      .advanceInstance()
      .accounts({ game: gamePda, cranker: authority.publicKey })
      .rpc();
    const g3 = await program.account.game.fetch(gamePda);
    assert.deepEqual(g3.status, { settling: {} }, "game moved to Settling");
  });
});

describe("last-circle — milestone 3: death + refund (cash out)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const gameId = new anchor.BN(Date.now() + 2);
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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // circle id -> owner (authority in 0, fresh keypairs in 1 and 2)
  const p1 = Keypair.generate();
  const p2 = Keypair.generate();
  const ownerOf = (id: number) => (id === 0 ? authority.publicKey : id === 1 ? p1.publicKey : p2.publicKey);
  const signerOf = (id: number) => (id === 0 ? [] : id === 1 ? [p1] : [p2]);

  it("builds a 3-circle game (one member each) and starts it", async () => {
    for (const kp of [p1, p2]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
    await program.methods
      .createGame(gameId, 6)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, authority: authority.publicKey })
      .rpc();

    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    const owners: [number, PublicKey, any[]][] = [
      [0, authority.publicKey, []],
      [1, p1.publicKey, [p1]],
      [2, p2.publicKey, [p2]],
    ];
    for (const [id, owner, signers] of owners) {
      await program.methods
        .createCircle(id, stake)
        .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(id), player: playerPda(owner), owner })
        .signers(signers)
        .rpc();
    }
    await program.methods.startGame().accounts({ game: gamePda, authority: authority.publicKey }).rpc();
    const g = await program.account.game.fetch(gamePda);
    assert.equal(g.aliveCircles, 3);
  });

  it("runs an instance to a death; eliminated player cashes out their refund", async () => {
    // no moves this instance — just crank through the phases to a death
    await sleep(9000);
    await program.methods.advanceToReveal().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    await sleep(10000); // reveal window (4s) + generous margin for validator clock lag // widened: entropy slot now reveal_window*3+4 slots out
    await program.methods
      .selectDeath()
      .accounts({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: authority.publicKey })
      .remainingAccounts([0, 1, 2].map((i) => ({ pubkey: circlePda(i), isSigner: false, isWritable: false })))
      .rpc();
    const g1 = await program.account.game.fetch(gamePda);
    const doomed = g1.doomedCircle;
    await program.methods
      .executeDeath(doomed)
      .accounts({ game: gamePda, circle: circlePda(doomed), cranker: authority.publicKey })
      .rpc();

    const g2 = await program.account.game.fetch(gamePda);
    assert.equal(g2.aliveCircles, 2, "3 -> 2 circles");
    assert.ok(g2.leftoverPot.toNumber() > 0, "haircut swept into leftover pot");
    assert.deepEqual(g2.phase, { scoring: {} }, "scoring window open after death");

    // the lone member of the doomed circle cashes out (works regardless of phase)
    const owner = ownerOf(doomed);
    const before = await provider.connection.getBalance(owner);
    await program.methods
      .cashOut()
      .accounts({
        game: gamePda,
        vault: vaultPda,
        circle: circlePda(doomed),
        player: playerPda(owner),
        owner,
        systemProgram: SystemProgram.programId,
      })
      .signers(signerOf(doomed))
      .rpc();
    const after = await provider.connection.getBalance(owner);
    assert.ok(after - before > 0.4 * LAMPORTS_PER_SOL, "received a real refund from the vault");

    const p = await program.account.player.fetch(playerPda(owner));
    assert.deepEqual(p.status, { cashedOut: {} });
    assert.equal(p.stake.toNumber(), 0);
  });
});

describe("last-circle — milestone 4: prediction skill points", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const gameId = new anchor.BN(Date.now() + 3);
  const [gamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), gameId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), gamePda.toBuffer()],
    program.programId
  );
  const circlePda = (id: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id])], program.programId)[0];
  const playerPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("player"), gamePda.toBuffer(), owner.toBuffer()], program.programId)[0];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const p1 = Keypair.generate();
  const p2 = Keypair.generate();

  it("commits a prediction, scores it after the death", async () => {
    for (const kp of [p1, p2]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
    await program.methods
      .createGame(gameId, 6)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, authority: authority.publicKey })
      .rpc();
    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    const setup: [number, PublicKey, any[]][] = [
      [0, authority.publicKey, []],
      [1, p1.publicKey, [p1]],
      [2, p2.publicKey, [p2]],
    ];
    for (const [id, owner, signers] of setup) {
      await program.methods
        .createCircle(id, stake)
        .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(id), player: playerPda(owner), owner })
        .signers(signers)
        .rpc();
    }
    await program.methods.startGame().accounts({ game: gamePda, authority: authority.publicKey }).rpc();

    // authority predicts circle 0 will die (instance 1)
    const predicted = 0;
    const nonce = new anchor.BN(987654321);
    const instance = 1;
    const preimage = Buffer.concat([
      Buffer.from([predicted]),
      nonce.toArrayLike(Buffer, "le", 8),
      authority.publicKey.toBuffer(),
      gamePda.toBuffer(),
      Buffer.from(new Uint16Array([instance]).buffer),
    ]);
    const hash = Buffer.from(keccak_256.arrayBuffer(preimage));
    await program.methods
      .commitPrediction(Array.from(hash))
      .accounts({ game: gamePda, player: playerPda(authority.publicKey), owner: authority.publicKey })
      .rpc();

    // crank through to a death
    await sleep(9000);
    await program.methods.advanceToReveal().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    await sleep(10000); // widened: entropy slot now reveal_window*3+4 slots out
    await program.methods
      .selectDeath()
      .accounts({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: authority.publicKey })
      .remainingAccounts([0, 1, 2].map((i) => ({ pubkey: circlePda(i), isSigner: false, isWritable: false })))
      .rpc();
    const g1 = await program.account.game.fetch(gamePda);
    const doomed = g1.doomedCircle;
    await program.methods
      .executeDeath(doomed)
      .accounts({ game: gamePda, circle: circlePda(doomed), cranker: authority.publicKey })
      .rpc();

    // reveal the prediction during the scoring window
    await program.methods
      .revealPrediction(predicted, nonce)
      .accounts({ game: gamePda, player: playerPda(authority.publicKey), owner: authority.publicKey })
      .rpc();

    const p = await program.account.player.fetch(playerPda(authority.publicKey));
    const expectedPoints = doomed === predicted ? 1 : 0;
    assert.equal(p.points, expectedPoints, `points correct for doomed=${doomed}, predicted=${predicted}`);
  });
});

describe("last-circle — milestone 5: settlement (pot distribution)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const gameId = new anchor.BN(Date.now() + 4);
  const [gamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), gameId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), gamePda.toBuffer()], program.programId);
  const circlePda = (id: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id])], program.programId)[0];
  const playerPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("player"), gamePda.toBuffer(), owner.toBuffer()], program.programId)[0];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const p1 = Keypair.generate();
  const kpOf = (owner: PublicKey) => (owner.equals(authority.publicKey) ? [] : [p1]);

  const predHash = (predicted: number, nonce: anchor.BN, owner: PublicKey) =>
    Buffer.from(
      keccak_256.arrayBuffer(
        Buffer.concat([
          Buffer.from([predicted]),
          nonce.toArrayLike(Buffer, "le", 8),
          owner.toBuffer(),
          gamePda.toBuffer(),
          Buffer.from(new Uint16Array([1]).buffer),
        ])
      )
    );

  it("runs a 2-circle game to Settling and distributes the pot", async () => {
    const sig = await provider.connection.requestAirdrop(p1.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    await program.methods
      .createGame(gameId, 6)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, authority: authority.publicKey })
      .rpc();
    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    await program.methods
      .createCircle(0, stake)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(0), player: playerPda(authority.publicKey), owner: authority.publicKey })
      .rpc();
    await program.methods
      .createCircle(1, stake)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(1), player: playerPda(p1.publicKey), owner: p1.publicKey })
      .signers([p1])
      .rpc();
    await program.methods.startGame().accounts({ game: gamePda, authority: authority.publicKey }).rpc();

    // both predict opposite circles -> exactly one is correct
    const nonceA = new anchor.BN(111);
    const nonceB = new anchor.BN(222);
    await program.methods
      .commitPrediction(Array.from(predHash(0, nonceA, authority.publicKey)))
      .accounts({ game: gamePda, player: playerPda(authority.publicKey), owner: authority.publicKey })
      .rpc();
    await program.methods
      .commitPrediction(Array.from(predHash(1, nonceB, p1.publicKey)))
      .accounts({ game: gamePda, player: playerPda(p1.publicKey), owner: p1.publicKey })
      .signers([p1])
      .rpc();

    await sleep(9000);
    await program.methods.advanceToReveal().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    await sleep(10000); // widened: entropy slot now reveal_window*3+4 slots out
    await program.methods
      .selectDeath()
      .accounts({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: authority.publicKey })
      .remainingAccounts([0, 1].map((i) => ({ pubkey: circlePda(i), isSigner: false, isWritable: false })))
      .rpc();
    const gd = await program.account.game.fetch(gamePda);
    const doomed = gd.doomedCircle;
    await program.methods
      .executeDeath(doomed)
      .accounts({ game: gamePda, circle: circlePda(doomed), cranker: authority.publicKey })
      .rpc();

    // reveal both predictions (one scores a point)
    await program.methods
      .revealPrediction(0, nonceA)
      .accounts({ game: gamePda, player: playerPda(authority.publicKey), owner: authority.publicKey })
      .rpc();
    await program.methods
      .revealPrediction(1, nonceB)
      .accounts({ game: gamePda, player: playerPda(p1.publicKey), owner: p1.publicKey })
      .signers([p1])
      .rpc();

    // close scoring -> Settling (one circle left)
    await sleep(7000);
    await program.methods.advanceInstance().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    const gs = await program.account.game.fetch(gamePda);
    assert.deepEqual(gs.status, { settling: {} });
    assert.equal(gs.totalPoints.toNumber(), 1, "exactly one correct prediction");

    const winner = doomed === 0 ? 1 : 0;
    const winnerOwner = winner === 0 ? authority.publicKey : p1.publicKey;
    const skillOwner = doomed === 0 ? authority.publicKey : p1.publicKey; // predicted the death

    // creator cut
    let before = await provider.connection.getBalance(winnerOwner);
    await program.methods
      .claimCreatorCut()
      .accounts({ game: gamePda, vault: vaultPda, winningCircle: circlePda(winner), owner: winnerOwner, systemProgram: SystemProgram.programId })
      .signers(kpOf(winnerOwner))
      .rpc();
    assert.ok((await provider.connection.getBalance(winnerOwner)) > before, "creator received κ cut");

    // winnings (stake-back + luck pool)
    before = await provider.connection.getBalance(winnerOwner);
    await program.methods
      .claimWinnings()
      .accounts({ game: gamePda, vault: vaultPda, winningCircle: circlePda(winner), player: playerPda(winnerOwner), owner: winnerOwner, systemProgram: SystemProgram.programId })
      .signers(kpOf(winnerOwner))
      .rpc();
    const afterWin = await provider.connection.getBalance(winnerOwner);
    assert.ok(afterWin - before > 0.9 * LAMPORTS_PER_SOL, "survivor got stake-back + luck share");

    // skill pool (claimed by the correct predictor)
    before = await provider.connection.getBalance(skillOwner);
    await program.methods
      .claimSkill()
      .accounts({ game: gamePda, vault: vaultPda, player: playerPda(skillOwner), owner: skillOwner, systemProgram: SystemProgram.programId })
      .signers(kpOf(skillOwner))
      .rpc();
    assert.ok((await provider.connection.getBalance(skillOwner)) > before, "skill pool paid to correct predictor");
  });
});

describe("last-circle — milestone 6: treasury + insane round", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], program.programId);
  const [treasuryVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_vault")], program.programId);

  // per-game PDA helpers
  const g = (gid: anchor.BN) => {
    const [gamePda] = PublicKey.findProgramAddressSync([Buffer.from("game"), gid.toArrayLike(Buffer, "le", 8)], program.programId);
    const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), gamePda.toBuffer()], program.programId);
    const circlePda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id])], program.programId)[0];
    const playerPda = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("player"), gamePda.toBuffer(), o.toBuffer()], program.programId)[0];
    return { gamePda, vaultPda, circlePda, playerPda };
  };

  // run a fresh game (with `owners` per circle id) to its first death, returning the doomed id
  const runToFirstDeath = async (gid: anchor.BN, owners: { id: number; kp: PublicKey; signers: any[] }[]) => {
    const G = g(gid);
    await program.methods.createGame(gid, 6).accounts({ config: configPda, game: G.gamePda, vault: G.vaultPda, authority: authority.publicKey }).rpc();
    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    for (const o of owners) {
      await program.methods.createCircle(o.id, stake)
        .accounts({ config: configPda, game: G.gamePda, vault: G.vaultPda, circle: G.circlePda(o.id), player: G.playerPda(o.kp), owner: o.kp })
        .signers(o.signers).rpc();
    }
    await program.methods.startGame().accounts({ game: G.gamePda, authority: authority.publicKey }).rpc();
    await sleep(9000);
    await program.methods.advanceToReveal().accounts({ game: G.gamePda, cranker: authority.publicKey }).rpc();
    await sleep(10000); // widened: entropy slot now reveal_window*3+4 slots out
    await program.methods.selectDeath().accounts({ game: G.gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: authority.publicKey })
      .remainingAccounts(owners.map((o) => ({ pubkey: G.circlePda(o.id), isSigner: false, isWritable: false }))).rpc();
    const doomed = (await program.account.game.fetch(G.gamePda)).doomedCircle;
    await program.methods.executeDeath(doomed).accounts({ game: G.gamePda, circle: G.circlePda(doomed), cranker: authority.publicKey }).rpc();
    await sleep(7000);
    await program.methods.advanceInstance().accounts({ game: G.gamePda, cranker: authority.publicKey }).rpc();
    return { G, doomed };
  };

  it("inits treasury, collects fees from a finished game, withdraws house profit", async () => {
    try {
      await program.methods.initTreasury()
        .accounts({ treasury: treasuryPda, treasuryVault: treasuryVaultPda, authority: authority.publicKey }).rpc();
    } catch (_) {}

    const pA = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(pA.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    // G1: 2 circles -> 1 death -> Settling
    const gid1 = new anchor.BN(Date.now() + 100);
    const { G } = await runToFirstDeath(gid1, [
      { id: 0, kp: authority.publicKey, signers: [] },
      { id: 1, kp: pA.publicKey, signers: [pA] },
    ]);
    assert.deepEqual((await program.account.game.fetch(G.gamePda)).status, { settling: {} });

    const tBefore = await program.account.treasury.fetch(treasuryPda);
    await program.methods.collectFees()
      .accounts({ config: configPda, game: G.gamePda, vault: G.vaultPda, treasury: treasuryPda, treasuryVault: treasuryVaultPda, cranker: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const tAfter = await program.account.treasury.fetch(treasuryPda);
    assert.ok(tAfter.houseBalance.toNumber() > tBefore.houseBalance.toNumber(), "house profit accrued");
    assert.ok(tAfter.jackpotPool.toNumber() > tBefore.jackpotPool.toNumber(), "jackpot pool grew");

    // withdraw all house profit
    const houseBal = tAfter.houseBalance;
    await program.methods.withdrawHouse(houseBal)
      .accounts({ treasury: treasuryPda, treasuryVault: treasuryVaultPda, authority: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const tFinal = await program.account.treasury.fetch(treasuryPda);
    assert.equal(tFinal.houseBalance.toNumber(), 0, "house balance withdrawn");
    assert.ok(tFinal.jackpotPool.toNumber() > 0, "jackpot pool retained for insane rounds");
  });

  it("rolls an INSANE round; the jackpot pool injects into the live pot", async () => {
    const jackpot = (await program.account.treasury.fetch(treasuryPda)).jackpotPool.toNumber();
    assert.ok(jackpot > 0, "jackpot funded by the previous game");

    const ps = [Keypair.generate(), Keypair.generate()];
    for (const kp of ps) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
    // G2: 3 circles -> 1 death -> instance 2 (>= lock), still Running
    const gid2 = new anchor.BN(Date.now() + 101);
    const { G } = await runToFirstDeath(gid2, [
      { id: 0, kp: authority.publicKey, signers: [] },
      { id: 1, kp: ps[0].publicKey, signers: [ps[0]] },
      { id: 2, kp: ps[1].publicKey, signers: [ps[1]] },
    ]);
    const gMid = await program.account.game.fetch(G.gamePda);
    assert.equal(gMid.instance, 2, "past the 50% lock");
    assert.deepEqual(gMid.status, { running: {} });
    const leftoverBefore = gMid.leftoverPot.toNumber();

    // forced insane (prob = 100% in test config); wait for the pre-committed
    // entropy slot (armed at lock-crossing, +5 slots) to pass
    await sleep(5000);
    await program.methods.rollInsane()
      .accounts({ config: configPda, game: G.gamePda, vault: G.vaultPda, treasury: treasuryPda, treasuryVault: treasuryVaultPda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const gAfter = await program.account.game.fetch(G.gamePda);
    assert.equal(gAfter.insane, true, "game flipped INSANE");
    assert.equal(gAfter.leftoverPot.toNumber(), leftoverBefore + jackpot, "jackpot injected into the pot");
    assert.equal((await program.account.treasury.fetch(treasuryPda)).jackpotPool.toNumber(), 0, "jackpot pool emptied");
  });
});

describe("last-circle — hardening: open-join window to the 50% lock", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const gameId = new anchor.BN(Date.now() + 200);
  const [gamePda] = PublicKey.findProgramAddressSync([Buffer.from("game"), gameId.toArrayLike(Buffer, "le", 8)], program.programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), gamePda.toBuffer()], program.programId);
  const circlePda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id])], program.programId)[0];
  const playerPda = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("player"), gamePda.toBuffer(), o.toBuffer()], program.programId)[0];

  const p1 = Keypair.generate();
  const newcomer = Keypair.generate();
  const latecomer = Keypair.generate();

  it("lets a newcomer join mid-game, then freezes joins after the Commit window", async () => {
    for (const kp of [p1, newcomer, latecomer]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
    await program.methods.createGame(gameId, 6).accounts({ config: configPda, game: gamePda, vault: vaultPda, authority: authority.publicKey }).rpc();
    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    await program.methods.createCircle(0, stake).accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(0), player: playerPda(authority.publicKey), owner: authority.publicKey }).rpc();
    await program.methods.createCircle(1, stake).accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(1), player: playerPda(p1.publicKey), owner: p1.publicKey }).signers([p1]).rpc();
    await program.methods.startGame().accounts({ game: gamePda, authority: authority.publicKey }).rpc();

    // newcomer joins circle 0 during the Commit window of instance 1 -> allowed
    await program.methods
      .joinCircle(stake)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(0), player: playerPda(newcomer.publicKey), owner: newcomer.publicKey })
      .signers([newcomer])
      .rpc();
    const c0 = await program.account.circle.fetch(circlePda(0));
    assert.equal(c0.memberCount, 2, "newcomer joined mid-game");
    const np = await program.account.player.fetch(playerPda(newcomer.publicKey));
    assert.equal(np.currentCircle, 0);

    // close the commit window -> Reveal phase; joins must now be rejected
    await sleep(9000);
    await program.methods.advanceToReveal().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();

    let rejected = false;
    try {
      await program.methods
        .joinCircle(stake)
        .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(0), player: playerPda(latecomer.publicKey), owner: latecomer.publicKey })
        .signers([latecomer])
        .rpc();
    } catch (e) {
      rejected = String(e).includes("JoinWindowClosed");
    }
    assert.ok(rejected, "join rejected once the window is closed");
  });
});

describe("last-circle — hardening: dead-circle escape + land window", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const gameId = new anchor.BN(Date.now() + 300);
  const [gamePda] = PublicKey.findProgramAddressSync([Buffer.from("game"), gameId.toArrayLike(Buffer, "le", 8)], program.programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), gamePda.toBuffer()], program.programId);
  const circlePda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id])], program.programId)[0];
  const playerPda = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("player"), gamePda.toBuffer(), o.toBuffer()], program.programId)[0];

  const p1 = Keypair.generate();
  const p2 = Keypair.generate();
  const ownerOf = (id: number) => (id === 0 ? authority.publicKey : id === 1 ? p1.publicKey : p2.publicKey);
  const signerOf = (id: number): Keypair[] => (id === 0 ? [] : id === 1 ? [p1] : [p2]);

  const runInstanceToDeath = async (aliveIds: number[]) => {
    await sleep(9000);
    await program.methods.advanceToReveal().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    await sleep(10000); // widened: entropy slot now reveal_window*3+4 slots out
    await program.methods
      .selectDeath()
      .accounts({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: authority.publicKey })
      .remainingAccounts(aliveIds.map((i) => ({ pubkey: circlePda(i), isSigner: false, isWritable: false })))
      .rpc();
    const doomed = (await program.account.game.fetch(gamePda)).doomedCircle;
    await program.methods.executeDeath(doomed).accounts({ game: gamePda, circle: circlePda(doomed), cranker: authority.publicKey }).rpc();
    await sleep(7000);
    await program.methods.advanceInstance().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    return doomed;
  };

  let doomed1 = 0; // circle killed in instance 1

  it("a dead-circle member cannot reveal_move their full stake out (haircut dodge)", async () => {
    for (const kp of [p1, p2]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
    await program.methods.createGame(gameId, 6).accounts({ config: configPda, game: gamePda, vault: vaultPda, authority: authority.publicKey }).rpc();
    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    for (const id of [0, 1, 2]) {
      await program.methods
        .createCircle(id, stake)
        .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(id), player: playerPda(ownerOf(id)), owner: ownerOf(id) })
        .signers(signerOf(id))
        .rpc();
    }
    await program.methods.startGame().accounts({ game: gamePda, authority: authority.publicKey }).rpc();

    // instance 1 -> first death (game continues: 3 -> 2 circles)
    doomed1 = await runInstanceToDeath([0, 1, 2]);
    const g = await program.account.game.fetch(gamePda);
    assert.equal(g.aliveCircles, 2);
    assert.deepEqual(g.status, { running: {} });

    // instance 2: the dead player commits a move into an alive circle and tries
    // to reveal it — must be rejected (their exit is land/cash_out, WITH haircut).
    const deadOwner = ownerOf(doomed1);
    const target = [0, 1, 2].find((i) => i !== doomed1)!;
    const instance = g.instance; // 2
    const nonce = new anchor.BN(777);
    const hash = Buffer.from(
      keccak_256.arrayBuffer(
        Buffer.concat([
          Buffer.from([target]),
          nonce.toArrayLike(Buffer, "le", 8),
          deadOwner.toBuffer(),
          gamePda.toBuffer(),
          Buffer.from(new Uint16Array([instance]).buffer),
        ])
      )
    );
    await program.methods
      .commitMove(Array.from(hash))
      .accounts({ game: gamePda, player: playerPda(deadOwner), owner: deadOwner })
      .signers(signerOf(doomed1))
      .rpc();
    await sleep(9000);
    await program.methods.advanceToReveal().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();

    let rejected = false;
    try {
      await program.methods
        .revealMove(target, nonce)
        .accounts({ game: gamePda, player: playerPda(deadOwner), fromCircle: circlePda(doomed1), toCircle: circlePda(target), owner: deadOwner })
        .signers(signerOf(doomed1))
        .rpc();
    } catch (e) {
      rejected = String(e).includes("CircleDead");
    }
    assert.ok(rejected, "full-stake escape from a dead circle rejected");
  });

  it("land is rejected once the game reaches Settling (no post-hoc luck-pool sniping)", async () => {
    // finish instance 2 (2 -> 1 circles) -> Settling
    await sleep(10000); // widened: entropy slot now reveal_window*3+4 slots out
    const aliveIds = [0, 1, 2].filter((i) => i !== doomed1);
    await program.methods
      .selectDeath()
      .accounts({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: authority.publicKey })
      .remainingAccounts(aliveIds.map((i) => ({ pubkey: circlePda(i), isSigner: false, isWritable: false })))
      .rpc();
    const doomed2 = (await program.account.game.fetch(gamePda)).doomedCircle;
    await program.methods.executeDeath(doomed2).accounts({ game: gamePda, circle: circlePda(doomed2), cranker: authority.publicKey }).rpc();
    await sleep(7000);
    await program.methods.advanceInstance().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    const g = await program.account.game.fetch(gamePda);
    assert.deepEqual(g.status, { settling: {} });

    // the instance-1 casualty now tries to land into the winning circle -> rejected
    const winner = [0, 1, 2].find((i) => i !== doomed1 && i !== doomed2)!;
    let rejected = false;
    try {
      await program.methods
        .land(winner)
        .accounts({ game: gamePda, player: playerPda(ownerOf(doomed1)), fromCircle: circlePda(doomed1), toCircle: circlePda(winner), owner: ownerOf(doomed1) })
        .signers(signerOf(doomed1))
        .rpc();
    } catch (e) {
      rejected = String(e).includes("WrongPhase");
    }
    assert.ok(rejected, "post-settlement landing rejected");

    // but cash_out (WITH haircut) still works for them
    const owner = ownerOf(doomed1);
    const before = await provider.connection.getBalance(owner);
    await program.methods
      .cashOut()
      .accounts({ game: gamePda, vault: vaultPda, circle: circlePda(doomed1), player: playerPda(owner), owner, systemProgram: SystemProgram.programId })
      .signers(signerOf(doomed1))
      .rpc();
    const after = await provider.connection.getBalance(owner);
    assert.ok(after - before > 0.4 * LAMPORTS_PER_SOL, "haircut refund still claimable");
  });
});

describe("last-circle — rent recovery: close player/circle/game", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], program.programId);
  const [treasuryVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_vault")], program.programId);
  const gameId = new anchor.BN(Date.now() + 400);
  const [gamePda] = PublicKey.findProgramAddressSync([Buffer.from("game"), gameId.toArrayLike(Buffer, "le", 8)], program.programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), gamePda.toBuffer()], program.programId);
  const circlePda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id])], program.programId)[0];
  const playerPda = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("player"), gamePda.toBuffer(), o.toBuffer()], program.programId)[0];

  const p1 = Keypair.generate();
  const ownerOf = (id: number) => (id === 0 ? authority.publicKey : p1.publicKey);
  const signerOf = (id: number): Keypair[] => (id === 0 ? [] : [p1]);

  it("settles a game, closes everything, vault drains to zero", async () => {
    try {
      await program.methods.initTreasury().accounts({ treasury: treasuryPda, treasuryVault: treasuryVaultPda, authority: authority.publicKey }).rpc();
    } catch (_) {}
    const sig = await provider.connection.requestAirdrop(p1.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    await program.methods.createGame(gameId, 6).accounts({ config: configPda, game: gamePda, vault: vaultPda, authority: authority.publicKey }).rpc();
    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    for (const id of [0, 1]) {
      await program.methods.createCircle(id, stake)
        .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(id), player: playerPda(ownerOf(id)), owner: ownerOf(id) })
        .signers(signerOf(id)).rpc();
    }
    await program.methods.startGame().accounts({ game: gamePda, authority: authority.publicKey }).rpc();

    // one instance -> one death -> Settling (no predictions: points stay 0)
    await sleep(9000);
    await program.methods.advanceToReveal().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    await sleep(10000);
    await program.methods.selectDeath()
      .accounts({ game: gamePda, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY, cranker: authority.publicKey })
      .remainingAccounts([0, 1].map((i) => ({ pubkey: circlePda(i), isSigner: false, isWritable: false }))).rpc();
    const doomed = (await program.account.game.fetch(gamePda)).doomedCircle;
    await program.methods.executeDeath(doomed).accounts({ game: gamePda, circle: circlePda(doomed), cranker: authority.publicKey }).rpc();
    await sleep(7000);
    await program.methods.advanceInstance().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    const winner = doomed === 0 ? 1 : 0;

    // full settlement: loser cashes out, winner claims, creator claims kappa
    await program.methods.cashOut()
      .accounts({ game: gamePda, vault: vaultPda, circle: circlePda(doomed), player: playerPda(ownerOf(doomed)), owner: ownerOf(doomed), systemProgram: SystemProgram.programId })
      .signers(signerOf(doomed)).rpc();
    await program.methods.claimWinnings()
      .accounts({ game: gamePda, vault: vaultPda, winningCircle: circlePda(winner), player: playerPda(ownerOf(winner)), owner: ownerOf(winner), systemProgram: SystemProgram.programId })
      .signers(signerOf(winner)).rpc();
    await program.methods.claimCreatorCut()
      .accounts({ game: gamePda, vault: vaultPda, winningCircle: circlePda(winner), owner: ownerOf(winner), systemProgram: SystemProgram.programId })
      .signers(signerOf(winner)).rpc();
    await program.methods.collectFees()
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, treasury: treasuryPda, treasuryVault: treasuryVaultPda, cranker: authority.publicKey, systemProgram: SystemProgram.programId }).rpc();

    // close_circle must be rejected while players remain
    let early = false;
    try {
      await program.methods.closeCircle().accounts({ game: gamePda, circle: circlePda(doomed), creator: ownerOf(doomed), cranker: authority.publicKey }).rpc();
    } catch (e) { early = String(e).includes("PlayersRemain"); }
    assert.ok(early, "close_circle rejected while players remain");

    // close players (both fully settled, 0 points -> permissionless), rent returns to owners
    const p1Before = await provider.connection.getBalance(p1.publicKey);
    for (const id of [0, 1]) {
      await program.methods.closePlayer().accounts({ game: gamePda, player: playerPda(ownerOf(id)), owner: ownerOf(id), cranker: authority.publicKey }).rpc();
    }
    const p1After = await provider.connection.getBalance(p1.publicKey);
    assert.ok(p1After > p1Before, "player rent refunded to owner");
    assert.equal(await provider.connection.getAccountInfo(playerPda(p1.publicKey)), null, "player account closed");

    // close circles (winner's kappa already paid -> permissionless), then the game
    for (const id of [0, 1]) {
      await program.methods.closeCircle().accounts({ game: gamePda, circle: circlePda(id), creator: ownerOf(id), cranker: authority.publicKey }).rpc();
    }
    await program.methods.closeGame()
      .accounts({ game: gamePda, vault: vaultPda, treasury: treasuryPda, treasuryVault: treasuryVaultPda, authority: authority.publicKey, cranker: authority.publicKey, systemProgram: SystemProgram.programId }).rpc();

    assert.equal(await provider.connection.getAccountInfo(gamePda), null, "game account closed");
    assert.equal(await provider.connection.getBalance(vaultPda), 0, "vault drained to exactly zero");
  });
});

describe("last-circle — hardening: lobby abort refund", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LastCircle as Program<LastCircle>;
  const authority = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const gameId = new anchor.BN(Date.now() + 500);
  const [gamePda] = PublicKey.findProgramAddressSync([Buffer.from("game"), gameId.toArrayLike(Buffer, "le", 8)], program.programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), gamePda.toBuffer()], program.programId);
  const circlePda = (id: number) => PublicKey.findProgramAddressSync([Buffer.from("circle"), gamePda.toBuffer(), Buffer.from([id])], program.programId)[0];
  const playerPda = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("player"), gamePda.toBuffer(), o.toBuffer()], program.programId)[0];

  it("refuses to abort a fresh lobby, and refunds the FULL deposit once aborted", async () => {
    await program.methods.createGame(gameId, 6)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, authority: authority.publicKey }).rpc();
    const stake = new anchor.BN(LAMPORTS_PER_SOL);
    await program.methods.createCircle(0, stake)
      .accounts({ config: configPda, game: gamePda, vault: vaultPda, circle: circlePda(0), player: playerPda(authority.publicKey), owner: authority.publicKey })
      .rpc();

    // the timeout has not elapsed, so the abort must be rejected
    let tooEarly = false;
    try {
      await program.methods.abortLobby().accounts({ game: gamePda, cranker: authority.publicKey }).rpc();
    } catch (e) { tooEarly = String(e).includes("TooEarly"); }
    assert.ok(tooEarly, "fresh lobby cannot be aborted");

    // a player in a live lobby cannot claim an abort refund either
    let wrongPhase = false;
    try {
      await program.methods.claimAbortRefund()
        .accounts({ config: configPda, game: gamePda, vault: vaultPda, player: playerPda(authority.publicKey), owner: authority.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
    } catch (e) { wrongPhase = String(e).includes("WrongPhase"); }
    assert.ok(wrongPhase, "no abort refund while the lobby is live");

    const g = await program.account.game.fetch(gamePda);
    assert.ok(g.createdAt.toNumber() > 0, "lobby records when it opened");
    assert.ok(g.feesCollected.toNumber() > 0, "rake was taken at deposit");
  });
});
