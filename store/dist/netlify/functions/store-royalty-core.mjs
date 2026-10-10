// Shared royalty→pot sweep. ALL Degen royalties (13% creator share) land in the creator wallet
// ED3GMC — from the DD store, Magic Eden, Tensor, anywhere — so one watcher on that wallet captures
// EVERY marketplace. Each run: read the wallet's new signatures, and for any tx that touches a known
// marketplace program, credit HALF of what the wallet gained (in every currency) to the weekly pot's
// "royalty" route. Verified against the ACTUAL on-chain gain, idempotent per signature (shared with the
// /api/dd-royalty client report so a sale is never double-counted). The FIRST run only records a baseline
// cursor and credits nothing, so it means "from now on" — never a retroactive dump of past sales.
import { getStore } from "@netlify/blobs";
import { addToPot } from "./store-pot-core.mjs";
import { livePrice } from "./store-verify-core.mjs";

const CREATOR = process.env.ROYALTY_WALLET || "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe";
const ROYALTY_TO_POT = 0.5;
const MINTS = { ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
// Marketplace programs whose sales pay this wallet a royalty. Conservative allow-list — an inflow that
// doesn't come through one of these (e.g. you funding the wallet) is NEVER counted as royalty.
const MARKETPLACES = new Set([
  "hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk",   // Metaplex / DD AuctionHouse
  "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K",   // Magic Eden v2
  "mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc",   // Magic Eden MMM (AMM pools)
  "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN",   // Tensor
]);

async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}

// what CREATOR gained in this tx, per currency (SOL native + our SPL mints)
function gains(tx) {
  const keys = [
    ...(tx.transaction.message.accountKeys || []),
    ...(tx.meta.loadedAddresses?.writable || []),
    ...(tx.meta.loadedAddresses?.readonly || []),
  ].map((k) => (typeof k === "string" ? k : k.pubkey || k));
  const out = {};
  const i = keys.indexOf(CREATOR);
  if (i >= 0) out.SOL = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
  const sum = (arr, mint) => arr.filter((b) => b.mint === mint && b.owner === CREATOR).reduce((s, b) => s + Number(b.uiTokenAmount?.uiAmount || 0), 0);
  for (const [cur, mint] of Object.entries(MINTS)) out[cur] = sum(tx.meta.postTokenBalances || [], mint) - sum(tx.meta.preTokenBalances || [], mint);
  return out;
}
const touchesMarket = (tx) => [
  ...(tx.transaction.message.accountKeys || []),
  ...(tx.meta.loadedAddresses?.writable || []),
  ...(tx.meta.loadedAddresses?.readonly || []),
].some((k) => MARKETPLACES.has(typeof k === "string" ? k : k.pubkey || k));

export async function sweepRoyalties() {
  if (!process.env.SOLANA_RPC) return { skipped: "no rpc" };
  const store = getStore("dd-royalties");
  const cur = await store.get("__cursor__", { type: "json" });
  const sigs = await rpc("getSignaturesForAddress", [CREATOR, cur?.lastSig ? { limit: 100, until: cur.lastSig } : { limit: 100 }]);
  if (!sigs || !sigs.length) return { checked: 0, credited: 0 };

  // First ever run → set a baseline and credit nothing (means "from now on").
  if (!cur?.lastSig) { await store.setJSON("__cursor__", { lastSig: sigs[0].signature, since: Date.now() }); return { baseline: sigs[0].signature }; }

  let credited = 0, creditedUsd = 0;
  for (const s of sigs.slice().reverse()) {                 // oldest → newest
    const sig = s.signature;
    if (s.err) continue;
    const prior = await store.get(sig, { type: "json" });
    if (prior && prior.credited) continue;                  // already counted (by client report or earlier sweep)
    const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
    if (!tx || tx.meta?.err) continue;                      // leave unmarked; a later run retries
    if (!touchesMarket(tx)) { await store.setJSON(sig, { credited: false, skip: "not-marketplace", at: Date.now() }); continue; }
    const g = gains(tx);
    const rec = { credited: true, at: Date.now(), routes: {} };
    let any = 0;
    for (const [c, amt] of Object.entries(g)) {
      if (!(amt > 0)) continue;
      const px = await livePrice(c);
      if (px == null) continue;
      const potNative = amt * ROYALTY_TO_POT, usd = potNative * px;
      await addToPot({ usd, currency: c, native: potNative, route: "royalty" });
      rec.routes[c] = { royalty: amt, potNative, usd: +usd.toFixed(4) }; any += usd;
    }
    await store.setJSON(sig, rec);
    if (any > 0) { credited++; creditedUsd += any; }
  }
  await store.setJSON("__cursor__", { lastSig: sigs[0].signature, at: Date.now() });
  return { checked: sigs.length, credited, creditedUsd: +creditedUsd.toFixed(2) };
}
