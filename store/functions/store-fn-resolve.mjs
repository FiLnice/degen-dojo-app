import { limited } from "./store-ratelimit-core.mjs";
import { dojoOf, isLookalike } from "./store-genuine-core.mjs";
// Netlify Function: /api/resolve?q=<mint | Magic Eden url | Tensor url>
//   Finds a live listing straight off the chain (personal Magic Eden M2 sell state or a Tensor
//   list state), enriches it with DAS metadata, and returns everything the market drawer needs to
//   show it + price it in ORE. Read-only, no npm deps, no marketplace API key.
// Env: SOLANA_RPC (Helius). The heavy getProgramAccounts is scoped to one mint via a memcmp filter.
const M2 = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
const TENSOR = "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp";
const M2_SELL_DISCS = new Set(["a40e5c647b39eacc", "01ee48898a15fef9"]);
const TENSOR_DISC = "4ef2598aa1ddb04b";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });

async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
const hex = (buf, o, n) => Buffer.from(buf.slice(o, o + n)).toString("hex");
const u64le = (buf, o) => { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(buf[o + i]) << (8n * BigInt(i)); return Number(v); };
const B58A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58enc(bytes) {
  const d = [0];
  for (const b of bytes) { let c = b; for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
  let s = ""; for (const b of bytes) { if (b === 0) s += "1"; else break; }
  for (let i = d.length - 1; i >= 0; i--) s += B58A[d[i]];
  return s;
}
function mintFromInput(s) {
  s = (s || "").trim();
  const m = s.match(/(?:item-details\/|item\/|\/)?([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
  return m ? m[1] : (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? s : null);
}
async function findM2(mint) {
  const accts = await rpc("getProgramAccounts", [M2, { encoding: "base64", filters: [{ memcmp: { offset: 112, bytes: mint } }] }]);
  for (const a of (accts || [])) {
    const buf = Buffer.from(a.account.data[0], "base64");
    if (!M2_SELL_DISCS.has(hex(buf, 0, 8))) continue;
    return { marketplace: "Magic Eden", model: "M2", seller: b58enc(buf.slice(40, 72)), price: u64le(buf, 104) / 1e9, tokenAccount: b58enc(buf.slice(144, 176)) };
  }
  return null;
}
async function findTensor(mint) {
  const accts = await rpc("getProgramAccounts", [TENSOR, { encoding: "base64", filters: [{ memcmp: { offset: 42, bytes: mint } }] }]);
  for (const a of (accts || [])) {
    const buf = Buffer.from(a.account.data[0], "base64");
    if (hex(buf, 0, 8) !== TENSOR_DISC) continue;
    return { marketplace: "Tensor", model: "TCOMP", seller: b58enc(buf.slice(10, 42)), price: u64le(buf, 74) / 1e9, tokenAccount: null };
  }
  return null;
}

export default async (request) => {
  const blocked = limited(request, "resolve", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  if (!process.env.SOLANA_RPC) return json({ ok: false, error: "server RPC not configured" }, 500);
  const q = new URL(request.url).searchParams.get("q") || "";
  const mint = mintFromInput(q);
  if (!mint) return json({ ok: false, error: "paste an NFT mint or a Magic Eden / Tensor link" }, 400);
  try {
    let L = await findM2(mint);
    if (!L) L = await findTensor(mint);
    if (!L) return json({ ok: false, mint, error: "No live listing found on-chain" });
    let name = mint.slice(0, 4) + "…", image = "", attributes = [], royaltyBps = 1300, collectionName = "", dojo = null, lookalike = false;
    try {
      const as = await rpc("getAsset", { id: mint });
      dojo = dojoOf(as); lookalike = isLookalike(as);
      name = as?.content?.metadata?.name || name;
      image = (as?.content?.links?.image) || (as?.content?.files?.[0]?.cdn_uri) || (as?.content?.files?.[0]?.uri) || "";
      attributes = as?.content?.metadata?.attributes || [];
      royaltyBps = as?.royalty?.basis_points ?? 1300;
      collectionName = (as?.grouping || []).find(g => g.group_key === "collection")?.collection_metadata?.name || "";
    } catch (e) {}
    const priceAllIn = L.price * (1 + royaltyBps / 1e4 + 0.02);
    return json({ ok: true, listing: { mint, name, image, price: L.price, priceAllIn, royaltyBps, attributes, collectionName, dojo, lookalike, marketplace: L.marketplace, model: L.model, seller: L.seller, tokenAccount: L.tokenAccount } });
  } catch (e) { return json({ ok: false, error: (e.message || String(e)).slice(0, 200) }); }
};

export const config = { path: "/api/resolve" };
