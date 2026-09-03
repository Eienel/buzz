// Names are chosen by strangers and printed on a public page.
//
// Registration is open, which is the point: an agent should be able to name
// itself without asking anybody. That also means the name is attacker
// controlled, and it reached the arena's leaderboard and bet menu through
// innerHTML with no escaping, one of them inside a data- attribute where a
// single quote ends the attribute. The page escapes on render now; this covers
// the half that stops the value being stored at all.
//
//   node --test tests/agent-names.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { registerAgent, agentName } from "../server/arena-api.mjs";

const fresh = () => Keypair.generate().publicKey.toBase58();
const nameOf = (raw) => {
  const w = fresh();
  registerAgent({ agentWallet: w, name: raw });
  return agentName(w);
};

test("an ordinary name survives intact", () => {
  assert.equal(nameOf("clawpump-buzz"), "clawpump-buzz");
  assert.equal(nameOf("Ava Agent 7"), "Ava Agent 7");
  assert.equal(nameOf("node.runner_01"), "node.runner_01");
});

test("markup is stripped rather than stored", () => {
  for (const attack of [
    `<img src=x onerror=alert(1)>`,
    `<script>alert(1)</script>`,
    `"><script>alert(1)</script>`,
    `" onmouseover="alert(1)`,
    `'><b>x`,
  ]) {
    const got = nameOf(attack);
    assert.ok(!/[<>"'&]/.test(got ?? ""), `kept a markup character: ${JSON.stringify(got)}`);
  }
});

test("a name that is only markup becomes no name at all", () => {
  assert.equal(nameOf("<>&\"'"), null, "an empty result is null, not an empty string");
});

test("whitespace cannot be used to sort to the top of a board", () => {
  assert.equal(nameOf("        aaa"), "aaa");
  assert.equal(nameOf("a     b"), "a b");
});

test("length is capped", () => {
  assert.equal(nameOf("x".repeat(200)).length, 24);
});

test("a missing name is allowed: the wallet is the identity", () => {
  assert.equal(nameOf(undefined), null);
  assert.equal(nameOf(""), null);
});

test("a wallet is claimed once, and the second attempt is refused", () => {
  const w = fresh();
  const first = registerAgent({ agentWallet: w, name: "mine" });
  assert.equal(first.status, 200);
  assert.equal(registerAgent({ agentWallet: w, name: "yours" }).status, 409);
  assert.equal(agentName(w), "mine", "a refused registration must not rename anyone");
});

test("a bad wallet is refused before anything is stored", () => {
  assert.equal(registerAgent({ agentWallet: "not-a-key", name: "x" }).status, 400);
});
