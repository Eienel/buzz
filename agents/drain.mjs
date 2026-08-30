// Crank every stale game to a decided state before a layout-changing upgrade.
//
//   PAYER=~/.config/solana/id.json node agents/drain.mjs
//
// A program upgrade never touches account data, so a Player written under the
// old layout stays the old size and the new program cannot deserialize it. The
// safe order is therefore: decide every live game first, then upgrade. This
// only uses permissionless cranks, because the swarm's agent keypairs are
// ephemeral and are gone once a game ends, so nobody can sign for those
// players any more. Cranking is enough to reach a winner: an instance with no
// reveals still kills a comb.

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { makeConnection, surviveRateLimits } from "../server/rpc.mjs";

const { AnchorProvider, Program, Wallet } = anchorPkg;
const connection = makeConnection(process.env.RPC ?? "https://api.devnet.solana.com", { label: "drain" });
surviveRateLimits("drain");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  readFileSync(process.env.PAYER ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync(new URL("./idl/last_circle.json", import.meta.url), "utf8"));
const program = new Program(idl, provider);
const PID = program.programId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pda = (...s) => PublicKey.findProgramAddressSync(s, PID)[0];
const combPda = (g, id) => pda(Buffer.from("circle"), g.toBuffer(), Buffer.from([id]));

// Enumerate by exact size: games written before the multi-mint upgrade are
// shorter and already unreadable by the deployed program, so decoding them here
// only throws. They were stranded by that upgrade, not this one.
const GAME_SIZE = program.account.game.size;
const raw = await connection.getProgramAccounts(PID, { filters: [{ dataSize: GAME_SIZE }] });
const games = raw.map(({ pubkey, account }) => ({
  publicKey: pubkey,
  account: program.coder.accounts.decode("game", account.data),
}));
log(`${games.length} games at the current layout (${GAME_SIZE} bytes)`);
const running = games.filter((g) => g.account.status.running);
const lobbies = games.filter((g) => g.account.status.lobby);
log(`${running.length} running, ${lobbies.length} lobbies`);

// Empty lobbies that timed out: abort so they stop showing as playable.
for (const { publicKey, account } of lobbies) {
  try {
    await program.methods.abortLobby().accountsPartial({ game: publicKey, cranker: payer.publicKey }).rpc();
    log(`lobby ${account.gameId} aborted`);
  } catch (e) { log(`lobby ${account.gameId}: ${String(e.message).slice(0, 70)}`); }
}

for (const { publicKey: game, account } of running) {
  const id = account.gameId.toString();
  log(`draining game ${id}`);
  for (let guard = 0; guard < 40; guard++) {
    let g;
    try { g = await program.account.game.fetch(game); } catch { break; }
    if (!g.status.running) { log(`  game ${id} decided`); break; }

    const combs = [];
    for (let i = 0; i < g.numCircles; i++) {
      try {
        const c = await program.account.circle.fetch(combPda(game, i));
        if (c.alive) combs.push(i);
      } catch {}
    }
    // One comb left still needs the instance to advance before the game
    // transitions to Settling, so keep cranking rather than stopping here.
    const decided = combs.length <= 1;

    const wait = g.phaseEndsAt.toNumber() * 1000 - Date.now() + 1500;
    if (wait > 0) await sleep(Math.min(wait, 40000));

    try {
      const phase = Object.keys(g.phase)[0];
      if (decided && phase !== "scoring") {
        await program.methods.advanceInstance().accountsPartial({ game, cranker: payer.publicKey }).rpc();
      } else if (phase === "commit") {
        await program.methods.advanceToReveal().accountsPartial({ game, cranker: payer.publicKey }).rpc();
      } else if (phase === "reveal") {
        // select_death can only land once the committed entropy slot has passed.
        for (let t = 0; t < 15; t++) {
          try {
            await program.methods.selectDeath()
              .accountsPartial({ game, recentSlotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
                                 randomness: null, cranker: payer.publicKey })
              .remainingAccounts(combs.map((i) => ({ pubkey: combPda(game, i), isSigner: false, isWritable: false })))
              .rpc();
            break;
          } catch (e) {
            if (!String(e).includes("PhaseNotOver")) throw e;
            await sleep(1500);
          }
        }
      } else if (phase === "resolving") {
        const doomed = (await program.account.game.fetch(game)).doomedCircle;
        await program.methods.executeDeath(doomed)
          .accountsPartial({ game, circle: combPda(game, doomed), cranker: payer.publicKey }).rpc();
        log(`  game ${id}: comb ${doomed} died`);
      } else {
        await program.methods.advanceInstance().accountsPartial({ game, cranker: payer.publicKey }).rpc();
      }
    } catch (e) { log(`  game ${id}: ${String(e.message).slice(0, 90)}`); await sleep(2000); }
  }
}
log("drain complete");
