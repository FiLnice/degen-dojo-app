// Netlify Function: preacher referral ledger at /api/attr
//
// POST  {sig, ref, buyer, mint, priceLamports, external, ts}
//   → append one sale record, keyed by its transaction signature (so a repeated
//     POST for the same sale can't double-count). Stored in a Netlify Blobs store.
//     This is an UNTRUSTED hint: anyone can POST. The payout script never trusts
//     it — it re-reads every signature on-chain before paying, so a forged record
//     that names no real sale simply pays nothing.
//
// GET   ?key=<ATTR_ADMIN_KEY>   → dump the whole ledger for the payout script.
//   Gated by a secret env var so the ledger isn't world-readable.
//
// Requires env: ATTR_ADMIN_KEY (any long random string). Netlify Blobs needs no
// extra config on Netlify — it's available to functions automatically.
import { getStore } from "@netlify/blobs";

const REF_RE  = /^[a-zA-Z0-9_-]{2,32}$/;
const SIG_RE  = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;   // base58 tx signature
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async (request) => {
  const store = getStore("preacher-ledger");
  const url = new URL(request.url);

  if (request.method === "GET") {
    if ((url.searchParams.get("key") || "") !== (process.env.ATTR_ADMIN_KEY || "\0")) {
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
  const rec = {
    sig: r.sig, ref: r.ref, mint: r.mint,
    buyer: MINT_RE.test(r.buyer || "") ? r.buyer : null,
    priceLamports: Number.isFinite(+r.priceLamports) ? Math.max(0, Math.round(+r.priceLamports)) : 0,
    external: !!r.external,
    ts: Number.isFinite(+r.ts) ? +r.ts : Date.now(),
    recordedAt: Date.now(),
  };
  // key by signature → idempotent; a re-POST of the same sale overwrites, not appends
  await store.setJSON("sale:" + rec.sig, rec);
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/attr" };
