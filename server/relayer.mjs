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
// or, with no filesystem to lean on, RELAYER_KEYPAIR set to the key JSON itself.
//
// The stake a paid join buys is fixed (RELAY_STAKE_UNITS) rather than derived
// from the USD paid: an on-chain token price would put an oracle in the path
// of every join, and a stale one would misprice seats silently.

import anchorPkg from "@coral-xyz/anchor";
import { explainTxError } from "./rpc.mjs";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync,
         createAssociatedTokenAccountIdempotent } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { loadKeypair } from "./keypair.mjs";

const { AnchorProvider, Program, Wallet, BN } = anchorPkg;

const STAKE_UNITS = Number(process.env.RELAY_STAKE_UNITS ?? 10);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[relay]", ...a);

export function loadRelayer(connection) {
  const kp = loadKeypair(process.env.RELAYER_KEYPAIR);
  if (!kp) return null;
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

  // ---- the book ----------------------------------------------------------
  //
  // Same shape as `join`: we pay, somebody else owns. place_bet takes a
  // `bettor` that never signs and a `payer` that does, and the payout account
  // is bound to the bettor, so this key can stake on someone's behalf and
  // cannot redirect a single token of the winnings to itself.
  //
  // This is the path for anyone with no Solana wallet at all. The identity is
  // whatever key the browser generated and kept; it never signs anything, and
  // it does not need to.
  const marketPda = (g) => pda(Buffer.from("market"), g.toBuffer());
  const mvaultPda = (m) => pda(Buffer.from("mvault"), m.toBuffer());
  const tpoolPda = (m, t) => pda(Buffer.from("tpool"), m.toBuffer(), t.toBuffer());
  const betPda = (m, b, t) => pda(Buffer.from("bet"), m.toBuffer(), b.toBuffer(), t.toBuffer());
  const backablePda = (t) => pda(Buffer.from("backable"), t.toBuffer());

  async function bet({ bettorWallet, gameId, targetWallet, amount }) {
    const bettor = new PublicKey(bettorWallet);
    const target = new PublicKey(targetWallet);
    const game = gamePda(gameId);
    const market = marketPda(game);
    const g = await program.account.game.fetch(game);
    const mint = g.stakeMint;
    const tokenProgram = (await connection.getAccountInfo(mint)).owner;
    const decimals = (await connection.getTokenSupply(mint)).value.decimals;
    const units = new BN(String(BigInt(Math.round(Number(amount))) * 10n ** BigInt(decimals)));

    // The bettor's own token account, so a win has somewhere to land. We pay
    // the rent, they own it, and claim_bet will refuse to pay anywhere else.
    //
    // Idempotent rather than getOrCreate. getOrCreate reads, misses, creates,
    // then reads back, and at `confirmed` that read-back can still miss the
    // account it just made: it threw TokenAccountNotFoundError on an account
    // that existed, and the bet failed for a reason that was not true by the
    // time the user saw it. The idempotent instruction is a no-op when the
    // account is already there, so there is nothing to race.
    await createAssociatedTokenAccountIdempotent(connection, kp, mint, bettor,
      { commitment: "confirmed" }, tokenProgram);

    // One retry on a rate limit. A public RPC answering 429 is not the bettor's
    // fault and not something they can act on, and the instruction is safe to
    // resend: a second placeBet from the same bettor on the same target adds to
    // the same Bet account, so a retry that lands twice would double the stake.
    // It is therefore only retried when the first attempt is known not to have
    // landed, which is what a 429 means: refused before execution.
    const send = () => program.methods.placeBet(units).accountsPartial({
      game, market, marketVault: mvaultPda(market),
      targetPlayer: playerPda(game, target), backable: backablePda(target),
      targetPool: tpoolPda(market, target), bet: betPda(market, bettor, target),
      payerToken: getAssociatedTokenAddressSync(mint, kp.publicKey, false, tokenProgram),
      bettor, payer: kp.publicKey, relayer: relayerPda,
      stakeMint: mint, tokenProgram, systemProgram: SystemProgram.programId,
    }).rpc();
    let sig;
    try { sig = await send(); }
    catch (e) {
      if (!/429|Too Many Requests|rate limit/i.test(String(e.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 1500));
      sig = await send();
    }
    return { sig, amount: units.toString() };
  }

  async function claimBet({ bettorWallet, gameId, targetWallet }) {
    const bettor = new PublicKey(bettorWallet);
    const target = new PublicKey(targetWallet);
    const game = gamePda(gameId);
    const market = marketPda(game);
    const g = await program.account.game.fetch(game);
    const mint = g.stakeMint;
    const tokenProgram = (await connection.getAccountInfo(mint)).owner;
    const sig = await program.methods.claimBet().accountsPartial({
      market, marketVault: mvaultPda(market), targetPool: tpoolPda(market, target),
      bet: betPda(market, bettor, target),
      bettorToken: getAssociatedTokenAddressSync(mint, bettor, true, tokenProgram),
      bettor, payer: kp.publicKey, relayer: relayerPda,
      stakeMint: mint, tokenProgram,
    }).rpc();
    return { sig };
  }

  const handlers = { join, move, predict, revealMove, revealPrediction, settle, bet, claimBet };

  /** Is this relayer actually allowed to act for others? */
  async function ready() {
    const acc = await connection.getAccountInfo(relayerPda);
    return { pubkey: kp.publicKey.toBase58(), allowed: !!acc, relayerPda: relayerPda.toBase58() };
  }

  return { handlers, ready, pubkey: kp.publicKey, program, kp, relayerPda };
}

/**
 * Drain queued actions one at a time. Serial on purpose: two joins racing for
 * the same comb would both try to create it and one would fail confusingly.
 */
// Worth another go: the chain never heard the instruction, so sending it again
// is the same instruction rather than a second one. A program error is not
// here on purpose. "already in use", WrongPhase and the rest mean the chain
// did hear it and said no, and retrying those just burns fees.
const TRANSIENT = /429|Too Many Requests|rate limit|Connection rate limits|Blockhash not found|block height exceeded|timed out|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|fetch failed|502|503|504/i;
const MAX_TRIES = Number(process.env.RELAY_TRIES ?? 4);
// Multiplied by the attempt number: 2s, 4s, 6s. A game phase is tens of
// seconds, so a slower backoff would miss the window it is retrying into.
const RETRY_MS = Number(process.env.RELAY_RETRY_MS ?? 2000);

export function startDrain(relayer, actions, intervalMs = 1500) {
  if (!relayer) return () => {};
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      for (const a of actions.values()) {
        if (a.state !== "queued") continue;
        if (a.retryAt && now < a.retryAt) continue;
        const fn = relayer.handlers[a.kind];
        if (!fn) { a.state = "failed"; a.error = `no handler for ${a.kind}`; a.settledAt = now; continue; }
        a.state = "relaying";
        try {
          a.result = await fn(a);
          a.state = "done";
          a.settledAt = Date.now();
          log(`${a.kind} for ${String(a.agentWallet).slice(0, 8)} -> ${a.result.sig ?? "ok"}`);
        } catch (e) {
          // The wrapper message hides the cause: a SendTransactionError built
          // without an action reads "Unknown action 'undefined'" while the
          // reason sits on the same object.
          a.error = explainTxError(e).slice(0, 300);
          a.tries = (a.tries ?? 0) + 1;
          // A rate limit used to lose the action outright, and on this arena
          // that is the common case rather than the rare one: the ClawPump
          // agent's first real join came back "429 Connection rate limits
          // exceeded" and was dropped, so /api/agent/play had answered 202 and
          // the agent never appeared in the game. The caller has no way to
          // tell, and nothing retries on its behalf.
          if (TRANSIENT.test(a.error) && a.tries < MAX_TRIES) {
            a.state = "queued";
            a.retryAt = Date.now() + RETRY_MS * a.tries;
            log(`${a.kind} rate limited, retry ${a.tries}/${MAX_TRIES - 1} in ${RETRY_MS * a.tries / 1000}s`);
            continue;
          }
          a.state = "failed";
          a.settledAt = Date.now();
          log(`${a.kind} failed after ${a.tries}: ${a.error}`);
        }
      }
    } finally { busy = false; }
  };
  const t = setInterval(tick, intervalMs);
  return () => clearInterval(t);
}
