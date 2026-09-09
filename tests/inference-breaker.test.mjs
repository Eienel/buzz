// The breaker that stops every pod paying to learn the account is empty.
//
// Measured on the live arena: 53 of a 60-call window were 402
// insufficient_balance, and being told there was no money took 13.1s and 24.9s
// on consecutive calls. Each pod spent most of its commit window on that, every
// round, while its own 60-call budget sat untouched.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.USEPOD_TOKEN ||= "test-token";
process.env.USEPOD_DRY_COOLDOWN_MS = "60000";

const fog = { 0: 2, 1: 1, 2: 3 };
const load = (tag) => import(`../agents/reason.mjs?${tag}`);

/** A UsePod that is slow to say no, which is the behaviour that costs. */
function stub(status, body, delayMs = 20) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, delayMs));
    return { ok: false, status, text: async () => body, headers: { get: () => null } };
  };
  return () => calls;
}

test("a 402 opens the breaker and the cohort stops calling", async () => {
  const calls = stub(402, '{"error":{"message":"insufficient balance","type":"insufficient_balance"}}');
  const { decide, inferenceDry } = await load("a");
  const skips = [];
  const run = () => decide(fog, 0, { instanceSeconds: 60,
    onSkip: (why, ms) => skips.push({ why, ms }) });

  await run();
  assert.equal(calls(), 1, "the first call still has to find out");
  assert.ok(inferenceDry() > 0, "breaker is open");

  const t0 = Date.now();
  await run(); await run(); await run();
  assert.equal(calls(), 1, "no further call reaches the network");
  assert.ok(Date.now() - t0 < 20, "and none of them waits");

  // The page reads this line. It must not blame the agent's own budget, which
  // at this point is untouched.
  assert.match(skips.at(-1).why, /prepaid account is empty/);
  assert.equal(skips.at(-1).ms, 0);
});

test("a plain server error does not open the breaker", async () => {
  const calls = stub(500, "upstream exploded");
  const { decide, inferenceDry } = await load("b");
  await decide(fog, 0, { instanceSeconds: 60, onSkip: () => {} });
  assert.equal(inferenceDry(), 0, "500 is this call's problem, not the account's");
  assert.equal(calls(), 1);
  await decide(fog, 0, { instanceSeconds: 60, onSkip: () => {} });
  assert.equal(calls(), 2, "so the next call is still made");
});

test("an insufficient_balance body opens it whatever the status", async () => {
  stub(400, '{"error":{"type":"insufficient_balance"}}');
  const { decide, inferenceDry } = await load("c");
  await decide(fog, 0, { instanceSeconds: 60, onSkip: () => {} });
  assert.ok(inferenceDry() > 0);
});

test("an agent out of its own budget is a different skip", async () => {
  stub(500, "unused");
  const { decide } = await load("d");
  const skips = [];
  await decide(fog, 0, { instanceSeconds: 60,
    budget: { left: 0, saving: false, spend: () => false },
    onSkip: (why) => skips.push(why) });
  assert.match(skips[0], /budget/);
  assert.doesNotMatch(skips[0], /prepaid/);
});

test("the breaker survives the per-game respawn", async () => {
  // The swarm is spawned per game, so an in-memory breaker buys one game's
  // quiet and then pays the slow 402 again. Measured in production: 6.2s to
  // 9.0s per new swarm while the pods behind it skipped at 0ms.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "buzz-dry-"));
  process.env.DATA_DIR = dir;
  try {
    const first = stub(402, '{"error":{"type":"insufficient_balance"}}');
    const a = await load("respawn-1");
    await a.decide(fog, 0, { instanceSeconds: 60, onSkip: () => {} });
    assert.equal(first(), 1);
    assert.ok(a.inferenceDry() > 0);

    // A fresh module is a fresh process, as far as module state goes.
    const second = stub(402, '{"error":{"type":"insufficient_balance"}}');
    const b = await load("respawn-2");
    assert.ok(b.inferenceDry() > 0, "the new swarm starts already knowing");
    await b.decide(fog, 0, { instanceSeconds: 60, onSkip: () => {} });
    assert.equal(second(), 0, "and never makes the call");
  } finally {
    delete process.env.DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no DATA_DIR it still works, in memory only", async () => {
  delete process.env.DATA_DIR;
  const calls = stub(402, '{"error":{"type":"insufficient_balance"}}');
  const { decide, inferenceDry } = await load("nodatadir");
  await decide(fog, 0, { instanceSeconds: 60, onSkip: () => {} });
  assert.ok(inferenceDry() > 0);
  await decide(fog, 0, { instanceSeconds: 60, onSkip: () => {} });
  assert.equal(calls(), 1, "held within the process");
});
