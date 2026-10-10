// Netlify Function: /api/dd-listings — the DD ORE/SKR/USDC AuctionHouse listing index.
//   POST { mint, seller, currency, price, priceBaseUnits, tradeState, name } → record a listing
//        (only after verifying the seller trade state actually exists on-chain — no fake listings).
//   GET  → the live listings, each re-verified against chain (a sold/cancelled listing's trade
//          state is closed, so it drops out automatically).
// Storage: Netlify Blobs. Env: SOLANA_RPC.
import { getStore } from "@netlify/blobs";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CURS = new Set(["ORE", "SKR", "USDC"]);
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
const store = () => getStore({ name: "dd-listings", consistency: "strong" });
async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}

export default async (request) => {
  if (request.method === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const { mint, seller, currency, price, priceBaseUnits, tradeState, name } = d || {};
    if (!B58.test(mint) || !B58.test(seller) || !B58.test(tradeState) || !CURS.has(currency) || !(price > 0)) return json({ error: "bad fields" }, 400);
    // Verify the listing is REAL: the seller trade state PDA must exist on-chain.
    const acc = await rpc("getAccountInfo", [tradeState, { encoding: "base64", commitment: "confirmed" }]);
    if (!acc || !acc.value) return json({ error: "trade state not found on-chain — listing not confirmed yet" }, 409);
    const rec = { mint, seller, currency, price: Number(price), priceBaseUnits: String(priceBaseUnits || ""), tradeState, name: String(name || "").slice(0, 64), listedAt: acc.context.slot };
    await store().setJSON(tradeState, rec);
    return json({ ok: true, listing: rec });
  }

  // GET → verify every stored listing against chain, drop the dead ones.
  const s = store();
  const { blobs } = await s.list();
  const recs = [];
  for (const b of blobs) { const r = await s.get(b.key, { type: "json" }); if (r) recs.push(r); }
  if (!recs.length) return json({ listings: [] });
  const live = [];
  for (let i = 0; i < recs.length; i += 100) {
    const chunk = recs.slice(i, i + 100);
    const infos = await rpc("getMultipleAccounts", [chunk.map((r) => r.tradeState), { encoding: "base64", commitment: "confirmed" }]);
    (infos.value || []).forEach((inf, k) => {
      if (inf && inf.lamports > 0) live.push(chunk[k]);
      else s.delete(chunk[k].tradeState).catch(() => {});   // sold/cancelled → prune
    });
  }
  live.sort((a, b) => a.price - b.price);
  return json({ listings: live });
};

export const config = { path: "/api/dd-listings" };
