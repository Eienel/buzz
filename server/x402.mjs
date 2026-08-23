// x402 payment verification: does the X-PAYMENT header correspond to a real,
// recent, unspent USDC transfer from the agent that is asking us to act?
//
// The arena has no facilitator in front of it, so verification happens here
// against the chain itself. Two shapes are accepted:
//
//   { signature }    the agent already settled; we look the transfer up
//   { transaction }  a signed transfer we submit, then look up the same way
//
// Both converge on one check, so there is a single place to get right:
// confirm the transaction, then read its token-balance deltas. Balance deltas
// beat instruction parsing here because they are what actually happened, and
// they survive transfer_checked, Token-2022, CPI wrappers and multi-hop
// routes alike.

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

// A payment is spent once. Kept in memory with the action queue, on the same
// reasoning: state that survives a restart would imply we owe an action we
// may no longer be able to honour. The recency window below is what keeps a
// restart from opening a replay hole wider than a few minutes.
const spent = new Map(); // signature -> expiry ms
const MAX_AGE_MS = Number(process.env.X402_MAX_AGE_MS ?? 10 * 60 * 1000);

function reap(now) {
  for (const [sig, exp] of spent) if (exp < now) spent.delete(sig);
}

export function decodeHeader(header) {
  try {
    return JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ok: true, signature: string, amount: bigint}
 *                  | {ok: false, error: string}>}
 */
export async function verifyPayment(connection, header, opts) {
  const { usd, payTo, usdcMint, agentWallet } = opts;
  const required = BigInt(Math.round(usd * 1e6)); // USDC, 6 decimals
  if (required === 0n) return { ok: true, signature: null, amount: 0n };
  if (!payTo) return { ok: false, error: "arena has no ARENA_PAY_TO configured" };

  const env = decodeHeader(header);
  if (!env) return { ok: false, error: "X-PAYMENT is not base64 JSON" };
  const p = env.payload ?? env;

  let signature = p.signature ?? null;
  if (!signature) {
    if (!p.transaction) return { ok: false, error: "payload needs a signature or a transaction" };
    try {
      signature = await connection.sendRawTransaction(Buffer.from(p.transaction, "base64"),
        { skipPreflight: false, maxRetries: 3 });
    } catch (e) {
      return { ok: false, error: `payment transaction rejected: ${String(e.message).slice(0, 140)}` };
    }
  }

  const now = Date.now();
  reap(now);
  if (spent.has(signature)) return { ok: false, error: "payment already spent" };

  const tx = await confirmed(connection, signature);
  if (!tx) return { ok: false, error: "payment transaction not found or not confirmed" };
  if (tx.meta?.err) return { ok: false, error: "payment transaction failed on chain" };

  const age = now - (tx.blockTime ?? 0) * 1000;
  if (!tx.blockTime || age > MAX_AGE_MS) {
    return { ok: false, error: `payment is older than ${Math.round(MAX_AGE_MS / 60000)} minutes` };
  }

  const credited = delta(tx, usdcMint, new PublicKey(payTo));
  if (credited < required) {
    return { ok: false, error: `paid ${credited} of ${required} required (USDC base units)` };
  }
  // Bind the payment to the caller: without this, agent A's payment could buy
  // agent B a seat. The agent pays from its own ClawPump wallet, so this holds
  // for every honest caller and refuses every borrowed receipt.
  if (agentWallet) {
    const debited = -delta(tx, usdcMint, new PublicKey(agentWallet));
    if (debited < required) return { ok: false, error: "payment did not come from agentWallet" };
  }

  spent.set(signature, now + MAX_AGE_MS);
  return { ok: true, signature, amount: credited };
}

/** Net change in `owner`'s balance of `mint` across the transaction. */
function delta(tx, mint, owner) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, true).toBase58();
  const keys = tx.transaction.message.getAccountKeys
    ? tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
    : null;
  const at = (b) => {
    const k = keys ? keys.get(b.accountIndex)?.toBase58() : null;
    // Match on the owner the runtime reports; fall back to the canonical ATA
    // so a legacy record without `owner` still resolves.
    return (b.owner ? b.owner === owner.toBase58() : k === ata) && b.mint === String(mint);
  };
  const sum = (list) => (list ?? []).filter(at)
    .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

/** Poll briefly: a just-submitted transfer needs a moment to land. */
async function confirmed(connection, signature, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed", maxSupportedTransactionVersion: 0,
    });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 750));
  }
  return null;
}
