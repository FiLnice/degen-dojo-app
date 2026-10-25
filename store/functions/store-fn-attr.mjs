// Netlify Function: preacher referral ledger at /api/attr
//
// RETIRED (review 2026-10-23, M9): referred NFT sales earn preachers nothing since 2026-10-23, and this unauthenticated
// POST let anyone grow a ledger that the preacher desk and the weekly payout plan used to walk in full. POST now
// answers 410 and writes nothing; the store pages no longer call it. GET (admin) still dumps the old records for history.
//
// (old) POST  {sig, ref, buyer, mint, priceLamports?, currency?, price?, external, ts}
//   → record one referred NFT sale, keyed by its transaction signature (first write wins,
//     so a repeated POST can't double-count or re-assign it). Stored in Netlify Blobs.
//     currency = SOL|ORE|SKR|USDC (default SOL); token sales may omit priceLamports.
//     This is an UNTRUSTED hint: anyone can POST. store-preacher-core.mjs re-reads every
//     signature on-chain (DD collection, royalty actually received, no self-referral)
//     before it earns anything, so a forged record that names no real sale pays nothing.
//
// GET   (Authorization: Bearer <ATTR_ADMIN_KEY>) → dump the whole ledger for the payout script.
//   Gated by a secret env var so the ledger isn't world-readable.
//
// Requires env: ATTR_ADMIN_KEY (any long random string). Netlify Blobs needs no
// extra config on Netlify — it's available to functions automatically.
import { limited } from "./store-ratelimit-core.mjs";
import { getStore } from "@netlify/blobs";
import { adminRequestOk } from "./store-session-core.mjs";
import { putIfNew } from "./store-cas-core.mjs";

const REF_RE  = /^[a-zA-Z0-9_-]{2,32}$/;
const SIG_RE  = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;   // base58 tx signature
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CURRENCIES = new Set(["SOL", "ORE", "SKR", "USDC"]);
const ACCEPT_POSTS = false;   // the retired write path below is kept only for reference

export default async (request) => {
  const blocked = limited(request, "attr", 20); if (blocked) return blocked;   // 20 / minute / IP (DD-04)
  const store = getStore("preacher-ledger");
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (!adminRequestOk(request, "ATTR_ADMIN_KEY")) {
      return new Response("forbidden", { status: 403 });
    }
    const { blobs } = await store.list({ prefix: "sale:" });   // the ledger (lost:<sig>:<ref> audit copies stay out)
    const out = [];
    for (const b of blobs) { const v = await store.get(b.key, { type: "json" }); if (v) out.push(v); }
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }

  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  if (!ACCEPT_POSTS) return new Response(JSON.stringify({ error: "retired — NFT referrals no longer earn" }), { status: 410, headers: { "content-type": "application/json" } });

  let r; try { r = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
  // validate shape — reject anything malformed rather than store junk
  if (!SIG_RE.test(r.sig || "") || !REF_RE.test(r.ref || "") || !MINT_RE.test(r.mint || "")) {
    return new Response(JSON.stringify({ error: "bad record" }), { status: 400 });
  }
  // Every field below is an untrusted hint — store-preacher-core re-reads the sig on-chain (DD collection,
  // royalty actually received by the royalty wallet, buyer ≠ preacher) before a sale earns anything.
  const currency = CURRENCIES.has(String(r.currency || "").toUpperCase()) ? String(r.currency).toUpperCase() : "SOL";
  const rec = {
    sig: r.sig, ref: String(r.ref).toLowerCase(), mint: r.mint,
    buyer: MINT_RE.test(r.buyer || "") ? r.buyer : null,
    priceLamports: Number.isFinite(+r.priceLamports) ? Math.max(0, Math.round(+r.priceLamports)) : 0,   // SOL sales; 0/omitted for token sales
    currency,                                                                       // what the buyer paid in (SOL|ORE|SKR|USDC)
    price: Number.isFinite(+r.price) && +r.price > 0 ? +r.price : null,             // listing price in `currency` units
    external: !!r.external,
    ts: Number.isFinite(+r.ts) ? +r.ts : Date.now(),
    recordedAt: Date.now(),
  };
  // key by signature → idempotent, FIRST write wins: a later POST naming another ref can't hijack a sale
  // that's already attributed (or wipe its cached on-chain verification). A create-only write (DD-14): two racing
  // POSTs can't both pass a check and let the later one overwrite. The losing claim is kept once per (sig, ref) for audit.
  let created;
  try { created = await putIfNew(store, "sale:" + rec.sig, rec); }
  catch { return new Response(JSON.stringify({ error: "busy — retry" }), { status: 503, headers: { "content-type": "application/json" } }); }
  if (!created) {
    await putIfNew(store, `lost:${rec.sig}:${rec.ref}`, rec).catch(() => {});
    return new Response(JSON.stringify({ ok: true, dup: true }), { headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/attr" };
