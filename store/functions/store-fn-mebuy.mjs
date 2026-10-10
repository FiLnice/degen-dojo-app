// Netlify Function: /api/mebuy — build a Magic Eden "buy now" transaction for ANY listed asset
// (regular NFT, pNFT, or Metaplex Core) using Magic Eden's own instruction builder. This is the
// universal path: ME builds the correct transaction for every asset type, so the store's inline
// checkout works for the whole shelf once a key is configured.
//
//   GET /api/mebuy?mint=<asset>&buyer=<wallet>[&price=<sol>]
//     → { txBase64, versioned, price, seller }   (client simulates, signs, sends)
//     → 501 { needKey:true } when MAGICEDEN_API_KEY isn't set (client falls back to the inline
//       engine for regular NFTs, or opens the ME listing)
//
// Env: MAGICEDEN_API_KEY (from magiceden.dev), SOLANA_RPC (Helius URL, already used by /api/rpc).
const ME = "https://api-mainnet.magiceden.dev/v2";
const M2 = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
const AH = "E8cU1WiRWjanGxmn96ewBgk9vPTcL6AEZ1t6F6fkgUWe";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const M2_SELL_DISCS = new Set(["a40e5c647b39eacc", "01ee48898a15fef9", "c3372e293607e19b"]);
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// tiny base58 for reading pubkeys out of the M2 sell-state bytes
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let digits = [0];
  for (const b of bytes) { let carry = b; for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; } while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; } }
  let s = ""; for (const b of bytes) { if (b === 0) s += "1"; else break; }
  for (let k = digits.length - 1; k >= 0; k--) s += ALPHA[digits[k]];
  return s;
}
async function rpc(rpcUrl, method, params) {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}

export default async (request) => {
  const url = new URL(request.url);
  const mint = url.searchParams.get("mint") || "";
  const buyer = url.searchParams.get("buyer") || "";
  const key = process.env.MAGICEDEN_API_KEY;
  if (!key) return json({ error: "Magic Eden API key not configured on the store.", needKey: true }, 501);
  if (!B58.test(mint) || !B58.test(buyer)) return json({ error: "bad mint/buyer" }, 400);
  const rpcUrl = process.env.SOLANA_RPC;
  if (!rpcUrl) return json({ error: "SOLANA_RPC not set" }, 500);

  // Resolve the live M2 listing (seller, price, seller token account) straight from chain.
  let seller = null, priceSol = Number(url.searchParams.get("price")) || null, tokenAccount = null;
  try {
    const accts = await rpc(rpcUrl, "getProgramAccounts", [M2, { encoding: "base64", filters: [{ memcmp: { offset: 112, bytes: mint } }] }]);
    for (const a of accts || []) {
      const b = Buffer.from(a.account.data[0], "base64");
      if (!M2_SELL_DISCS.has(b.subarray(0, 8).toString("hex"))) continue;
      const price = b.readBigUInt64LE(104); if (price === 0n) continue;
      seller = b58(b.subarray(40, 72)); tokenAccount = b58(b.subarray(144, 176));
      priceSol = Number(price) / 1e9; break;
    }
  } catch (e) { return json({ error: "listing lookup failed: " + (e.message || e) }, 502); }

  // Pool/Tensor listings have NO M2 sell-state, so the on-chain scan finds nothing. But Magic Eden's
  // /listings API already told the client the seller (the pool address for a pool listing), the price,
  // and the token account — so fall back to THOSE and let ME's universal buy_now builder handle it.
  const B58ok = (v) => v && B58.test(v);
  if (!seller) {
    const qSeller = url.searchParams.get("seller"), qPrice = Number(url.searchParams.get("price")) || null, qAta = url.searchParams.get("tokenATA");
    if (B58ok(qSeller) && qPrice) { seller = qSeller; priceSol = qPrice; if (B58ok(qAta)) tokenAccount = qAta; }
  }
  if (!seller || priceSol == null) return json({ error: "No live Magic Eden listing for that asset." }, 404);

  // Ask Magic Eden to build the buy. tokenATA is the seller's token account (standard NFTs);
  // ME resolves the rest per asset type (pNFT rules, Core, etc.).
  const q = new URLSearchParams({ buyer, seller, auctionHouseAddress: AH, tokenMint: mint, price: String(priceSol) });
  if (tokenAccount) q.set("tokenATA", tokenAccount);
  const meRes = await fetch(`${ME}/instructions/buy_now?${q.toString()}&v0=true`, { headers: { Authorization: "Bearer " + key, accept: "application/json" } });
  const text = await meRes.text();
  if (!meRes.ok) return json({ error: "Magic Eden returned " + meRes.status, detail: text.slice(0, 300) }, 502);
  let d; try { d = JSON.parse(text); } catch { return json({ error: "ME response not JSON" }, 502); }
  // Prefer the version that carries ME's own required signatures; prefer v0 (versioned) when present.
  const txObj = (d.v0 && (d.v0.txSigned || d.v0.tx)) || d.txSigned || d.tx;
  if (!txObj || !txObj.data) return json({ error: "ME did not return a transaction", keys: Object.keys(d) }, 502);
  const versioned = !!(d.v0);
  const txBase64 = Buffer.from(txObj.data).toString("base64");
  return json({ txBase64, versioned, price: priceSol, seller });
};

export const config = { path: "/api/mebuy" };
