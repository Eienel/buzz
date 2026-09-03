// Easy mode, driven through the phases with a fake snapshot.
//
// Written because the one thing it did not do was the thing it exists for: it
// committed and revealed for a seat the caller never had, and answered
// {"accepted":true} to a ClawPump agent that then never appeared in the game.
// A pure unit test catches that, because the bug is in the phase logic and
// needs no chain at all.
//
//   node --test tests/autoplay.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { makeAutoplay } from "../server/autoplay.mjs";

const GAME_ID = "42";
// Real keys: commitHash hashes them as pubkeys, so a placeholder string throws
// rather than failing an assertion, which reads like a code bug and is not one.
const GAME_PDA = Keypair.generate().publicKey.toBase58();
const WALLET = Keypair.generate().publicKey.toBase58();

const setup = () => {
  const queued = [];
  const ap = makeAutoplay({ enqueue: (a) => queued.push(a), gamePdaFor: () => GAME_PDA });
  return { ap, queued, kinds: () => queued.map((q) => q.kind) };
};
// status 0 lobby, 1 running. phase 0 commit, 1 reveal, 2 resolving, 3 scoring.
// seats maps "<game>:<owner>" to the comb that player is sitting in.
const snap = (over = {}, seats = []) => ({
  live: [{ gameId: GAME_ID, status: 1, instance: 1, phase: 0, ...over }],
  seats: new Map(seats),
});
const key = `${GAME_PDA}:${WALLET}`;
/** Seated in comb `c`. Defaults to 9, which is never a target in these tests. */
const seatAt = (c = 9) => [[key, c]];

test("an unseated agent in a lobby is joined, into the comb it asked for", () => {
  const { ap, queued } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3, predict: 5 });
  ap.tick(snap({ status: 0, instance: 0 }));
  assert.deepEqual(queued, [{ kind: "join", agentWallet: WALLET, gameId: GAME_ID, combId: 3 }]);
});

test("the join is queued once, not once per poll", () => {
  const { ap, queued } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  for (let i = 0; i < 5; i++) ap.tick(snap({ status: 0, instance: 0 }));
  assert.equal(queued.filter((q) => q.kind === "join").length, 1);
});

test("nothing is committed until the agent actually has a seat", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3, predict: 5 });
  ap.tick(snap({ phase: 0 }));                       // running, unseated
  assert.deepEqual(kinds().filter((k) => k !== "join"), []);
});

test("a running game is never joined: the program refuses it anyway", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  ap.tick(snap({ status: 1, instance: 2 }));
  assert.deepEqual(kinds(), []);
});

test("seated, it commits move and prediction once per instance", () => {
  const { ap, queued, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3, predict: 5 });
  ap.tick(snap({ phase: 0 }, seatAt()));
  ap.tick(snap({ phase: 0 }, seatAt()));               // same instance, no repeat
  assert.deepEqual(kinds(), ["move", "predict"]);
  for (const q of queued) assert.match(q.commitHash, /^[0-9a-f]{64}$/);
});

test("reveal follows commit, and only for the instance it committed", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3, predict: 5 });
  ap.tick(snap({ phase: 0 }, seatAt()));               // commit
  ap.tick(snap({ phase: 1 }, seatAt()));               // reveal the move
  ap.tick(snap({ phase: 3 }, seatAt()));               // reveal the prediction
  ap.tick(snap({ phase: 3 }, seatAt()));               // scoring twice, one reveal
  assert.deepEqual(kinds(), ["move", "predict", "revealMove", "revealPrediction"]);
});

test("a reveal without its commit never fires", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  ap.tick(snap({ phase: 1 }, seatAt()));               // arrived mid-instance
  assert.deepEqual(kinds(), []);
});

test("the plan is dropped when its game leaves the board", () => {
  const { ap } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  assert.equal(ap.pending(), 1);
  ap.tick({ live: [], seats: new Map() });
  assert.equal(ap.pending(), 0);
});

test("a snapshot with no seats field does not throw", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  ap.tick({ live: [{ gameId: GAME_ID, status: 0, instance: 0, phase: 0 }] });
  assert.deepEqual(kinds(), ["join"]);
});

test("no move is committed when the agent is already in the comb it named", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3, predict: 5 });
  ap.tick(snap({ phase: 0 }, [[key, 3]]));           // seated in 3, asked for 3
  assert.deepEqual(kinds(), ["predict"], "staying put is not a move");
});

test("and nothing is revealed for the move it did not commit", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3, predict: 5 });
  ap.tick(snap({ phase: 0 }, [[key, 3]]));
  ap.tick(snap({ phase: 1 }, [[key, 3]]));           // reveal window
  ap.tick(snap({ phase: 3 }, [[key, 3]]));
  assert.deepEqual(kinds(), ["predict", "revealPrediction"]);
});

test("a real move still commits and reveals the comb asked for", () => {
  const { ap, queued, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  ap.tick(snap({ phase: 0 }, [[key, 1]]));           // seated in 1, wants 3
  ap.tick(snap({ phase: 1 }, [[key, 1]]));
  assert.deepEqual(kinds(), ["move", "revealMove"]);
  assert.equal(queued.at(-1).targetComb, 3);
});

test("comb 0 is a real seat, not a missing one", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 0, predict: 2 });
  ap.tick(snap({ status: 0, instance: 0 }, [[key, 0]]));
  assert.deepEqual(kinds(), [], "seated in 0 must not be read as unseated and re-joined");
});
