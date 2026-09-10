// Which provider is used, and the ceiling that keeps a free tier alive.
//
// UsePod was the only route, so when its prepaid balance ran out the whole
// reasoning cohort stopped and /thinking went blank. Money is not always
// available and the arena should not need it to be interesting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["OPENROUTER_KEY", "GROQ_KEY", "USEPOD_TOKEN"];
const clear = () => { for (const k of KEYS) delete process.env[k]; };
const load = (tag) => import(`../agents/reason.mjs?${tag}`);

test("providers are tried in order, and the first key wins", async () => {
  clear();
  process.env.USEPOD_TOKEN = "u";
  assert.equal((await load("p1")).activeProvider().name, "usepod");

  process.env.GROQ_KEY = "g";
  assert.equal((await load("p2")).activeProvider().name, "groq",
               "groq outranks usepod: it is free and usepod is prepaid");

  process.env.OPENROUTER_KEY = "o";
  assert.equal((await load("p3")).activeProvider().name, "openrouter");
  clear();
});

test("no key at all means reasoning is off, not broken", async () => {
  clear();
  const { reasoningEnabled, activeProvider, decide } = await load("p4");
  assert.equal(activeProvider(), null);
  assert.equal(reasoningEnabled(), false);
  const skips = [];
  const out = await decide({ 0: 2, 1: 1 }, 0, { onSkip: (w) => skips.push(w) });
  assert.equal(out, null, "the game carries on without it");
  // The message must name what to set, since a blank traces page looks
  // identical to a broken one.
  assert.match(skips[0], /OPENROUTER_KEY/);
  assert.match(skips[0], /GROQ_KEY/);
});

test("every provider offers three models from three labs", async () => {
  clear();
  process.env.OPENROUTER_KEY = "o";
  const { activeProvider } = await load("p5");
  for (const name of ["openrouter", "groq", "usepod"]) {
    process.env.OPENROUTER_KEY = name === "openrouter" ? "o" : "";
    if (name !== "openrouter") { delete process.env.OPENROUTER_KEY; process.env[name === "groq" ? "GROQ_KEY" : "USEPOD_TOKEN"] = "k"; }
    const m = (await load(`p5-${name}`)).activeProvider().models;
    assert.equal(m.length, 3, `${name} should offer three`);
    assert.equal(new Set(m).size, 3, `${name} models must be distinct`);
    clear();
  }
});

test("the daily cap stops calls and survives the per-game respawn", async () => {
  clear();
  const dir = mkdtempSync(join(tmpdir(), "buzz-cap-"));
  process.env.DATA_DIR = dir;
  process.env.INFER_DAILY_CAP = "3";
  process.env.OPENROUTER_KEY = "o";
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 500,
    text: async () => "nope", headers: { get: () => null } }; };
  try {
    const a = await load("cap1");
    const fog = { 0: 2, 1: 1, 2: 3 };
    for (let i = 0; i < 3; i++) await a.decide(fog, 0, { onSkip: () => {} });
    assert.equal(calls, 3, "three calls fit under a cap of three");
    assert.equal(a.dailyBudget().left, 0);

    const skips = [];
    await a.decide(fog, 0, { onSkip: (w) => skips.push(w) });
    assert.equal(calls, 3, "the fourth does not reach the network");
    assert.match(skips[0], /daily inference cap/);

    // A fresh module is a fresh swarm process; the count must not reset.
    const b = await load("cap2");
    assert.equal(b.dailyBudget().spent, 3, "the new swarm inherits the spend");
    await b.decide(fog, 0, { onSkip: () => {} });
    assert.equal(calls, 3);
  } finally {
    delete process.env.DATA_DIR; delete process.env.INFER_DAILY_CAP;
    clear(); rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed call still counts against the provider's allowance", async () => {
  clear();
  const dir = mkdtempSync(join(tmpdir(), "buzz-cap2-"));
  process.env.DATA_DIR = dir;
  process.env.OPENROUTER_KEY = "o";
  globalThis.fetch = async () => { throw new Error("connection reset"); };
  try {
    const a = await load("cap3");
    await a.decide({ 0: 2, 1: 1 }, 0, { onSkip: () => {} });
    // The provider counted it even though nothing usable came back. A cap that
    // only counts successes is not a cap.
    assert.equal(a.dailyBudget().spent, 1);
  } finally {
    delete process.env.DATA_DIR; clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("yesterday's spend does not eat today's allowance", async () => {
  clear();
  const dir = mkdtempSync(join(tmpdir(), "buzz-cap3-"));
  process.env.DATA_DIR = dir;
  process.env.OPENROUTER_KEY = "o";
  writeFileSync(join(dir, "inference-spend.json"),
                JSON.stringify({ day: "2001-01-01", calls: 99999 }));
  try {
    const a = await load("cap4");
    assert.equal(a.dailyBudget().spent, 0, "a stale day reads as nothing spent");
  } finally {
    delete process.env.DATA_DIR; clear();
    rmSync(dir, { recursive: true, force: true });
  }
});
