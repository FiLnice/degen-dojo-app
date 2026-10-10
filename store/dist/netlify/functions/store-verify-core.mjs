// Shared coin-purchase verification — the ONE place a purchase turns into coins.
// Imported by BOTH /api/verify (admin-triggered) and verify-cron (every minute) so
// the crediting rule can never drift between the two paths.
//
// Rule: re-read the purchase's signature on-chain, confirm the TREASURY actually
// received the tokens, value that REAL amount in USD at the live price, and mint
// coins from the server pack table. The client's claimed coins/usd/tokenAmount are
// hints only — a tiny payment can never buy a big pack.
//
// Env: SOLANA_RPC (getTransaction) + TREASURY_WALLET.
import { getStore } from "@netlify/blobs";
import { addToPot, POT_FRAC } from "./store-pot-core.mjs";

export const TREASURY = process.env.TREASURY_WALLET || "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MINTS = { ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
const DEC = { SOL: 1e9, ORE: 1e11, SKR: 1e6, USDC: 1e6 };
const PACK_TOL = 0.04;   // absorb price drift between purchase and verification
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// The ONLY coin prices the server honours (mirror of dojo-credits.html PACKS).
const PACKS = [
  { usd: 5, total: 5 }, { usd: 10, total: 11 }, { usd: 25, total: 29 }, { usd: 50, total: 60 },
].sort((a, b) => a.usd - b.usd);
// largest pack whose price the paid USD covers; sub-$5 pays 1 coin per whole $1 (no bonus)
export function coinsForUsd(usd) {
  let best = 0;
  for (const p of PACKS) if (usd + 1e-9 >= p.usd * (1 - PACK_TOL)) best = p.total;
  return best || Math.max(0, Math.floor(usd));
}

async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()).result;
}

// the dedicated Dojo Pot wallet tips flow to (kept separate from the coin treasury)
const POT_WALLET = process.env.POT_WALLET || "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe";

// how much of `currency` the given wallet (default TREASURY) GAINED in tx `sig` (null → tx missing/failed)
export async function walletReceived(sig, currency, wallet = TREASURY) {
  const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
  if (!tx || tx.meta?.err) return null;
  const keys = [
    ...tx.transaction.message.accountKeys || [],
    ...(tx.meta.loadedAddresses?.writable || []),
    ...(tx.meta.loadedAddresses?.readonly || []),
  ].map((k) => (typeof k === "string" ? k : k.pubkey || k));
  if (currency === "SOL") {
    const i = keys.indexOf(wallet);
    if (i < 0) return 0;
    return (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / DEC.SOL;
  }
  const mint = MINTS[currency];
  const pre = (tx.meta.preTokenBalances || []).filter((b) => b.mint === mint && b.owner === wallet);
  const post = (tx.meta.postTokenBalances || []).filter((b) => b.mint === mint && b.owner === wallet);
  const amt = (arr) => arr.reduce((s, b) => s + Number(b.uiTokenAmount?.uiAmount || 0), 0);
  return amt(post) - amt(pre);
}

// live USD price of a currency from Jupiter (CORS-open, no key). null → fail-closed (retry).
const _priceCache = {};
export async function livePrice(cur) {
  if (cur === "USDC") return 1;
  if (cur in _priceCache) return _priceCache[cur];
  const mint = cur === "SOL" ? SOL_MINT : MINTS[cur];
  let px = null;
  try { const j = await (await fetch("https://lite-api.jup.ag/price/v3?ids=" + mint)).json(); px = j?.[mint]?.usdPrice ?? null; } catch { px = null; }
  return (_priceCache[cur] = (Number.isFinite(px) && px > 0 ? px : null));
}

// Walk every unverified purchase, verify on-chain, credit server coins from the
// verified USD. Returns a summary. `strictReject` (admin path) rejects a tx that
// can't be read; the cron leaves it pending so a not-yet-propagated tx retries.
export async function verifyPurchases({ strictReject = false } = {}) {
  const store = getStore("coin-purchases");
  const balances = getStore("balances");
  const { blobs } = await store.list();
  let checked = 0, verified = 0, rejected = 0;
  const results = [];
  for (const b of blobs) {
    const rec = await store.get(b.key, { type: "json" });
    if (!rec || rec.verified || rec.rejected) continue;
    checked++;
    try {
      const got = await walletReceived(rec.sig, rec.currency, rec.kind === "tip" ? POT_WALLET : TREASURY);
      if (got == null) {   // tx missing/failed
        if (strictReject) { rec.rejected = true; rec.rejectReason = "tx missing/failed"; await store.setJSON(b.key, rec); rejected++; }
        results.push({ sig: rec.sig, got: null, ok: false, retry: !strictReject });
        continue;
      }
      const price = await livePrice(rec.currency);
      if (price == null) { results.push({ sig: rec.sig, got, ok: false, retry: "no price" }); continue; }  // fail-closed
      const usdGot = got * price;

      // A TIP (rec.kind==='tip') mints NO coins — 100% of it feeds the Dojo Pot.
      if (rec.kind === "tip") {
        rec.verified = true; rec.verifiedAmount = got; rec.verifiedUsd = usdGot; rec.verifiedAt = Date.now(); rec.toPotUsd = usdGot;
        await store.setJSON(b.key, rec); verified++;
        await addToPot({ usd: usdGot, currency: rec.currency, native: got, route: "tip" });
        results.push({ sig: rec.sig, currency: rec.currency, got, usd: +usdGot.toFixed(2), ok: true, tip: true });
        continue;
      }

      const credit = coinsForUsd(usdGot);
      if (credit > 0) {
        rec.verified = true; rec.verifiedAmount = got; rec.verifiedUsd = usdGot; rec.verifiedAt = Date.now(); rec.creditedCoins = credit;
        await store.setJSON(b.key, rec); verified++;
        if (ADDR_RE.test(rec.buyer || "")) {   // credit server coins — the ONLY way coins are minted
          const bal = (await balances.get("bal:" + rec.buyer, { type: "json" })) || { coins: 0 };
          bal.coins = (bal.coins || 0) + credit; bal.updatedAt = Date.now();
          await balances.setJSON("bal:" + rec.buyer, bal);
        }
        // POT_FRAC of every verified purchase feeds the pot — this is what makes the
        // "25% into the pot" real & verifiable, tallied from the ACTUAL on-chain amount.
        await addToPot({ usd: usdGot * POT_FRAC, currency: rec.currency, native: got * POT_FRAC, route: "coinbuy" });
        results.push({ sig: rec.sig, currency: rec.currency, got, usd: +usdGot.toFixed(2), ok: true, credited: credit, claimed: rec.coins });
      } else {   // paid less than $1 of value → dust, reject
        rec.rejected = true; rec.rejectReason = `dust: $${usdGot.toFixed(2)} < $1`;
        await store.setJSON(b.key, rec); rejected++;
        results.push({ sig: rec.sig, currency: rec.currency, got, usd: +usdGot.toFixed(2), ok: false });
      }
    } catch (e) { results.push({ sig: rec.sig, error: String(e.message || e), retry: true }); }
  }
  return { checked, verified, rejected, results };
}
