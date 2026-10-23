// Shared, dependency-free core for the branded-miner signup (/api/miner-requests).
// Kept pure (no Blobs, no fetch) so it can be unit-tested with a mocked getTransaction.
//
//   checkOrePayment(tx, opts) → { ok: true, received } | { ok: false, error }
//   validateRequest(body)     → { ok: true, value } | { ok: false, error }
//   slugify(name)             → URL-safe base slug ("Cool Apes!" → "cool-apes")

import { createHash } from "node:crypto";

/** The store treasury (receives coin purchases) — default receiver of the branded-miner setup fee.
 *  Override with env OPERATOR_WALLET. MUST match the address baked into the /create page
 *  (degen-dojo-ore lib/config.ts STORE_TREASURY_WALLET), or every payment fails verification. */
export const STORE_TREASURY_WALLET = "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp";
export const ORE_MINT = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";
export const ORE_DECIMALS = 11;
export const DEFAULT_FEE_ORE = 5;
export const MAX_PAYMENT_AGE_MS = 60 * 60 * 1000; // a payment must be < ~1 hour old when submitted
export const SQUARES = 25;

export const B58_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const B58_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

// Front-run guard (2026-10-23): the payer commits to the EXACT request inside the payment. The /create page adds a
// memo "ddminer:<hash of the request>" to the fee transfer it signs; a request is accepted only when its own hash is
// in that memo — so nobody can file a different request (their own name / tip wallet) against someone's payment.
// The page computes the same hash: sha256 of this JSON, first 32 hex characters.
export const MINER_MEMO_PREFIX = "ddminer:";
export function minerRequestHash(b) {
  const s = (v) => String(v == null ? "" : v).trim();
  const tiles = (Array.isArray(b?.degens) ? b.degens : []).map((d) => [s(d?.mint), s(d?.image)]);
  return createHash("sha256").update(JSON.stringify([1, s(b?.name), s(b?.tipWallet), s(b?.contact), s(b?.website), s(b?.collection), s(b?.payer), tiles])).digest("hex").slice(0, 32);
}
/** true when the payment transaction carries this request's "ddminer:<hash>" memo */
export function memoBindsRequest(tx, body) {
  const want = MINER_MEMO_PREFIX + minerRequestHash(body);
  return (tx?.meta?.logMessages || []).some((l) => { const m = /Memo \(len \d+\): "(.*)"$/.exec(l); return !!m && m[1] === want; });
}

/** Fee in ORE base units ("grams"), allowing a 0.1% rounding tolerance. */
export function minFeeUnits(feeOre) {
  return BigInt(Math.floor(feeOre * 10 ** ORE_DECIMALS * 0.999));
}

/**
 * Verify a jsonParsed getTransaction result is a real setup-fee payment:
 *  - landed without error,
 *  - `payer` signed it,
 *  - it isn't older than maxAgeMs (blockTime required, and not in the future),
 *  - the operator's ORE balance went up by ≥ fee × 0.999,
 *  - and that ORE came out of the PAYER's own token account(s): the ORE held in accounts whose owner is
 *    `payer` went DOWN by ≥ fee × 0.999. Signing alone isn't enough — a co-signer of someone else's
 *    payment (or of a tx that moved a third party's delegated ORE) must not be able to claim it.
 */
export function checkOrePayment(tx, { operator, payer, feeOre, now = Date.now(), maxAgeMs = MAX_PAYMENT_AGE_MS }) {
  if (!tx) return { ok: false, error: "Transaction not found yet — wait a few seconds and retry." };
  if (!tx.meta || tx.meta.err) return { ok: false, error: "That transaction failed on-chain." };
  if (!B58_ADDR.test(String(payer || "")) || !B58_ADDR.test(String(operator || ""))) return { ok: false, error: "Bad payer address." };
  if (payer === operator) return { ok: false, error: "The operator can't pay itself." };

  const keys = tx.transaction?.message?.accountKeys || [];
  const signed = keys.some((k) => (typeof k === "string" ? false : k?.pubkey === payer && k?.signer === true));
  if (!signed) return { ok: false, error: "The paying wallet didn't sign that transaction." };

  if (!Number.isFinite(tx.blockTime)) return { ok: false, error: "Transaction has no block time yet — retry shortly." };
  const age = now - tx.blockTime * 1000;
  if (age > maxAgeMs) return { ok: false, error: "That payment is too old — pay again from this page." };
  if (age < -5 * 60 * 1000) return { ok: false, error: "That transaction's block time is in the future." };

  const oreOf = (list, owner) =>
    (list || [])
      .filter((b) => b?.mint === ORE_MINT && b?.owner === owner)
      .reduce((n, b) => n + BigInt(b?.uiTokenAmount?.amount || "0"), 0n);
  const delta = (owner) => oreOf(tx.meta.postTokenBalances, owner) - oreOf(tx.meta.preTokenBalances, owner);
  const diff = delta(operator);
  const received = diff > 0n ? diff : 0n;
  if (received < minFeeUnits(feeOre)) {
    return { ok: false, error: `Couldn’t verify a ${feeOre} ORE payment to the operator in that transaction.` };
  }
  const spent = -delta(payer);
  if (spent < minFeeUnits(feeOre)) {
    return { ok: false, error: "That ORE didn't come from the paying wallet's own token account." };
  }
  return { ok: true, received };
}

/** Validate + normalise a signup body. Returns the cleaned fields (no RPC field — we host it). */
export function validateRequest(b) {
  if (!b || typeof b !== "object") return { ok: false, error: "Bad request." };
  const name = clip(b.name, 80);
  const tipWallet = clip(b.tipWallet, 44);
  const contact = clip(b.contact, 200);
  const website = clip(b.website, 200);
  const collection = clip(b.collection, 44);
  const paymentSig = clip(b.paymentSig, 100);
  const payer = clip(b.payer, 44);

  if (!name || !tipWallet || !contact || !paymentSig || !payer) return { ok: false, error: "Please fill every field." };
  if (!B58_ADDR.test(tipWallet)) return { ok: false, error: "Tip wallet isn’t a valid Solana address." };
  if (!B58_ADDR.test(payer)) return { ok: false, error: "Bad payer address." };
  if (!B58_SIG.test(paymentSig)) return { ok: false, error: "Bad payment signature." };
  if (collection && !B58_ADDR.test(collection)) return { ok: false, error: "Collection isn’t a valid address." };
  if (website && !/^https?:\/\//i.test(website) && !/^[\w.-]+\.[a-z]{2,}/i.test(website))
    return { ok: false, error: "Website doesn’t look like a URL." };

  if (!Array.isArray(b.degens) || b.degens.length !== SQUARES) return { ok: false, error: "Need exactly 25 images." };
  const degens = [];
  for (const d of b.degens) {
    const image = clip(d?.image, 500);
    if (!/^https:\/\/[^\s"'<>]+$/i.test(image)) return { ok: false, error: "Every image must be an https URL." };
    const mint = clip(d?.mint, 44);
    degens.push({ name: clip(d?.name, 120) || "NFT", image, ...(B58_ADDR.test(mint) ? { mint } : {}) });
  }
  return { ok: true, value: { name, tipWallet, contact, website, collection, degens, paymentSig, payer } };
}

/** URL-safe base slug from a collection name. Never empty. */
export function slugify(name) {
  const s = String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return s || "miner";
}

/** First free slug: base, base-2, base-3 … `taken(slug)` → true if used by someone else. */
export async function uniqueSlug(base, taken) {
  const root = slugify(base).slice(0, 28).replace(/-+$/g, "") || "miner";
  if (!(await taken(root))) return root;
  for (let i = 2; i < 1000; i++) {
    const s = `${root}-${i}`;
    if (!(await taken(s))) return s;
  }
  return `${root}-${Date.now().toString(36)}`;
}
