// The refusal an agent can act on when it did not fill in the template.
//
// The only outside attempt this arena has ever logged sent
// `wallet=WALLET&name=YOURNAME`, straight out of /claw.txt, and was told
// "wallet not registered: call register first". Registering would have failed
// for the same reason, so the agent was pointed at a door that would refuse it
// again without ever saying which value was wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerAgent, badWalletBody, looksLikePlaceholder } from "../server/arena-api.mjs";

const REAL = "7pNzXfZxeC9A75GifS2Q8vRbMiRRKoSJkPEqXTfRSVzJ";

test("the exact value that bounced is named as a placeholder", () => {
  const b = badWalletBody("WALLET");
  assert.match(b.error, /placeholder/);
  assert.match(b.error, /WALLET/);
  // It must say where to get the real one, or the agent is no better off.
  assert.match(b.hint, /get_portfolio/);
  assert.match(b.hint, /wallet_address/);
});

test("every placeholder shape the skill could leave behind", () => {
  for (const v of ["WALLET", "YOURNAME", "<your wallet>", "{wallet}", "[ADDRESS]",
                   "your_wallet", "my address", "AGENT_WALLET", "pubkey", "address"])
    assert.ok(looksLikePlaceholder(v), `${v} should read as a placeholder`);
});

test("a real address is never called a placeholder", () => {
  for (const v of [REAL, "DuPTc8CC9PmpZMfqTutdMRCTNBTGYK9AZX5vtaQHnaui"])
    assert.ok(!looksLikePlaceholder(v), `${v} is a real wallet`);
});

test("a wallet that is merely wrong gets a different answer than a placeholder", () => {
  // Junk is not a template, and telling someone to "replace the placeholder"
  // when they typed a bad address sends them looking for a thing that is not
  // there.
  const junk = badWalletBody("0OIl-not-base58-x");
  assert.match(junk.error, /base58/);
  assert.doesNotMatch(junk.error, /placeholder/);
});

test("a missing wallet says so rather than blaming a placeholder", () => {
  const b = badWalletBody("");
  assert.match(b.error, /missing/);
  assert.doesNotMatch(b.error, /placeholder/);
});

test("every refusal carries a working example url", () => {
  for (const v of ["", "WALLET", "junk!!"]) {
    const b = badWalletBody(v);
    assert.match(b.example, /^https:\/\/lastbuzz\.fun\/api\/agent\/play\?wallet=/);
    assert.ok(b.example.includes(REAL), "the example must use a real address");
  }
});

test("register and play agree, because both go through registerAgent", () => {
  const r = registerAgent({ agentWallet: "WALLET", name: "YOURNAME" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, badWalletBody("WALLET"));
});

test("a real wallet still registers", () => {
  const r = registerAgent({ agentWallet: REAL, name: "test-" + Date.now() });
  assert.ok(r.status === 200 || r.status === 409, `got ${r.status}`);
});
