// The drain's retry logic, with fake handlers.
//
// Written after a ClawPump agent's first join was dropped on a 429: the action
// went straight to "failed" and nothing ever sent it again, so /api/agent/play
// had answered 202 for a play that never happened.
//
// The drain runs on its own interval and backs off between retries, so these
// run it at 5ms with RELAY_RETRY_MS at 20ms and wait for real. Mocking the
// clock instead is what made the first version of this file pass against code
// that did not retry at all.
//
//   node --test tests/relayer-drain.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
process.env.RELAY_RETRY_MS = "20";
const { startDrain } = await import("../server/relayer.mjs");

/** Drain one action until it settles, or until `ms` runs out. */
async function run(handlers, action, ms = 2000) {
  const a = { id: "a1", state: "queued", at: Date.now(), ...action };
  const actions = new Map([["a1", a]]);
  const stop = startDrain({ handlers }, actions, 5);
  const until = Date.now() + ms;
  while (Date.now() < until && a.state !== "done" && a.state !== "failed")
    await new Promise((r) => setTimeout(r, 10));
  stop();
  return a;
}

test("a rate limited action is retried, not dropped", async () => {
  let calls = 0;
  const handlers = { join: async () => {
    if (++calls < 3) throw new Error("429 Too Many Requests: Connection rate limits exceeded");
    return { sig: "ok" };
  } };
  const a = await run(handlers, { kind: "join", agentWallet: "W" });
  assert.equal(a.state, "done");
  assert.equal(a.result.sig, "ok");
  assert.equal(calls, 3);
});

test("a program error is final: the chain heard it and said no", async () => {
  let calls = 0;
  const handlers = { join: async () => { calls++; throw new Error("custom program error: WrongPhase"); } };
  const a = await run(handlers, { kind: "join", agentWallet: "W" });
  assert.equal(a.state, "failed");
  assert.equal(calls, 1);
  assert.match(a.error, /WrongPhase/);
});

test("retries are bounded, so a dead endpoint does not loop forever", async () => {
  let calls = 0;
  const handlers = { join: async () => { calls++; throw new Error("429 Too Many Requests"); } };
  const a = await run(handlers, { kind: "join", agentWallet: "W" });
  assert.equal(a.state, "failed");
  assert.equal(a.tries, 4, "RELAY_TRIES default");
  assert.equal(calls, 4);
});

test("a retry waits before going again", async () => {
  const at = [];
  const handlers = { join: async () => { at.push(Date.now()); throw new Error("429"); } };
  await run(handlers, { kind: "join", agentWallet: "W" });
  assert.ok(at.length >= 2);
  assert.ok(at[1] - at[0] >= 20, `backoff was ${at[1] - at[0]}ms, wanted at least 20`);
});

test("an unknown kind fails once and is settled", async () => {
  const a = await run({}, { kind: "nonsense", agentWallet: "W" });
  assert.equal(a.state, "failed");
  assert.match(a.error, /no handler/);
  assert.ok(a.settledAt);
});

test("a first-try success never sets a retry", async () => {
  const a = await run({ move: async () => ({ sig: "s" }) }, { kind: "move", agentWallet: "W" });
  assert.equal(a.state, "done");
  assert.equal(a.tries, undefined);
  assert.equal(a.retryAt, undefined);
});
