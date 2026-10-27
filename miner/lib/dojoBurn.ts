// The store's shared burn module (/dojo-burn.js → window.DojoBurn — the same code Dojo Sweep runs), typed for the miner:
// burn mode on /mine (/mine?burn=1) uses it through this file. The module ships with the
// store, so on a standalone deploy of the miner it simply doesn't load (the UI says so).
import { useEffect, useState } from "react";
import * as web3 from "@solana/web3.js";
import { Buffer } from "buffer";

export type BurnNft = { mint: string; name: string; image: string; collectionName: string; collection: string | null; lamports: number; burnable: boolean; junk: number; reason: string | null; pnft: boolean };
export type ScanOut = { nfts: BurnNft[]; empties: unknown[]; emptyLamports: number; unread: number; calls: number | null; ms: number };
export type Batch = { ixs: unknown[]; items: BurnNft[]; lamports: number };
export type Plan = { batches: Batch[]; dropped: { item: BurnNft; reason: string }[] };
export type Rpc = (method: string, params: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type DojoBurnApi = {
  makeRpc: (url: string, opts?: { onRetry?: (attempt: number, ms: number, method: string) => void }) => Rpc;
  scan: (rpc: Rpc, owner: string, step?: (s: string) => void) => Promise<ScanOut>;
  // opts.fee false: no 1% Dojo fee on these (Burn to Mine pays its one fee on the mining deposit)
  planBurns: (rpc: Rpc, owner: string, nfts: BurnNft[], step?: (s: string) => void, opts?: { fee?: boolean }) => Promise<Plan>;
  planCloses: (rpc: Rpc, owner: string, empties: unknown[], step?: (s: string) => void, opts?: { fee?: boolean }) => Promise<Plan>;
  finalize: (rpc: Rpc, owner: string, batches: Batch[]) => Promise<web3.VersionedTransaction[]>;
};

// One paced client for the page once /dojo-burn.js is loaded (≤ 2 in flight, ≤ 4 a second, retries 429/5xx with
// backoff — DojoBurn.makeRpc, the same as /sweep). Retries are announced to whoever listens ("busy, retrying").
let paced: Rpc | null = null;
const retryListeners = new Set<() => void>();
export function onRpcRetry(fn: () => void) {
  retryListeners.add(fn);
  return () => {
    retryListeners.delete(fn);
  };
}

/** JSON-RPC through the store's same-origin proxy (/api/rpc). */
export async function storeRpc(method: string, params: unknown) {
  const w = window as unknown as { DojoBurn?: DojoBurnApi };
  if (!paced && w.DojoBurn?.makeRpc) paced = w.DojoBurn.makeRpc("/api/rpc", { onRetry: () => retryListeners.forEach((f) => f()) });
  if (paced) return paced(method, params);
  const r = await fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(j.error.message || "RPC error");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return j.result;
}
// the paced client's request counter, so a scan can report its own RPC calls (logged on localhost)
Object.defineProperty(storeRpc, "stats", { get: () => (paced as unknown as { stats?: unknown } | null)?.stats });

/** Poll until every signature is confirmed (or ~60 s pass) → how many landed / failed. */
export async function confirmAll(sigs: string[]) {
  let done = 0, failed = 0;
  for (let k = 0; k < 40 && done + failed < sigs.length; k++) {
    const st = ((await storeRpc("getSignatureStatuses", [sigs])).value || []) as ({ confirmationStatus?: string; err?: unknown } | null)[];
    done = 0;
    failed = 0;
    for (const s of st) {
      if (!s || (s.confirmationStatus !== "confirmed" && s.confirmationStatus !== "finalized")) continue;
      if (s.err) failed++;
      else done++;
    }
    if (done + failed < sigs.length) await new Promise((r) => setTimeout(r, 1500));
  }
  return { done, failed };
}

/** Load /dojo-burn.js on this app's web3.js. */
export function useDojoBurn(): { api: DojoBurnApi | null; error: string | null } {
  const [api, setApi] = useState<DojoBurnApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const w = window as unknown as { solanaWeb3?: unknown; Buffer?: unknown; DojoBurn?: DojoBurnApi };
    w.solanaWeb3 = w.solanaWeb3 || web3;
    w.Buffer = w.Buffer || Buffer;
    if (w.DojoBurn) {
      const ready = w.DojoBurn;
      void Promise.resolve().then(() => setApi(ready)); // already loaded
      return;
    }
    const s = document.createElement("script");
    s.src = "/dojo-burn.js";
    s.async = true;
    s.onload = () => (w.DojoBurn ? setApi(w.DojoBurn) : setError("the burn module didn't load"));
    s.onerror = () => setError("the burn module didn't load — open this page on the Dojo store");
    document.head.appendChild(s);
  }, []);
  return { api, error };
}

// thumbnails through an image proxy: a spam NFT's own host never sees the visitor, and huge files stay small
export const thumb = (u: string) => {
  try {
    const x = new URL(String(u || ""));
    return x.protocol === "https:" ? "https://wsrv.nl/?url=" + encodeURIComponent(x.href) + "&w=240&h=240&fit=cover&output=webp" : "";
  } catch {
    return "";
  }
};

// Dojo Sweep's "🔥 Burn & ⛏ Mine ORE" hands the NFTs ticked there to burn mode through sessionStorage (never the URL).
// Read once, then removed; burn mode keeps only the ones still in the scanned wallet and burnable.
export const BURN2MINE_KEY = "dd:burn2mine";
const PICKS_TTL_MS = 30 * 60 * 1000;
export function takeBurnPicks(): { owner: string; mints: string[] } | null {
  try {
    const raw = sessionStorage.getItem(BURN2MINE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(BURN2MINE_KEY);
    const p = JSON.parse(raw) as { owner?: unknown; mints?: unknown; at?: unknown };
    if (typeof p.owner !== "string" || !Array.isArray(p.mints) || typeof p.at !== "number" || Date.now() - p.at > PICKS_TTL_MS) return null;
    return { owner: p.owner, mints: p.mints.filter((m): m is string => typeof m === "string").slice(0, 500) };
  } catch {
    return null; // storage blocked / bad JSON → nothing pre-selected
  }
}
