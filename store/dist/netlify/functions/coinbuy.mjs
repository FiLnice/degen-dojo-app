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
// No env needed to write; the admin read (/api/admin) is the gated side.
import { getStore } from "@netlify/blobs";
import { getStrong } from "./store-verify-core.mjs";
import { putIfNew } from "./store-cas-core.mjs";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REF_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const CUR = new Set(["ORE", "SKR", "SOL"]);

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const JSONH = { "content-type": "application/json", "cache-control": "no-store", ...CORS };

export default async (request) => {
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
    ts: Number.isFinite(+r.ts) ? +r.ts : Date.now(),
    verified: false,               // set true once the admin/backend confirms the tx on-chain
    recordedAt: Date.now(),
  };
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
