// Which comb the house takes when it matches the first bet in a round.
//
// A parimutuel with one participant pays that participant their own stake back:
// they are both the winning pool and the whole pool. Two real bets have ever
// been placed on this arena and both returned exactly what went in. The house
// match exists to make the first ticket in a round worth more than its stake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { houseComb } from "../server/rounds.mjs";

const pools = (o) => { const a = Array(12).fill(0n); for (const k in o) a[k] = BigInt(o[k]); return a; };

test("takes the emptiest living comb", () => {
  assert.equal(houseComb(pools({ 0: 10 }), [0, 1, 2]), 1);
});

test("lowest id breaks a tie, so the rule is checkable", () => {
  assert.equal(houseComb(pools({ 2: 10 }), [0, 1, 2]), 0);
  assert.equal(houseComb(pools({ 0: 10 }), [0, 3, 5]), 3);
});

test("never takes a comb that is already dead", () => {
  // A dead comb cannot die again and place_round_bet rejects it outright.
  assert.equal(houseComb(pools({ 1: 10 }), [1, 4]), 4);
});

test("stays out when every living comb already has money", () => {
  // The book does not need a counterparty: a winner is already being paid by
  // the money on the combs that did not die.
  assert.equal(houseComb(pools({ 0: 5, 1: 5, 2: 5 }), [0, 1, 2]), null);
});

test("stays out when there is nothing to take", () => {
  assert.equal(houseComb(pools({}), []), null);
  assert.equal(houseComb(pools({}), null), null);
});

test("the chosen comb is one that makes the bettor's ticket pay", () => {
  // The payout is stake * total / winning. With the bettor alone on comb 0 the
  // ratio is 1, which is the arrival problem. The house on any other comb
  // makes it worth more, and this asserts the arithmetic rather than the rule.
  const bettor = 10n, house = 10n;
  const comb = houseComb(pools({ 0: bettor }), [0, 1, 2]);
  assert.notEqual(comb, 0, "must not land on the bettor's own comb here");
  const total = bettor + house, winning = bettor;      // bettor's comb dies
  assert.equal(bettor * total / winning, 20n, "10 staked returns 20");
});
