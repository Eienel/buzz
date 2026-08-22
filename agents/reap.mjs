// Reap finished games: close their Player/Circle/Game accounts so the rent
// comes back and they stop showing up as "Settling" forever.
//
//   PAYER=~/.config/solana/id.json node agents/reap.mjs
//
// Only games in Settling are touched. Players whose owners we cannot sign for
// are skipped unless they are fully settled (then the close is permissionless),
// so a game with an unclaimed player simply stays until its owner acts.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";

const { AnchorProvider, Program, Wallet } = anchorPkg;
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.PAYER ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8"));
const program = new Program(idl, provider);
const PID = program.programId;
const pda = (...s) => PublicKey.findProgramAddressSync(s, PID)[0];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSE = Number(process.env.PAUSE_MS ?? 400); // be gentle with the public RPC

const before = await connection.getBalance(payer.publicKey);
// ONE scan of each account type, then group locally — scanning per game
// rate-limits the public RPC instantly.
const games = await program.account.game.all();
await sleep(PAUSE);
const allPlayers = await program.account.player.all();
await sleep(PAUSE);
const allCircles = await program.account.circle.all();
const settling = games.filter((g) => g.account.status.settling);
log(`${games.length} game accounts on-chain, ${settling.length} in Settling, ` +
    `${allPlayers.length} players, ${allCircles.length} circles`);

for (const { publicKey: gamePda, account: g } of settling) {
  const vaultPda = pda(Buffer.from("vault"), gamePda.toBuffer());
  const players = allPlayers.filter((p) => p.account.game.equals(gamePda));
  const circles = allCircles.filter((c) => c.account.game.equals(gamePda));

  for (const p of players) {
    try {
      await program.methods.closePlayer()
        .accounts({ game: gamePda, player: p.publicKey, owner: p.account.owner, cranker: payer.publicKey }).rpc();
    } catch (e) { log(`  player ${p.publicKey.toBase58().slice(0, 8)}: ${String(e.message).slice(0, 44)}`); }
    await sleep(PAUSE);
  }
  for (const c of circles) {
    try {
      await program.methods.closeCircle()
        .accounts({ game: gamePda, circle: c.publicKey, creator: c.account.creator, cranker: payer.publicKey }).rpc();
    } catch (e) { log(`  circle ${c.account.circleId}: ${String(e.message).slice(0, 44)}`); }
    await sleep(PAUSE);
  }
  try {
    await program.methods.closeGame()
      .accounts({ game: gamePda, vault: vaultPda, treasury: pda(Buffer.from("treasury")), treasuryVault: pda(Buffer.from("treasury_vault")), authority: payer.publicKey, cranker: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    log(`reaped game ${g.gameId}`);
  } catch (e) { log(`game ${g.gameId}: ${String(e.message).slice(0, 60)}`); }
  await sleep(PAUSE);
}

const after = await connection.getBalance(payer.publicKey);
log(`rent reclaimed: ${((after - before) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
const left = await program.account.game.all();
log(`game accounts remaining: ${left.length}`);
