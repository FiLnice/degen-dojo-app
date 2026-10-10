"use client";

import { useState } from "react";
import {
  ComputeBudgetProgram,
  Connection,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { useWallet } from "@/lib/wallet-bridge";
import { toast } from "sonner";

/**
 * Builds, simulates, signs and confirms an ORE transaction. Nothing is signed
 * or sent unless the on-chain simulation passes first (no wasted SOL on reverts).
 */
export function useOreSubmit(connection: Connection, refresh: () => Promise<void>) {
  const { publicKey, sendTransaction } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);

  async function submit(label: string, ixs: TransactionInstruction[]) {
    if (!publicKey) return;
    setBusy(label);
    const t = toast.loading(`${label}: simulating…`);
    try {
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }));
      for (const i of ixs) tx.add(i);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        const logs = (sim.value.logs || []).slice(-3).join(" | ");
        throw new Error(`simulation reverted: ${JSON.stringify(sim.value.err)} — ${logs}`);
      }

      toast.loading(`${label}: approve in your wallet…`, { id: t });
      const sig = await sendTransaction(tx, connection);
      toast.loading(`${label}: confirming…`, { id: t });
      // Confirm by polling status (HTTP only — works through the proxy; no websocket).
      const deadline = Date.now() + 45_000;
      for (;;) {
        const { value } = await connection.getSignatureStatus(sig);
        if (value?.err) throw new Error(`transaction failed: ${JSON.stringify(value.err)}`);
        if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") break;
        if (Date.now() > deadline) throw new Error("confirmation timed out — check your wallet history");
        await new Promise((r) => setTimeout(r, 1500));
      }
      toast.success(`${label} confirmed`, { id: t });
      await refresh();
    } catch (e) {
      toast.error(`${label} failed — ${e instanceof Error ? e.message : String(e)}`, { id: t });
    } finally {
      setBusy(null);
    }
  }

  return { busy, submit };
}
