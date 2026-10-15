"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
// The store's shared wallet session (same as /mine): embedded → window.DOJO_WALLET via
// wallet-picker.js, sending with signAndSendTransaction (the store /api/rpc refuses
// sendTransaction); standalone → the regular wallet-adapter.
import { useWallet } from "@/lib/wallet-bridge";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Loader2, Check, Copy, ArrowLeft, ExternalLink } from "lucide-react";
import { OreIcon } from "@/components/OreIcon";
import { StoreNav } from "@/components/StoreNav";
import { OPERATOR_WALLET, SETUP_FEE_ORE } from "@/lib/config";
import { createAtaIdempotentIx, oreTransferIx, ORE_DECIMALS } from "@/lib/ore";

type Tile = { mint: string; name: string; image: string };
const SQUARES = 25;
/** Store endpoint (scripts/store-fn-miner-requests.mjs) — verifies the fee on-chain + queues review. */
const REQUESTS_API = "/api/miner-requests";
/** A paid-but-not-yet-accepted signature, kept so a failed submit can retry WITHOUT paying twice. */
const PAID_KEY = "dd_create_paid_sig";
const isHttps = (u: string) => /^https:\/\//i.test(u);

let operatorKey: PublicKey | null = null;
try {
  operatorKey = OPERATOR_WALLET ? new PublicKey(OPERATOR_WALLET) : null;
} catch {
  operatorKey = null;
}

async function resolveMint(mint: string): Promise<Tile | null> {
  try {
    const res = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getAsset", params: { id: mint } }),
    });
    const j = await res.json();
    const a = j?.result;
    if (!a) return null;
    const image =
      a.content?.links?.image || a.content?.files?.[0]?.cdn_uri || a.content?.files?.[0]?.uri || "";
    const name = a.content?.metadata?.name || `${mint.slice(0, 4)}…`;
    return image && isHttps(image) ? { mint, name, image } : null;
  } catch {
    return null;
  }
}

type DasAsset = {
  id: string;
  burnt?: boolean;
  content?: { metadata?: { name?: string }; links?: { image?: string }; files?: { uri?: string; cdn_uri?: string }[] };
};

function shuffled<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
    >
      {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ─── Page: form, or status view when ?id=<id> ────────────────────────────────
export default function CreatePage() {
  const [mounted, setMounted] = useState(false);
  const [reqId, setReqId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setReqId(id);
  }, []);

  if (!mounted) return <main className="min-h-screen" />;

  return (
    <>
    <StoreNav />
    <main className="min-h-screen px-5 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-2 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-600/30 bg-amber-600/10 px-3 py-1 text-xs text-amber-300">
            <OreIcon className="size-3.5" /> Whitelabel ORE mining
          </div>
          <h1 className="text-2xl font-semibold text-slate-100 sm:text-3xl">
            {reqId ? "Your request" : "Create your miner"}
          </h1>
        </header>
        {reqId ? (
          <StatusView
            id={reqId}
            onBack={() => {
              window.history.pushState({}, "", "/create");
              setReqId(null);
            }}
          />
        ) : (
          <RequestForm
            onSubmitted={(id) => {
              window.history.pushState({}, "", `/create?id=${id}`);
              setReqId(id);
            }}
          />
        )}
      </div>
    </main>
    </>
  );
}

// ─── The paid request form ───────────────────────────────────────────────────
function RequestForm({ onSubmitted }: { onSubmitted: (id: string) => void }) {
  const { publicKey, connected, sendTransaction, embedded, select } = useWallet();
  const connection = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
    return new Connection(`${origin}/api/rpc`, "confirmed");
  }, []);

  const [name, setName] = useState("");
  const [tipWallet, setTipWallet] = useState("");
  const [contact, setContact] = useState("");
  // A fee already paid (confirmed) whose submission failed — retry without paying again.
  const [paidSig, setPaidSig] = useState<string | null>(() => {
    try {
      return typeof window !== "undefined" ? sessionStorage.getItem(PAID_KEY) : null;
    } catch {
      return null;
    }
  });
  const [website, setWebsite] = useState("");
  const [hashlist, setHashlist] = useState("");
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collection, setCollection] = useState("");
  const [collectionAddr, setCollectionAddr] = useState(""); // last successfully loaded collection
  const [pool, setPool] = useState<Tile[]>([]);

  function pickFromPool(from: Tile[]) {
    const picked = shuffled(from).slice(0, SQUARES);
    setTiles(picked);
    setHashlist(picked.map((t) => t.mint).join("\n"));
  }

  // Paste a collection address → read its NFTs (DAS getAssetsByGroup) → 25 random ones on the grid.
  async function onLoadCollection() {
    setError(null);
    let addr: string;
    try {
      addr = new PublicKey(collection.trim()).toBase58();
    } catch {
      setError("That isn't a valid collection address.");
      return;
    }
    setBusy("collection");
    try {
      const res = await fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "getAssetsByGroup",
          params: { groupKey: "collection", groupValue: addr, page: 1, limit: 1000 },
        }),
      });
      const j = await res.json();
      const items: DasAsset[] = j?.result?.items ?? [];
      const found = items
        .filter((a) => !a.burnt)
        .map((a) => ({
          mint: a.id,
          name: a.content?.metadata?.name || `${a.id.slice(0, 4)}…`,
          // First https candidate — the hosted page can't show http/ipfs:// art (mixed content).
          image:
            [a.content?.links?.image, a.content?.files?.[0]?.cdn_uri, a.content?.files?.[0]?.uri].find(
              (u): u is string => !!u && isHttps(u),
            ) || "",
        }))
        .filter((t) => t.image);
      if (found.length < SQUARES) {
        setError(`Found ${found.length} NFTs with art in that collection — need at least 25.`);
        return;
      }
      setPool(found);
      setCollectionAddr(addr);
      pickFromPool(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }


  const mints = useMemo(
    () => hashlist.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    [hashlist],
  );
  const tipValid = useMemo(() => {
    try {
      new PublicKey(tipWallet.trim());
      return true;
    } catch {
      return false;
    }
  }, [tipWallet]);

  async function onPreview() {
    setError(null);
    setTiles([]);
    if (mints.length !== SQUARES) {
      setError(`Paste exactly 25 mint addresses — you have ${mints.length}.`);
      return;
    }
    setBusy("preview");
    try {
      const resolved = (await mapLimit(mints, 5, resolveMint)).filter(Boolean) as Tile[];
      setTiles(resolved);
      if (resolved.length < SQUARES)
        setError(`Only ${resolved.length}/25 resolved — check those are valid NFT mints.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const infoValid = name.trim() && tipValid && contact.trim() && tiles.length === SQUARES;
  const canPay = connected && !!operatorKey && infoValid && !busy;

  function rememberPaid(sig: string | null) {
    setPaidSig(sig);
    try {
      if (sig) sessionStorage.setItem(PAID_KEY, sig);
      else sessionStorage.removeItem(PAID_KEY);
    } catch {
      /* private mode — the in-memory copy still covers this visit */
    }
  }

  async function onPayAndSubmit() {
    if (!publicKey || !operatorKey) return;
    setError(null);
    try {
      let sig = paidSig;
      if (!sig) {
        setBusy("pay");
        // Pay the fee in ORE: make sure the operator's ORE account exists, then send it.
        const tx = new Transaction().add(
          createAtaIdempotentIx(publicKey, operatorKey),
          oreTransferIx(publicKey, operatorKey, BigInt(Math.round(SETUP_FEE_ORE * 10 ** ORE_DECIMALS))),
        );
        tx.feePayer = publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        // Simulate first so a wallet without enough ORE gets a clear message, not a failed tx.
        const sim = await connection.simulateTransaction(tx);
        if (sim.value.err)
          throw new Error(`You need ${SETUP_FEE_ORE} ORE (plus a little SOL for fees) in this wallet to pay the setup fee.`);
        const sent = await sendTransaction(tx, connection);

        setBusy("confirm");
        const deadline = Date.now() + 60_000;
        for (;;) {
          const { value } = await connection.getSignatureStatus(sent);
          if (value?.err) throw new Error("Payment failed on-chain.");
          if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") break;
          if (Date.now() > deadline) throw new Error("Payment timed out — check your wallet.");
          await new Promise((r) => setTimeout(r, 1500));
        }
        sig = sent;
        rememberPaid(sig);
      }

      setBusy("submit");
      const res = await fetch(REQUESTS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          tipWallet: tipWallet.trim(),
          contact: contact.trim(),
          website: website.trim(),
          collection: collectionAddr,
          degens: tiles.map((t) => ({ name: t.name, image: t.image, mint: t.mint })),
          paymentSig: sig,
          payer: publicKey.toBase58(),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !j.id) {
        // Already accepted (e.g. a double click) or verifiably bad → don't keep retrying this sig.
        if (res.status === 409) rememberPaid(null);
        throw new Error(j.error || "Submission failed.");
      }
      rememberPaid(null);
      onSubmitted(j.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const field =
    "w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500";

  return (
    <div className="space-y-6">
      <p className="text-center text-sm text-slate-400">
        Put your collection&apos;s art on an ORE mining grid. Fill this in, pay the one-time{" "}
        <span className="text-amber-300">{SETUP_FEE_ORE} ORE</span>{" "}setup fee, and we&apos;ll review it and host
        your miner at <span className="text-slate-200">store.degendojo.xyz/m/your-name</span>. Tips go straight to
        your wallet.
      </p>

      {/* details */}
      <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="text-sm font-medium text-slate-200">1 · Your collection</h2>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Collection name (e.g. Cool Apes)" className={field} />
        <div>
          <input
            value={tipWallet}
            onChange={(e) => setTipWallet(e.target.value)}
            placeholder="Tip wallet — your Solana address (receives the tips)"
            className={`${field} ${tipWallet && !tipValid ? "border-red-600/60" : ""}`}
          />
          {tipWallet && !tipValid && <p className="mt-1 text-[11px] text-red-400">Not a valid Solana address.</p>}
        </div>
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Contact — email / X / Discord (so we can reach you)" className={field} />
        <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Your website (optional)" className={field} />
      </section>

      {/* NFTs */}
      <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-slate-200">2 · Your 25 NFTs</h2>
          <span className={`text-xs ${mints.length === SQUARES ? "text-emerald-300" : "text-slate-500"}`}>
            {mints.length}/25 mints
          </span>
        </div>
        <div className="flex gap-2">
          <input
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="Paste your collection address — we pick 25 NFTs for you"
            className={field}
          />
          <button
            onClick={onLoadCollection}
            disabled={busy === "collection" || !collection.trim()}
            className={`inline-flex shrink-0 items-center gap-2 rounded px-4 text-sm font-medium transition-colors ${
              busy === "collection" || !collection.trim()
                ? "cursor-not-allowed bg-slate-800 text-slate-500"
                : "bg-amber-600 text-white hover:bg-amber-500"
            }`}
          >
            {busy === "collection" && <Loader2 className="size-4 animate-spin" />}
            Load
          </button>
        </div>
        {pool.length > SQUARES && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400">{pool.length} NFTs found.</span>
            <button onClick={() => pickFromPool(pool)} className="rounded border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800">
              Shuffle
            </button>
          </div>
        )}
        <p className="text-[11px] text-slate-500">Or pick them yourself:</p>
        <textarea
          value={hashlist}
          onChange={(e) => setHashlist(e.target.value)}
          rows={5}
          placeholder={"Paste 25 NFT mint addresses — one per line"}
          className="w-full resize-y rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
        />
        <button
          onClick={onPreview}
          disabled={busy === "preview" || mints.length !== SQUARES}
          className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
            busy === "preview" || mints.length !== SQUARES
              ? "cursor-not-allowed bg-slate-800 text-slate-500"
              : "bg-sky-600 text-white hover:bg-sky-500"
          }`}
        >
          {busy === "preview" && <Loader2 className="size-4 animate-spin" />}
          {busy === "preview" ? "Fetching artwork…" : "Preview the grid"}
        </button>
        {tiles.length > 0 && (
          <div className="grid grid-cols-5 gap-2">
            {tiles.map((t, i) => (
              <div key={t.mint || i} title={t.name} className="relative aspect-square overflow-hidden rounded-lg bg-slate-900 ring-1 ring-slate-800">
                <Image src={t.image} alt={t.name} fill sizes="90px" className="object-cover" />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* pay */}
      <section className="space-y-3 rounded-lg border border-amber-800/40 bg-amber-950/10 p-4">
        <h2 className="text-sm font-medium text-amber-200">3 · Pay {SETUP_FEE_ORE} ORE & submit</h2>
        {!operatorKey ? (
          <p className="text-xs text-slate-400">Signups aren&apos;t open yet — check back soon.</p>
        ) : !connected ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-slate-400">Connect your wallet to pay.</p>
            {embedded ? (
              // Inside the store: open the store's shared wallet picker (same session as every page).
              <button
                onClick={() => select?.()}
                className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-medium text-white hover:bg-amber-500"
              >
                Connect wallet
              </button>
            ) : (
              <WalletMultiButton />
            )}
          </div>
        ) : (
          <button
            onClick={onPayAndSubmit}
            disabled={!canPay}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
              !canPay ? "cursor-not-allowed bg-slate-800 text-slate-500" : "bg-amber-600 text-white hover:bg-amber-500"
            }`}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy === "pay"
              ? "Approve payment in wallet…"
              : busy === "confirm"
                ? "Confirming payment…"
                : busy === "submit"
                  ? "Submitting…"
                  : !infoValid
                    ? "Fill everything + preview the grid"
                    : paidSig
                      ? "Already paid — submit request"
                      : `Pay ${SETUP_FEE_ORE} ORE & submit`}
          </button>
        )}
        {error && <p className="text-xs text-amber-300">{error}</p>}
        {paidSig && !busy && (
          <p className="text-[11px] text-slate-500">
            Your fee payment{" "}
            <a
              href={`https://solscan.io/tx/${paidSig}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 underline"
            >
              {paidSig.slice(0, 8)}…
            </a>{" "}
            is saved, so retrying won&apos;t charge you again.{" "}
            <button onClick={() => rememberPaid(null)} className="text-slate-400 underline hover:text-slate-200">
              Forget it and pay again
            </button>
          </p>
        )}
      </section>

      <p className="text-center text-[11px] text-slate-600">
        Grid mining stakes real SOL — 24 of 25 tiles lose each round. Your community owns that risk. Not
        financial advice.
      </p>
    </div>
  );
}

// ─── Status view (after submit, or via ?id=) ─────────────────────────────────
type ReqData = {
  status: "pending" | "approved" | "rejected";
  name?: string;
  slug?: string;
  url?: string;
};

function StatusView({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<ReqData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setInterval> | undefined;
    const load = async () => {
      try {
        const res = await fetch(`${REQUESTS_API}?id=${encodeURIComponent(id)}`, { cache: "no-store" });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "Not found.");
        if (!alive) return;
        setError(null);
        setData(j);
        if (j.status !== "pending" && t) clearInterval(t); // decided — stop polling
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  // Always show the link on THIS origin (store.degendojo.xyz in production).
  const liveUrl = data?.slug ? `${window.location.origin}/m/${data.slug}` : "";

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
        <ArrowLeft className="size-4" /> New request
      </button>

      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-center text-sm">
        <div className="text-[11px] uppercase tracking-wide text-slate-500">
          Request {id}
          {data?.name ? ` · ${data.name}` : ""}
        </div>
        {error ? (
          <p className="mt-1 text-amber-300">{error}</p>
        ) : !data ? (
          <p className="mt-1 text-slate-400">Loading…</p>
        ) : data.status === "pending" ? (
          <p className="mt-1 text-amber-300">⏳ Pending review — we&apos;ll approve it shortly. This page updates automatically.</p>
        ) : data.status === "rejected" ? (
          <p className="mt-1 text-red-300">This request was declined. Reach out and we&apos;ll sort it.</p>
        ) : (
          <p className="mt-1 text-emerald-300">✅ Approved — your miner is live!</p>
        )}
      </div>

      {data?.status === "approved" && liveUrl && (
        <section className="space-y-3 rounded-lg border border-emerald-800/40 bg-emerald-950/10 p-4">
          <div className="text-xs text-slate-400">Your miner&apos;s link — share it, or add a &quot;Mine ORE&quot; button on your site:</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-slate-950 px-3 py-2 text-sm text-emerald-300">{liveUrl}</code>
            <CopyButton text={liveUrl} />
          </div>
          <a
            href={liveUrl}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-amber-500"
          >
            <ExternalLink className="size-4" /> Open your miner
          </a>
          <p className="text-[11px] text-slate-500">Tips your miners add go straight to the tip wallet you set.</p>
        </section>
      )}
    </div>
  );
}
