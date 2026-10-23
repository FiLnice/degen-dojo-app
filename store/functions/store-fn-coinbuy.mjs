// Netlify Function: record a coin purchase at /api/coinbuy
//
// POST {sig, buyer, coins, currency, tokenAmount, usd, ref?, ts}
//   → append one purchase, keyed by its transaction signature (idempotent — a
//     re-POST of the same buy overwrites, never double-counts). Stored in a
//     Netlify Blobs store the admin dashboard reads.
//
// Like the referral ledger this is an UNTRUSTED hint (anyone can POST). Before
// crediting coins or paying affiliates for real, the backend/admin must re-read
// each signature on-chain and confirm the payment actually reached the treasury —
// a forged record that names no real transfer is worth nothing.
//
// A record is written ONCE: a re-POST of a known signature never overwrites it (it used to
// reset verified:false, so the cron would credit the same payment again).
//
// GET ?sig=<signature> → {found, verified, rejected, creditedCoins} — lets the coins page show
// "coins landed" without a sign-in. Public by design: the signature is already public on-chain.
//
// POST {action:"quote", wallet, currency, usd} → a server price quote for one coin pack (DD-11): the exact token
// amount at the live price, valid 10 minutes, bound to that wallet + currency. The page pays exactly that amount with
// the memo "ddq:<quoteId>", so the coins are priced when the buyer PAYS (store-verify-core createQuote / verifyOne).
// A purchase record also keeps the live price at the moment it was first POSTed (postPrice) for payments without a
// usable quote — they are valued at the lower of that and the price at verification.
//
// No env needed to write; the admin read (/api/admin) is the gated side.
import { limited } from "./store-ratelimit-core.mjs";
import { getStore } from "@netlify/blobs";
import { getStrong, createQuote, livePrice, QuoteError, QUOTE_ID_RE } from "./store-verify-core.mjs";
import { putIfNew } from "./store-cas-core.mjs";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REF_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const CUR = new Set(["ORE", "SKR", "SOL"]);

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const JSONH = { "content-type": "application/json", "cache-control": "no-store", ...CORS };

export default async (request) => {
  const blocked = limited(request, "coinbuy", 20); if (blocked) return blocked;   // 20 / minute / IP (DD-04)
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method === "GET") {
    const sig = new URL(request.url).searchParams.get("sig") || "";
    if (!SIG_RE.test(sig)) return new Response(JSON.stringify({ error: "bad sig" }), { status: 400, headers: JSONH });
    const rec = await getStrong(getStore("coin-purchases"), "buy:" + sig);
    return new Response(JSON.stringify(rec
      ? { found: true, verified: !!rec.verified, rejected: !!rec.rejected, creditedCoins: rec.creditedCoins || 0, kind: rec.kind || "buy" }
      : { found: false }), { headers: JSONH });
  }
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
  let r; try { r = await request.json(); } catch { return new Response("bad json", { status: 400, headers: CORS }); }

  if (r?.action === "quote") {
    try { return new Response(JSON.stringify(await createQuote({ wallet: r.wallet, currency: r.currency, usd: r.usd })), { headers: JSONH }); }
    catch (e) {
      if (e instanceof QuoteError) return new Response(JSON.stringify({ error: e.message }), { status: e.status, headers: JSONH });
      return new Response(JSON.stringify({ error: "busy — retry" }), { status: 503, headers: JSONH });
    }
  }

  if (!SIG_RE.test(r.sig || "") || !ADDR_RE.test(r.buyer || "") || !CUR.has(r.currency)) {
    return new Response(JSON.stringify({ error: "bad record" }), { status: 400, headers: CORS });
  }
  const rec = {
    sig: r.sig,
    buyer: r.buyer,
    kind: r.kind === "tip" ? "tip" : "buy",   // a tip mints no coins — 100% feeds the pot (see verify-core)
    coins: Number.isFinite(+r.coins) ? Math.max(0, Math.round(+r.coins)) : 0,
    currency: r.currency,
    tokenAmount: Number.isFinite(+r.tokenAmount) ? +r.tokenAmount : 0,
    usd: Number.isFinite(+r.usd) ? Math.max(0, +r.usd) : 0,
    ref: REF_RE.test(r.ref || "") ? r.ref : null,
    quoteId: QUOTE_ID_RE.test(r.quoteId || "") ? r.quoteId : null,   // a hint: verify reads the quote from the payment's memo
    ts: Number.isFinite(+r.ts) ? +r.ts : Date.now(),
    verified: false,               // set true once the admin/backend confirms the tx on-chain
    recordedAt: Date.now(),
  };
  // Junk filter: a real payment was just confirmed, so the chain knows its signature. An unknown or failed one is
  // refused here instead of sitting in the pending queue the cron re-reads every minute.
  try {
    const st = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[rec.sig], { searchTransactionHistory: true }] }) }).then((x) => x.json());
    const s = st?.result?.value?.[0];
    if (st?.result && (!s || s.err)) return new Response(JSON.stringify({ error: s ? "that transaction failed" : "unknown transaction" }), { status: 400, headers: JSONH });
  } catch { /* RPC hiccup: accept — the cron still verifies, and unreadable records expire after 15 minutes */ }
  // the live price when this purchase was first claimed: a payment without a usable quote is never valued above it
  if (rec.kind === "buy") rec.postPrice = await livePrice(rec.currency).catch(() => null);
  const store = getStore("coin-purchases");
  // create-only write: two racing POSTs of one signature can't both "win". The buyer named here is
  // only a claim — verify-core credits the wallet that actually paid on-chain (payer binding).
  let created;
  try { created = await putIfNew(store, "buy:" + rec.sig, rec); }
  catch (e) { return new Response(JSON.stringify({ error: "busy — retry" }), { status: 503, headers: JSONH }); }
  if (!created) {
    const prev = await getStrong(store, "buy:" + rec.sig);
    return new Response(JSON.stringify({ ok: true, known: true, verified: !!prev?.verified, rejected: !!prev?.rejected }), { headers: JSONH });
  }
  return new Response(JSON.stringify({ ok: true }), { headers: JSONH });
};

export const config = { path: "/api/coinbuy" };
