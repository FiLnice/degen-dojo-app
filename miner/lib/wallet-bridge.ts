"use client";

// Wallet bridge: when the miner is embedded in the STORE (store.degendojo.xyz/mine),
// the store injects wallet-picker.js so `window.DojoWalletPicker` exists. This shim
// makes the miner's React use ONE shared wallet session (window.DOJO_WALLET) — connect
// once, connected on every store page — instead of its own wallet-adapter session.
//
// Standalone (mine.degendojo.xyz, no store shell) → falls straight through to the real
// wallet-adapter, unchanged. The store nav itself is rendered by React (StoreNav), so it
// survives Next's hydration; this file owns the wallet plumbing.
import { useCallback, useEffect, useState } from "react";
import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";

type StoreWallet = {
  pubkey?: string;
  publicKey?: string;
  signAndSendTransaction: (tx: Transaction | VersionedTransaction) => Promise<string | { signature: string }>;
  provider?: { disconnect?: () => void | Promise<void> };
};

// Only the fields the miner actually reads. Both the real adapter and the store
// bridge are exposed through this shape so the call sites type-check either way.
type BridgedWallet = {
  publicKey: PublicKey | null;
  connected: boolean;
  embedded?: boolean;
  select?: () => void;
  sendTransaction: (tx: Transaction | VersionedTransaction, ...rest: unknown[]) => Promise<string>;
  disconnect: () => void | Promise<void>;
};

type Win = {
  DOJO_WALLET?: StoreWallet | null;
  DojoWalletPicker?: { pick?: () => Promise<StoreWallet>; autoConnect?: () => Promise<StoreWallet | null> };
};
const w = (): Win => window as unknown as Win;

const storeWallet = (): StoreWallet | null => (typeof window !== "undefined" ? w().DOJO_WALLET ?? null : null);

/** True when running inside the store shell (wallet-picker.js was injected). */
export const isEmbedded = (): boolean => typeof window !== "undefined" && "DojoWalletPicker" in window;

/** Set the shared session + notify every embedded consumer (the miner + any store nav). */
function setStoreWallet(a: StoreWallet | null): void {
  w().DOJO_WALLET = a || null;
  window.dispatchEvent(new Event("dojo-wallet-change"));
}

/** Open the store's shared wallet picker and adopt the chosen wallet as the session. */
export function pickStoreWallet(): void {
  try {
    const p = w().DojoWalletPicker?.pick?.();
    if (p && typeof p.then === "function") p.then((a) => setStoreWallet(a)).catch(() => {});
  } catch {
    /* picker not ready */
  }
}

/**
 * Drop-in for wallet-adapter's useWallet. Embedded → the store's shared wallet;
 * standalone → the real adapter. Bridges only the fields the miner uses.
 */
export function useWallet(): BridgedWallet {
  const adapter = useAdapterWallet();
  const [embedded, setEmbedded] = useState(false);
  const [sw, setSw] = useState<StoreWallet | null>(null);

  useEffect(() => {
    const sync = () => {
      setEmbedded(isEmbedded());
      setSw(storeWallet());
    };
    sync();
    // Adopt the store's existing session if the user already connected elsewhere.
    try {
      const dp = w().DojoWalletPicker;
      if (dp?.autoConnect && !storeWallet()) dp.autoConnect().then((a) => a && setStoreWallet(a)).catch(() => {});
    } catch {
      /* picker not ready yet — the poll below retries */
    }
    window.addEventListener("dojo-wallet-change", sync);
    const id = window.setInterval(sync, 1200); // fallback if the event isn't wired / picker loads late
    return () => {
      window.removeEventListener("dojo-wallet-change", sync);
      window.clearInterval(id);
    };
  }, []);

  const disconnect = useCallback(async () => {
    const s = storeWallet();
    try {
      await s?.provider?.disconnect?.();
    } catch {
      /* ignore */
    }
    setStoreWallet(null);
  }, []);

  if (!embedded) return adapter as unknown as BridgedWallet;

  if (!sw) {
    return {
      publicKey: null,
      connected: false,
      embedded: true,
      select: pickStoreWallet,
      sendTransaction: async () => {
        throw new Error("Connect a wallet first");
      },
      disconnect,
    };
  }

  return {
    publicKey: new PublicKey((sw.pubkey || sw.publicKey) as string),
    connected: true,
    embedded: true,
    select: pickStoreWallet,
    // The miner builds the tx (feePayer + blockhash set) then calls sendTransaction; the
    // store wallet's signAndSendTransaction signs + sends via the wallet's own RPC (the
    // /api/rpc proxy blocks sending — same as the standalone adapter did).
    sendTransaction: async (tx: Transaction | VersionedTransaction) => {
      const r = await sw.signAndSendTransaction(tx);
      return typeof r === "string" ? r : r.signature;
    },
    disconnect,
  };
}
