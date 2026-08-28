// Did crankStep stop the swarm skipping settlement?
//
// The question is not what status a game ends in: Settling is the normal end
// state, and a reaped game has no account at all. The leak was players left
// Active with unclaimed points because the crank race made the swarm give up
// before settling. So look at the players, and only in games started after
// SINCE, which the reaper has not touched.
import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
const { AnchorProvider, Program, Wallet } = anchorPkg;
const connection = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const program = new Program(
  JSON.parse(readFileSync("/home/user/buzz/agents/idl/last_circle.json", "utf8")),
  new AnchorProvider(connection, new Wallet(Keypair.generate()), { commitment: "confirmed" }));
const grab = async (name) => {
  const raw = await connection.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: program.coder.accounts.memcmp(name).bytes } }] });
  const out = [];
  for (const { pubkey, account } of raw) {
    try { out.push({ pubkey, d: program.coder.accounts.decode(name, account.data) }); } catch {}
  }
  return out;
};
const games = await grab("game");
const players = await grab("player");
const SINCE = Number(process.env.SINCE ?? 0);
const st = (s) => Object.keys(s)[0];
const byGame = new Map();
for (const p of players) {
  const k = p.d.game.toBase58();
  if (!byGame.has(k)) byGame.set(k, []);
  byGame.get(k).push(p.d);
}
const recent = games.filter((g) => Number(g.d.gameId) >= SINCE);
recent.sort((a, b) => Number(a.d.gameId) - Number(b.d.gameId));
console.log(`${games.length} games, ${players.length} players`);
console.log(`${recent.length} games started at or after ${new Date(SINCE).toISOString()}`);
let stuck = 0, clean = 0;
for (const g of recent) {
  if (st(g.d.status) !== "settling") continue;
  const ps = byGame.get(g.pubkey.toBase58()) ?? [];
  const active = ps.filter((p) => st(p.status) === "active");
  const owed = ps.filter((p) => Number(p.points) > 0 && !p.skillClaimed);
  if (active.length || owed.length) {
    stuck++;
    console.log(`  ${g.d.gameId}  ${ps.length} players, ${active.length} still Active, ${owed.length} unclaimed`);
  } else clean++;
}
console.log(`\nsettled games since cutoff: ${clean} clean, ${stuck} left with an unsettled player`);
