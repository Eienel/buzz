// Pulling the cause out of a web3.js transaction error.
//
// The swarm's failure log filled up with "Unknown action 'undefined'", which
// is what SendTransactionError renders when it is built without an `action`.
// The reason was on the same object the whole time, as `transactionMessage`,
// and so were the program logs, as `transactionLogs`.
//
//   node --test tests/explain-tx-error.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { SendTransactionError } from "@solana/web3.js";
import { explainTxError } from "../server/rpc.mjs";

test("the real cause is recovered from a message that hides it", () => {
  const e = new SendTransactionError({
    action: undefined, signature: "sig", transactionMessage: "Blockhash not found", logs: [] });
  assert.match(String(e.message), /Unknown action/, "this is what we used to log");
  assert.equal(explainTxError(e), "Blockhash not found");
});

test("a program error keeps its message and the line that explains it", () => {
  const e = new SendTransactionError({
    action: "simulate", signature: "sig", transactionMessage: "custom program error: 0x1771",
    logs: ["Program log: Instruction: RevealMove",
           "Program log: AnchorError caused by account: player. Error Code: NotAMove.",
           "Program consumed 12000 of 200000 compute units"] });
  const out = explainTxError(e);
  assert.match(out, /custom program error: 0x1771/);
  assert.match(out, /NotAMove/, "the diagnostic line survives");
  assert.doesNotMatch(out, /compute units/, "the noise does not");
});

test("Anchor puts its logs on `logs`, and those are read too", () => {
  const out = explainTxError({ message: "tx failed", logs: ["Program log: insufficient funds"] });
  assert.match(out, /tx failed/);
  assert.match(out, /insufficient funds/);
});

test("with no interesting line it falls back to the tail rather than nothing", () => {
  const out = explainTxError({ message: "boom", logs: ["a","b","c","d"] });
  assert.match(out, /boom/);
  assert.match(out, /c \| d/, "last two lines");
});

test("a plain Error passes through unchanged", () => {
  assert.equal(explainTxError(new Error("plain old error")), "plain old error");
});

test("nothing thrown at it makes it throw", () => {
  for (const junk of [null, undefined, "a string", 42, {}, { logs: [] }, { logs: "not an array" }])
    assert.equal(typeof explainTxError(junk), "string", `threw or returned non-string for ${JSON.stringify(junk)}`);
});
