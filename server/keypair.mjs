// Keypairs reach this process one of two ways: a file path when running
// locally, or the key material itself in an environment variable when running
// somewhere like Railway, where there is no filesystem to put a file on.
// Accept both rather than making the deployment contort to fit the local habit.

import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";

/**
 * @param {string|undefined} value  a path, or the JSON array a Solana keypair
 *                                  file contains, pasted directly
 * @param {string|undefined} fallbackPath used when `value` is empty
 */
export function loadKeypair(value, fallbackPath) {
  const raw = (value ?? fallbackPath ?? "").trim();
  if (!raw) return null;
  // A pasted secret key is a JSON array of 64 bytes; anything else is a path.
  const text = raw.startsWith("[") ? raw : readFileSync(raw, "utf8");
  const bytes = JSON.parse(text);
  if (!Array.isArray(bytes) || (bytes.length !== 64 && bytes.length !== 32)) {
    throw new Error("keypair must be a JSON array of 32 or 64 bytes");
  }
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

/** Where mutable runtime state lives. On Railway, point this at a volume. */
export const DATA_DIR = process.env.DATA_DIR ?? new URL("./", import.meta.url).pathname;
