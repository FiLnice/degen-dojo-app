"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet-bridge";
import { StoreNav } from "@/components/StoreNav";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { ArrowLeft, Loader2 } from "lucide-react";
import { OreIcon } from "@/components/OreIcon";
import { useOreGame } from "@/hooks/useOreGame";
import { useOreSubmit } from "@/hooks/useOreSubmit";
import { claimOreIx, createAtaIdempotentIx } from "@/lib/ore";

const ore = (grams: bigint) => Number(grams) / 1e11;

export default function VaultPage() {
  const { publicKey, connected, embedded, select } = useWallet();
  const { connection, miner, error, refresh } = useOreGame();
  const { busy, submit } = useOreSubmit(connection, refresh);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const claimableOre = miner ? ore(miner.claimableOre) : 0;
  const unrefined = miner ? ore(miner.unrefinedOre) : 0;
  const refined = miner ? ore(miner.refinedOre) : 0;

  const onClaim = () =>
    publicKey &&
    submit("Claim uORE", [createAtaIdempotentIx(publicKey, publicKey), claimOreIx(publicKey)]);

  return (
    <>
      <StoreNav />
      <main className="mine-cave min-h-screen px-5 py-10">
      <div className="mx-auto max-w-lg space-y-6">
        <Link
          href="/mine"
          className="inline-flex items-center gap-1.5 text-sm text-stone-400 hover:text-amber-200"
        >
          <ArrowLeft className="size-4" /> Back to mining
        </Link>

        <header className="space-y-2 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-red-500/50 bg-gradient-to-r from-red-950/60 to-amber-950/50 px-3 py-1 text-xs text-amber-200">
            <OreIcon className="size-3.5" /> uORE Vault
          </div>
          <h1 className="text-2xl font-semibold text-stone-100">Claim your uORE</h1>
          <p className="mx-auto max-w-sm text-sm text-stone-400">
            uORE you&apos;ve mined across rounds settles here.
          </p>
        </header>

        {error && (
          <div className="rounded-md border border-amber-700/40 bg-amber-950/20 p-3 text-xs text-amber-300">
            RPC issue: {error}. Retrying…
          </div>
        )}

        <div className="rounded-xl border border-red-500/50 bg-gradient-to-r from-red-950/60 to-amber-950/50 p-6 text-center">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">You&apos;ll receive</div>
          <div className="mt-1 text-4xl font-bold tabular-nums text-amber-300">
            {claimableOre.toFixed(4)} <span className="text-lg text-stone-400">ORE</span>
          </div>
          <div className="mt-2 text-xs text-stone-500">
            {unrefined.toFixed(4)} uORE × 90% + {refined.toFixed(4)} rORE
          </div>
        </div>

        {!mounted ? (
          <div className="h-12" />
        ) : !connected ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-stone-400">Connect your wallet to view and claim your uORE.</p>
            {embedded ? (
              <button
                onClick={select}
                className="rounded-lg bg-gradient-to-br from-amber-500 to-amber-700 px-5 py-2.5 text-sm font-semibold text-black transition hover:brightness-110"
              >
                Select Wallet
              </button>
            ) : (
              <WalletMultiButton />
            )}
          </div>
        ) : (
          <button
            onClick={onClaim}
            disabled={!!busy || claimableOre <= 0}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-medium transition-colors ${
              busy || claimableOre <= 0
                ? "cursor-not-allowed bg-stone-800 text-stone-500"
                : "bg-gradient-to-br from-amber-500 to-amber-700 font-semibold text-black hover:brightness-110"
            }`}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {claimableOre > 0 ? `Claim ${claimableOre.toFixed(4)} ORE` : "Nothing to claim yet"}
          </button>
        )}

        <p className="text-center text-[11px] text-stone-500">
          Claiming charges a small ORE protocol fee (a 10% cut on unrefined ORE, shared with other miners).
        </p>
      </div>
      </main>
    </>
  );
}
