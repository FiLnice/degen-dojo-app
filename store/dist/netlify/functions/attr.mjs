// Netlify Function: preacher referral ledger at /api/attr
//
// POST  {sig, ref, buyer, mint, priceLamports?, currency?, price?, external, ts}
//   → record one referred NFT sale, keyed by its transaction signature (first write wins,
//     so a repeated POST can't double-count or re-assign it). Stored in Netlify Blobs.
//     currency = SOL|ORE|SKR|USDC (default SOL); token sales may omit priceLamports.
//     This is an UNTRUSTED hint: anyone can POST. store-preacher-core.mjs re-reads every
//     signature on-chain (DD collection, royalty actually received, no self-referral)
//     before it earns anything, so a forged record that names no real sale pays nothing.
//
// GET   ?key=<ATTR_ADMIN_KEY>   → dump the whole ledger for the payout script.
//   Gated by a secret env var so the ledger isn't world-readable.
//
// Requires env: ATTR_ADMIN_KEY (any long random string). Netlify Blobs needs no
// extra config on Netlify — it's available to functions automatically.
import { getStore } from "@netlify/blobs";
import { adminKeyOk } from "./store-session-core.mjs";

const REF_RE  = /^[a-zA-Z0-9_-]{2,32}$/;
const SIG_RE  = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;   // base58 tx signature
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CURRENCIES = new Set(["SOL", "ORE", "SKR", "USDC"]);

export default async (request) => {
  const store = getStore("preacher-ledger");
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (!adminKeyOk(url.searchParams.get("key"), "ATTR_ADMIN_KEY")) {
      return new Response("forbidden", { status: 403 });
    }
    const { blobs } = await store.list();
    const out = [];
    for (const b of blobs) { const v = await store.get(b.key, { type: "json" }); if (v) out.push(v); }
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }

  if (request.method !== "POST") return new Response("POST only", { status: 405 });

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
  // that's already attributed (or wipe its cached on-chain verification).
  if (await store.get("sale:" + rec.sig, { type: "json" })) {
    return new Response(JSON.stringify({ ok: true, dup: true }), { headers: { "content-type": "application/json" } });
  }
  await store.setJSON("sale:" + rec.sig, rec);
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/attr" };
