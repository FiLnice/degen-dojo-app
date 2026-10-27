"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { useWallet } from "@/lib/wallet-bridge";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Pickaxe, Loader2, RefreshCw, LogOut, Info, X } from "lucide-react";
import { OreIcon } from "@/components/OreIcon";
import { StoreNav } from "@/components/StoreNav";
import { useOreGame } from "@/hooks/useOreGame";
import { useOreSubmit } from "@/hooks/useOreSubmit";
import {
  automateIx,
  stopAutomationIx,
  claimSolIx,
  checkpointIx,
  minerNeedsCheckpoint,
  estimateRounds,
  SQUARES,
  EXECUTOR_FEE_LAMPORTS,
  oreTransferIx,
  ataFor,
  ORE_DECIMALS,
} from "@/lib/ore";
import { COLLECTION_NAME, TIP_WALLET, TIP_ENABLED, DEGENS_URL, DEGENS_INLINE_JSON } from "@/lib/config";
import { recordTip, dojoFeeIxs, dojoFeeOf, type TipCurrency } from "@/lib/minerTip";
import { BurnMode } from "./BurnMode";

type GridDegen = { name: string; image: string; mint?: string };

const ALL_SQUARES = Array.from({ length: SQUARES }, () => true);
// SOL/round paid to the permissionless bot that auto-deploys for you (lib/ore.ts — the fee live automations pay)
const EXECUTOR_FEE = Number(EXECUTOR_FEE_LAMPORTS) / LAMPORTS_PER_SOL;
const sol = (lamports: bigint | number) => Number(lamports) / LAMPORTS_PER_SOL;
const ore = (grams: bigint) => Number(grams) / 1e11;
const fmtPct = (p: number) => (p >= 0.1 ? p.toFixed(2) : p.toFixed(4)) + "%";
const solVal = (n: number, dp = 3) => (
  <span className="inline-flex items-center justify-center gap-1">
    {n.toFixed(dp)} <SolIcon className="size-3.5" />
  </span>
);

// ─── Hosted branded miners ───────────────────────────────────────────────────
// The store rewrites /m/<slug> to this page (and ?c=<slug> works anywhere). A hosted miner
// loads its name, tip wallet and 25 NFTs from /api/miner?slug= at runtime; plain /mine is
// the Degen Dojo miner, configured at build time exactly as before.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
function hostedSlugFromLocation(): string | null {
  const m = window.location.pathname.match(/^\/m\/([^/?#]+)\/?$/);
  let raw = m ? m[1] : new URLSearchParams(window.location.search).get("c");
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  return raw.toLowerCase(); // validated by the caller (a bad slug shows "not found")
}
type Hosted = { slug: string; state: "loading" | "ok" | "missing" };
type HostedConfig = { name: string; tipWallet: string; degens: GridDegen[] };

export default function MinePage() {
  const { publicKey, connected, disconnect, embedded } = useWallet();
  const { board, round, lastWinner, miner, automation, motherlode, balance, secondsLeft, phase, error, connection, refresh } =
    useOreGame();
  const { busy, submit } = useOreSubmit(connection, refresh);

  const [mounted, setMounted] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const [degenPool, setDegenPool] = useState<GridDegen[]>([]);
  const [amountStr, setAmountStr] = useState("0.0001");
  const [depositStr, setDepositStr] = useState("0.5");
  const [tipStr, setTipStr] = useState("");
  // Hosted (/m/<slug>) miners swap these at runtime; the default /mine keeps the build-time config.
  const [hosted, setHosted] = useState<Hosted | null>(null);
  const [collectionName, setCollectionName] = useState(COLLECTION_NAME);
  const [tipWallet, setTipWallet] = useState<PublicKey>(TIP_WALLET);
  // The tip can be SOL or ORE. ORE only when the tip wallet already has an ORE account (the Dojo's treasury does;
  // a hosted collection's wallet may not) — we never create accounts for someone else's wallet.
  const [tipCur, setTipCur] = useState<TipCurrency>("SOL");
  const [oreTipOk, setOreTipOk] = useState(false);
  const [oreBal, setOreBal] = useState(0);
  // Burn to Mine is a MODE of this page (the Degen Dojo miner only): the grid becomes the wallet's burnable NFTs.
  // ?burn=1 opens it directly (/mine/burn and Dojo Sweep's "Burn & Mine ORE" land here); the URL follows the mode.
  const [burnMode, setBurnMode] = useState(false);
  const showBurn = (on: boolean) => {
    setBurnMode(on);
    const u = new URL(window.location.href);
    if (on) u.searchParams.set("burn", "1");
    else u.searchParams.delete("burn");
    window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("burn") === "1") void Promise.resolve().then(() => setBurnMode(true));
  }, []);
  useEffect(() => {
    const slug = hostedSlugFromLocation();
    if (slug) {
      setHosted({ slug, state: "loading" });
      if (!SLUG_RE.test(slug)) {
        setHosted({ slug, state: "missing" });
        return;
      }
      let alive = true;
      fetch(`/api/miner?slug=${encodeURIComponent(slug)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          return (await r.json()) as HostedConfig;
        })
        .then((c) => {
          if (!alive) return;
          const pool = Array.isArray(c.degens) ? c.degens.filter((d) => d && typeof d.image === "string") : [];
          const wallet = new PublicKey(c.tipWallet); // throws on a bad address → treated as missing
          if (pool.length < SQUARES) throw new Error("incomplete");
          setCollectionName(c.name || "ORE");
          setTipWallet(wallet);
          setDegenPool(pool);
          document.title = `${c.name || "ORE"} × ORE — Grid Mining`;
          setHosted({ slug, state: "ok" });
        })
        .catch(() => alive && setHosted({ slug, state: "missing" }));
      return () => {
        alive = false;
      };
    }
    if (DEGENS_INLINE_JSON) {
      try {
        setDegenPool(JSON.parse(DEGENS_INLINE_JSON) as GridDegen[]);
        return;
      } catch {
        /* bad JSON — fall through to the URL/file */
      }
    }
    fetch(DEGENS_URL)
      .then((r) => r.json())
      .then((d: GridDegen[]) => setDegenPool(d))
      .catch(() => {});
  }, []);

  const roundId = board?.roundId ?? null;
  // A fixed grid: the first 25 NFTs of the collection config.
  const degens = useMemo(() => degenPool.slice(0, SQUARES), [degenPool]);
  const amount = parseFloat(amountStr) || 0;
  const deposit = parseFloat(depositStr) || 0;
  const tip = parseFloat(tipStr) || 0;

  const pot = round ? sol(round.deployed.reduce((a, b) => a + b, 0n)) : 0;
  const avgPerTile = pot / SQUARES;
  const motherlodeOre = motherlode ? ore(motherlode) : 0;
  const myStake =
    miner && roundId !== null && miner.roundId === roundId
      ? sol(miner.deployed.reduce((a, b) => a + b, 0n))
      : 0;
  // Chance of taking the single uORE this round. The winning tile is random, and only on single-
  // winner rounds (SINGLE_ROUND_SHARE of them) does one miner take it, weighted by their share of
  // that tile. You mine all 25 tiles, so average your share across them: mean(you_i / tile_i) × 40%.
  // Before you deploy, it previews your per-tile amount added on top of each tile.
  const myRoundMiner = myStake > 0 && miner ? miner : null;
  const tileShares = round
    ? round.deployed.map((d, i) => {
        const tile = sol(d);
        if (myRoundMiner) {
          const mine = sol(myRoundMiner.deployed[i] ?? 0n);
          return tile > 0 ? mine / tile : 0;
        }
        return amount > 0 ? amount / (tile + amount) : 0;
      })
    : [];
  const winSingleUOre =
    tileShares.length > 0 ? (tileShares.reduce((a, b) => a + b, 0) / tileShares.length) * SINGLE_ROUND_SHARE * 100 : 0;
  const claimableOre = miner ? ore(miner.claimableOre) : 0;
  const vaultUnrefined = miner ? ore(miner.unrefinedOre) : 0;
  const vaultRefined = miner ? ore(miner.refinedOre) : 0;
  const claimableSol = miner ? sol(miner.rewardsSol) : 0;
  const needsCheckpoint = !!miner && roundId !== null && minerNeedsCheckpoint(miner, roundId);
  const hasLeftoverSol = claimableSol > 0 || needsCheckpoint;
  const walletSol = balance != null ? sol(balance) : null;

  // in lamports, like the automation's own numbers below (estimateRounds counts the executor fee in lamports)
  const estSetupRounds = estimateRounds(Math.floor(deposit * LAMPORTS_PER_SOL), Math.floor(amount * LAMPORTS_PER_SOL));
  const autoBalance = automation ? sol(automation.balance) : 0;
  const autoPerTile = automation ? sol(automation.amount) : 0;
  const estLeftRounds = automation ? estimateRounds(automation.balance, automation.amount) : 0;
  // A hosted miner must have loaded ITS tip wallet before anything can be sent — never the default.
  const hostedReady = !hosted || hosted.state === "ok";
  // ORE tip availability (tip wallet must already hold an ORE account) + the player's own ORE balance
  useEffect(() => {
    let alive = true;
    connection
      .getAccountInfo(ataFor(tipWallet))
      .then((a) => alive && setOreTipOk(!!a))
      .catch(() => alive && setOreTipOk(false));
    return () => {
      alive = false;
    };
  }, [connection, tipWallet]);
  useEffect(() => {
    if (!oreTipOk && tipCur === "ORE") setTipCur("SOL");
  }, [oreTipOk, tipCur]);
  useEffect(() => {
    if (!publicKey) return setOreBal(0);
    let alive = true;
    connection
      .getTokenAccountBalance(ataFor(publicKey))
      .then((b) => alive && setOreBal(Number(b.value.uiAmountString || 0)))
      .catch(() => alive && setOreBal(0));
    return () => {
      alive = false;
    };
  }, [connection, publicKey, busy]);
  // The Degen Dojo miner charges the 1% Dojo fee on the deposit (lib/minerTip); a branded /m/<slug> miner keeps its optional tip.
  const dojoFee = !hosted;
  const feeSol = dojoFee ? dojoFeeOf(Math.floor(deposit * LAMPORTS_PER_SOL)) / LAMPORTS_PER_SOL : 0;
  const oreTipShort = !!hosted && TIP_ENABLED && tipCur === "ORE" && tip > 0 && tip > oreBal;
  // The bot needs one full round (25 tiles) PLUS its fee in the balance — less and ORE's first deploy just closes it.
  const minDeposit = amount * SQUARES + EXECUTOR_FEE;
  const canStartAuto = connected && amount > 0 && deposit >= minDeposit && !busy && hostedReady && !oreTipShort;

  const pending = degens.length < SQUARES;

  async function onStartAuto() {
    if (!publicKey || !hostedReady) return;
    const ixs: TransactionInstruction[] = [
      automateIx({
        signer: publicKey,
        amountLamports: BigInt(Math.floor(amount * LAMPORTS_PER_SOL)),
        depositLamports: BigInt(Math.floor(deposit * LAMPORTS_PER_SOL)),
        feeLamports: EXECUTOR_FEE_LAMPORTS,
        squares: ALL_SQUARES,
        reload: true,
      }),
    ];
    const buyer = publicKey.toBase58();
    if (dojoFee) {
      // the 1% Dojo fee rides in this same Automate transaction (+ the referring preacher's ddref memo), and is logged
      // for the store's minetip ledger exactly like the old tip was
      const fee = dojoFeeIxs(publicKey, Math.floor(deposit * LAMPORTS_PER_SOL), tipWallet);
      ixs.push(...fee.ixs);
      const sig = await submit("Start auto-mining", ixs);
      if (sig && fee.feeLamports > 0) void recordTip(sig, buyer, fee.feeLamports / LAMPORTS_PER_SOL, "SOL");
      return;
    }
    // branded /m/<slug> miner: its optional tip to the collection's own wallet, unchanged
    const oreTip = tipCur === "ORE" && oreTipOk;
    const tipLamports = TIP_ENABLED && tip > 0 && !oreTip ? Math.floor(tip * LAMPORTS_PER_SOL) : 0;
    const tipOreRaw = TIP_ENABLED && tip > 0 && oreTip ? BigInt(Math.round(tip * 10 ** ORE_DECIMALS)) : 0n;
    if (tipLamports > 0 || tipOreRaw > 0n) {
      ixs.push(
        tipOreRaw > 0n
          ? oreTransferIx(publicKey, tipWallet, tipOreRaw) // ORE from the player's ORE account to the tip wallet's
          : SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: tipWallet, lamports: tipLamports }),
      );
      // (no preacher memo: a hosted tip goes to the collection's wallet — nothing of ours to share or record)
    }
    await submit("Start auto-mining", ixs);
  }
  const onStopAuto = () => publicKey && submit("Stop & withdraw", [stopAutomationIx(publicKey)]);
  function onClaimSol() {
    if (!publicKey || !miner) return;
    const ixs: TransactionInstruction[] = [];
    // If the last round wasn't checkpointed (auto-mining depleted), settle it first
    // so the winnings materialise, then claim the SOL — all in one transaction.
    if (needsCheckpoint) ixs.push(checkpointIx({ signer: publicKey, roundId: miner.roundId }));
    ixs.push(claimSolIx(publicKey));
    submit("Claim SOL", ixs);
  }

  if (hosted?.state === "missing") {
    return (
      <>
        <StoreNav />
        <main className="min-h-screen px-5 py-16">
          <div className="mx-auto max-w-md space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-6 text-center">
            <OreIcon className="mx-auto size-8" />
            <h1 className="text-lg font-semibold text-slate-100">Miner not found</h1>
            <p className="text-sm text-slate-400">
              There&apos;s no live miner at <span className="font-mono text-slate-300">/m/{hosted.slug}</span>. It may
              still be awaiting approval, or the link is mistyped.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              {/* Plain <a>: a full load, so the page re-reads the URL (client nav would keep this state). */}
              <a href="/mine" className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500">
                Mine with Degen Dojo
              </a>
              <Link href="/whitelabel" className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">
                Get your own miner
              </Link>
            </div>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <StoreNav />
      <main className="min-h-screen px-5 py-10">
      <div className="mx-auto max-w-5xl space-y-4">
        {error && (
          <div className="rounded-md border border-amber-700/40 bg-amber-950/20 p-3 text-xs text-amber-300">
            RPC issue: {error}. Retrying…
          </div>
        )}

        {burnMode && !hosted ? (
          <BurnMode connection={connection} automation={automation} motherlode={motherlode} busy={busy} submit={submit} onBack={() => showBurn(false)} />
        ) : (
        /* Desktop: Degens left, info + auto-miner right */
        <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_auto_auto_1fr] lg:items-start lg:gap-x-6 lg:gap-y-4 lg:space-y-0">
          {/* Vault link — full width, shows the uORE / ×90% / rORE breakdown */}
          <div className="lg:col-start-2 lg:row-start-1">
            <Link
              href="/mine/vault"
              // the static export writes this nested route's prefetch file under a different name than the client
              // asks for (404 in the console) — a plain navigation needs no prefetch
              prefetch={false}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-sky-600/30 bg-sky-600/10 px-3 py-2 text-sky-300 transition-colors hover:bg-sky-600/20"
            >
              <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                <OreIcon className="size-3.5" /> Vault ↗
              </span>
              <span className="text-right text-[10px] leading-tight text-slate-300">
                {vaultUnrefined.toFixed(2)} uORE · {vaultRefined.toFixed(2)} rORE
              </span>
            </Link>
          </div>

          {/* Stat boxes — 3 × 2 */}
          <div className="grid grid-cols-3 gap-3 text-center lg:col-start-2 lg:row-start-2">
            <Stat label="Motherlode" value={`${motherlodeOre.toFixed(2)} uORE`} accent="gold" />
            <Stat label="Total Deploy" value={solVal(pot, 3)} />
            <Stat label="Avg Deploy" value={solVal(avgPerTile, 4)} />
            <Stat label="Your Deploy" value={solVal(myStake, 4)} />
            <Stat
              label="Chance of winning a single uORE"
              value={!connected ? "0%" : avgPerTile > 0 ? fmtPct(winSingleUOre) : "—"}
              accent="emerald"
              sub="40% of rounds give a single uORE"
            />
            <Stat
              label="Mining Round Time"
              value={secondsLeft > 0 ? `${secondsLeft}s` : phase === "starting" ? "starting…" : board ? "resolving…" : "—"}
              accent="amber"
            />
          </div>

          {/* The 5×5 Degen grid (display only — you always mine all 25) */}
          <div className="grid grid-cols-5 gap-2 sm:gap-2.5 lg:col-start-1 lg:row-span-4 lg:row-start-1 lg:self-start">
            {pending
              ? Array.from({ length: SQUARES }).map((_, i) => (
                  <div key={i} className="aspect-square animate-pulse rounded-lg bg-slate-900/60" />
                ))
              : degens.map((d, i) => {
                  const isWinner = lastWinner === i;
                  const sqSol = round ? sol(round.deployed[i]) : 0;
                  const sqMiners = round ? round.miners[i] : 0;
                  return (
                    <div
                      key={d.mint || i}
                      title={`${d.name} — ${sqSol.toFixed(3)} SOL · ${sqMiners} miners`}
                      className={`group relative aspect-square overflow-hidden rounded-lg bg-slate-900 ring-1 transition-all duration-300 ${
                        isWinner
                          ? "z-10 ring-2 ring-amber-400 shadow-[0_0_22px_rgba(251,191,36,0.55)]"
                          : "ring-slate-800"
                      }`}
                    >
                      <Image
                        src={d.image}
                        alt={d.name}
                        fill
                        sizes="(max-width: 640px) 20vw, 130px"
                        className="object-cover transition-all duration-300"
                      />

                      {isWinner && (
                        <div className="pointer-events-none absolute inset-0 animate-pulse">
                          <div
                            className="absolute inset-[-35%] animate-[spin_9s_linear_infinite] opacity-45 mix-blend-screen"
                            style={{
                              background:
                                "repeating-conic-gradient(from 0deg at 50% 50%, rgba(239,68,68,0.9) 0deg 7deg, transparent 7deg 18deg)",
                            }}
                          />
                        </div>
                      )}

                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/80 to-transparent px-1 pt-3 pb-0.5 text-[9px] font-medium text-slate-100">
                        <span className="inline-flex items-center gap-0.5 tabular-nums">
                          {sqSol.toFixed(2)}
                          <SolIcon className="size-2" />
                        </span>
                        <span className="tabular-nums text-slate-300">{sqMiners}⛏</span>
                      </div>
                    </div>
                  );
                })}
          </div>

          {/* Auto-miner (only mining mode) */}
          <div className="lg:col-start-2 lg:row-start-3">
            {!mounted ? (
              <div className="h-24" />
            ) : !connected ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                {embedded ? (
                  // Inside the store, StoreNav already renders a Connect button (top-right).
                  // Avoid a second wallet button so mobile doesn't show "connect" twice.
                  <p className="text-sm text-slate-400 text-center">
                    Connect your wallet using the <span className="text-amber-400 font-semibold">Connect wallet</span> button at the top to auto-mine.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-slate-400">Connect your wallet to auto-mine.</p>
                    <WalletMultiButton />
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                {automation?.active ? (
                  <>
                    <div className="space-y-1 rounded-md bg-slate-950/60 p-3 text-xs">
                      <Row label="Status" value={<span className="text-emerald-300">Auto-mining ✓</span>} />
                      <Row
                        label="Per tile"
                        value={
                          <>
                            {autoPerTile} <SolIcon className="inline size-3" /> × 25
                          </>
                        }
                      />
                      <Row
                        label="Balance left"
                        value={
                          <>
                            {autoBalance.toFixed(5)} <SolIcon className="inline size-3" />
                          </>
                        }
                      />
                      <Row label="Est. rounds left" value={`~${estLeftRounds}`} />
                      <Row label="Auto-reload" value={automation.reload ? "on" : "off"} />
                    </div>
                    <ActionButton
                      variant="outline"
                      onClick={onStopAuto}
                      busy={busy === "Stop & withdraw"}
                      disabled={!!busy}
                    >
                      Stop &amp; withdraw {autoBalance.toFixed(5)} <SolIcon className="size-3.5" />
                    </ActionButton>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between rounded bg-slate-950/60 px-3 py-2 text-xs">
                      <span className="text-slate-400">Wallet balance</span>
                      <span className="inline-flex items-center gap-1 font-medium text-slate-100">
                        {walletSol != null ? walletSol.toFixed(4) : "…"} <SolIcon className="size-3" />
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs text-slate-400">SOL / tile</label>
                      <input
                        value={amountStr}
                        onChange={(e) => setAmountStr(e.target.value)}
                        inputMode="decimal"
                        className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-right text-sm text-slate-100 tabular-nums outline-none focus:border-sky-500"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs text-slate-400">
                        Deposit <SolIcon className="inline size-3" />
                      </label>
                      <input
                        value={depositStr}
                        onChange={(e) => setDepositStr(e.target.value)}
                        inputMode="decimal"
                        className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-right text-sm text-slate-100 tabular-nums outline-none focus:border-sky-500"
                      />
                    </div>
                    <div className="flex items-center justify-between rounded bg-slate-950/60 px-3 py-2 text-xs">
                      <span className="text-slate-400">Est. rounds</span>
                      <span className="font-semibold text-emerald-300">~{estSetupRounds}</span>
                    </div>
                    {dojoFee && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between rounded bg-slate-950/60 px-3 py-2 text-xs">
                          <span className="text-slate-400">Dojo fee 1%</span>
                          <span className="inline-flex items-center gap-1 font-medium text-slate-200">
                            {feeSol.toFixed(6)} <SolIcon className="size-3" />
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500">1% Dojo fee — same as ORE takes. Paid only when it works.</p>
                      </div>
                    )}
                    {!dojoFee && TIP_ENABLED && (
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-xs text-slate-400">Tip {collectionName} (optional)</label>
                        <div className="flex items-center gap-1.5">
                          {oreTipOk && (
                            <div className="flex overflow-hidden rounded border border-slate-700 text-[11px]" role="group" aria-label="Tip currency">
                              {(["SOL", "ORE"] as const).map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  onClick={() => setTipCur(c)}
                                  aria-pressed={tipCur === c}
                                  className={`px-2 py-1 font-semibold ${tipCur === c ? "bg-sky-600/30 text-sky-200" : "text-slate-400 hover:text-slate-200"}`}
                                >
                                  {c}
                                </button>
                              ))}
                            </div>
                          )}
                          <input
                            value={tipStr}
                            onChange={(e) => setTipStr(e.target.value)}
                            inputMode="decimal"
                            placeholder="0"
                            aria-label={`Tip in ${tipCur}`}
                            className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-right text-sm text-slate-100 tabular-nums outline-none focus:border-sky-500"
                          />
                        </div>
                      </div>
                    )}
                    {oreTipShort && (
                      <p className="text-right text-[11px] text-amber-300">Not enough ORE for this tip (you have {oreBal.toFixed(4)} ORE)</p>
                    )}
                    <ActionButton onClick={onStartAuto} busy={busy === "Start auto-mining"} disabled={!canStartAuto}>
                      <Pickaxe className="size-4" />
                      {amount <= 0
                        ? "Enter SOL per tile"
                        : deposit < minDeposit
                          ? `Deposit ≥ ${(Math.ceil(minDeposit * 1e6) / 1e6).toFixed(6)} SOL (1 round + bot fee)`
                          : (
                              dojoFee ? (
                                <>
                                  Start auto-mining ({(deposit + feeSol).toFixed(4)} <SolIcon className="size-3.5" />)
                                </>
                              ) : tipCur === "ORE" && oreTipOk && tip > 0 ? (
                                <>
                                  Start auto-mining ({deposit.toFixed(4)} <SolIcon className="size-3.5" /> + {tip.toFixed(4)}{" "}
                                  <OreIcon className="size-3.5" />)
                                </>
                              ) : (
                                <>
                                  Start auto-mining ({(deposit + tip).toFixed(4)}{" "}
                                  <SolIcon className="size-3.5" />)
                                </>
                              )
                            )}
                    </ActionButton>
                    {hasLeftoverSol && (
                      <ActionButton
                        variant="outline"
                        onClick={onClaimSol}
                        busy={busy === "Claim SOL"}
                        disabled={!!busy}
                      >
                        {claimableSol > 0 ? (
                          <>
                            Claim leftover SOL ({claimableSol.toFixed(5)} <SolIcon className="size-3.5" />)
                          </>
                        ) : (
                          "Collect leftover SOL"
                        )}
                      </ActionButton>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="pt-1 lg:col-start-2 lg:row-start-4">
            {!hosted && (
              <button
                type="button"
                onClick={() => showBurn(true)}
                className="mb-2 flex w-full flex-col items-center rounded-lg border border-red-500/50 bg-gradient-to-r from-red-950/60 to-amber-950/50 px-3 py-2.5 text-amber-200 transition-colors hover:from-red-900/60 hover:to-amber-900/50"
              >
                <span className="text-sm font-semibold">🔥 Burn to Mine</span>
                <span className="text-[11px] text-slate-400">burn NFTs you don&apos;t want, mine ORE with the SOL</span>
              </button>
            )}
            {/* One even 2×2 grid: every button the same size, the collection CTA first. */}
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500">
              <Link href="/whitelabel" prefetch={false} className={`${FOOT_BTN} border-amber-600/60 bg-amber-950/30 text-amber-300 hover:bg-amber-900/40`}>
                <Pickaxe className="size-3.5 shrink-0" /> add your collection on the grid
              </Link>
              <button onClick={() => setShowHow(true)} className={`${FOOT_BTN} border-slate-800 bg-slate-900/40 hover:bg-slate-800 hover:text-slate-300`}>
                <Info className="size-3.5 shrink-0" /> how it works
              </button>
              <button onClick={refresh} className={`${FOOT_BTN} border-slate-800 bg-slate-900/40 hover:bg-slate-800 hover:text-slate-300`}>
                <RefreshCw className="size-3.5 shrink-0" /> refresh
              </button>
              {connected && (
                <button onClick={() => disconnect()} className={`${FOOT_BTN} border-slate-800 bg-slate-900/40 hover:bg-slate-800 hover:text-slate-300`}>
                  <LogOut className="size-3.5 shrink-0" /> disconnect
                </button>
              )}
            </div>
          </div>
        </div>
        )}
      </div>
      <HowItWorksModal open={showHow} onClose={() => setShowHow(false)} />
      </main>
    </>
  );
}

function HowStep({ n, t, d }: { n: number; t: string; d: string }) {
  return (
    <div className="flex gap-3">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-600/20 text-xs font-bold text-amber-300">
        {n}
      </div>
      <div>
        <div className="text-sm font-medium text-slate-200">{t}</div>
        <div className="text-xs leading-relaxed text-slate-400">{d}</div>
      </div>
    </div>
  );
}

function HowItWorksModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-5"
      >
        <div className="flex items-center gap-2">
          <Info className="size-4 text-amber-400" />
          <h2 className="text-sm font-medium text-slate-100">How mining works</h2>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-slate-200">
            <X className="size-4" />
          </button>
        </div>
        <HowStep n={1} t="It's a 25-tile grid" d="ORE mining is a fixed 5×5 board — always 25 tiles. Each one here is a Degen." />
        <HowStep n={2} t="You deploy SOL on every tile" d="Pick an amount per tile; it stakes that on all 25. e.g. 0.0001 × 25 = 0.0025 SOL." />
        <HowStep n={3} t="Every ~2 min, one tile wins" d="Whoever staked the winning tile mines the round's fresh uORE (one miner takes it, or it's split) — plus the Motherlode when it hits. Your SOL comes back, minus ORE's fees: 1% on every tile, and 10% on the tiles that lost." />
        <HowStep n={4} t="Your uORE stacks in the Vault" d="Claim it to your wallet whenever you like." />
        <HowStep n={5} t="Auto-mine plays for you" d="Fund a balance and it enters every round until it runs low. Stop & withdraw pulls the rest back out." />
        <p className="rounded bg-slate-950/60 px-3 py-2 text-xs text-slate-500">
          Each round costs roughly a tenth of what you stake, and only 1 of 25 tiles mines ORE — so you can lose SOL. That&apos;s the game.
        </p>
      </div>
    </div>
  );
}

type Accent = "amber" | "emerald" | "violet" | "sky" | "gold";
const ACCENT: Record<Accent | "default", string> = {
  amber: "text-amber-300",
  emerald: "text-emerald-300",
  violet: "text-violet-300",
  sky: "text-sky-300",
  gold: "text-amber-400",
  default: "text-slate-100",
};

/** Solana logo mark; inherits the surrounding text colour. */
function SolIcon({ className = "inline size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 397.7 311.7" className={className} fill="currentColor" aria-hidden="true">
      <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
      <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
      <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
    </svg>
  );
}

function Stat({
  label,
  value,
  accent,
  hint,
  sub,
}: {
  label: string;
  value: ReactNode;
  accent?: Accent;
  hint?: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-slate-800 bg-slate-900/50 p-3" title={hint}>
      <div className="text-[10px] uppercase leading-tight tracking-wide text-slate-500">{label}</div>
      <div className={`mt-auto text-base font-semibold tabular-nums sm:text-lg ${ACCENT[accent ?? "default"]}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[8px] leading-tight text-slate-600">{sub}</div>}
    </div>
  );
}

// Share of rounds whose +1 uORE goes to a single winner (the rest split it) — matches the
// "40% of rounds give a single uORE" note on the stat box (the other 60% split it).
const SINGLE_ROUND_SHARE = 0.4;

const FOOT_BTN =
  "inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-lg border px-3 text-center leading-tight transition-colors";

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-200">{value}</span>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  busy,
  disabled,
  variant = "primary",
}: {
  children: ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "outline";
}) {
  const enabled =
    variant === "outline"
      ? "border border-slate-700 text-slate-200 hover:bg-slate-800"
      : "bg-amber-600 text-white hover:bg-amber-500";
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
        disabled || busy ? "cursor-not-allowed bg-slate-800 text-slate-500" : enabled
      }`}
    >
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}
