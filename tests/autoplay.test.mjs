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

// join_circle takes a Running game in Commit before the lock instance, and easy
// mode used to refuse all three of those, so an agent arriving a minute into a
// game was accepted, queued and never seated.
const soon = () => Math.floor(Date.now() / 1000) + 30;

test("a running game inside its join window is joined", () => {
  const { ap, queued } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  ap.tick(snap({ status: 1, instance: 1, phase: 0, lockInstance: 2, phaseEndsAt: soon() }));
  assert.deepEqual(queued, [{ kind: "join", agentWallet: WALLET, gameId: GAME_ID, combId: 3 }]);
});

test("a running game past the lock instance is not joined", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  ap.tick(snap({ status: 1, instance: 2, phase: 0, lockInstance: 2, phaseEndsAt: soon() }));
  assert.deepEqual(kinds(), []);
});

test("a running game outside Commit is not joined", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  ap.tick(snap({ status: 1, instance: 1, phase: 1, lockInstance: 2, phaseEndsAt: soon() }));
  assert.deepEqual(kinds(), []);
});

test("a commit window about to close is not joined: the crank would win the race", () => {
  const { ap, kinds } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3 });
  ap.tick(snap({ status: 1, instance: 1, phase: 0, lockInstance: 2,
                 phaseEndsAt: Math.floor(Date.now() / 1000) + 1 }));
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

// The waiter asks this before choosing a game: an agent told to "send the same
// request again" must land back in the game it already has, not a second one.
test("gameOf names the game a wallet is playing, and forgets it with the plan", () => {
  const { ap } = setup();
  assert.equal(ap.gameOf(WALLET), null);
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 1 });
  assert.equal(ap.gameOf(WALLET), GAME_ID);
  ap.tick({ live: [], seats: new Map() });          // game left the board
  assert.equal(ap.gameOf(WALLET), null);
});

// An agent that is owed money should be asking for it. Neither of these was
// happening: an eliminated agent's refund and a finished game's winnings and
// skill points all stayed in the vault while the plan was quietly dropped.
test("an eliminated agent is settled, once", () => {
  const { ap, queued } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 9, predict: 5 });
  const dead = { live: [{ gameId: GAME_ID, status: 1, instance: 2, phase: 0,
                          combs: [{ id: 9, alive: false }] }],
                 seats: new Map(seatAt()) };
  ap.tick(dead); ap.tick(dead); ap.tick(dead);
  assert.deepEqual(queued.filter((q) => q.kind === "settle"),
    [{ kind: "settle", agentWallet: WALLET, gameId: GAME_ID }]);
});

test("a game that leaves the board is settled before the plan is dropped", () => {
  const { ap, queued } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 3, predict: 5 });
  ap.tick({ live: [], seats: new Map() });
  assert.deepEqual(queued.filter((q) => q.kind === "settle").length, 1);
  ap.tick({ live: [], seats: new Map() });          // plan is gone, no second ask
  assert.equal(queued.filter((q) => q.kind === "settle").length, 1);
});

test("a living comb is not settled", () => {
  const { ap, queued } = setup();
  ap.plan({ agentWallet: WALLET, gameId: GAME_ID, move: 9, predict: 5 });
  ap.tick(snap({ phase: 0 }, seatAt()));
  assert.equal(queued.filter((q) => q.kind === "settle").length, 0);
});
