// Netlify Function: same-origin Solana RPC proxy for the store.
//
// The store page is public, so it can never carry a keyed RPC URL. It calls
// /api/rpc instead, and this forwards to the real endpoint with the key held in
// a Netlify environment variable (Site configuration → Environment variables →
// SOLANA_RPC, e.g. your Helius URL).
//
// Only the read-only methods checkout actually needs are allowed, so the proxy
// can't be turned into a general-purpose free RPC by anyone who finds the URL.
// sendTransaction is deliberately absent: the store submits through the user's
// own wallet, so there is no reason to let this endpoint relay transactions.
const ALLOWED = new Set([
  "getLatestBlockhash",
  "simulateTransaction",
  "getSignatureStatuses",
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenAccountsByOwner",   // list a wallet's NFTs for the "List a Degen" page
  "getBalance",
  // universal resolve: find a listing by mint, and read its DAS metadata.
  "getProgramAccounts",   // guarded below to the Magic Eden program only
  "getAsset",             // DAS — name, image, traits
  "getAssetBatch",        // DAS batch — names + images for a wallet's NFTs / the listings grid
  "getAssetsByGroup",     // DAS — a collection's NFTs, for the branded-miner preview (/create); guarded below
  // The ORE miner (/mine) reads the round clock and confirms deploys/claims
  // through this same proxy — both read-only.
  "getSlot",
  "getTransaction",
]);

// getProgramAccounts is the one heavy call here, so it's pinned to Magic Eden's
// M2 program. That's all the resolver needs (find a listing's trade state by
// mint); it stops the endpoint being used to scan arbitrary programs on our key.
const M2_PROGRAM = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
// Solana's public RPC: a fallback for plain methods when Helius is rate-limiting (no DAS / no gPA there).
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const PUBLIC_OK = new Set(["getLatestBlockhash", "getSignatureStatuses", "getAccountInfo", "getMultipleAccounts", "getBalance", "simulateTransaction", "getSlot", "getTransaction", "getTokenAccountsByOwner"]);
const gpaOk = (c) => c?.method !== "getProgramAccounts" || c?.params?.[0] === M2_PROGRAM;
// getAssetsByGroup: collection lookups only, one page of at most 1000, first few pages — enough to
// sample a collection's art for the /create preview without letting the proxy crawl everything.
const groupOk = (c) => {
  if (c?.method !== "getAssetsByGroup") return true;
  const p = c?.params || {};
  return p.groupKey === "collection" && typeof p.groupValue === "string" && (p.limit ?? 1000) <= 1000 && (p.page ?? 1) <= 3;
};

export default async (request) => {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });

  // Accept either name: the store historically used SOLANA_RPC, the standalone miner uses
  // HELIUS_RPC. Reading both means whichever the Netlify site has set just works (this was the
  // cause of the /mine "403 Access forbidden" fallback — the site only had HELIUS_RPC). Only take
  // a value that actually looks like an https URL, so a mistyped/garbage var is ignored, not forwarded.
  const pick = (v) => (typeof v === "string" && /^https?:\/\//i.test(v.trim())) ? v.trim() : "";
  const upstream = pick(process.env.SOLANA_RPC) || pick(process.env.HELIUS_RPC);
  if (!upstream) return new Response(JSON.stringify({ error: { message: "no valid RPC URL configured — set SOLANA_RPC or HELIUS_RPC to your Helius https URL" } }), { status: 500 });

  // Only serve requests from the store's own pages. This is spoofable by a
  // non-browser client, but it stops other websites from quietly spending the
  // Helius quota through a visitor's browser.
  const host = request.headers.get("host") || "";
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";
  if (origin && host && !origin.includes(host)) {
    return new Response(JSON.stringify({ error: { message: "forbidden origin" } }), { status: 403 });
  }

  let body;
  try { body = await request.json(); } catch { return new Response("bad json", { status: 400 }); }

  const calls = Array.isArray(body) ? body : [body];
  if (!calls.every((c) => ALLOWED.has(c?.method) && gpaOk(c) && groupOk(c))) {
    return new Response(JSON.stringify({ error: { message: "method not allowed" } }), { status: 403 });
  }

  // The upstream (Helius) rate-limits bursts with a 429. Retry a few times with a short backoff so a
  // busy second doesn't fail a page load, a mining read or a purchase step.
  let res, text;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); continue; }
    // Helius still busy: plain (non-DAS) calls can be served by Solana's public RPC instead.
    if (res.status === 429 && calls.every((c) => PUBLIC_OK.has(c?.method))) {
      const p = await fetch(PUBLIC_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (p.ok) { res = p; }
    }
    text = await res.text();
    break;
  }
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

export const config = { path: "/api/rpc" };
