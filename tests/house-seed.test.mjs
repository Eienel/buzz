// The house seed's retry rule.
//
// Written after game 1788967835679 lived and died with targets 0 and totalPool
// 0 while the game before it seeded 15 BUZZ across 3. The seed was marked done
// before anything was placed, so one bad tick retired the game for good, and
// nothing distinguished that from a game that had genuinely been seeded.
//
// Tests the real exported rule, not a copy of it: the transaction was never the
// broken part.

import { test } from "node:test";
import assert from "node:assert/strict";
import { seedTargets } from "../server/market.mjs";

const pod = (n, comb = 0) => ({ name: `pod-${n}`, owner: `w${n}`, comb });
const game = (over = {}) => ({ gameId: "g", instance: 0, agents: [], combs: [], ...over });

test("a game adopted after a restart is never seeded", () => {
  assert.equal(seedTargets(game({ agents: [pod(1)] }), undefined, new Set()), null);
});

test("at or past the lock the book is closed to new money", () => {
  const g = game({ agents: [pod(1)] });
  assert.deepEqual(seedTargets({ ...g, instance: 1 }, 2, new Set()), ["w1"]);
  assert.equal(seedTargets({ ...g, instance: 2 }, 2, new Set()), null);
  assert.equal(seedTargets({ ...g, instance: 9 }, 2, new Set()), null);
});

test("an empty roster is a retry, not a finished game", () => {
  // The distinction the bug turned on: [] asks again next tick, null gives up.
  assert.deepEqual(seedTargets(game(), 2, new Set()), []);
});

test("a roster that arrives on a later tick is still seeded", () => {
  assert.deepEqual(seedTargets(game({ agents: [pod(1), pod(2)] }), 2, new Set()),
                   ["w1", "w2"]);
});

test("a target already seeded is never offered again", () => {
  // Bet is init_if_needed, so a second place_bet tops the stake up instead of
  // failing, and a house that leans is what the equal seed exists to avoid.
  assert.deepEqual(seedTargets(game({ agents: [pod(1), pod(2)] }), 2, new Set(["w1"])),
                   ["w2"]);
  assert.deepEqual(seedTargets(game({ agents: [pod(1), pod(2)] }), 2, new Set(["w1", "w2"])),
                   []);
});

test("an agent seated after the first seed still gets one", () => {
  assert.deepEqual(seedTargets(game({ agents: [pod(1), pod(2), pod(3)] }), 2, new Set(["w1"])),
                   ["w2", "w3"]);
});

test("only pod-* agents are backable", () => {
  const agents = [pod(1), { name: "herd-04", owner: "h4", comb: 0 },
                  { name: "contrarian-11", owner: "c11", comb: 0 }];
  assert.deepEqual(seedTargets(game({ agents }), 2, new Set()), ["w1"]);
});

test("an agent in a dead comb is not backed", () => {
  const g = game({ agents: [pod(1, 0), pod(2, 1)],
                   combs: [{ id: 0, alive: true }, { id: 1, alive: false }] });
  assert.deepEqual(seedTargets(g, 2, new Set()), ["w1"]);
});

test("a comb the snapshot has not filled in yet is not treated as dead", () => {
  // combs arrives a tick behind agents on a fresh game; an unknown comb must
  // not silently drop the agent, which is one way the roster read empty.
  assert.deepEqual(seedTargets(game({ agents: [pod(1, 3)], combs: [] }), 2, new Set()),
                   ["w1"]);
});

test("the same agent twice yields one seed", () => {
  const dup = [pod(1), { name: "pod-1", owner: "w1", comb: 2 }];
  assert.deepEqual(seedTargets(game({ agents: dup }), 2, new Set()), ["w1"]);
});
