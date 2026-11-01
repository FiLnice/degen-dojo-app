"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { LAMPORTS_PER_SOL, type TransactionInstruction } from "@solana/web3.js";
import { useWallet } from "@/lib/wallet-bridge";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Pickaxe, Loader2, RefreshCw, LogOut, Info, Wand2, X } from "lucide-react";
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
  STRATEGY_RANDOM,
} from "@/lib/ore";
import { SolIcon } from "@/components/SolIcon";
import { TIP_WALLET, DEGENS_URL, DEGENS_INLINE_JSON } from "@/lib/config";
import { recordTip, dojoFeeIxs, dojoFeeOf } from "@/lib/minerTip";
import { estimateRun, PRESETS, PRESET_MAX_MOTHERLODE, SOLO_TILES, SPLIT_TILES, NO_MOTHERLODE_LIMIT, type Preset } from "@/lib/mineEstimate";
import { BurnMode } from "./BurnMode";

type GridDegen = { name: string; image: string; mint?: string };

const ALL_SQUARES = Array.from({ length: SQUARES }, () => true);
// SOL/round paid to the permissionless bot that auto-deploys for you (lib/ore.ts — the fee live automations pay)
const EXECUTOR_FEE = Number(EXECUTOR_FEE_LAMPORTS) / LAMPORTS_PER_SOL;
const sol = (lamports: bigint | number) => Number(lamports) / LAMPORTS_PER_SOL;
const ore = (grams: bigint) => Number(grams) / 1e11;
const fmtPct = (p: number) => (p >= 0.1 ? p.toFixed(2) : p.toFixed(4)) + "%";
// The estimate's numbers: two figures at most, so they don't look more exact than they are.
const fmtEst = (n: number) => String(Number(n.toPrecision(2)));
const fmtOdds = (p: number) => (p < 0.001 ? "<0.1%" : p < 0.1 ? `${(p * 100).toFixed(1)}%` : `${Math.min(99, Math.round(p * 100))}%`);
const fmtSol = (lamports: number) => String(Number((lamports / LAMPORTS_PER_SOL).toFixed(6)));
const fmtTime = (s: number) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);
const solVal = (n: number, dp = 3) => (
  <span className="inline-flex items-center justify-center gap-1">
    {n.toFixed(dp)} <SolIcon className="size-3.5" />
  </span>
);
// small stakes need all five decimals (0.00011): no trailing zeros, and the unit named on the line
const deployLine = (n: number, unit: string) => (
  <div className="flex items-baseline justify-center gap-1 whitespace-nowrap text-xs leading-tight">
    {Number(n.toFixed(5))} <span className="text-[9px] font-normal text-stone-400">{unit}</span>
  </div>
);

// ─── Hosted branded miners ───────────────────────────────────────────────────
// The store rewrites /m/<slug> to this page (and ?c=<slug> works anywhere). A hosted miner
// loads its name and 25 NFTs from /api/miner?slug= at runtime; plain /mine is
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
type HostedConfig = { name: string; degens: GridDegen[] };

/** A branded miner has no top bar, so it carries its own Connect. Framed on a collection's site, Connect opens the full page:
 *  Phantom doesn't load inside frames and phone wallets can't be relied on there, so a new tab works for every wallet. */
function BrandedConnect({ onConnect }: { onConnect?: () => void }) {
  const framed = window.self !== window.top;
  const button = "rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500";
  return (
    <>
      <p className="text-sm text-stone-400">Connect your wallet to auto-mine.</p>
      {framed ? (
        <a href={window.location.href} target="_blank" rel="noopener" className={button}>
          Connect wallet
        </a>
      ) : (
        <button onClick={onConnect} className={button}>
          Connect wallet
        </button>
      )}
    </>
  );
}

/** The miner. previewDegens (/create) = the page as a branded miner will look, live round and all, with those NFTs on the
 *  grid (none yet: the default grid). Display only: nothing can be sent from it. header/footer sit above and below it. */
export function MineScreen({ previewDegens, header, footer }: { previewDegens?: GridDegen[]; header?: ReactNode; footer?: ReactNode }) {
  const preview = !!previewDegens;
  const { publicKey, connected, disconnect, embedded, select } = useWallet();
  const { board, round, prevRound, lastWinner, slotMs, miner, automation, motherlode, balance, secondsLeft, phase, error, connection, refresh } =
    useOreGame();
  const { busy, submit } = useOreSubmit(connection, refresh);

  const [mounted, setMounted] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const [degenPool, setDegenPool] = useState<GridDegen[]>([]);
  const [amountStr, setAmountStr] = useState("0.0001");
  const [depositStr, setDepositStr] = useState("1");
  // Shorter and Longer are fixed: all 25 tiles, up to a 140 Motherlode. Custom opens the per-tile setting, the tiles and the Motherlode range.
  const [mode, setMode] = useState<Preset | "custom">("shorter");
  const [soloStr, setSoloStr] = useState(String(SOLO_TILES));
  const [splitStr, setSplitStr] = useState(String(SPLIT_TILES));
  const [minMotherlodeStr, setMinMotherlodeStr] = useState("0");
  const [maxMotherlodeStr, setMaxMotherlodeStr] = useState(String(PRESET_MAX_MOTHERLODE));
  // Hosted (/m/<slug>) miners swap their art in at runtime; the default /mine keeps the build-time config.
  const [hosted, setHosted] = useState<Hosted | null>(preview ? { slug: "preview", state: "ok" } : null);
  const [hostedName, setHostedName] = useState("");
  // A collection's own miner carries no Degen Dojo menu or links: it can sit on the collection's own website (owner 2026-10-30).
  const branded = !!hosted && !preview;
  // ?bg=RRGGBB: the colour behind a branded miner, so an embed can match the collection's website (/create builds the link).
  const [pageBg, setPageBg] = useState<string | undefined>();
  useEffect(() => {
    if (!branded) return;
    const bg = new URLSearchParams(window.location.search).get("bg");
    if (bg && /^[0-9a-f]{6}$/i.test(bg)) setPageBg(`#${bg}`);
  }, [branded]);
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
    const slug = preview ? null : hostedSlugFromLocation();
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
          if (pool.length < SQUARES) throw new Error("incomplete");
          setDegenPool(pool);
          setHostedName(c.name || "ORE");
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
  // Next writes the build-time <title> back after hydrating, so a hosted miner's name is put back whenever the head changes.
  useEffect(() => {
    if (!hostedName) return;
    const title = `${hostedName} × ORE — Grid Mining`;
    const keep = () => {
      if (document.title !== title) document.title = title;
    };
    keep();
    const head = new MutationObserver(keep);
    head.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => head.disconnect();
  }, [hostedName]);

  const roundId = board?.roundId ?? null;
  // A fixed grid: the first 25 NFTs of the collection config.
  const degens = useMemo(() => (previewDegens?.length ? previewDegens : degenPool).slice(0, SQUARES), [previewDegens, degenPool]);
  const deposit = parseFloat(depositStr) || 0;
  const depositLamports = Math.floor(deposit * LAMPORTS_PER_SOL);
  const perTileLamports = mode === "custom" ? Math.floor((parseFloat(amountStr) || 0) * LAMPORTS_PER_SOL) : PRESETS[mode];
  const amount = perTileLamports / LAMPORTS_PER_SOL;
  const presetRun = mode !== "custom";
  const soloTiles = presetRun ? SOLO_TILES : Number(soloStr);
  const splitTiles = presetRun ? SPLIT_TILES : Number(splitStr);
  const minedTiles = soloTiles + splitTiles;
  const minMotherlode = presetRun ? 0 : Number(minMotherlodeStr);
  // Max 0 = no limit, as on the ORE Wizard. Below ORE's own default a limit is real.
  const maxMotherlode = presetRun ? PRESET_MAX_MOTHERLODE : Number(maxMotherlodeStr) || NO_MOTHERLODE_LIMIT;
  const goodRange = minMotherlode < maxMotherlode;

  const pot = round ? sol(round.deployed.reduce((a, b) => a + b, 0n)) : 0;
  const avgPerTile = pot / SQUARES;
  const motherlodeOre = motherlode ? ore(motherlode) : 0;
  const myDeployed = miner && roundId !== null && miner.roundId === roundId ? miner.deployed.filter((d) => d > 0n) : [];
  const myStake = sol(myDeployed.reduce((a, b) => a + b, 0n));
  const myPerTile = myDeployed.length ? myStake / myDeployed.length : 0;
  // Chance of taking the single uORE this round. The winning tile is random, and only on single-
  // winner rounds (SINGLE_ROUND_SHARE of them) does one miner take it, weighted by their share of
  // that tile. So average your share across your tiles, × how many of them are solo tiles of the 25.
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
  const heldTiles = myRoundMiner ? myDeployed.length : SQUARES;
  const pickedTiles = !!automation && automation.soloTiles + automation.splitTiles > 0;
  const soloHeld = !myRoundMiner ? soloTiles : pickedTiles ? automation.soloTiles : heldTiles * SINGLE_ROUND_SHARE;
  const winSingleUOre = tileShares.length > 0 ? (tileShares.reduce((a, b) => a + b, 0) / heldTiles) * (soloHeld / SQUARES) * 100 : 0;
  const claimableOre = miner ? ore(miner.claimableOre) : 0;
  const vaultUnrefined = miner ? ore(miner.unrefinedOre) : 0;
  const vaultRefined = miner ? ore(miner.refinedOre) : 0;
  const claimableSol = miner ? sol(miner.rewardsSol) : 0;
  const needsCheckpoint = !!miner && roundId !== null && minerNeedsCheckpoint(miner, roundId);
  const hasLeftoverSol = claimableSol > 0 || needsCheckpoint;
  const walletSol = balance != null ? sol(balance) : null;

  // The live estimate reads the fuller of the last two rounds: a new round starts near empty and fills up.
  const overLimit = goodRange && motherlodeOre > maxMotherlode;
  const underLimit = goodRange && !!motherlode && motherlodeOre < minMotherlode;
  const prevPot = prevRound ? sol(prevRound.deployed.reduce((a, b) => a + b, 0n)) : 0;
  const run = estimateRun({
    depositLamports,
    perTileLamports,
    tiles: (prevPot >= pot ? prevRound?.deployed : round?.deployed) ?? [],
    motherlodeOre,
    soloTiles,
    splitTiles,
    minMotherlode,
    maxMotherlode,
    slotMs,
  });
  const autoBalance = automation ? sol(automation.balance) : 0;
  const autoPerTile = automation ? sol(automation.amount) : 0;
  const estLeftRounds = automation ? estimateRounds(automation.balance, automation.amount, automation.fee || undefined, automation.tiles) : 0;
  const autoTilesLabel = !automation ? "" : automation.soloTiles && !automation.splitTiles ? `${automation.tiles} solo` : automation.splitTiles && !automation.soloTiles ? `${automation.tiles} split` : automation.soloTiles ? `${automation.soloTiles} solo + ${automation.splitTiles} split` : String(automation.tiles);
  const autoAboveLimit = !!automation && motherlodeOre > automation.maxMotherlode;
  const autoBelowLimit = !!automation && !!motherlode && motherlodeOre < automation.minMotherlode;
  const formColumn = !automation?.active || preview;
  // A hosted miner's own page must have loaded before anything can be sent.
  const hostedReady = !hosted || hosted.state === "ok";
  // The 1% Dojo fee on the deposit (lib/minerTip): every miner pays it, branded /m/<slug> ones too (owner 2026-10-30).
  const feeSol = dojoFeeOf(depositLamports) / LAMPORTS_PER_SOL;
  // The bot needs one full round (every tile mined) PLUS its fee in the balance — less and ORE's first deploy just closes it.
  const minDeposit = amount * minedTiles + EXECUTOR_FEE;
  const walletShort = walletSol != null && deposit + feeSol > walletSol;
  const canStartAuto = !preview && connected && amount > 0 && minedTiles > 0 && goodRange && deposit >= minDeposit && !walletShort && !busy && hostedReady;

  const pending = degens.length < SQUARES;

  async function onStartAuto() {
    if (!publicKey || !hostedReady || preview) return;
    // ORE picks solo and split tiles only on its Random strategy, and it takes the first round's tiles from the mask, so the mask
    // holds the same count (71 of 71 live miners set this way, 2026-11-01). All 25 needs neither.
    const pickTiles = minedTiles < SQUARES;
    const ixs: TransactionInstruction[] = [
      automateIx({
        signer: publicKey,
        amountLamports: BigInt(perTileLamports),
        depositLamports: BigInt(depositLamports),
        feeLamports: EXECUTOR_FEE_LAMPORTS,
        squares: pickTiles ? ALL_SQUARES.map((_, i) => i < minedTiles) : ALL_SQUARES,
        reload: true,
        strategy: pickTiles ? STRATEGY_RANDOM : undefined,
        conditions: { minMotherlode, maxMotherlode, ...(pickTiles ? { soloTiles, splitTiles } : {}) },
      }),
    ];
    const buyer = publicKey.toBase58();
    // the 1% Dojo fee rides in this same Automate transaction (+ the referring preacher's ddref memo), and is logged
    // for the store's minetip ledger exactly like the old tip was
    const fee = dojoFeeIxs(publicKey, depositLamports, TIP_WALLET);
    ixs.push(...fee.ixs);
    const sig = await submit("Start auto-mining", ixs);
    if (sig && fee.feeLamports > 0) void recordTip(sig, buyer, fee.feeLamports / LAMPORTS_PER_SOL, "SOL");
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
      <main className="min-h-screen px-5 py-16">
        <div className="mx-auto max-w-md space-y-4 rounded-xl border border-stone-800 bg-stone-900/40 p-6 text-center">
          <OreIcon className="mx-auto size-8" />
          <h1 className="text-lg font-semibold text-stone-100">Miner not found</h1>
          <p className="text-sm text-stone-400">
            There&apos;s no live miner at <span className="font-mono text-stone-300">/m/{hosted.slug}</span>. It may
            still be awaiting approval, or the link is mistyped.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            {/* New tabs: this page may be framed on another site, and these two refuse to load in a frame. */}
            <a href="/mine" target="_blank" rel="noopener" className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500">
              Mine with Degen Dojo
            </a>
            <a href="/whitelabel" target="_blank" rel="noopener" className="rounded-lg border border-stone-700 px-4 py-2 text-sm text-stone-200 hover:bg-stone-800">
              Get your own miner
            </a>
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      {!branded && <StoreNav />}
      <main className="mine-cave min-h-screen px-5 py-6 lg:min-h-[calc(100dvh-70px)] lg:py-3" style={pageBg ? { background: pageBg } : undefined}>
      <div className={`mx-auto max-w-5xl space-y-4 ${burnMode ? "xl:max-w-6xl" : "xl:max-w-none"}`}>
        {header}
        {error && (
          <div className="rounded-md border border-amber-700/40 bg-amber-950/20 p-3 text-xs text-amber-300">
            RPC issue: {error}. Retrying…
          </div>
        )}

        {burnMode && !hosted ? (
          <BurnMode connection={connection} automation={automation} motherlode={motherlode} miner={miner} busy={busy} submit={submit} onBack={() => showBurn(false)} />
        ) : (
        /* Desktop: Degens left, info + auto-miner right. From xl the setup form takes its own column so the page fits with no scroll;
           a running miner's status is short enough to stay in the info column, just above Burn to Mine. */
        <div className={`space-y-4 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[auto_auto_auto_1fr] lg:items-start lg:gap-x-5 lg:gap-y-2 lg:space-y-0 xl:justify-center ${formColumn ? "xl:grid-cols-[auto_340px_340px] xl:grid-rows-[auto_auto_1fr]" : "xl:grid-cols-[auto_380px]"}`}>
          {/* Vault link — full width, shows the uORE / ×90% / rORE breakdown */}
          <div className="lg:col-start-2 lg:row-start-1">
            <Link
              // a branded miner's holders claim in their own tab (the vault can't load in a frame), with no Degen Dojo menu
              href={branded ? `/mine/vault?c=${encodeURIComponent(hosted?.slug ?? "")}` : "/mine/vault"}
              target={branded ? "_blank" : undefined}
              // the static export writes this nested route's prefetch file under a different name than the client
              // asks for (404 in the console) — a plain navigation needs no prefetch
              prefetch={false}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-red-500/50 bg-gradient-to-r from-red-950/60 to-amber-950/50 px-3 py-2 text-amber-200 transition-colors hover:from-red-900/60 hover:to-amber-900/50"
            >
              <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                <OreIcon className="size-3.5" /> Vault ↗
              </span>
              <span className="text-right text-[10px] leading-tight text-amber-100/80">
                {vaultUnrefined.toFixed(2)} uORE · {vaultRefined.toFixed(2)} rORE
              </span>
            </Link>
          </div>

          {/* Stat boxes — 3 × 2 */}
          <div className="grid grid-cols-3 gap-3 text-center lg:col-start-2 lg:row-start-2 lg:gap-2">
            <Stat label="Motherlode" value={<span className="whitespace-nowrap text-sm">{motherlodeOre.toFixed(2)} uORE</span>} accent="gold" />
            <Stat label="Total Deploy" value={solVal(pot, 3)} />
            <Stat label="Avg Deploy" value={solVal(avgPerTile, 4)} />
            <Stat
              label="Your Deploy"
              value={
                <>
                  {deployLine(myPerTile, "per tile")}
                  {deployLine(myStake, "total")}
                </>
              }
            />
            <Stat
              label="Chance of winning a single uORE"
              value={!connected ? "0%" : avgPerTile > 0 ? fmtPct(winSingleUOre) : "—"}
              sub="40% of rounds give a single uORE"
            />
            <Stat
              label="Mining Round Time"
              value={secondsLeft > 0 ? `${secondsLeft}s` : phase === "starting" ? "starting…" : board ? "resolving…" : "—"}
            />
          </div>

          {/* The 5×5 Degen grid (display only) */}
          <div className={`mine-frame mx-auto w-full lg:col-start-1 lg:row-span-4 lg:row-start-1 lg:w-[min(100%,calc(100dvh-6rem))] lg:self-start ${formColumn ? "xl:row-span-3 xl:w-[min(calc(100vw-47rem),calc(100dvh-6rem))]" : "xl:w-[min(calc(100vw-30rem),calc(100dvh-6rem))]"}`}>
          <div className="mine-shaft grid grid-cols-5 gap-1 sm:gap-2">
            {pending
              ? Array.from({ length: SQUARES }).map((_, i) => (
                  <div key={i} className="aspect-square animate-pulse rounded-lg bg-stone-900/60" />
                ))
              : degens.map((d, i) => {
                  const isWinner = lastWinner === i;
                  const sqSol = round ? sol(round.deployed[i]) : 0;
                  const sqMiners = round ? round.miners[i] : 0;
                  return (
                    <div
                      key={d.mint || i}
                      title={`${d.name} — ${sqSol.toFixed(3)} SOL · ${sqMiners} miners`}
                      className={`group relative aspect-square overflow-hidden rounded-lg bg-stone-900 ring-1 transition-all duration-300 ${
                        isWinner
                          ? "z-10 ring-2 ring-amber-400 shadow-[0_0_22px_rgba(251,191,36,0.55)]"
                          : "ring-stone-800"
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

                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/80 to-transparent px-0.5 pt-3 pb-0.5 text-[9px] font-medium sm:px-1 text-stone-100">
                        <span className="inline-flex items-center gap-0.5 tabular-nums">
                          {sqSol.toFixed(2)}
                          <SolIcon className="size-2" />
                        </span>
                        <span className="tabular-nums text-stone-300">{sqMiners}⛏</span>
                      </div>
                    </div>
                  );
                })}
          </div>
          </div>

          {/* Auto-miner (only mining mode) */}
          <div className={`lg:col-start-2 lg:row-start-3 ${formColumn ? "xl:col-start-3 xl:row-span-3 xl:row-start-1" : ""}`}>
            {!mounted ? (
              <div className="h-24" />
            ) : (
              <div className="space-y-3 rounded-lg border border-stone-800 bg-stone-900/40 p-4 lg:space-y-2 lg:p-2">
                {automation?.active && !preview ? (
                  <>
                    <div className="space-y-1 rounded-md bg-stone-950/60 p-3 text-xs">
                      <Row
                        label="Status"
                        value={
                          autoAboveLimit ? (
                            <span className="font-semibold text-stone-300">Waiting for the Motherlode to hit</span>
                          ) : autoBelowLimit ? (
                            <span className="font-semibold text-stone-300">Waiting for the Motherlode to grow</span>
                          ) : (
                            <span className="font-semibold text-amber-300">Auto-mining ✓</span>
                          )
                        }
                      />
                      <Row
                        label="Per tile"
                        value={
                          <>
                            {autoPerTile} <SolIcon className="inline size-3" /> × {autoTilesLabel}
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
                    <label htmlFor="mine-sol" className="block text-sm font-medium text-stone-200">
                      How much SOL do you want to mine with?
                    </label>
                    <div className="flex items-center gap-2 rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 focus-within:border-amber-500 lg:py-1.5">
                      <input
                        id="mine-sol"
                        value={depositStr}
                        onChange={(e) => setDepositStr(e.target.value)}
                        inputMode="decimal"
                        className="w-full min-w-0 bg-transparent text-lg font-semibold text-stone-100 tabular-nums outline-none lg:text-base"
                      />
                      <SolIcon className="size-4 shrink-0" />
                    </div>
                    {connected && (
                      <div className="flex items-center justify-between px-1 text-xs">
                        <span className="text-stone-400">Wallet balance</span>
                        <span className="inline-flex items-center gap-1 font-medium text-stone-100">
                          {walletSol != null ? walletSol.toFixed(4) : "…"} <SolIcon className="size-3" />
                        </span>
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      {(["shorter", "longer", "custom"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={mode === m}
                          onClick={() => setMode(m)}
                          className={`rounded-lg border px-2 py-2 text-xs font-semibold uppercase tracking-wide transition-colors lg:py-1.5 ${
                            mode === m
                              ? "border-amber-400 bg-amber-500/20 text-amber-200"
                              : m === "custom"
                                ? "border-stone-700 text-stone-400 hover:bg-stone-800"
                                : "border-amber-600/60 text-amber-300 hover:bg-amber-900/30"
                          }`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                    {mode === "custom" && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-xs text-stone-400">SOL / tile</label>
                          <input
                            value={amountStr}
                            onChange={(e) => setAmountStr(e.target.value)}
                            inputMode="decimal"
                            className="w-24 rounded border border-stone-700 bg-stone-950 px-2 py-0.5 text-right text-sm text-stone-100 tabular-nums outline-none focus:border-amber-500"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                          <WholeField label="Solo tiles" value={soloStr} onChange={setSoloStr} max={SOLO_TILES} />
                          <WholeField label="Split tiles" value={splitStr} onChange={setSplitStr} max={SPLIT_TILES} />
                          <WholeField label="Min Motherlode" value={minMotherlodeStr} onChange={setMinMotherlodeStr} max={NO_MOTHERLODE_LIMIT} />
                          <WholeField label="Max Motherlode" value={maxMotherlodeStr} onChange={setMaxMotherlodeStr} max={NO_MOTHERLODE_LIMIT} />
                        </div>
                        <p className="text-[11px] leading-snug text-stone-500">
                          Up to {SOLO_TILES} solo, {SPLIT_TILES} split. Motherlode in uORE, max 0 = no limit.
                        </p>
                      </div>
                    )}
                    {run && (
                      <div className="space-y-1 rounded-md bg-stone-950/60 p-3 text-xs lg:space-y-0.5 lg:p-2">
                        <Row label="You'd get about" value={<span className="text-sm font-semibold text-amber-300">{fmtEst(run.steady)} uORE</span>} />
                        <Row label="Chance of a solo (+1 uORE)" value={fmtOdds(run.soloChance)} />
                        <Row
                          label="Chance of a Motherlode"
                          value={run.motherlodeCut > 0 ? `${fmtOdds(run.motherlodeChance)} · ${maxMotherlode < NO_MOTHERLODE_LIMIT ? "up to " : ""}+${fmtEst(run.motherlodeCut)} uORE` : fmtOdds(run.motherlodeChance)}
                        />
                        {presetRun && <Row label="Max Motherlode we mine" value={`${PRESET_MAX_MOTHERLODE} uORE`} />}
                        <Row label="Average with lucky hits" value={`${fmtEst(run.average)} uORE`} />
                        <Row label="Mining time" value={`~${fmtTime(run.seconds)} · ${fmtEst(run.rounds)} rounds`} />
                        {!presetRun && (minMotherlode > 0 || maxMotherlode < NO_MOTHERLODE_LIMIT) && (
                          <Row label="With Motherlode waits" value={run.secondsWithWaits < 31_536_000 ? `~${fmtTime(run.secondsWithWaits)}` : "over a year"} />
                        )}
                        <Row
                          label="SOL deployed per round"
                          value={
                            <span className="inline-flex items-center gap-1">
                              {fmtSol(run.stakePerRound)} <SolIcon className="size-3" />
                            </span>
                          }
                        />
                        <Row
                          label="Cost per round"
                          value={
                            <span className="inline-flex items-center gap-1">
                              ~{fmtEst(run.costPerRound / LAMPORTS_PER_SOL)} <SolIcon className="size-3" />
                            </span>
                          }
                        />
                        <Row
                          label={`${hosted ? "Miner" : "Dojo"} fee 1%`}
                          value={
                            <span className="inline-flex items-center gap-1">
                              {feeSol.toFixed(6)} <SolIcon className="size-3" />
                            </span>
                          }
                        />
                      </div>
                    )}
                    {!connected && amount > 0 && minedTiles > 0 && deposit < minDeposit && (
                      <p className="text-xs text-amber-300">Mine at least {(Math.ceil(minDeposit * 1e6) / 1e6).toFixed(6)} SOL.</p>
                    )}
                    {!goodRange && <p className="text-xs text-amber-300">Max Motherlode must be above Min.</p>}
                    {minedTiles === 0 && <p className="text-xs text-amber-300">Pick at least 1 tile.</p>}
                    {overLimit && (
                      <p className="text-xs text-amber-300">Motherlode above {maxMotherlode} uORE now: mining starts after it hits.</p>
                    )}
                    {underLimit && (
                      <p className="text-xs text-amber-300">Motherlode below {minMotherlode} uORE now: mining starts when it gets there.</p>
                    )}
                    {/* Measured on chain 10-31 from the Treasury factor: 51% a year over 6 months, 45% over the last 30 days, 88% a year ago. Simple, not compounding. */}
                    {presetRun && (
                      <p className="text-xs leading-snug text-stone-300 lg:text-[11px]">
                        Leave your uORE unclaimed and it earns about 50% a year in rORE (refined ORE). At today&apos;s rate, 1 uORE earns 2.5 rORE in 5 years. The rate moves with how much others claim.
                      </p>
                    )}
                    <p className="text-[11px] leading-snug text-stone-500">
                      An estimate from the last round, not a promise. Your SOL gets used up as you mine, and ORE takes 10% of uORE when you claim.
                      {presetRun && !overLimit && ` Pauses while the Motherlode is above ${PRESET_MAX_MOTHERLODE} uORE.`} 1% {hosted ? "miner" : "Dojo"} fee — same as ORE takes.
                      Paid only when it works.
                    </p>
                    {!connected ? (
                      <div className="flex flex-col items-center gap-2 pt-1">
                        {embedded && branded ? (
                          <BrandedConnect onConnect={select} />
                        ) : embedded ? (
                          // Inside the store, StoreNav already renders a Connect button (top-right).
                          // Avoid a second wallet button so mobile doesn't show "connect" twice.
                          <p className="text-sm text-stone-400 text-center">
                            Connect your wallet using the <span className="text-amber-400 font-semibold">Connect wallet</span> button at the top to auto-mine.
                          </p>
                        ) : (
                          <>
                            <p className="text-sm text-stone-400">Connect your wallet to auto-mine.</p>
                            <WalletMultiButton />
                          </>
                        )}
                      </div>
                    ) : (
                      <ActionButton variant="mine" onClick={onStartAuto} busy={busy === "Start auto-mining"} disabled={!canStartAuto}>
                        <Pickaxe className="size-4" />
                        {amount <= 0
                          ? "Enter SOL per tile"
                          : minedTiles === 0
                            ? "Pick at least 1 tile"
                            : !goodRange
                              ? "Max Motherlode must be above Min"
                              : deposit < minDeposit
                            ? `Mine at least ${(Math.ceil(minDeposit * 1e6) / 1e6).toFixed(6)} SOL`
                            : walletShort
                              ? "Not enough SOL in your wallet"
                              : (
                                  <>
                                    MINE ({(deposit + feeSol).toFixed(4)} <SolIcon className="size-3.5" />)
                                  </>
                                )}
                      </ActionButton>
                    )}
                    {connected && hasLeftoverSol && !preview && (
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
          <div className={`pt-1 lg:col-start-2 lg:row-start-4 lg:pt-0 ${formColumn ? "xl:row-start-3" : ""}`}>
            {!hosted && (
              <>
                <button
                  type="button"
                  onClick={() => showBurn(true)}
                  className="mb-2 flex w-full flex-col items-center rounded-lg border border-red-500/50 bg-gradient-to-r from-red-950/60 to-amber-950/50 px-3 py-2.5 text-amber-200 transition-colors hover:from-red-900/60 hover:to-amber-900/50 lg:py-1.5"
                >
                  <span className="text-sm font-semibold">🔥 Burn to Mine</span>
                  <span className="text-[11px] text-stone-400">burn NFTs you don&apos;t want, mine ORE with the SOL</span>
                </button>
                <Link
                  href="/whitelabel"
                  prefetch={false}
                  className="mb-2 flex w-full flex-col items-center rounded-lg border border-amber-600/60 bg-amber-950/30 px-3 py-2.5 text-amber-200 transition-colors hover:bg-amber-900/40 lg:py-1.5"
                >
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                    <Pickaxe className="size-3.5 shrink-0" /> Add your collection on the grid
                  </span>
                  <span className="text-[11px] text-stone-400">run this miner with your own NFTs</span>
                </Link>
              </>
            )}
            <div className={`grid ${!hosted && !preview ? "grid-cols-3" : "grid-cols-2"} gap-2 text-[11px] text-stone-500`}>
              <button onClick={() => setShowHow(true)} className={`${FOOT_BTN} border-stone-800 bg-stone-900/40 hover:bg-stone-800 hover:text-stone-300`}>
                <Info className="size-3.5 shrink-0" /> how it works
              </button>
              <button onClick={refresh} className={`${FOOT_BTN} border-stone-800 bg-stone-900/40 hover:bg-stone-800 hover:text-stone-300`}>
                <RefreshCw className="size-3.5 shrink-0" /> refresh
              </button>
              {/* a store page, not part of this app, and Degen Dojo's own: branded miners don't link it */}
              {!hosted && !preview && (
                <a href="/orewizard/" className={`${FOOT_BTN} border-amber-900/60 bg-stone-900/40 text-amber-400 hover:bg-stone-800 hover:text-amber-300`}>
                  <Wand2 className="size-3.5 shrink-0" /> ORE Wizard
                </a>
              )}
              {/* the store menu at the top has Disconnect; a branded miner has no such menu, so it keeps this one */}
              {connected && branded && (
                <button onClick={() => disconnect()} className={`${FOOT_BTN} border-stone-800 bg-stone-900/40 hover:bg-stone-800 hover:text-stone-300`}>
                  <LogOut className="size-3.5 shrink-0" /> disconnect
                </button>
              )}
            </div>
            {/* Degen Dojo's own miner only, same as the ORE Wizard link above */}
            {!hosted && !preview && (
              <>
                <div className="mt-3 mb-2 flex items-center gap-2 text-[11px] text-stone-500">
                  <span className="h-px flex-1 bg-stone-800" />
                  other mining solutions
                  <span className="h-px flex-1 bg-stone-800" />
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px] text-stone-500">
                  {OTHER_MINERS.map(([name, url, border]) => (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer" className={`${FOOT_BTN} ${border} bg-stone-900/40 text-stone-300 hover:bg-stone-800 hover:text-white`}>
                      {name}
                    </a>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        )}
        {footer}
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
        <div className="text-sm font-medium text-stone-200">{t}</div>
        <div className="text-xs leading-relaxed text-stone-400">{d}</div>
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
        className="w-full max-w-md space-y-3 rounded-xl border border-stone-800 bg-stone-900 p-5"
      >
        <div className="flex items-center gap-2">
          <Info className="size-4 text-amber-400" />
          <h2 className="text-sm font-medium text-stone-100">How mining works</h2>
          <button onClick={onClose} className="ml-auto text-stone-500 hover:text-stone-200">
            <X className="size-4" />
          </button>
        </div>
        <HowStep n={1} t="It's a 25-tile grid" d="ORE mining is a fixed 5×5 board — always 25 tiles. Each one here is a Degen." />
        <HowStep n={2} t="You deploy SOL on every tile" d="Pick your SOL, then Shorter or Longer: that sets how much goes on each tile. e.g. 0.0012 × 25 = 0.03 SOL a round. Custom lets you pick your own solo and split tiles and Motherlode range." />
        <HowStep n={3} t="Every ~80 sec, one tile wins" d="Whoever staked the winning tile mines the round's fresh uORE (one miner takes it, or it's split) — plus the Motherlode when it hits. Your SOL comes back, minus ORE's fees: 1% on every tile, and 10% on the tiles that lost." />
        <HowStep n={4} t="Your uORE stacks in the Vault" d="Claim it to your wallet whenever you like." />
        <HowStep n={5} t="Auto-mine plays for you" d="Fund a balance and it enters every round until it runs low. Stop & withdraw pulls the rest back out." />
        <p className="rounded bg-stone-950/60 px-3 py-2 text-xs text-stone-500">
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
  default: "text-stone-100",
};

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
    <div className="flex flex-col rounded-lg border border-stone-800 bg-stone-900/50 p-2 sm:p-3 lg:p-2" title={hint}>
      <div className="text-[10px] uppercase leading-tight tracking-wide text-stone-500">{label}</div>
      <div className={`mt-auto text-base font-semibold tabular-nums sm:text-lg lg:text-base ${ACCENT[accent ?? "default"]}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[8px] leading-tight text-stone-600">{sub}</div>}
    </div>
  );
}

// Share of rounds whose +1 uORE goes to a single winner (the rest split it) — matches the
// "40% of rounds give a single uORE" note on the stat box (the other 60% split it).
const SINGLE_ROUND_SHARE = 0.4;

const OTHER_MINERS = [
  ["RubyPool", "https://rubypool.io/", "border-red-600"],
  ["Orestack", "https://orestack.app/", "border-white"],
  ["ORE Party", "https://ore.party/", "border-yellow-400"],
];
const FOOT_BTN =
  "inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border px-1.5 text-center leading-tight whitespace-nowrap transition-colors";

/** A Custom setting in whole numbers: digits only, and anything above `max` becomes `max` as it's typed. */
function WholeField({ label, value, onChange, max }: { label: string; value: string; onChange: (v: string) => void; max: number }) {
  return (
    <label className="flex items-center justify-between gap-1 text-xs text-stone-400">
      {label}
      <input
        value={value}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "");
          onChange(Number(digits) > max ? String(max) : digits);
        }}
        inputMode="numeric"
        className="w-12 rounded border border-stone-700 bg-stone-950 px-1.5 py-0.5 text-right text-sm text-stone-100 tabular-nums outline-none focus:border-amber-500"
      />
    </label>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-stone-400">{label}</span>
      <span className="font-medium text-stone-200">{value}</span>
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
  variant?: "primary" | "outline" | "mine";
}) {
  const enabled =
    variant === "outline"
      ? "border border-stone-700 text-stone-200 hover:bg-stone-800"
      : variant === "mine"
        ? "bg-red-600 font-semibold text-white hover:bg-red-500"
        : "bg-amber-600 text-white hover:bg-amber-500";
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
        disabled || busy ? "cursor-not-allowed bg-stone-800 text-stone-500" : enabled
      }`}
    >
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}
