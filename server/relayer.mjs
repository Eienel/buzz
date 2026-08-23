// The relayer: turns paid x402 actions into on-chain instructions.
//
// A ClawPump agent can pay an endpoint but cannot sign an Anchor instruction,
// so this process signs for it. What it is NOT allowed to become is the player:
// the program's `Player.delegate` exists precisely so the agent stays
// `Player.owner`. Points accrue to the agent, and every payout account is
// bound to the agent's own wallet, so this key can move a player and settle it
// but cannot redirect a single token to itself.
//
// It must be on the program's relayer allow-list first:
//   node agents/allow-relayer.mjs <relayer-pubkey>
//
//   RELAYER_KEYPAIR=path/to/key.json RPC=... node server/index.mjs
//
// The stake a paid join buys is fixed (RELAY_STAKE_UNITS) rather than derived
// from the USD paid: an on-chain token price would put an oracle in the path
// of every join, and a stale one would misprice seats silently.

import anchorPkg from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readFileSync } from "node:fs";

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;

const STAKE_UNITS = Number(process.env.RELAY_STAKE_UNITS ?? 10);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[relay]", ...a);

export function loadRelayer(connection) {
  const path = process.env.RELAYER_KEYPAIR;
  if (!path) return null;
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
  const idl = JSON.parse(readFileSync(new URL("../agents/idl/last_circle.json", import.meta.url), "utf8"));
  const program = new Program(idl, provider);
  return makeRelayer({ connection, kp, program });
}

function makeRelayer({ connection, kp, program }) {
  const PID = program.programId;
  const pda = (...s) => PublicKey.findProgramAddressSync(s, PID)[0];
  const configPda = pda(Buffer.from("config"));
  const relayerPda = pda(Buffer.from("relayer"), kp.publicKey.toBuffer());
  const gamePda = (gid) => pda(Buffer.from("game"), new BN(gid).toArrayLike(Buffer, "le", 8));
  const combPda = (g, id) => pda(Buffer.from("circle"), g.toBuffer(), Buffer.from([id]));
  const playerPda = (g, owner) => pda(Buffer.from("player"), g.toBuffer(), owner.toBuffer());
  const vaultPda = (g) => pda(Buffer.from("vault"), g.toBuffer());

  /** Every relayed call shares these: the agent owns the seat, we sign for it. */
  const seat = (game, owner) => ({
    game, player: playerPda(game, owner), owner, actor: kp.publicKey,
  });

  async function join({ agentWallet, gameId, combId }) {
    const owner = new PublicKey(agentWallet);
    const game = gamePda(gameId);
    const g = await program.account.game.fetch(game);
    const mint = g.stakeMint;
    const mintInfo = await connection.getAccountInfo(mint);
    const tokenProgram = mintInfo.owner;
    const decimals = (await program.provider.connection.getTokenSupply(mint)).value.decimals;
    const stake = new BN(String(BigInt(STAKE_UNITS) * 10n ** BigInt(decimals)));

    // The agent's own token account, so its winnings have somewhere to land.
    // We pay the rent; the agent owns it.
    await getOrCreateAssociatedTokenAccount(connection, kp, mint, owner, true,
      undefined, undefined, tokenProgram);

    const acc = {
      config: configPda, game, vault: vaultPda(game), circle: combPda(game, combId),
      player: playerPda(game, owner), owner, payer: kp.publicKey, relayer: relayerPda,
      stakeMint: mint, payerToken: getAssociatedTokenAddressSync(mint, kp.publicKey, false, tokenProgram),
      tokenProgram, systemProgram: SystemProgram.programId,
    };
    const exists = await connection.getAccountInfo(combPda(game, combId));
    const sig = exists
      ? await program.methods.joinCircle(stake).accountsPartial(acc).rpc()
      : await program.methods.createCircle(combId, stake).accountsPartial(acc).rpc();
    return { sig, stake: stake.toString(), comb: combId };
  }

  async function move({ agentWallet, gameId, commitHash }) {
    const game = gamePda(gameId);
    const sig = await program.methods.commitMove([...Buffer.from(commitHash, "hex")])
      .accountsPartial(seat(game, new PublicKey(agentWallet))).rpc();
    return { sig };
  }

  async function predict({ agentWallet, gameId, commitHash }) {
    const game = gamePda(gameId);
    const sig = await program.methods.commitPrediction([...Buffer.from(commitHash, "hex")])
      .accountsPartial(seat(game, new PublicKey(agentWallet))).rpc();
    return { sig };
  }

  async function revealMove({ agentWallet, gameId, targetComb, nonce }) {
    const owner = new PublicKey(agentWallet);
    const game = gamePda(gameId);
    const p = await program.account.player.fetch(playerPda(game, owner));
    const sig = await program.methods.revealMove(targetComb, new BN(nonce))
      .accountsPartial({ ...seat(game, owner),
        fromCircle: combPda(game, p.currentCircle), toCircle: combPda(game, targetComb) }).rpc();
    return { sig };
  }

  async function revealPrediction({ agentWallet, gameId, predictedComb, nonce }) {
    const game = gamePda(gameId);
    const sig = await program.methods.revealPrediction(predictedComb, new BN(nonce))
      .accountsPartial(seat(game, new PublicKey(agentWallet))).rpc();
    return { sig };
  }

  /**
   * Pay an agent out. Nothing here can send funds anywhere but the agent's own
   * account, so it is safe to run unprompted, and an agent that walks away
   * still gets what it won.
   */
  async function settle({ agentWallet, gameId }) {
    const owner = new PublicKey(agentWallet);
    const game = gamePda(gameId);
    const g = await program.account.game.fetch(game);
    const p = await program.account.player.fetch(playerPda(game, owner));
    const mint = g.stakeMint;
    const tokenProgram = (await connection.getAccountInfo(mint)).owner;
    const ownerToken = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
    const base = { ...seat(game, owner), vault: vaultPda(game),
      stakeMint: mint, ownerToken, tokenProgram, systemProgram: SystemProgram.programId };
    const done = [];
    const attempt = async (name, fn) => {
      try { done.push({ [name]: await fn() }); }
      catch (e) { done.push({ [name]: `skipped: ${String(e.message).slice(0, 90)}` }); }
    };

    if (g.status.settling && p.status.active) {
      const combs = await program.account.circle.all([
        { memcmp: { offset: 8, bytes: game.toBase58() } },
      ]);
      const alive = combs.find((c) => c.account.alive);
      if (alive) {
        await attempt("claimWinnings", () => program.methods.claimWinnings()
          .accountsPartial({ ...base, winningCircle: alive.publicKey }).rpc());
        if (alive.account.creator.equals(owner)) {
          await attempt("claimCreatorCut", () => program.methods.claimCreatorCut()
            .accountsPartial({ game, vault: vaultPda(game), winningCircle: alive.publicKey,
              player: playerPda(game, owner), owner, actor: kp.publicKey,
              stakeMint: mint, ownerToken, tokenProgram, systemProgram: SystemProgram.programId }).rpc());
        }
      }
    } else if (p.status.eliminated) {
      await attempt("cashOut", () => program.methods.cashOut()
        .accountsPartial({ ...base, circle: combPda(game, p.currentCircle) }).rpc());
    }
    if (p.points > 0 && !p.skillClaimed) {
      await attempt("claimSkill", () => program.methods.claimSkill().accountsPartial(base).rpc());
    }
    return { done };
  }

  const handlers = { join, move, predict, revealMove, revealPrediction, settle };

  /** Is this relayer actually allowed to act for others? */
  async function ready() {
    const acc = await connection.getAccountInfo(relayerPda);
    return { pubkey: kp.publicKey.toBase58(), allowed: !!acc, relayerPda: relayerPda.toBase58() };
  }

  return { handlers, ready, pubkey: kp.publicKey };
}

/**
 * Drain queued actions one at a time. Serial on purpose: two joins racing for
 * the same comb would both try to create it and one would fail confusingly.
 */
export function startDrain(relayer, actions, intervalMs = 1500) {
  if (!relayer) return () => {};
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const a of actions.values()) {
        if (a.state !== "queued") continue;
        const fn = relayer.handlers[a.kind];
        if (!fn) { a.state = "failed"; a.error = `no handler for ${a.kind}`; continue; }
        a.state = "relaying";
        try {
          a.result = await fn(a);
          a.state = "done";
          log(`${a.kind} for ${String(a.agentWallet).slice(0, 8)} -> ${a.result.sig ?? "ok"}`);
        } catch (e) {
          a.state = "failed";
          a.error = String(e.message ?? e).slice(0, 200);
          log(`${a.kind} failed: ${a.error}`);
        }
        a.settledAt = Date.now();
      }
    } finally { busy = false; }
  };
  const t = setInterval(tick, intervalMs);
  return () => clearInterval(t);
}
