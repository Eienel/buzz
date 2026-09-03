// The boot filter that decides which recorded games survive a restart.
//
// It exists to delete aborted lobbies that an old bug wrote in as finished
// games: a field under four could never have started. It was also deleting
// every result whose per-agent detail had been reaped, because record() leaves
// `entrants` empty on those and `[].length ?? h.players` is 0. Games finished
// on the day this was found were gone by the next deploy.
//
//   node --test tests/history-filter.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

// The predicate as it now stands in server/index.mjs. Kept in step by the
// tests below rather than by exporting a one-line arrow from a 1500 line file.
const fieldOf = (h) => Math.max(h.entrants?.length ?? 0, h.players ?? 0);
const keep = (h) => fieldOf(h) >= 4;

// What the old one did, so the regression is visible rather than described.
const oldKeep = (h) => (h.entrants?.length ?? h.players ?? 0) >= 4;

test("a full record is kept", () => {
  assert.equal(keep({ entrants: ["a","b","c","d","e"], players: 5 }), true);
});

test("a reaped record is kept, and used not to be", () => {
  const reaped = { entrants: [], players: 7, partial: true };
  assert.equal(keep(reaped), true);
  assert.equal(oldKeep(reaped), false, "this is the bug being fixed");
});

test("an aborted lobby is still dropped, which is the whole point", () => {
  assert.equal(keep({ entrants: ["a","b"], players: 2 }), false);
  assert.equal(keep({ entrants: [], players: 1, partial: true }), false);
  assert.equal(keep({ entrants: [], players: 0 }), false);
});

test("exactly four is a real game", () => {
  assert.equal(keep({ entrants: ["a","b","c","d"], players: 4 }), true);
  assert.equal(keep({ entrants: [], players: 4 }), true);
});

test("a record missing both counts is dropped rather than throwing", () => {
  assert.equal(keep({}), false);
  assert.equal(keep({ entrants: undefined, players: undefined }), false);
});

test("the larger of the two counts wins", () => {
  // The chain's own player count can lag the entrants we actually saw.
  assert.equal(fieldOf({ entrants: ["a","b","c","d","e"], players: 2 }), 5);
  assert.equal(fieldOf({ entrants: [], players: 6 }), 6);
});
