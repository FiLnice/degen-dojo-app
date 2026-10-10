"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Loader2, Check, Copy, Rocket, ArrowLeft } from "lucide-react";
import { OreIcon } from "@/components/OreIcon";
import { StoreNav } from "@/components/StoreNav";
import { OPERATOR_WALLET, SETUP_FEE_ORE } from "@/lib/config";
import { createAtaIdempotentIx, oreTransferIx, ORE_DECIMALS } from "@/lib/ore";

type Tile = { mint: string; name: string; image: string };
const SQUARES = 25;
const REPO = "https://github.com/FiLnice/degen-dojo-ore";

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
    return image ? { mint, name, image } : null;
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

function envBlockFor(r: { name: string; tipWallet: string; rpc: string; degens: { name: string; image: string }[] }) {
  // NFT names almost always contain "#" (e.g. "Cool Ape #1234"), which .env parsers treat as a
  // comment — that would truncate the list and blank the grid. Single-quote the JSON value, and
  // swap any straight apostrophes to ’ so a name never closes the single-quote wrapper.
  const degensJson = JSON.stringify(
    r.degens.map((d) => ({ name: (d.name || "").replace(/'/g, "’"), image: d.image })),
  );
  return [
    `NEXT_PUBLIC_COLLECTION_NAME=${r.name}`,
    `NEXT_PUBLIC_TIP_WALLET=${r.tipWallet}`,
    `NEXT_PUBLIC_DEGENS_JSON='${degensJson}'`,
    `ALLOW_RPC_PROXY=1`,
    `HELIUS_RPC=${r.rpc}`,
  ].join("\n");
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
  const { publicKey, connected, sendTransaction } = useWallet();
  const connection = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
    return new Connection(`${origin}/api/rpc`, "confirmed");
  }, []);

  const [name, setName] = useState("");
  const [tipWallet, setTipWallet] = useState("");
  const [rpc, setRpc] = useState("");
  const [contact, setContact] = useState("");
  const [website, setWebsite] = useState("");
  const [hashlist, setHashlist] = useState("");
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collection, setCollection] = useState("");
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
          image: a.content?.links?.image || a.content?.files?.[0]?.cdn_uri || a.content?.files?.[0]?.uri || "",
        }))
        .filter((t) => t.image);
      if (found.length < SQUARES) {
        setError(`Found ${found.length} NFTs with art in that collection — need at least 25.`);
        return;
      }
      setPool(found);
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

  const infoValid =
    name.trim() && tipValid && rpc.trim().startsWith("http") && contact.trim() && tiles.length === SQUARES;
  const canPay = connected && !!operatorKey && infoValid && !busy;

  async function onPayAndSubmit() {
    if (!publicKey || !operatorKey) return;
    setError(null);
    setBusy("pay");
    try {
      // Pay the fee in ORE: make sure the operator's ORE account exists, then send it.
      const tx = new Transaction().add(
        createAtaIdempotentIx(publicKey, operatorKey),
        oreTransferIx(publicKey, operatorKey, BigInt(Math.round(SETUP_FEE_ORE * 10 ** ORE_DECIMALS))),
      );
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const sig = await sendTransaction(tx, connection);

      setBusy("confirm");
      const deadline = Date.now() + 60_000;
      for (;;) {
        const { value } = await connection.getSignatureStatus(sig);
        if (value?.err) throw new Error("Payment failed on-chain.");
        if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") break;
        if (Date.now() > deadline) throw new Error("Payment timed out — check your wallet.");
        await new Promise((r) => setTimeout(r, 1500));
      }

      setBusy("submit");
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          tipWallet: tipWallet.trim(),
          rpc: rpc.trim(),
          contact: contact.trim(),
          website: website.trim(),
          degens: tiles.map((t) => ({ name: t.name, image: t.image })),
          paymentSig: sig,
          payer: publicKey.toBase58(),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Submission failed.");
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
        <span className="text-amber-300">{SETUP_FEE_ORE} ORE</span> setup fee, and we&apos;ll review + approve
        it. You host it, so your tip wallet is always yours.
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
        <input value={rpc} onChange={(e) => setRpc(e.target.value)} placeholder="Your Helius mainnet RPC URL (https://mainnet.helius-rpc.com/?api-key=…)" className={field} />
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Contact — email / X / Discord (so we can reach you)" className={field} />
        <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Your website (optional)" className={field} />
        <p className="text-[11px] text-slate-500">
          Need a free RPC key? Grab one at{" "}
          <a href="https://helius.dev" target="_blank" rel="noopener noreferrer" className="text-sky-400 underline">
            helius.dev
          </a>
          .
        </p>
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
            <WalletMultiButton />
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
                    : `Pay ${SETUP_FEE_ORE} ORE & submit`}
          </button>
        )}
        {error && <p className="text-xs text-amber-300">{error}</p>}
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
  request?: { name: string; tipWallet: string; rpc: string; degens: { name: string; image: string }[] };
};

function StatusView({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<ReqData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/requests?id=${encodeURIComponent(id)}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "Not found.");
        if (alive) setData(j);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
        <ArrowLeft className="size-4" /> New request
      </button>

      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-center text-sm">
        <div className="text-[11px] uppercase tracking-wide text-slate-500">Request {id}</div>
        {error ? (
          <p className="mt-1 text-amber-300">{error}</p>
        ) : !data ? (
          <p className="mt-1 text-slate-400">Loading…</p>
        ) : data.status === "pending" ? (
          <p className="mt-1 text-amber-300">⏳ Pending review — we&apos;ll approve it shortly. This page updates automatically.</p>
        ) : data.status === "rejected" ? (
          <p className="mt-1 text-red-300">This request was declined. Reach out and we&apos;ll sort it.</p>
        ) : (
          <p className="mt-1 text-emerald-300">✅ Approved! Deploy it below.</p>
        )}
      </div>

      {data?.status === "approved" && data.request && (
        <section className="space-y-4 rounded-lg border border-emerald-800/40 bg-emerald-950/10 p-4">
          <ol className="list-decimal space-y-1 pl-4 text-xs text-slate-400">
            <li>Click <span className="text-slate-200">Deploy to Netlify</span> (forks it into your GitHub + Netlify).</li>
            <li>When it asks for environment variables, paste the block below.</li>
            <li>Deploy — no code, no files. Then link a &quot;Mine ORE&quot; button from your site.</li>
          </ol>
          <a
            href={`https://app.netlify.com/start/deploy?repository=${REPO}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-amber-500"
          >
            <Rocket className="size-4" /> Deploy to Netlify
          </a>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Environment variables — paste ALL into Netlify</span>
              <CopyButton text={envBlockFor(data.request)} />
            </div>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-3 text-[11px] text-slate-300">
              {envBlockFor(data.request)}
            </pre>
          </div>
        </section>
      )}
    </div>
  );
}
