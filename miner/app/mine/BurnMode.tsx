"use client";

// Burn mode of /mine (/mine?burn=1 opens it directly; /mine/burn redirects here): burn the NFTs you don't want, then
// put the SOL that ACTUALLY came back into ORE auto-mining. The burn logic is the store's shared /dojo-burn.js
// (window.DojoBurn — the same module Dojo Sweep uses); the auto-mining step is this app's own Automate instruction.
// Two signing steps: the burns, then the miner. NFTs ticked on /sweep arrive pre-selected (sessionStorage), re-checked.
// The Dojo fee is charged ONCE here (owner 2026-10-27): 1% of the mining deposit (lib/minerTip) — the burns and closes
// are planned with { fee: false }.
import { useEffect, useMemo, useRef, useState } from "react";
import { LAMPORTS_PER_SOL, type TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { Flame, Pickaxe, Loader2 } from "lucide-react";
import { useWallet } from "@/lib/wallet-bridge";
import type { OreGameState } from "@/hooks/useOreGame";
import { automateIx, estimateRounds, SQUARES, EXECUTOR_FEE_LAMPORTS, STRATEGY_PREFERRED, STRATEGY_RANDOM, type AutomationConditions } from "@/lib/ore";
import { confirmAll, onRpcRetry, storeRpc as rpc, takeBurnPicks, thumb, useDojoBurn, type Plan, type ScanOut } from "@/lib/dojoBurn";
import { TIP_WALLET } from "@/lib/config";
import { depositWithin, dojoFeeIxs, dojoFeeOf, recordTip } from "@/lib/minerTip";

// ─── Mining presets (owner 2026-10-25/26) — ONE table of the miner's real Automate V2 fields ───────────────────
//   strategy  PREFERRED = the same `tiles` squares every round · RANDOM = `tiles` random squares on the first round, then
//             the bot picks up to soloTiles / splitTiles squares from each round's "solo" / "split" groups
//   perTileSol  SOL deployed on each tile per round · reload  winnings flow back into the balance
//   conditions  maxMotherlode: the program SKIPS a round while the motherlode is ABOVE this many ORE (mines while ≤ it);
//               minMotherlode: skips while BELOW · soloTiles / splitTiles: RANDOM only · maxProductionCost: stored, not
//               checked by deploy today (see AutomationConditions in lib/ore.ts)
type Preset = { id: string; name: string; blurb: string; tiles: number; strategy: number; perTileSol: number; reload: boolean; conditions: AutomationConditions };
export const PRESETS: Preset[] = [
  { id: "all25", name: "25 tiles", blurb: "Every tile, the smallest amount — the most rounds.", tiles: 25, strategy: STRATEGY_PREFERRED, perTileSol: 0.0002, reload: true, conditions: { maxMotherlode: 140 } },
  { id: "split15", name: "15 split tiles", blurb: "15 tiles from each round's split group.", tiles: 15, strategy: STRATEGY_RANDOM, perTileSol: 0.0004, reload: true, conditions: { maxMotherlode: 140, splitTiles: 15, soloTiles: 0 } },
  { id: "solo10", name: "10 solo tiles", blurb: "10 tiles from each round's solo group — fewer, larger.", tiles: 10, strategy: STRATEGY_RANDOM, perTileSol: 0.0005, reload: true, conditions: { maxMotherlode: 90, soloTiles: 10, splitTiles: 0 } },
];

const PAGE = 25;
const FEE = Number(EXECUTOR_FEE_LAMPORTS);
const lam = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);
const solStr = (lamports: number, dp = 4) => (lamports / LAMPORTS_PER_SOL).toFixed(dp);
const minDepositOf = (p: Preset) => lam(p.perTileSol) * p.tiles + FEE; // one full round + the bot's fee
const roundsOf = (p: Preset, depositLamports: number) => estimateRounds(depositLamports, lam(p.perTileSol), EXECUTOR_FEE_LAMPORTS, p.tiles);
const needOf = (p: Preset) => minDepositOf(p) + dojoFeeOf(minDepositOf(p)); // what has to come back: one round + its 1% fee
const isB58 = (s: string | null) => !!s && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

type Props = Pick<OreGameState, "connection" | "automation" | "motherlode"> & {
  busy: string | null;
  submit: (label: string, ixs: TransactionInstruction[]) => Promise<string | null>;
  onBack: () => void;
};

export function BurnMode({ connection, automation, motherlode, busy, submit, onBack }: Props) {
  const { publicKey, sendTransaction } = useWallet();
  const { api, error: loadErr } = useDojoBurn();

  const [viewWallet, setViewWallet] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanOut | null>(null);
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<{ kept: number; dropped: number } | null>(null);
  const [page, setPage] = useState(0);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [withEmpties, setWithEmpties] = useState(false);
  const [review, setReview] = useState<{ plan: Plan; closes: Plan | null; gain: number } | null>(null);
  const [sure, setSure] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<string>("");
  const [rescan, setRescan] = useState(0); // "Refresh" after a partly-read scan
  const sweepPicks = useRef<{ owner: string; mints: string[] } | null>(null); // kept so a Refresh re-ticks them

  const owner = publicKey ? publicKey.toBase58() : viewWallet;
  const mine = !!publicKey && owner === publicKey.toBase58();
  const preset = PRESETS.find((p) => p.id === presetId) || PRESETS[0];

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("wallet");
    if (isB58(q)) void Promise.resolve().then(() => setViewWallet(q)); // read-only view of a pasted wallet (?wallet=)
  }, []);
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
        }
      })
      .catch((e) => alive && (setErr("Couldn't read this wallet right now (" + (e?.message || e) + "). Try Refresh in a minute."), setStep("")));
    return () => {
      alive = false;
    };
  }, [api, owner, rescan]);

  const burnables = useMemo(() => (scan ? scan.nfts.filter((n) => n.burnable) : []), [scan]);
  const pages = Math.max(1, Math.ceil(burnables.length / PAGE));
  const shown = burnables.slice(page * PAGE, page * PAGE + PAGE);
  const chosen = burnables.filter((n) => sel.has(n.mint));
  const estLamports = chosen.reduce((t, n) => t + n.lamports, 0) + (withEmpties && scan ? scan.emptyLamports : 0);
  const reclaim = review ? review.gain : estLamports;
  const motherlodeOre = motherlode ? Number(motherlode) / 1e11 : null;

  const toggle = (m: string) => {
    if (working) return;
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
    setReview(null);
    setSel(new Set(burnables.filter((n) => n.junk >= 3).map((n) => n.mint)));
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
      const pre = (await rpc("getBalance", [me])).value as number;
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
      await confirmAll(sigs);
      const post = (await rpc("getBalance", [me])).value as number;
      const back = post - pre; // the SOL that ACTUALLY came back (after network fees)
      const min = minDepositOf(preset), deposit = depositWithin(back); // deposit + its 1% fee = what came back
      if (deposit < min) {
        setDone(`🔥 Burned — ${solStr(back)} SOL came back. That's below the ${solStr(needOf(preset))} SOL this setting needs for one round (with the 1% fee), so mining wasn't started; you can top up on the miner.`);
        return;
      }
      // Step 2: auto-mining with what came back — the deposit plus the 1% Dojo fee (+ the preacher's ddref memo), one tx
      setStep("Step 2 — set up auto-mining…");
      const squares =
        preset.strategy === STRATEGY_PREFERRED && preset.tiles === SQUARES
          ? Array.from({ length: SQUARES }, () => true)
          : (() => {
              const idx = Array.from({ length: SQUARES }, (_, i) => i).sort(() => Math.random() - 0.5).slice(0, preset.tiles);
              return Array.from({ length: SQUARES }, (_, i) => idx.includes(i));
            })();
      const fee = dojoFeeIxs(publicKey, deposit, TIP_WALLET);
      const sig = await submit("Start auto-mining", [
        automateIx({
          signer: publicKey,
          amountLamports: BigInt(lam(preset.perTileSol)),
          depositLamports: BigInt(deposit),
          feeLamports: EXECUTOR_FEE_LAMPORTS,
          squares,
          reload: preset.reload,
          strategy: preset.strategy,
          conditions: preset.conditions,
        }),
        ...fee.ixs,
      ]);
      if (sig && fee.feeLamports > 0) void recordTip(sig, me, fee.feeLamports / LAMPORTS_PER_SOL, "SOL");
      setDone(sig ? `🔥 Burned and ⛏ mining — ${solStr(deposit)} SOL went into auto-mining (${preset.name}), + ${solStr(fee.feeLamports, 6)} SOL Dojo fee.` : `🔥 Burned — ${solStr(back)} SOL came back. Auto-mining wasn't started (see the message above); you can start it on the miner.`);
    } catch (e) {
      setErr(((e as Error)?.message || String(e)).slice(0, 200));
    } finally {
      setStep("");
      setWorking(false);
    }
  }

  return (
    <section className="text-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-amber-300 sm:text-3xl">
          <Flame className="size-6 text-red-400 sm:size-7" /> Burn to Mine <Pickaxe className="size-5 text-amber-400 sm:size-6" />
        </h1>
        <button
          type="button"
          onClick={onBack}
          disabled={working}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          ⛏ Back to mining
        </button>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Burn the NFTs you don&apos;t want — every one gives back its rent — and mine ORE with that SOL. Tap tiles to choose; nothing is picked for you. Mining is a chance:
        rounds can lose, so only burn what you&apos;re happy to burn.
      </p>

      {!owner && <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/50 p-5 text-sm text-slate-300">Connect your wallet (top right) to see your burnable NFTs.</div>}
      {loadErr && <div className="mt-4 text-sm text-red-300">{loadErr}</div>}
      {err && <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">{err}</div>}
      {step && (
        <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
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
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-slate-400">
                {burnables.length} NFT{burnables.length === 1 ? "" : "s"} you could burn{owner && !mine ? " · viewing " + owner.slice(0, 4) + "…" + owner.slice(-4) : ""}
              </span>
              <span className="flex gap-2">
                <button className="rounded-md border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800" onClick={selectJunk} disabled={working}>
                  Select all likely spam
                </button>
                {sel.size > 0 && (
                  <button className="rounded-md border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800" onClick={() => (setSel(new Set()), setReview(null))} disabled={working}>
                    Clear
                  </button>
                )}
              </span>
            </div>
            {burnables.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 text-sm text-slate-400">Nothing here to burn — no spare NFTs outside Degen Dojo, Demon Dojo and TETO.</div>
            ) : (
              <div className="grid grid-cols-5 gap-2 sm:gap-2.5">
                {shown.map((n) => {
                  const on = sel.has(n.mint), im = thumb(n.image);
                  return (
                    <button
                      key={n.mint}
                      type="button"
                      onClick={() => toggle(n.mint)}
                      title={`${n.name}${n.collectionName ? " · " + n.collectionName : ""} — +${solStr(n.lamports)} SOL`}
                      className={`group relative aspect-square overflow-hidden rounded-lg bg-slate-900 ring-1 transition-all ${on ? "z-10 ring-2 ring-red-500 shadow-[0_0_18px_rgba(239,68,68,0.5)]" : "ring-slate-800 hover:ring-slate-600"}`}
                    >
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">no image</span>
                      {im && (
                        // a dead thumbnail (spam hosts vanish) hides itself, leaving the "no image" tile underneath
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={im} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} className={`absolute inset-0 size-full object-cover ${on ? "opacity-70" : ""}`} />
                      )}
                      {on && <span className="absolute inset-0 flex items-center justify-center text-2xl">🔥</span>}
                      {n.junk >= 3 && <span className="absolute right-1 top-1 rounded bg-amber-500/90 px-1 text-[8px] font-bold uppercase text-black">spam</span>}
                      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-1 pb-0.5 pt-3 text-left text-[9px] font-medium text-slate-100">{n.name}</span>
                    </button>
                  );
                })}
                {Array.from({ length: Math.max(0, PAGE - shown.length) }).map((_, i) => (
                  <div key={"e" + i} className="aspect-square rounded-lg bg-slate-900/40 ring-1 ring-slate-900" />
                ))}
              </div>
            )}
            {pages > 1 && (
              <div className="mt-3 flex items-center justify-center gap-3 text-sm">
                <button className="rounded-md border border-slate-700 px-3 py-1 disabled:opacity-40" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  ‹ Prev
                </button>
                <span className="text-slate-400">
                  Page {page + 1} of {pages}
                </span>
                <button className="rounded-md border border-slate-700 px-3 py-1 disabled:opacity-40" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                  Next ›
                </button>
              </div>
            )}
          </div>

          <aside className="space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="text-xs uppercase tracking-wider text-slate-500">Burning these gives back</div>
              <div className="mt-1 text-3xl font-bold tabular-nums text-amber-300">{solStr(reclaim)} SOL</div>
              <div className="text-xs text-slate-500">
                {sel.size} NFT{sel.size === 1 ? "" : "s"}
                {review ? " · measured by simulation" : " · their rent, before checking"}
              </div>
              {scan.emptyLamports > 0 && (
                <label className="mt-3 flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={withEmpties} onChange={(e) => (setWithEmpties(e.target.checked), setReview(null))} />
                  Also close {scan.empties.length} empty account{scan.empties.length === 1 ? "" : "s"} (+{solStr(scan.emptyLamports)} SOL)
                </label>
              )}
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="mb-2 text-xs uppercase tracking-wider text-slate-500">Mine ORE with it</div>
              <div className="space-y-2">
                {PRESETS.map((p) => {
                  const need = needOf(p), rounds = roundsOf(p, depositWithin(reclaim)), short = Math.max(0, need - reclaim);
                  return (
                    <label key={p.id} className={`block cursor-pointer rounded-lg border p-3 text-sm ${presetId === p.id ? "border-amber-500/70 bg-amber-950/20" : "border-slate-800 hover:border-slate-700"}`}>
                      <span className="flex items-center gap-2">
                        <input type="radio" name="preset" checked={presetId === p.id} onChange={() => (setPresetId(p.id), setSure(false))} />
                        <b className="text-slate-100">{p.name}</b>
                        <span className="ml-auto text-xs text-slate-400">{p.perTileSol} SOL/tile/round</span>
                      </span>
                      <span className="mt-1 block text-xs text-slate-400">
                        {p.blurb} Only while the motherlode is ≤ {p.conditions.maxMotherlode} ORE.
                      </span>
                      <span className="mt-1 block text-xs">
                        {reclaim > 0 && short === 0 ? (
                          <span className="text-emerald-300">
                            ≈ {rounds} round{rounds === 1 ? "" : "s"} (≈ {Math.round((rounds * 2.4) / 6) / 10} h at ~2.4 min a round)
                          </span>
                        ) : (
                          <span className="text-amber-300">
                            Needs {solStr(need)} SOL for one round{reclaim > 0 ? ` — ${solStr(short)} SOL more` : ""}
                            {scan.emptyLamports > 0 && !withEmpties ? " (try adding the empty-account rent)" : ""}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              {motherlodeOre != null && <div className="mt-2 text-xs text-slate-500">Motherlode now: {motherlodeOre.toFixed(1)} ORE</div>}
              {automation && <div className="mt-2 text-xs text-amber-300">You already auto-mine: this updates your settings and adds the SOL to that balance.</div>}
            </div>

            {!review ? (
              <button
                className="w-full rounded-xl bg-gradient-to-r from-red-600 to-amber-600 px-4 py-3 font-bold text-white disabled:opacity-40"
                disabled={!api || !sel.size || working || !mine}
                onClick={prepare}
              >
                {working ? "Checking…" : mine ? "🔥 Burn & ⛏ Mine — check first" : "Connect this wallet to burn"}
              </button>
            ) : (
              <div className="space-y-3 rounded-xl border border-red-900/60 bg-red-950/20 p-4 text-sm">
                <div>
                  <b>Step 1</b> — burn {review.plan.batches.reduce((t, b) => t + b.items.length, 0)} NFT{review.plan.batches.length === 1 ? "" : "s"}
                  {review.closes ? ` and close ${review.closes.batches.reduce((t, b) => t + b.items.length, 0)} empty accounts` : ""}: about <b>{solStr(review.gain)} SOL</b> back (
                  {review.plan.batches.length + (review.closes?.batches.length || 0)} transaction{review.plan.batches.length + (review.closes?.batches.length || 0) === 1 ? "" : "s"}).
                </div>
                {review.plan.dropped.length > 0 && <div className="text-xs text-amber-300">Left out: {review.plan.dropped.map((d) => d.item.name + " — " + d.reason).join("; ")}</div>}
                <div>
                  <b>Step 2</b> — auto-mine with exactly the SOL that comes back, setting <b>{preset.name}</b> ({preset.perTileSol} SOL a tile, {preset.tiles} tiles a round, only while the
                  motherlode is ≤ {preset.conditions.maxMotherlode} ORE). The 1% Dojo fee (≈ {solStr(dojoFeeOf(depositWithin(review.gain)), 6)} SOL) rides in that same
                  transaction.
                </div>
                <div className="text-xs text-red-200">⚠ Burning is permanent — these NFTs are destroyed for good. Mining is a chance: rounds can lose.</div>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I understand — burn them forever and mine with the SOL
                </label>
                <button className="w-full rounded-lg bg-red-600 px-4 py-2.5 font-bold text-white disabled:opacity-40" disabled={!sure || working || !!busy} onClick={burnAndMine}>
                  {working ? "Working…" : "🔥 Burn & ⛏ Mine"}
                </button>
              </div>
            )}

            <p className="text-xs text-slate-500">1% Dojo fee — same as ORE takes. Paid only when it works: once, on the mining deposit (nothing on the burns).</p>
          </aside>
        </div>
      )}
    </section>
  );
}
