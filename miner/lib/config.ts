import { PublicKey } from "@solana/web3.js";

// ─── Per-collection config (whitelabel) ──────────────────────────────────────
// To spin up a new collection, set these env vars in the host (Netlify) and drop
// the collection's 25 images into public/mine/degens.json. Everything else (the
// ORE mining, grid, vault, auto-mine) is collection-agnostic. Defaults = Degen Dojo.

const DEFAULT_TIP_WALLET = "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe";

function toPubkey(addr: string | undefined): PublicKey {
  try {
    return new PublicKey(addr || DEFAULT_TIP_WALLET);
  } catch {
    return new PublicKey(DEFAULT_TIP_WALLET);
  }
}

/** Collection name shown in the tab title, tip label, etc. */
export const COLLECTION_NAME = process.env.NEXT_PUBLIC_COLLECTION_NAME || "Degen Dojo";

/** Wallet that receives optional tips (a public address — safe to expose). */
export const TIP_WALLET = toPubkey(process.env.NEXT_PUBLIC_TIP_WALLET);

/** Show the optional-tip field. Set NEXT_PUBLIC_TIP_ENABLED=false to hide it. */
export const TIP_ENABLED =
  (process.env.NEXT_PUBLIC_TIP_ENABLED ?? "true").toLowerCase() !== "false";

/** Inline 25-image list as a JSON string. If set, used directly (no fetch) — the
 *  fully-automatic whitelabel path: the whole collection config lives in env vars. */
export const DEGENS_INLINE_JSON = process.env.NEXT_PUBLIC_DEGENS_JSON || "";

// ─── Whitelabel signup (paid request flow) ───────────────────────────────────
/** The Degen Dojo store treasury (also receives coin purchases). Default receiver of the
 *  branded-miner setup fee — MUST match the store's /api/miner-requests OPERATOR_WALLET
 *  (scripts/store-miner-core.mjs STORE_TREASURY_WALLET) or payments won't verify. */
export const STORE_TREASURY_WALLET = "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp";
/** Operator wallet that receives the one-time setup fee (override: NEXT_PUBLIC_OPERATOR_WALLET). */
export const OPERATOR_WALLET = process.env.NEXT_PUBLIC_OPERATOR_WALLET || STORE_TREASURY_WALLET;
/** One-time setup fee in ORE a collection pays to request a miner. */
export const SETUP_FEE_ORE = parseFloat(process.env.NEXT_PUBLIC_SETUP_FEE_ORE || "5") || 5;

/** Where the 25 grid images come from when not inline. Default = bundled file. */
export const DEGENS_URL = process.env.NEXT_PUBLIC_DEGENS_URL || "/mine/degens.json";
