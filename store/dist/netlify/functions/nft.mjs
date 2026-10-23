// Netlify Function: per-mint SEO page at /nft/:mint
//
// Renders a full, indexable page for ANY NFT on first visit, then the edge cache
// serves it — so we never pre-build millions of files (no Netlify file-count
// ceiling, near-zero storage; images stay on their origin CDNs). Degen Dojo mints
// get real per-trait rarity (bundled table); outside collections get the minimal
// treatment. Pure render lives in seo-nft.mjs; this only does the chain reads.
//
// Env: SOLANA_RPC (DAS-capable). No secrets in the output — safe to cache/index.
import { limited } from "./store-ratelimit-core.mjs";
import { renderNftPage, gatherNft } from "./seo-nft.mjs";
import RARITY from "./dd-trait-rarity.json" with { type: "json" };

const M2 = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
const SELL = new Set(["a40e5c647b39eacc", "01ee48898a15fef9"]);
const DD_CREATORS = ["HEyazxpV2wxMUvNx53UZUXthRS9Rjsbv7hoHYJNbVedC", "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp"];   // ED3GMC retired 2026-10-22
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
// minimal listing lookup — just the live price for the page (null if not listed)
async function resolveMagicEden(mint) {
  const res = await rpc("getProgramAccounts", [M2, { encoding: "base64", filters: [{ memcmp: { offset: 112, bytes: mint } }] }]);
  for (const acc of res || []) {
    const b = Buffer.from(acc.account.data[0], "base64");
    if (!SELL.has(b.subarray(0, 8).toString("hex"))) continue;
    const price = b.readBigUInt64LE(104);
    if (price === 0n) continue;
    return { price: Number(price) / 1e9 };
  }
  return null;
}
const getAsset = (id) => rpc("getAsset", { id });

export default async (request) => {
  const blocked = limited(request, "nft", 120); if (blocked) return blocked;   // 120 / minute / IP (DD-04)
  const mint = new URL(request.url).pathname.split("/").filter(Boolean).pop();
  if (!MINT_RE.test(mint || "")) return new Response("not found", { status: 404 });
  try {
    const data = await gatherNft(mint, { resolveMagicEden, getAsset, ddCreators: DD_CREATORS, rarity: RARITY.traits });
    if (data.lookalike) return new Response("not found", { status: 404, headers: { "cache-control": "public, max-age=0, s-maxage=86400" } });   // copies of our NFTs get no page
    const html = renderNftPage(data);
    return new Response(html, { status: 200, headers: {
      "content-type": "text/html; charset=utf-8",
      // render once, then let the CDN serve it; refresh in the background daily
      "cache-control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800",
      "netlify-cdn-cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
    } });
  } catch (e) {
    return new Response("temporarily unavailable", { status: 503 });
  }
};

export const config = { path: "/nft/:mint" };
