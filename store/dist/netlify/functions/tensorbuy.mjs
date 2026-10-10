// Netlify Function: /api/tensorbuy — build a BUY-NOW transaction for ANY listed NFT via Tensor's
// aggregator API (api.mainnet.tensordev.io). Tensor routes to whatever marketplace holds the
// listing, INCLUDING Magic Eden AMM/MMM pools — which Magic Eden's own public API can't build
// (pool fulfills need ME's cosigner, which only ME's or an aggregator's backend supplies).
//
//   GET /api/tensorbuy?mint=<asset>&buyer=<wallet>&maxPrice=<sol>[&owner=<holder>][&royaltyPct=<0-100>]
//     → { txBase64, versioned:true, totalCost }   (client swaps ORE→SOL then signs+sends this)
//     → 501 { needKey:true } when TENSOR_API_KEY isn't set
//
// Env: TENSOR_API_KEY (apply at dev.tensor.trade), SOLANA_RPC (Helius; used to resolve the current
// holder + a recent blockhash).
const TENSOR = "https://api.mainnet.tensordev.io/api/v1/tx/buy";
// Solana's public RPC: a fallback for plain methods when Helius is rate-limiting (no DAS / no gPA there).
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const PUBLIC_OK = new Set(["getLatestBlockhash", "getSignatureStatuses", "getAccountInfo", "getMultipleAccounts", "getBalance", "simulateTransaction", "getSlot", "getTransaction", "getTokenAccountsByOwner"]);

const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";   // Metaplex Core program (asset owner @ bytes 1..33)
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });

const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) { let d = [0]; for (const b of bytes) { let c = b; for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let s = ""; for (const b of bytes) { if (b === 0) s += "1"; else break; } for (let k = d.length - 1; k >= 0; k--) s += ALPHA[d[k]]; return s; }
// Helius rate-limits bursts (429 "Too Many Requests", plain text) — that was failing Tensor buys
// before Tensor was even asked. Retry with a short backoff instead of failing the purchase.
async function rpc(rpcUrl, method, params) {
  const call = (u) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  for (let attempt = 0; ; attempt++) {
    const r = await call(rpcUrl);
    if (r.status === 429 && attempt < 2) { await new Promise((res) => setTimeout(res, 300 * (attempt + 1))); continue; }
    if (r.status === 429 && PUBLIC_OK.has(method)) {           // Helius still busy → public RPC for plain calls
      const p = await call(PUBLIC_RPC); try { return JSON.parse(await p.text()).result; } catch { /* fall through */ }
    }
    const t = await r.text();
    try { return JSON.parse(t).result; } catch { throw new Error(r.status === 429 ? "The Solana RPC is busy — try again in a moment." : "RPC error " + r.status); }
  }
}

// Resolve the wallet/account that currently HOLDS the NFT (Tensor needs the listing owner).
async function resolveOwner(rpcUrl, mint) {
  const acc = await rpc(rpcUrl, "getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]);
  if (acc && acc.value) {
    if (acc.value.owner === CORE) {                              // Metaplex Core asset → owner is in the account data
      const d = Buffer.from(acc.value.data[0], "base64");
      return b58(d.subarray(1, 33));
    }
  }
  // Regular SPL NFT → the wallet owner of the single token account holding it.
  const largest = await rpc(rpcUrl, "getTokenLargestAccounts", [mint]);
  const ta = largest && largest.value && largest.value[0] && largest.value[0].address;
  if (ta) { const info = await rpc(rpcUrl, "getAccountInfo", [ta, { encoding: "jsonParsed", commitment: "confirmed" }]); return info?.value?.data?.parsed?.info?.owner || null; }
  return null;
}

export default async (request) => {
  const url = new URL(request.url);
  const mint = url.searchParams.get("mint") || "";
  const buyer = url.searchParams.get("buyer") || "";
  const maxPrice = Number(url.searchParams.get("maxPrice")) || 0;
  let owner = url.searchParams.get("owner") || "";
  const royaltyPct = url.searchParams.get("royaltyPct");
  const key = process.env.TENSOR_API_KEY;
  if (!key) return json({ error: "Tensor API key not configured on the store.", needKey: true }, 501);
  if (!B58.test(mint) || !B58.test(buyer) || maxPrice <= 0) return json({ error: "bad mint/buyer/maxPrice" }, 400);
  const rpcUrl = process.env.SOLANA_RPC;
  if (!rpcUrl) return json({ error: "SOLANA_RPC not set" }, 500);

  try {
    if (!B58.test(owner)) owner = await resolveOwner(rpcUrl, mint);
    if (!owner) return json({ error: "Could not resolve the current holder for that NFT." }, 404);
    const bh = await rpc(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
    const blockhash = bh && bh.value && bh.value.blockhash;
    if (!blockhash) return json({ error: "could not fetch blockhash" }, 502);

    // Tensor's maxPrice is in LAMPORTS (it was sent in SOL, so every buy was refused as "over max price").
    const q = new URLSearchParams({ buyer, mint, owner, maxPrice: String(Math.ceil(maxPrice * 1e9)), blockhash });
    if (royaltyPct != null && royaltyPct !== "") q.set("optionalRoyaltyPct", String(royaltyPct));
    const r = await fetch(`${TENSOR}?${q.toString()}`, { headers: { "x-tensor-api-key": key, accept: "application/json" } });
    const text = await r.text();
    if (!r.ok) return json({ error: "Tensor returned " + r.status, detail: text.slice(0, 300) }, 502);
    let d; try { d = JSON.parse(text); } catch { return json({ error: "Tensor response not JSON" }, 502); }
    const t = d && d.txs && d.txs[0];
    const raw = t && ((t.txV0 && t.txV0.data) || (t.tx && t.tx.data));
    if (!raw) return json({ error: "Tensor did not return a transaction", keys: d ? Object.keys(d) : [] }, 502);
    const versioned = !!(t.txV0 && t.txV0.data);
    return json({ txBase64: Buffer.from(raw).toString("base64"), versioned, totalCost: d.totalCost ?? null, owner });
  } catch (e) { return json({ error: "tensorbuy failed: " + (e.message || e) }, 502); }
};

export const config = { path: "/api/tensorbuy" };
