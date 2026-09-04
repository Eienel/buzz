// The deal, which used to decide the game before a single move was made.
//
//   node --test tests/seating.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { dealSeats } from "../agents/seating.mjs";

const counts = (seats, combs = 6) => {
  const c = Array(combs).fill(0);
  for (const s of seats) c[s]++;
  return c;
};

test("every comb is occupied before any comb doubles", () => {
  for (let i = 0; i < 200; i++) {
    const c = counts(dealSeats(9));
    assert.equal(c.filter((x) => x === 0).length, 0, "a comb was left empty");
    assert.equal(Math.max(...c) - Math.min(...c), 1, "the deal was not even");
  }
});

test("fewer agents than combs still spreads one to a comb", () => {
  const seats = dealSeats(4);
  assert.equal(new Set(seats).size, 4);
});

test("which combs get the extra agents moves between games", () => {
  // The bug was that it never moved: combs 0, 1 and 2 got the doubles every
  // time. Over 200 deals every comb should draw an extra sometimes.
  const doubled = new Set();
  for (let i = 0; i < 200; i++)
    counts(dealSeats(9)).forEach((n, id) => { if (n > 1) doubled.add(id); });
  assert.deepEqual([...doubled].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test("the deal is uniform, not merely shuffled", () => {
  // Each comb should draw an extra in about half of nine-agent deals (three of
  // six combs double). Fail outside a wide band rather than on noise.
  const N = 3000, extra = Array(6).fill(0);
  for (let i = 0; i < N; i++)
    counts(dealSeats(9)).forEach((n, id) => { if (n > 1) extra[id]++; });
  for (const [id, n] of extra.entries())
    assert.ok(n / N > 0.4 && n / N < 0.6, `comb ${id} doubled ${(100 * n / N).toFixed(1)}% of deals`);
});
