"use client";

// Burn mode of /mine (/mine?burn=1 opens it directly; /mine/burn redirects here): burn the NFTs you don't want, then
// put the SOL that ACTUALLY came back into ORE auto-mining. The burn logic is the store's shared /dojo-burn.js
// (window.DojoBurn — the same module Dojo Sweep uses); the auto-mining step is this app's own Automate instruction.
// Two signing steps: the burns, then the miner. NFTs ticked on /sweep arrive pre-selected (sessionStorage), re-checked.
// The Dojo fee is charged ONCE here (owner 2026-10-27): 1% of the mining deposit (lib/minerTip) — the burns and closes
// are planned with { fee: false }. Two all-25-tile options, a rounds choice and a wallet top-up when the burns return too
// little (owner 2026-10-27) — the sizing and what ORE requires are in lib/burnMine.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { LAMPORTS_PER_SOL, type TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { Flame, Pickaxe, Loader2 } from "lucide-react";
import { useWallet } from "@/lib/wallet-bridge";
import type { OreGameState } from "@/hooks/useOreGame";
import { automateIx, SQUARES, EXECUTOR_FEE_LAMPORTS, STRATEGY_PREFERRED, type AutomationConditions } from "@/lib/ore";
import { confirmAll, onRpcRetry, storeRpc as rpc, takeBurnPicks, thumb, useDojoBurn, type BurnNft, type Plan, type ScanOut } from "@/lib/dojoBurn";
import { TIP_WALLET } from "@/lib/config";
import { dojoFeeIxs, recordTip } from "@/lib/minerTip";
import {
  AUTOMATION_BYTES, DEFAULT_ROUNDS, FIXED_PER_TILE, MINER_BYTES, ROUND_CHOICES, STRETCH_MIN_PER_TILE, STRETCH_ROUNDS, TILES,
  oneTimeLamports, rentFallback, sizeOption, step2Plan, walletNeedAfter, walletNeedBefore, type Option, type Sizing,
} from "@/lib/burnMine";

// ─── Mining options (owner 2026-10-27) — Burn to Mine covers ALL 25 tiles, so a new miner is on the winning tile every round
// and collects some ORE each round. Both: Automate V2 Preferred strategy with every square, winnings reloaded, and the
// program skips a round while the motherlode is above 140 ORE. The /mine page's own auto-miner keeps its own settings.
//   Stretch   the per-tile amount is sized from the deposit so it lasts ≈ 50 rounds, never below 0.00004 SOL a tile
//   25 tiles  a fixed 0.0002 SOL a tile
type Preset = { id: Option; name: string; blurb: string; conditions: AutomationConditions };
export const PRESETS: Preset[] = [
  { id: "stretch", name: "Stretch", blurb: "All 25 tiles, the amount per tile sized to last about 50 rounds (never below 0.00004 SOL a tile).", conditions: { maxMotherlode: 140 } },
  { id: "fixed", name: "25 tiles", blurb: "All 25 tiles at 0.0002 SOL a tile — bigger stakes, fewer rounds.", conditions: { maxMotherlode: 140 } },
];
const ALL_SQUARES = Array.from({ length: SQUARES }, () => true);

const PAGE = 40; // 5 rows of 8 on a laptop; no placeholder tiles
const solStr = (lamports: number, dp = 4) => (lamports / LAMPORTS_PER_SOL).toFixed(dp);
/** SOL with enough digits to show small amounts (0.000645, 0.00004) without a wall of zeros on bigger ones. */
const solFine = (lamports: number) => {
  const v = lamports / LAMPORTS_PER_SOL;
  return v >= 0.01 ? v.toFixed(4) : v >= 0.0001 ? v.toFixed(6) : v.toFixed(8).replace(/0+$/, "");
};
const isB58 = (s: string | null) => !!s && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

type Props = Pick<OreGameState, "connection" | "automation" | "motherlode" | "miner"> & {
  busy: string | null;
  submit: (label: string, ixs: TransactionInstruction[]) => Promise<string | null>;
  onBack: () => void;
};

export function BurnMode({ connection, automation, motherlode, miner, busy, submit, onBack }: Props) {
  const { publicKey, sendTransaction } = useWallet();
  const { api, error: loadErr } = useDojoBurn();

  const [viewWallet, setViewWallet] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanOut | null>(null);
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<{ kept: number; dropped: number } | null>(null);
  const [page, setPage] = useState(0);
  const [presetId, setPresetId] = useState<Option>(PRESETS[0].id); // Stretch first: the cheapest way onto all 25 tiles
  const [rounds, setRounds] = useState<number>(DEFAULT_ROUNDS);
  const [showAll, setShowAll] = useState(false); // burn list: "Floor below 0.05 SOL" (default) | "Show all"
  const [walletBal, setWalletBal] = useState<number | null>(null);
  const [rent, setRent] = useState({ auto: rentFallback(AUTOMATION_BYTES), miner: rentFallback(MINER_BYTES) });
  const [withEmpties, setWithEmpties] = useState(false);
  const [review, setReview] = useState<{ plan: Plan; closes: Plan | null; gain: number } | null>(null);
  const [sure, setSure] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<string>("");
  const [pendingMine, setPendingMine] = useState<{ s2: Sizing; back: number; expected: number } | null>(null); // step 2 numbers grew: second click
  const [rescan, setRescan] = useState(0); // "Refresh" after a partly-read scan
  const sweepPicks = useRef<{ owner: string; mints: string[] } | null>(null); // kept so a Refresh re-ticks them

  const owner = publicKey ? publicKey.toBase58() : viewWallet;
  const mine = !!publicKey && owner === publicKey.toBase58();
  const preset = PRESETS.find((p) => p.id === presetId) || PRESETS[0];

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("wallet");
    if (isB58(q)) void Promise.resolve().then(() => setViewWallet(q)); // read-only view of a pasted wallet (?wallet=)
  }, []);
  useEffect(() => {
    let alive = true;
    Promise.all([rpc("getMinimumBalanceForRentExemption", [AUTOMATION_BYTES]), rpc("getMinimumBalanceForRentExemption", [MINER_BYTES])])
      .then(([a, m]) => alive && Number(a) > 0 && Number(m) > 0 && setRent({ auto: Number(a), miner: Number(m) }))
      .catch(() => {}); // keep the (higher) fallback
    return () => {
      alive = false;
    };
  }, []);
  const mineKey = publicKey ? publicKey.toBase58() : "";
  useEffect(() => {
    if (!mineKey) return;
    let alive = true;
    rpc("getBalance", [mineKey])
      .then((b) => alive && setWalletBal(Number(b?.value ?? b)))
      .catch(() => alive && setWalletBal(null));
    return () => {
      alive = false;
    };
  }, [mineKey, review, done]);
  // the paced RPC client retries a busy network itself; say so next to the current step
  useEffect(() => onRpcRetry(() => setStep((s) => (s && !s.includes("busy, retrying") ? s + " (busy, retrying)" : s))), []);
  useEffect(() => {
    if (!api || !owner) return;
    let alive = true;
    void Promise.resolve()
      .then(() => {
        if (!alive) return null;
        setScan(null);
        setSel(new Set());
        setReview(null);
        setErr("");
        return api.scan(rpc, owner, (s) => alive && setStep(s));
      })
      .then((s) => {
        if (!alive || !s) return;
        setScan(s);
        setStep("");
        // NFTs ticked on /sweep: keep only the ones still in THIS wallet and burnable here; the rest are dropped
        const picks = takeBurnPicks() || (sweepPicks.current?.owner === owner ? sweepPicks.current : null);
        if (picks) {
          sweepPicks.current = picks;
          const ok = new Set(s.nfts.filter((n) => n.burnable).map((n) => n.mint));
          const kept = picks.owner === owner ? picks.mints.filter((m) => ok.has(m)) : [];
          setSel(new Set(kept));
          setPicked({ kept: kept.length, dropped: picks.mints.length - kept.length });
          const hiFloor = new Set(s.nfts.filter((n) => typeof n.floorSol === "number" && n.floorSol >= (api.FLOOR_MAX ?? 0.05)).map((n) => n.mint));
          if (kept.some((m) => hiFloor.has(m))) setShowAll(true);
        }
      })
      .catch((e) => alive && (setErr("Couldn't read this wallet right now (" + (e?.message || e) + "). Try Refresh in a minute."), setStep("")));
    return () => {
      alive = false;
    };
  }, [api, owner, rescan]);

  const burnables = useMemo(() => (scan ? scan.nfts.filter((n) => n.burnable) : []), [scan]);
  // floor guard (owner 2026-10-27): a collection floor ≥ FLOOR_MAX SOL is worth more listed than burned — hidden by default,
  // never bulk-picked, named in red if ticked by hand
  const FLOOR_MAX = api?.FLOOR_MAX ?? 0.05;
  const isHigh = (n: BurnNft) => (api ? api.floorHigh(n) : typeof n.floorSol === "number" && n.floorSol >= FLOOR_MAX);
  const degraded = !!scan?.floors?.degraded; // floors couldn't be read for several verified collections
  const visibleOf = (all: boolean) => (api ? api.visibleNfts(burnables, all, degraded) : all ? burnables : burnables.filter((n) => !isHigh(n) && !(degraded && n.collection && n.floorSol == null)));
  const listed = visibleOf(showAll);
  const hiddenCount = burnables.length - listed.length;
  const pages = Math.max(1, Math.ceil(listed.length / PAGE));
  const shown = listed.slice(page * PAGE, page * PAGE + PAGE);
  const floorTxt = (v: number) => (v >= 10 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(2) : v.toFixed(3)).replace(/\.?0+$/, "");
  const chosen = burnables.filter((n) => sel.has(n.mint));
  const estLamports = chosen.reduce((t, n) => t + n.lamports, 0) + (withEmpties && scan ? scan.emptyLamports : 0);
  const reclaim = review ? review.gain : estLamports;
  const motherlodeOre = motherlode ? Number(motherlode) / 1e11 : null;
  // what the chosen option needs: from the burn (≈ reclaim), the top-up from the wallet, one-time account costs
  const sz: Sizing = sizeOption(preset.id, reclaim, rounds);
  const oneTime = oneTimeLamports({ hasAutomation: !!automation, hasMiner: !!miner, rentAutomation: rent.auto, rentMiner: rent.miner });
  const burnTxs = review ? review.plan.batches.length + (review.closes?.batches.length || 0) : Math.max(1, Math.ceil(chosen.length / 3));
  const walletShort = walletBal != null ? Math.max(0, walletNeedBefore(sz, oneTime, burnTxs) - walletBal) : 0;
  const pctStr = (p: number) => (p < 1 ? p.toFixed(1) : String(Math.round(p)));

  const toggle = (m: string) => {
    if (working) return;
    sweepPicks.current = null;
    setReview(null);
    setSure(false);
    setSel((s) => {
      const n = new Set(s);
      if (n.has(m)) n.delete(m);
      else n.add(m);
      return n;
    });
  };
  const selectJunk = () => {
    sweepPicks.current = null;
    setReview(null);
    // never a high floor, and a verified collection only with a known floor under FLOOR_MAX (the spam check alone can flag a real project)
    setSel(new Set((api ? api.junkPicks(burnables) : burnables.filter((n) => n.junk >= 3 && !isHigh(n) && (!n.collection || (typeof n.floorSol === "number" && n.floorSol < FLOOR_MAX)))).map((n) => n.mint)));
  };

  // Step 0: plan + simulate the burns (and closes) so the total shown is what the chain says
  async function prepare() {
    if (!api || !owner || !chosen.length) return;
    setWorking(true);
    setErr("");
    try {
      // no fee on the burns / closes here: Burn to Mine pays its one 1% on the mining deposit
      const plan = await api.planBurns(rpc, owner, chosen, setStep, { fee: false });
      const closes = withEmpties && scan && scan.empties.length ? await api.planCloses(rpc, owner, scan.empties, setStep, { fee: false }) : null;
      const gain = plan.batches.reduce((t, b) => t + b.lamports, 0) + (closes ? closes.batches.reduce((t, b) => t + b.lamports, 0) : 0);
      setReview({ plan, closes, gain });
    } catch (e) {
      setErr("Couldn't check these burns (" + ((e as Error)?.message || e) + ").");
    }
    setStep("");
    setWorking(false);
  }

  // Step 1 (burns) + step 2 (auto-mining with the SOL that actually came back)
  async function burnAndMine() {
    if (!api || !publicKey || !review || !mine) return;
    const me = publicKey.toBase58();
    setWorking(true);
    setErr("");
    try {
      const batches = [...review.plan.batches, ...(review.closes ? review.closes.batches : [])];
      if (!batches.length) throw new Error("none of these NFTs can be burned");
      const pre = (await rpc("getBalance", [me, { commitment: "confirmed" }])).value as number;
      setPendingMine(null);
      const txs = await api.finalize(rpc, me, batches);
      const sigs: string[] = [];
      const store = (window as unknown as { DOJO_WALLET?: { signAll?: (t: unknown[]) => Promise<Uint8Array[]> } }).DOJO_WALLET;
      let signed: Uint8Array[] | null = null;
      if (txs.length > 1 && store?.signAll) {
        setStep("Step 1 — approve " + txs.length + " burn transactions in your wallet…");
        try {
          signed = await store.signAll(txs);
        } catch (e) {
          if (!/cannot sign multiple/i.test((e as Error)?.message || "")) throw e;
        }
      }
      if (signed) {
        for (let i = 0; i < signed.length; i++) {
          setStep(`Step 1 — sending ${i + 1} of ${signed.length}…`);
          sigs.push(await rpc("sendTransaction", [Buffer.from(signed[i]).toString("base64"), { encoding: "base64", maxRetries: 3 }]));
        }
      } else {
        for (let i = 0; i < txs.length; i++) {
          setStep(`Step 1 — approve burn ${i + 1} of ${txs.length} in your wallet…`);
          sigs.push(await sendTransaction(txs[i], connection));
        }
      }
      setStep("Step 1 — confirming the burns…");
      const conf = await confirmAll(sigs);
      const post = (await rpc("getBalance", [me, { commitment: "confirmed" }])).value as number;
      // Step 2 is sized from what ACTUALLY came back — capped at what the review measured (SOL arriving from elsewhere
      // isn't burn proceeds) — and only once EVERY burn confirmed (lib/burnMine.ts step2Plan)
      const plan2 = step2Plan({ pre, post, reviewGain: review.gain, sent: sigs.length, done: conf.done, option: preset.id, rounds, planned: sz, oneTime });
      // the burns are sent: this review can't be used again (a second click would try to burn them twice)
      const expected = review.gain;
      setReview(null);
      setSure(false);
      setSel(new Set());
      sweepPicks.current = null;
      if (plan2.kind === "failed") {
        setDone(`⚠ ${plan2.done} of ${plan2.sent} burn transaction${plan2.sent === 1 ? "" : "s"} confirmed — mining wasn't started and nothing was taken from your wallet. Check your wallet's activity, then Refresh.`);
        setRescan((n) => n + 1);
        return;
      }
      if (plan2.kind === "short") {
        setDone(`🔥 Burned — ${solFine(plan2.back)} SOL came back. Mining needs ${solFine(plan2.missing)} SOL more in this wallet (${preset.name}, ${rounds} funded rounds), so it wasn't started; you can top up on the miner.`);
        setRescan((n) => n + 1);
        return;
      }
      if (plan2.kind === "reconfirm") {
        setPendingMine({ s2: plan2.s2, back: plan2.back, expected });   // show the new numbers — the user starts mining with a second click
        return;
      }
      await startMining(plan2.s2, plan2.back);
    } catch (e) {
      setErr(((e as Error)?.message || String(e)).slice(0, 200));
    } finally {
      setStep("");
      setWorking(false);
    }
  }

  // Step 2: auto-mining on all 25 tiles — the deposit plus the 1% Dojo fee (+ the preacher's ddref memo), one tx. The
  // wallet is re-checked right before it's signed.
  async function startMining(s2: Sizing, back: number) {
    if (!publicKey || !mine) return;
    const me = publicKey.toBase58();
    const bal = (await rpc("getBalance", [me, { commitment: "confirmed" }])).value as number;
    const needNow = walletNeedAfter(s2, oneTime);
    if (bal < needNow) {
      setPendingMine(null);
      setDone(`🔥 Burned — ${solFine(back)} SOL came back. Mining needs ${solFine(needNow - bal)} SOL more in this wallet (${preset.name}, ${rounds} funded rounds), so it wasn't started; you can top up on the miner.`);
      return;
    }
    {
      setStep("Step 2 — set up auto-mining…");
      const fee = dojoFeeIxs(publicKey, s2.deposit, TIP_WALLET);
      const sig = await submit("Start auto-mining", [
        automateIx({
          signer: publicKey,
          amountLamports: BigInt(s2.perTile),
          depositLamports: BigInt(s2.deposit),
          feeLamports: EXECUTOR_FEE_LAMPORTS,
          squares: ALL_SQUARES,
          reload: true,
          strategy: STRATEGY_PREFERRED,
          conditions: preset.conditions,
        }),
        ...fee.ixs,
      ]);
      if (sig && fee.feeLamports > 0) void recordTip(sig, me, fee.feeLamports / LAMPORTS_PER_SOL, "SOL");
      setDone(
        sig
          ? `🔥 Burned and ⛏ mining — ${solFine(s2.deposit)} SOL went into auto-mining (${preset.name}: all 25 tiles at ${solFine(s2.perTile)} SOL, ${s2.funded} funded rounds, ≈ ${s2.rounds} on average)${s2.topUp > 0 ? `, ${solFine(s2.topUp)} SOL of it from your wallet` : ""}, + ${solFine(fee.feeLamports)} SOL Dojo fee.`
          : `🔥 Burned — ${solFine(back)} SOL came back. Auto-mining wasn't started (see the message above); you can start it on the miner.`,
      );
      setPendingMine(null);
      setRescan((n) => n + 1); // the burned NFTs leave the list
    }
  }
  async function confirmPendingMine() {
    if (!pendingMine) return;
    setWorking(true);
    setErr("");
    try {
      await startMining(pendingMine.s2, pendingMine.back);
    } catch (e) {
      setErr(((e as Error)?.message || String(e)).slice(0, 200));
    } finally {
      setStep("");
      setWorking(false);
    }
  }

  return (
    <section className={`text-stone-200 ${sel.size > 0 ? "pb-20 md:pb-0" : ""}`}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
      <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-amber-300 sm:text-3xl">
          <Flame className="size-6 text-red-400 sm:size-7" /> Burn to Mine <Pickaxe className="size-5 text-amber-400 sm:size-6" />
        </h1>
        <button
          type="button"
          onClick={onBack}
          disabled={working}
          className="inline-flex items-center gap-1.5 rounded-lg border border-stone-700 bg-stone-900/60 px-3 py-2 text-sm font-medium text-stone-200 hover:bg-stone-800 disabled:opacity-40 lg:hidden"
        >
          ⛏ Back to mining
        </button>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-stone-400">
        Burn the NFTs you don&apos;t want — every one gives back its rent — and auto-mine ORE with that SOL on all 25 tiles: you&apos;re on the winning tile every
        round and collect uORE as it runs. Tap the NFTs you want to burn; nothing is picked for you.
      </p>
      <p className="mt-1 max-w-2xl text-xs text-stone-500">
        Staked somewhere off-chain? Some projects track staking on their own servers — the NFT looks free here, and burning it ends that stake.
      </p>

      {!owner && <div className="mt-6 rounded-xl border border-stone-800 bg-stone-900/50 p-5 text-sm text-stone-300">Connect your wallet (top right) to see your burnable NFTs.</div>}
      {loadErr && <div className="mt-4 text-sm text-red-300">{loadErr}</div>}
      {err && <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">{err}</div>}
      {step && (
        <div className="mt-4 flex items-center gap-2 text-sm text-stone-400">
          <Loader2 className="size-4 animate-spin" /> {step}
        </div>
      )}
      {done && <div className="mt-4 rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-3 text-sm text-emerald-200">{done}</div>}
      {(scan?.unread || (err && !scan && owner)) ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 p-3 text-xs text-amber-200">
          {scan?.unread ? "Some items couldn't be read (the network was busy) — the rest is below." : "Nothing could be read this time."}
          <button type="button" className="rounded-md border border-amber-600/50 px-2 py-0.5 font-semibold hover:bg-amber-900/30 disabled:opacity-40" disabled={working || !!step} onClick={() => setRescan((n) => n + 1)}>
            Refresh
          </button>
        </div>
      ) : null}
      {picked && (
        <div className="mt-4 rounded-lg border border-amber-700/40 bg-amber-950/20 p-3 text-xs text-amber-200">
          From Dojo Sweep: {picked.kept} NFT{picked.kept === 1 ? "" : "s"} ticked for you here
          {picked.dropped > 0 ? ` · ${picked.dropped} left out (no longer in this wallet, or can't be burned)` : ""}. Pick a mining setting, then check and confirm — nothing is burned before that.
        </div>
      )}

      {scan && (
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-stone-400">
                {listed.length} NFT{listed.length === 1 ? "" : "s"} you could burn{owner && !mine ? " · viewing " + owner.slice(0, 4) + "…" + owner.slice(-4) : ""}
              </span>
              <span className="flex gap-1 text-xs">
                <button
                  type="button"
                  disabled={working}
                  onClick={() => {
                    if (!showAll) return;
                    setShowAll(false);
                    setPage(0);
                    setReview(null);
                    sweepPicks.current = null;
                    const vis = new Set(visibleOf(false).map((n) => n.mint));
                    setSel((cur) => new Set([...cur].filter((m) => vis.has(m)))); // hidden = never ticked
                  }}
                  className={`rounded-md border px-2 py-1 ${showAll ? "border-stone-700 hover:bg-stone-800" : "border-amber-500/70 bg-amber-950/40 text-amber-200"}`}
                >
                  Floor below {FLOOR_MAX} SOL
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => ((sweepPicks.current = null), setShowAll(true), setPage(0))}
                  className={`rounded-md border px-2 py-1 ${showAll ? "border-amber-500/70 bg-amber-950/40 text-amber-200" : "border-stone-700 hover:bg-stone-800"}`}
                >
                  Show all
                </button>
              </span>
              <span className="flex gap-2">
                <button className="rounded-md border border-stone-700 px-2 py-1 text-xs hover:bg-stone-800" onClick={selectJunk} disabled={working}>
                  Select all likely spam
                </button>
                {sel.size > 0 && (
                  <button className="rounded-md border border-stone-700 px-2 py-1 text-xs hover:bg-stone-800" onClick={() => ((sweepPicks.current = null), setSel(new Set()), setReview(null))} disabled={working}>
                    Clear
                  </button>
                )}
              </span>
            </div>
            {!showAll && hiddenCount > 0 && (
              <div className="mb-2 text-xs text-stone-400">
                {hiddenCount} hidden — their collection floor is {FLOOR_MAX} SOL or more{degraded ? ", or couldn't be checked" : " (worth more listed than burned)"}.
              </div>
            )}
            {degraded && (
              <div className="mb-2 rounded-lg border border-amber-700/40 bg-amber-950/20 p-2 text-xs text-amber-200">
                ⚠ Floor prices couldn&apos;t be checked for {scan.floors?.unknownVerified ?? "some"} collections right now — their NFTs are under Show all until they can be. Spam
                without a collection stays here.
              </div>
            )}
            {burnables.length === 0 ? (
              <div className="rounded-xl border border-stone-800 bg-stone-900/50 p-5 text-sm text-stone-400">Nothing here to burn — no spare NFTs outside Degen Dojo, Demon Dojo and TETO.</div>
            ) : listed.length === 0 ? (
              <div className="rounded-xl border border-stone-800 bg-stone-900/50 p-5 text-sm text-stone-400">All of them have a floor of {FLOOR_MAX} SOL or more — tap Show all to see them.</div>
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-5 md:grid-cols-6 xl:grid-cols-8">
                {shown.map((n) => {
                  const on = sel.has(n.mint), im = thumb(n.image);
                  return (
                    <button
                      key={n.mint}
                      type="button"
                      onClick={() => toggle(n.mint)}
                      title={`${n.name}${n.collectionName ? " · " + n.collectionName : ""} — +${solStr(n.lamports)} SOL${typeof n.floorSol === "number" ? ` · floor ${floorTxt(n.floorSol)} SOL${isHigh(n) ? " — worth more listed than burned" : ""}` : " · floor unknown"}`}
                      className={`group relative aspect-square overflow-hidden rounded-lg bg-stone-900 ring-1 transition-all ${on ? "z-10 ring-2 ring-red-500 shadow-[0_0_18px_rgba(239,68,68,0.5)]" : "ring-stone-800 hover:ring-stone-600"}`}
                    >
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-stone-500">no image</span>
                      {im && (
                        // a dead thumbnail (spam hosts vanish) hides itself, leaving the "no image" tile underneath
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={im}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            // the resizer refuses some hosts by policy (e.g. gateway.irys.xyz) → the original image, once
                            const el = e.currentTarget;
                            if (!el.dataset.raw && api?.rawImageOk(n.image)) { el.dataset.raw = "1"; el.src = n.image; } // Arweave / Irys / IPFS / our S3 only
                            else el.style.display = "none";
                          }}
                          className={`absolute inset-0 size-full object-cover ${on ? "opacity-70" : ""}`}
                        />
                      )}
                      {on && <span className="absolute inset-0 flex items-center justify-center text-2xl">🔥</span>}
                      {n.junk >= 3 && <span className="absolute right-1 top-1 rounded bg-amber-500/90 px-1 text-[8px] font-bold uppercase text-black">spam</span>}
                      {isHigh(n) ? (
                        <span className="absolute left-1 top-1 rounded bg-red-600 px-1 text-[8px] font-bold uppercase text-white">floor {floorTxt(n.floorSol as number)} SOL</span>
                      ) : n.floorSol == null ? (
                        <span className="absolute left-1 top-1 rounded bg-stone-800/90 px-1 text-[8px] font-bold uppercase text-stone-300">floor ?</span>
                      ) : showAll ? (
                        <span className="absolute left-1 top-1 rounded bg-stone-800/90 px-1 text-[8px] font-bold uppercase text-stone-200">floor {floorTxt(n.floorSol)}</span>
                      ) : null}
                      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-1 pb-0.5 pt-3 text-left text-[9px] font-medium text-stone-100">{n.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {pages > 1 && (
              <div className="mt-3 flex items-center justify-center gap-3 text-sm">
                <button className="rounded-md border border-stone-700 px-3 py-1 disabled:opacity-40" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  ‹ Prev
                </button>
                <span className="text-stone-400">
                  Page {page + 1} of {pages}
                </span>
                <button className="rounded-md border border-stone-700 px-3 py-1 disabled:opacity-40" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                  Next ›
                </button>
              </div>
            )}
          </div>
      )}
      </div>

      <div className="min-w-0 space-y-3">
        <div className="hidden lg:flex lg:justify-end">
          <button type="button" onClick={onBack} disabled={working} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-700 bg-stone-900/60 px-3 py-2 text-sm font-medium text-stone-200 hover:bg-stone-800 disabled:opacity-40">
            ⛏ Back to mining
          </button>
        </div>
      {scan && (
          <aside className="space-y-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
            <div id="burn-action" className="rounded-xl border border-stone-800 bg-stone-900/60 p-3">
              <div className="flex items-end justify-between gap-2">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-stone-500">Burning these gives back</div>
                  <div className="text-2xl font-bold tabular-nums text-amber-300">{solStr(reclaim)} SOL</div>
                </div>
                <div className="text-right text-[11px] text-stone-500">
                  {sel.size} NFT{sel.size === 1 ? "" : "s"}
                  <br />
                  {review ? "measured by simulation" : "their rent, before checking"}
                </div>
              </div>
              {scan.emptyLamports > 0 && (
                <label className="mt-2 flex items-center gap-2 text-xs text-stone-300">
                  <input type="checkbox" checked={withEmpties} onChange={(e) => (setWithEmpties(e.target.checked), setReview(null))} />
                  Also close {scan.empties.length} empty account{scan.empties.length === 1 ? "" : "s"} (+{solStr(scan.emptyLamports)} SOL)
                </label>
              )}
              {pendingMine && (
                <div className="mt-3 space-y-2 rounded-lg border border-amber-600/60 bg-amber-950/30 p-3 text-xs text-amber-100">
                  <div>
                    🔥 Burned — {solFine(pendingMine.back)} SOL came back (the check said ≈ {solFine(pendingMine.expected)}). To mine {rounds} funded rounds the top-up is now{" "}
                    <b>{solFine(pendingMine.s2.topUp)} SOL</b> (was {solFine(sz.topUp)}) — {solFine(pendingMine.s2.deposit)} SOL into auto-mining, + {solFine(pendingMine.s2.dojoFee)} SOL Dojo fee.
                  </div>
                  <div className="flex gap-2">
                    <button className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40" disabled={working || !!busy} onClick={confirmPendingMine}>
                      {working ? "Working…" : "⛏ Mine with these numbers"}
                    </button>
                    <button className="rounded-lg border border-stone-700 px-3 py-2 text-xs hover:bg-stone-800 disabled:opacity-40" disabled={working} onClick={() => setPendingMine(null)}>
                      Not now
                    </button>
                  </div>
                </div>
              )}
              {!review ? (
                <button
                  className="mt-3 w-full rounded-xl bg-gradient-to-r from-red-600 to-amber-600 px-4 py-2.5 font-bold text-white disabled:opacity-40"
                  disabled={!api || !sel.size || working || !mine}
                  onClick={prepare}
                >
                  {working ? "Checking…" : mine ? "🔥 Burn & ⛏ Mine — check first" : "Connect this wallet to burn"}
                </button>
              ) : (
                <div className="mt-3 space-y-2 rounded-lg border border-red-900/60 bg-red-950/20 p-3 text-xs">
                  <div>
                    <b>Step 1</b> — burn {review.plan.batches.reduce((t, b) => t + b.items.length, 0)} NFT{review.plan.batches.length === 1 ? "" : "s"}
                    {review.closes ? ` and close ${review.closes.batches.reduce((t, b) => t + b.items.length, 0)} empty accounts` : ""}: about <b>{solStr(review.gain)} SOL</b> back (
                    {review.plan.batches.length + (review.closes?.batches.length || 0)} transaction{review.plan.batches.length + (review.closes?.batches.length || 0) === 1 ? "" : "s"}).
                  </div>
                  {chosen.some(isHigh) && (
                    <div className="text-red-300">
                      ⚠ Worth more listed than burned:{" "}
                      {chosen
                        .filter(isHigh)
                        .map((n) => `${n.name}${n.collectionName ? " · " + n.collectionName : ""} — floor ${floorTxt(n.floorSol as number)} SOL`)
                        .join("; ")}
                    </div>
                  )}
                  {review.plan.dropped.length > 0 && <div className="text-amber-300">Left out: {review.plan.dropped.map((d) => d.item.name + " — " + d.reason).join("; ")}</div>}
                  <div>
                    <b>Step 2</b> — auto-mine on all {TILES} tiles at ≈ <b>{solFine(sz.perTile)} SOL a tile</b> ({preset.name}, {sz.funded} funded rounds, ≈ {sz.rounds} on average with reload, only while the
                    motherlode is ≤ {preset.conditions.maxMotherlode} ORE) with the ≈ {solFine(review.gain)} SOL that comes back
                    {sz.topUp > 0 ? (
                      <>
                        {" "}
                        plus <b>{solFine(sz.topUp)} SOL from your wallet</b>
                      </>
                    ) : null}
                    . The 1% Dojo fee (≈ {solFine(sz.dojoFee)} SOL) rides in that same transaction.
                    {oneTime > 0 ? ` First time: ORE also takes ≈ ${solFine(oneTime)} SOL to open your auto-mining account (rent, returned when it closes).` : ""}
                  </div>
                  <div className="text-red-200">⚠ Burning is permanent — these NFTs are destroyed for good.</div>
                  <label className="flex items-start gap-2">
                    <input id="burn-sure" className="mt-0.5" type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                    <span>
                      I understand — burn them forever and mine with the SOL
                      {sz.topUp > 0 ? ` plus ${solFine(sz.topUp)} SOL from my wallet` : ""}
                      {(() => {
                        const hi = chosen.filter(isHigh), top = hi.reduce((m, n) => Math.max(m, n.floorSol as number), 0);
                        return hi.length ? ` — includes ${hi.length === 1 ? `1 NFT with a ${floorTxt(top)} SOL floor` : `${hi.length} NFTs with floors up to ${floorTxt(top)} SOL`}` : "";
                      })()}
                    </span>
                  </label>
                  {walletShort > 0 && walletBal != null && (
                    <div className="text-amber-300">
                      Your wallet has {solFine(walletBal)} SOL; this needs {solFine(walletShort)} SOL more — add SOL, pick fewer rounds or the other option, or burn more NFTs.
                    </div>
                  )}
                  <button className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40" disabled={!sure || working || !!busy || walletShort > 0} onClick={burnAndMine}>
                    {working ? "Working…" : "🔥 Burn & ⛏ Mine"}
                  </button>
                </div>
              )}
              <div className="mt-2 text-[11px] text-stone-400">Best with ≈0.02 SOL of NFTs — less? a small top-up starts you.</div>
            </div>

            <div className="rounded-xl border border-stone-800 bg-stone-900/60 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="text-[11px] uppercase tracking-wider text-stone-500">Mine ORE with it</span>
                <span className="flex flex-wrap items-center gap-1 text-[11px] text-stone-400">
                  Funded rounds
                  {ROUND_CHOICES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      disabled={working}
                      onClick={() => (setRounds(r), setSure(false))}
                      className={`min-w-7 rounded-md border px-1.5 py-0.5 font-semibold disabled:opacity-40 ${rounds === r ? "border-amber-500/70 bg-amber-950/40 text-amber-200" : "border-stone-700 hover:bg-stone-800"}`}
                    >
                      {r}
                    </button>
                  ))}
                </span>
              </div>
              <div className="space-y-2">
                {PRESETS.map((p) => {
                  const z = sizeOption(p.id, reclaim, rounds);
                  return (
                    <label
                      key={p.id}
                      title={p.blurb}
                      className={`block cursor-pointer rounded-lg border px-2.5 py-2 text-xs ${presetId === p.id ? "border-amber-500/70 bg-amber-950/20" : "border-stone-800 hover:border-stone-700"}`}
                    >
                      <span className="flex items-center gap-2 text-sm">
                        <input type="radio" name="preset" checked={presetId === p.id} onChange={() => (setPresetId(p.id), setSure(false))} />
                        <b className="text-stone-100">{p.name}</b>
                        <span className="text-xs text-stone-400">· {p.id === "stretch" ? "sized for you" : solFine(FIXED_PER_TILE) + "/tile"}</span>
                      </span>
                      <span className="mt-1 block text-stone-300">
                        all {TILES} tiles · ≈{solFine(z.perTile)}/tile · ≈{z.rounds} rounds avg · fees ≈{pctStr(z.botFeePct)}%
                      </span>
                      {z.topUp > 0 && reclaim > 0 ? (
                        <span className="mt-0.5 block text-amber-300">
                          Needs {solFine(z.totalIn)} · burn gives {solFine(reclaim)} · add {solFine(z.topUp)} from wallet
                        </span>
                      ) : reclaim > 0 ? (
                        <span className="mt-0.5 block text-emerald-300">Needs {solFine(z.totalIn)} · covered by the burn</span>
                      ) : (
                        <span className="mt-0.5 block text-stone-400">
                          Needs {solFine(z.totalIn)} for {rounds} funded rounds
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
              {mine && walletBal != null && <div className="mt-2 text-[11px] text-stone-500">Wallet: {solFine(walletBal)} SOL</div>}
              {automation && <div className="mt-1 text-[11px] text-amber-300">You already auto-mine: this updates your settings and adds the SOL to that balance.</div>}
              <details className="mt-2 text-[11px] text-stone-500">
                <summary className="cursor-pointer select-none text-stone-400 hover:text-stone-300">ⓘ How it works</summary>
                <ul className="mt-1.5 list-disc space-y-1 pl-4">
                  {PRESETS.map((p) => (
                    <li key={p.id}>
                      <b className="text-stone-400">{p.name}</b> — {p.blurb}
                    </li>
                  ))}
                  <li>
                    Stretch is sized toward ≈ {STRETCH_ROUNDS} rounds on average, never below {solFine(STRETCH_MIN_PER_TILE)} SOL a tile.
                  </li>
                  <li>
                    Funded = full rounds even if none of them returns anything. With reload on, winnings flow back, so it keeps going until the balance can&apos;t load a full
                    round — the ≈ average is a guide; a run can be shorter or longer.
                  </li>
                  <li>
                    Both mine only while the motherlode is ≤ {PRESETS[0].conditions.maxMotherlode} ORE{motherlodeOre != null ? ` (now ${motherlodeOre.toFixed(1)} ORE)` : ""}.
                  </li>
                  {oneTime > 0 && <li>Your first auto-mine also opens your ORE account (≈ {solFine(oneTime)} SOL rent, returned when it closes).</li>}
                  <li>1% Dojo fee — same as ORE takes. Paid only when it works: once, on the mining deposit (nothing on the burns).</li>
                </ul>
              </details>
            </div>
          </aside>
      )}
      </div>
      </div>
      {scan && (sel.size > 0 || pendingMine) && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t border-stone-800 bg-stone-950/95 px-3 py-2 backdrop-blur md:hidden">
          <span className="min-w-0 flex-1 truncate text-xs text-stone-300">
            {pendingMine ? (
              <>
                top-up now <b className="text-amber-300">{solFine(pendingMine.s2.topUp)}</b>
              </>
            ) : (
              <>
                <b className="text-amber-300">{solFine(reclaim)}</b> back{sz.topUp > 0 ? <> · +{solFine(sz.topUp)} top-up</> : null}
              </>
            )}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-lg bg-gradient-to-r from-red-600 to-amber-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
            disabled={!api || working || !mine || (!!review && (!!busy || walletShort > 0))}
            onClick={() => {
              if (pendingMine) return void confirmPendingMine();
              if (!review) return void prepare();
              if (!sure) return document.getElementById("burn-sure")?.scrollIntoView({ block: "center", behavior: "smooth" });
              void burnAndMine();
            }}
          >
            {working ? "Working…" : !mine ? "Connect to burn" : pendingMine ? "⛏ Mine with these numbers" : "🔥 Burn & ⛏ Mine"}
          </button>
        </div>
      )}
    </section>
  );
}
