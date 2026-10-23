// The Degen Dojo listing floor: 1.5 SOL, expressed in the listing's currency at the live price, so the ORE
// minimum follows SOL/ORE automatically. It applies to Degen Dojo NFTs ONLY — any other collection lists freely.
// Shared by the listing index (store-fn-dd-listings) and the co-signer (store-fn-dd-cosign); the List page
// (dd-list.html) shows and enforces the same number.
export const MIN_SOL = 1.5;
export const FLOOR_COLLECTION = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";   // Degen Dojo
export const collectionOf = (asset) => (asset?.grouping || []).find((g) => g.group_key === "collection")?.group_value || "";
// A listing made right at the minimum can drift below it when ORE/SKR moves against SOL. The index checks
// at list time (2% slack for the page's price being a minute old); the co-signer allows 15% drift so honest
// listings stay buyable while dumps far under the floor are refused.
export const LIST_SLACK = 0.98, BUY_SLACK = 0.85;

const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp",
  SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
};

let cache = { at: 0, usd: null };
/** USD prices { SOL, ORE, SKR, USDC } from Jupiter, cached 60s per instance; null when unavailable. */
export async function usdPrices(fetchFn = fetch) {
  if (cache.usd && Date.now() - cache.at < 60_000) return cache.usd;
  try {
    const j = await (await fetchFn("https://lite-api.jup.ag/price/v3?ids=" + Object.values(MINTS).join(","))).json();
    const usd = { USDC: 1 };
    for (const [k, m] of Object.entries(MINTS)) usd[k] = Number(j?.[m]?.usdPrice) || 0;
    if (!(usd.SOL > 0)) return null;
    cache = { at: Date.now(), usd };
    return usd;
  } catch { return null; }
}

/** The 1.5 SOL minimum in `currency` (ORE / SKR / USDC); null when prices are unavailable. */
export async function minInCurrency(currency, fetchFn = fetch) {
  const usd = await usdPrices(fetchFn);
  const per = usd?.[currency];
  if (!usd || !(per > 0)) return null;
  return (MIN_SOL * usd.SOL) / per;
}
