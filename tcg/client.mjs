// A card-price client that pays for itself.
//
// tcgapi.dev answers 402 with an x402 challenge instead of demanding an API
// key, and offers a Solana branch: USDC on mainnet, 0.005 per call, with THEIR
// facilitator listed as feePayer. That last detail is the interesting one. The
// agent needs a USDC balance and no SOL at all, so an agent can buy data with
// the same asset it trades in and never hold gas.
//
//   accepts[1] = {
//     network: "solana",
//     asset:   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,   // mainnet USDC
//     payTo:   AHk5DFmmdvPMjf6tZFrMPbHGhEBUDhUmcqmWkYANYthg,
//     extra:   { feePayer: BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP },
//     maxAmountRequired: "5000",                                // 0.005 USDC
//   }
//
// The payment payload is built by the official @x402 client rather than by
// hand: the exact-scheme encoding is a moving target and a wrong header is an
// unpaid call, not an error you find in review.

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm";

const BASE = process.env.TCG_BASE ?? "https://api.tcgapi.dev";
const KEY = process.env.TCG_API_KEY ?? "";          // free tier, if you have one
const SECRET = process.env.TCG_WALLET_SECRET ?? ""; // mainnet USDC payer

/** Cheapest path first: a key costs nothing, so only pay when there isn't one. */
export const mode = () => (KEY ? "api-key" : SECRET ? "x402" : "none");

let paid = null;
async function payingFetch() {
  if (paid) return paid;
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const bytes = SECRET.trim().startsWith("[")
    ? Uint8Array.from(JSON.parse(SECRET))
    : (await import("bs58")).default.decode(SECRET.trim());
  const signer = await createKeyPairSignerFromBytes(bytes);
  const client = x402Client({ schemes: [ExactSvmScheme], signer });
  paid = wrapFetchWithPayment(fetch, client);
  return paid;
}

/**
 * One request. Returns { ok, status, data, spentUsdc }.
 * Never throws on a payment problem: a scanner that dies because one lookup
 * could not be paid for is worse than a scanner that records the gap.
 */
export async function call(path, params = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);

  try {
    if (KEY) {
      const r = await fetch(url, { headers: { "X-API-Key": KEY } });
      return { ok: r.ok, status: r.status, data: await r.json().catch(() => null), spentUsdc: 0 };
    }
    if (!SECRET) return { ok: false, status: 0, data: null, spentUsdc: 0, error: "no TCG_API_KEY and no TCG_WALLET_SECRET" };

    const f = await payingFetch();
    const r = await f(url);
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => null), spentUsdc: 0.005 };
  } catch (e) {
    return { ok: false, status: 0, data: null, spentUsdc: 0, error: String(e.message ?? e).slice(0, 160) };
  }
}

export const search = (q, game) => call("/v1/search", { q, game });

/** What the server is willing to sell, and on which chains. Free to ask. */
export async function quote(path = "/v1/search", params = { q: "charizard", game: "pokemon" }) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (r.status !== 402) return { paywalled: false, status: r.status };
  const j = await r.json();
  return {
    paywalled: true,
    options: (j.accepts ?? []).map((a) => ({
      network: a.network, asset: a.asset, payTo: a.payTo,
      usdc: Number(a.maxAmountRequired) / 1e6, feePayer: a.extra?.feePayer ?? null,
    })),
  };
}
