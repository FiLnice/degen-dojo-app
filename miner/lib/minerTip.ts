"use client";

// Shared by the miner (/mine and its burn mode): the preacher referral, the Dojo fee on auto-mining deposits and the
// best-effort record of it.
import { SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { refMemoIx } from "@/lib/ore";
import { dojoFeeOf } from "@/lib/dojoFee";
// ─── Preacher referral on tips (Degen Dojo miner only) ───────────────────────
export const REF_RE = /^[a-zA-Z0-9_-]{2,32}$/;
export function readRef(): string | null {
  try {
    const q = new URLSearchParams(window.location.search).get("ref");
    // the store's host-only referral cookie, read through wallet-picker.js (loaded before this app on /mine)
    const dojoRef = (window as unknown as { DojoRef?: { code?: () => string | null } }).DojoRef;
    const raw = q || (dojoRef?.code ? dojoRef.code() || "" : "");
    return raw && REF_RE.test(raw) ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ─── The Dojo fee on auto-mining (owner 2026-10-27; replaces the Degen Dojo miner's optional tip) ─────────────
// 1% of the deposit, ALWAYS, routed exactly like the old mining tip: a SOL transfer to the tip wallet (the Reserve) inside
// the Automate transaction — so it is paid only if that lands — plus the preacher's signed "ddref:<code>" memo when one
// referred this miner — kept for attribution only: since 2026-10-27 the store books every mining fee 100% to the Reserve
// (store-verify-core), memo or not; preachers earn from coin purchases.
// Not on branded /m/<slug> miners: they keep their own optional tip to the collection's wallet.
// the fee math itself lives in lib/dojoFee.ts (import-free, shared with lib/burnMine.ts)
export { DOJO_FEE_BPS, dojoFeeOf, depositWithin } from "@/lib/dojoFee";
export function dojoFeeIxs(payer: PublicKey, depositLamports: number, wallet: PublicKey): { ixs: TransactionInstruction[]; feeLamports: number } {
  const feeLamports = dojoFeeOf(depositLamports);
  if (feeLamports <= 0) return { ixs: [], feeLamports: 0 };
  const ixs: TransactionInstruction[] = [SystemProgram.transfer({ fromPubkey: payer, toPubkey: wallet, lamports: feeLamports })];
  const ref = readRef();
  if (ref) ixs.push(refMemoIx(ref));
  return { ixs, feeLamports };
}

export type TipCurrency = "SOL" | "ORE";
const PRICE_MINT: Record<TipCurrency, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp",
};
export async function usdPrice(currency: TipCurrency): Promise<number> {
  const mint = PRICE_MINT[currency];
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const j = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: ctl.signal })).json();
    clearTimeout(t);
    const p = Number(j?.[mint]?.usdPrice);
    return p > 0 ? p : 0;
  } catch {
    return 0;
  }
}
/** Best effort: log a confirmed tip to the store's ledger (with the preacher ref, if any).
 *  Never throws, never blocks mining — an untrusted hint the backend re-verifies on-chain. */
export async function recordTip(sig: string, buyer: string, tipAmount: number, currency: TipCurrency): Promise<void> {
  try {
    const px = await usdPrice(currency);
    await fetch("/api/coinbuy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        sig,
        buyer,
        kind: "tip",
        coins: 0,
        currency,
        tokenAmount: tipAmount,
        usd: px ? Math.round(tipAmount * px * 100) / 100 : 0,
        ref: readRef(),
        ts: Date.now(),
      }),
    });
  } catch {
    /* best effort */
  }
}

