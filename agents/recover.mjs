// Reclaim the rent sitting in finished games.
//
//   PAYER=~/.config/solana/id.json node agents/recover.mjs [maxGames]
//
// Every game leaves Player, Circle and Game accounts behind, each holding its
// rent-exempt minimum. Across a few hundred games that is most of the payer's
// balance, which is why the arena keeps running dry: the SOL was never burned,
// only parked.
//
// reap.mjs could not get it back because it was written when the swarm's agents
// were ephemeral: close_player needs the owner's signature unless the player is
// fully settled, and those keys were gone. Swarm agents are now derived from
// SWARM_SEED, so every house player can be signed for and closed.
//
// Rent lands in three different places, which sets the order:
//   close_player  -> player.owner    (an agent wallet)
//   close_circle  -> circle.creator  (an agent wallet)
//   close_game    -> game.authority  (the payer)
// Players must all go before circles, and circles before the game, so this
// walks each game in that order and sweeps the agent wallets at the end.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import sha3 from "js-sha3";
const { keccak_256 } = sha3;   // js-sha3 is CommonJS; named imports do not resolve
import { readFileSync } from "node:fs";
import { loadKeypair } from "../server/keypair.mjs";
import { makeConnection, surviveRateLimits } from "../server/rpc.mjs";

const { AnchorProvider, Program, Wallet } = anchorPkg;
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const MAX_GAMES = Number(process.argv[2] ?? process.env.MAX_GAMES ?? 40);
const PAUSE = Number(process.env.PAUSE_MS ?? 120);

const payer = loadKeypair(process.env.PAYER, `${process.env.HOME}/.config/solana/id.json`);
const connection = makeConnection(RPC, { label: "recover" });
surviveRateLimits("recover");
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const program = new Program(
  JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8")), provider);
const PID = program.programId;
const pda = (...s) => PublicKey.findProgramAddressSync(s, PID)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- every house agent we have ever named -----------------------------------
const SWARM_SEED = process.env.SWARM_SEED ?? "buzz-devnet-swarm-v1";
const agentKey = (name) => Keypair.fromSeed(
  Uint8Array.from(Buffer.from(keccak_256.arrayBuffer(`${SWARM_SEED}:${name}`)).subarray(0, 32)));

const known = new Map();                       // base58 -> Keypair
const STRATS = ["herd", "contrarian", "random"];
for (let slot = 0; slot < 6; slot++) {
  for (let i = 0; i < 12; i++) {
    for (const name of [`${STRATS[i % STRATS.length]}-${slot}${i}`, `pod-${slot}${i}`]) {
      const kp = agentKey(name);
      known.set(kp.publicKey.toBase58(), kp);
    }
  }
}
log(`derived ${known.size} house agent keys`);

/** Decode per account and skip anything written under an older layout. */
async function decodeAll(name) {
  const disc = program.coder.accounts.memcmp(name).bytes;
  const raw = await connection.getProgramAccounts(PID, { filters: [{ memcmp: { offset: 0, bytes: disc } }] });
  const out = [];
  for (const { pubkey, account } of raw) {
    try { out.push({ publicKey: pubkey, account: program.coder.accounts.decode(name, account.data) }); }
    catch { /* predates this program; not ours to close */ }
  }
  return out;
}


// The IDL marks `owner` and `creator` as non-signers, because most closes are
// permissionless. The program still demands their signature for a player that
// never settled or a comb still alive, and Anchor will not mark an account it
// believes needs no signature — web3 then rejects the extra keypair outright
// with "unknown signer". So build the instruction, flip that one account's
// meta, and sign it ourselves.
async function sendSigned(ix, extra, signer) {
  if (signer) for (const k of ix.keys) if (k.pubkey.equals(extra)) k.isSigner = true;
  const tx = new Transaction().add(ix);
  return provider.sendAndConfirm(tx, signer ? [signer] : []);
}

const before = await connection.getBalance(payer.publicKey);
log(`payer ${payer.publicKey.toBase58()} at ${(before / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

const games = await decodeAll("game");
await sleep(PAUSE);
const players = await decodeAll("player");
await sleep(PAUSE);
const circles = await decodeAll("circle");
const settling = games.filter((g) => g.account.status.settling);
log(`${games.length} games (${settling.length} settling), ${players.length} players, ${circles.length} circles`);

let closedP = 0, closedC = 0, closedG = 0, blocked = 0;
for (const { publicKey: gamePda, account: g } of settling.slice(0, MAX_GAMES)) {
  const mine = players.filter((p) => p.account.game.equals(gamePda));
  const cs = circles.filter((c) => c.account.game.equals(gamePda));
  let stuck = false;

  for (const p of mine) {
    const owner = p.account.owner;
    const kp = known.get(owner.toBase58());
    const settled = !p.account.status.active && (p.account.skillClaimed || p.account.points === 0);
    if (!settled && !kp) { stuck = true; blocked++; continue; }   // someone else's player
    try {
      const ix = await program.methods.closePlayer()
        .accountsPartial({ game: gamePda, player: p.publicKey, owner, cranker: payer.publicKey })
        .instruction();
      await sendSigned(ix, owner, settled ? null : kp);
      closedP++;
    } catch (e) { stuck = true; log(`  player ${p.publicKey.toBase58().slice(0,8)}: ${String(e.message).slice(0,60)}`); }
    await sleep(PAUSE);
  }
  if (stuck) continue;                       // circles need player_count at zero

  for (const c of cs) {
    const creator = c.account.creator;
    const kp = known.get(creator.toBase58());
    const needsSig = c.account.alive && !g.creatorCutPaid;
    if (needsSig && !kp) { stuck = true; blocked++; continue; }
    try {
      const ix = await program.methods.closeCircle()
        .accountsPartial({ game: gamePda, circle: c.publicKey, creator, cranker: payer.publicKey })
        .instruction();
      await sendSigned(ix, creator, needsSig ? kp : null);
      closedC++;
    } catch (e) { stuck = true; log(`  circle ${c.account.circleId}: ${String(e.message).slice(0,60)}`); }
    await sleep(PAUSE);
  }
  if (stuck) continue;

  try {
    const mintInfo = await connection.getAccountInfo(g.stakeMint);
    const tokenProgram = mintInfo.owner;          // Token or Token-2022
    const treasury = pda(Buffer.from("treasury"), g.stakeMint.toBuffer());
    const tvault  = pda(Buffer.from("tvault"),   g.stakeMint.toBuffer());
    // close_game refuses while the rake is still in the vault, so sweep it to
    // the treasury first. Already-collected games throw, which is fine.
    try {
      await program.methods.collectFees().accountsPartial({
        config: pda(Buffer.from("config")), game: gamePda,
        vault: pda(Buffer.from("vault"), gamePda.toBuffer()),
        treasury, treasuryVault: tvault, stakeMint: g.stakeMint, tokenProgram,
        cranker: payer.publicKey }).rpc();
      await sleep(PAUSE);
    } catch { /* nothing left to collect */ }
    await program.methods.closeGame()
      .accountsPartial({ game: gamePda, vault: pda(Buffer.from("vault"), gamePda.toBuffer()),
        treasury, treasuryVault: tvault,
        stakeMint: g.stakeMint, tokenProgram,
        authority: g.authority, cranker: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    closedG++;
    log(`reaped game ${g.gameId} (${mine.length} players, ${cs.length} combs)`);
  } catch (e) { log(`game ${g.gameId}: ${String(e.message).slice(0,70)}`); }
  await sleep(PAUSE);
}

// ---- sweep the agents: player and circle rent landed in their wallets --------
let swept = 0;
for (const kp of known.values()) {
  const bal = await connection.getBalance(kp.publicKey);
  if (bal <= 0) continue;
  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: kp.publicKey, toPubkey: payer.publicKey, lamports: bal }));
    tx.feePayer = payer.publicKey;
    await provider.sendAndConfirm(tx, [kp]);
    swept += bal;
  } catch (e) { log(`sweep ${kp.publicKey.toBase58().slice(0,8)}: ${String(e.message).slice(0,50)}`); }
}

const after = await connection.getBalance(payer.publicKey);
log(`closed ${closedP} players, ${closedC} circles, ${closedG} games; ${blocked} not ours to close`);
log(`swept ${(swept / LAMPORTS_PER_SOL).toFixed(4)} SOL out of agent wallets`);
log(`payer ${(before / LAMPORTS_PER_SOL).toFixed(4)} -> ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
    `(${((after - before) / LAMPORTS_PER_SOL >= 0 ? "+" : "")}${((after - before) / LAMPORTS_PER_SOL).toFixed(4)})`);
