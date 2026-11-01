"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
// The store's shared wallet session (same as /mine): embedded → window.DOJO_WALLET via
// wallet-picker.js, sending with signAndSendTransaction (the store /api/rpc refuses
// sendTransaction); standalone → the regular wallet-adapter.
import { useWallet } from "@/lib/wallet-bridge";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Loader2, Check, Copy, ArrowLeft, ExternalLink } from "lucide-react";
import { OreIcon } from "@/components/OreIcon";
import { StoreNav } from "@/components/StoreNav";
import { MineScreen } from "@/app/mine/MineScreen";
import { OPERATOR_WALLET, SETUP_FEE_ORE } from "@/lib/config";
import { createAtaIdempotentIx, oreTransferIx, ORE_DECIMALS, MEMO_PROGRAM_ID } from "@/lib/ore";

type Tile = { mint: string; name: string; image: string };
const SQUARES = 25;
/** Store endpoint (scripts/store-fn-miner-requests.mjs) — verifies the fee on-chain + queues review. */
const REQUESTS_API = "/api/miner-requests";
/** The miner page's own colour: left as is, no ?bg= goes in the link. */
const DEFAULT_BG = "#0c0a08";
/** A paid-but-not-yet-accepted signature, kept so a failed submit can retry WITHOUT paying twice. */
const PAID_KEY = "dd_create_paid_sig";
/** …and the exact request that payment was made for (the payment's memo commits to it). */
const PAID_BODY_KEY = "dd_create_paid_body";
const isHttps = (u: string) => /^https:\/\//i.test(u);
/** Solana addresses in anything pasted: lines, commas, a JSON array… */
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

type ReqBody = {
  name: string; contact: string; website: string; collection: string;
  degens: { name: string; image: string; mint: string }[]; payer: string;
};
/** The payer commits to the exact request inside the payment: memo "ddminer:<this hash>". The store accepts a
 *  request only when its own hash is in that memo (front-run guard) — MUST match minerRequestHash in
 *  bulkitor/scripts/store-miner-core.mjs: sha256 of this JSON, first 32 hex characters. */
async function requestHash(b: ReqBody): Promise<string> {
  const s = (v: unknown) => String(v ?? "").trim();
  const tiles = b.degens.map((d) => [s(d.mint), s(d.image)]);
  const data = new TextEncoder().encode(JSON.stringify([2, s(b.name), s(b.contact), s(b.website), s(b.collection), s(b.payer), tiles]));
  const dig = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(dig, (x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

let operatorKey: PublicKey | null = null;
try {
  operatorKey = OPERATOR_WALLET ? new PublicKey(OPERATOR_WALLET) : null;
} catch {
  operatorKey = null;
}

type DasAsset = {
  id: string;
  burnt?: boolean;
  content?: { metadata?: { name?: string }; links?: { image?: string }; files?: { uri?: string; cdn_uri?: string }[] };
};
async function das<T>(method: string, params: unknown): Promise<T | undefined> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  if (!res.ok) throw new Error("Couldn't read that right now — try again in a moment.");
  return (await res.json())?.result;
}
function assetTile(a: DasAsset): Tile | null {
  // First https candidate — the hosted page can't show http/ipfs:// art (mixed content).
  const image = [a.content?.links?.image, a.content?.files?.[0]?.cdn_uri, a.content?.files?.[0]?.uri].find(
    (u): u is string => !!u && isHttps(u),
  );
  return image && !a.burnt ? { mint: a.id, name: a.content?.metadata?.name || `${a.id.slice(0, 4)}…`, image } : null;
}

function shuffled<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
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

  if (!reqId)
    return (
      <RequestForm
        onSubmitted={(id) => {
          window.history.pushState({}, "", `/create?id=${id}`);
          setReqId(id);
        }}
      />
    );

  return (
    <>
    <StoreNav />
    <main className="min-h-screen px-5 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-2 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-600/30 bg-amber-600/10 px-3 py-1 text-xs text-amber-300">
            <OreIcon className="size-3.5" /> Whitelabel ORE mining
          </div>
          <h1 className="text-2xl font-semibold text-slate-100 sm:text-3xl">Your request</h1>
        </header>
        <StatusView
          id={reqId}
          onBack={() => {
            window.history.pushState({}, "", "/create");
            setReqId(null);
          }}
        />
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
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collectionAddr, setCollectionAddr] = useState(""); // the collection on the grid, when it came from one
  const [pool, setPool] = useState<Tile[]>([]); // that collection's NFTs…
  const [listMints, setListMints] = useState<string[]>([]); // …or the pasted hashlist
  const pasteRun = useRef(0); // a newer paste outdates whatever is still loading
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function clearGrid() {
    setTiles([]);
    setPool([]);
    setListMints([]);
    setCollectionAddr("");
  }
  function failPaste(run: number, message: string) {
    if (run !== pasteRun.current) return;
    clearGrid();
    setPasteError(message);
  }

  // One box: a collection address, or a hashlist of any length. No button: the grid fills itself.
  function onPaste(text: string) {
    setPaste(text);
    setPasteError(null);
    clearTimeout(pasteTimer.current);
    const run = ++pasteRun.current;
    const addrs = [...new Set(text.match(ADDRESS) ?? [])];
    if (addrs.length === 0) {
      setBusy(null);
      clearGrid();
      if (text.trim()) setPasteError("That isn't a collection address or a hashlist.");
      return;
    }
    pasteTimer.current = setTimeout(() => void (addrs.length === 1 ? loadCollection(addrs[0], run) : loadHashlist(addrs, run)), 400);
  }

  // A collection address → its NFTs (DAS getAssetsByGroup) → 25 random ones on the grid.
  async function loadCollection(addr: string, run: number) {
    setBusy("loading");
    try {
      const r = await das<{ items?: DasAsset[] }>("getAssetsByGroup", { groupKey: "collection", groupValue: addr, page: 1, limit: 1000 });
      const found = (r?.items ?? []).flatMap((a) => assetTile(a) ?? []);
      if (run !== pasteRun.current) return;
      if (found.length < SQUARES) return failPaste(run, `Found ${found.length} NFTs with art there — need at least 25.`);
      setListMints([]);
      setPool(found);
      setCollectionAddr(addr);
      setTiles(shuffled(found).slice(0, SQUARES));
    } catch (e) {
      failPaste(run, e instanceof Error ? e.message : String(e));
    } finally {
      if (run === pasteRun.current) setBusy(null);
    }
  }

  // A hashlist → a random 25 of it; a mint with no usable art is replaced by the next one.
  async function loadHashlist(all: string[], run: number) {
    if (all.length < SQUARES) return failPaste(run, `That hashlist has ${all.length} mints — need at least 25.`);
    setBusy("loading");
    try {
      const order = shuffled(all);
      const got: Tile[] = [];
      for (let next = 0; run === pasteRun.current && got.length < SQUARES && next < Math.min(order.length, SQUARES * 4); ) {
        const ids = order.slice(next, next + SQUARES - got.length);
        next += ids.length;
        const found = await das<(DasAsset | null)[]>("getAssetBatch", { ids });
        got.push(...(found ?? []).flatMap((a) => (a && assetTile(a)) ?? []));
      }
      if (run !== pasteRun.current) return;
      if (got.length < SQUARES) return failPaste(run, `Only ${got.length} of those have art we can show — need 25.`);
      setPool([]);
      setCollectionAddr("");
      setListMints(all);
      setTiles(got);
    } catch (e) {
      failPaste(run, e instanceof Error ? e.message : String(e));
    } finally {
      if (run === pasteRun.current) setBusy(null);
    }
  }

  const foundCount = pool.length || listMints.length;
  function onShuffle() {
    if (pool.length) setTiles(shuffled(pool).slice(0, SQUARES));
    else void loadHashlist(listMints, ++pasteRun.current);
  }

  const infoValid = name.trim() && contact.trim() && tiles.length === SQUARES;
  const canPay = connected && !!operatorKey && infoValid && !busy;
  const paying = busy === "pay" || busy === "confirm" || busy === "submit";

  function rememberPaid(sig: string | null, body?: ReqBody) {
    setPaidSig(sig);
    try {
      if (sig) sessionStorage.setItem(PAID_KEY, sig);
      else sessionStorage.removeItem(PAID_KEY);
      if (sig && body) sessionStorage.setItem(PAID_BODY_KEY, JSON.stringify(body));
      if (!sig) sessionStorage.removeItem(PAID_BODY_KEY);
    } catch {
      /* private mode — the in-memory copy still covers this visit */
    }
  }
  function paidBody(): ReqBody | null {
    try {
      const v = sessionStorage.getItem(PAID_BODY_KEY);
      return v ? (JSON.parse(v) as ReqBody) : null;
    } catch {
      return null;
    }
  }

  async function onPayAndSubmit() {
    if (!publicKey || !operatorKey) return;
    setError(null);
    try {
      let sig = paidSig;
      // a retry after a failed submit sends exactly the request that was paid for (the memo commits to it)
      let body: ReqBody = (sig && paidBody()) || {
        name: name.trim(),
        contact: contact.trim(),
        website: website.trim(),
        collection: collectionAddr,
        degens: tiles.map((t) => ({ name: t.name, image: t.image, mint: t.mint })),
        payer: publicKey.toBase58(),
      };
      if (!sig) {
        setBusy("pay");
        body = { ...body, payer: publicKey.toBase58() };
        // Pay the fee in ORE: make sure the operator's ORE account exists, then send it — with a memo that
        // commits this payment to THIS request, so nobody else can file a different request against it.
        const memo = new TransactionInstruction({
          programId: MEMO_PROGRAM_ID,
          keys: [],
          data: Buffer.from("ddminer:" + (await requestHash(body)), "utf8"),
        });
        const tx = new Transaction().add(
          createAtaIdempotentIx(publicKey, operatorKey),
          oreTransferIx(publicKey, operatorKey, BigInt(Math.round(SETUP_FEE_ORE * 10 ** ORE_DECIMALS))),
          memo,
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
        rememberPaid(sig, body);
      }

      setBusy("submit");
      const res = await fetch(REQUESTS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, paymentSig: sig }),
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
    "w-full rounded border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 outline-none focus:border-amber-500";

  return (
    <MineScreen
      previewDegens={tiles}
      header={
        <section className="space-y-2 rounded-lg border border-stone-800 bg-stone-900/40 p-4">
          <h1 className="text-lg font-semibold text-stone-100 sm:text-xl">Create your miner</h1>
          <p className="text-xs text-stone-400">
            Paste your collection address or hashlist to see how it will look on the grid. Like it? Fill in your details below, pay
            the one-time <span className="text-amber-300">{SETUP_FEE_ORE} ORE</span> setup fee and we&apos;ll host it at{" "}
            <span className="text-stone-200">store.degendojo.xyz/m/your-name</span>, ready to embed on your own website. Miners pay
            the same 1% fee as on our own miner.
          </p>
          <textarea
            value={paste}
            onChange={(e) => onPaste(e.target.value)}
            disabled={paying}
            rows={2}
            spellCheck={false}
            aria-label="Your collection address or hashlist"
            placeholder="Paste your collection address or hashlist"
            className="w-full resize-y rounded border border-stone-700 bg-stone-950 px-3 py-2 font-mono text-xs text-stone-100 outline-none focus:border-amber-500"
          />
          {busy === "loading" ? (
            <p className="inline-flex items-center gap-2 text-xs text-stone-400">
              <Loader2 className="size-3.5 animate-spin" /> Putting your NFTs on the grid…
            </p>
          ) : pasteError ? (
            <p className="text-xs text-amber-300">{pasteError}</p>
          ) : tiles.length === SQUARES ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-stone-400">Your NFTs are on the grid.</span>
              {foundCount > SQUARES && (
                <button onClick={onShuffle} className="rounded border border-stone-700 px-3 py-1.5 text-stone-200 hover:bg-stone-800">
                  Shuffle
                </button>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-stone-500">Degen Dojo is shown as the example.</p>
          )}
        </section>
      }
      footer={
        <>
          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      {/* details */}
      <section className="space-y-3 rounded-lg border border-stone-800 bg-stone-900/40 p-4">
        <h2 className="text-sm font-medium text-stone-200">Your details</h2>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Collection name (e.g. Cool Apes)" className={field} />
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Contact — email / X / Discord (so we can reach you)" className={field} />
        <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Your website (optional)" className={field} />
      </section>

      {/* pay */}
      <section className="space-y-3 rounded-lg border border-amber-800/40 bg-amber-950/10 p-4">
        <h2 className="text-sm font-medium text-amber-200">Pay {SETUP_FEE_ORE} ORE & submit</h2>
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
                    ? "Paste your NFTs + fill in your details"
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
          </div>

      <p className="text-center text-[11px] text-stone-600">
        Grid mining stakes real SOL — each round ORE keeps about a tenth of it as fees, and only 1 of 25 tiles mines ORE. Your community owns that risk. Not
        financial advice.
      </p>
        </>
      }
    />
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

  // Always show the link on THIS origin (store.degendojo.xyz in production). A background colour other than the default rides in it.
  const [bg, setBg] = useState(DEFAULT_BG);
  const liveUrl = data?.slug ? `${window.location.origin}/m/${data.slug}${bg === DEFAULT_BG ? "" : `?bg=${bg.slice(1)}`}` : "";
  const embedCode = `<iframe src="${liveUrl}" width="100%" height="1250" style="border:0" title="ORE miner"></iframe>`;

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
          <div className="text-xs text-slate-400">Or put it on your website — paste this where the miner should appear:</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-slate-950 px-3 py-2 text-sm text-emerald-300">{embedCode}</code>
            <CopyButton text={embedCode} />
          </div>
          <div className="text-[11px] text-slate-500">
            WordPress: add a Custom HTML block and paste it there. WordPress.com&apos;s free plan removes embeds, so use your link instead.
            On any website, Connect opens your miner in a new tab.
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="color"
              value={bg}
              onChange={(e) => setBg(e.target.value)}
              className="h-7 w-10 cursor-pointer rounded border border-slate-700 bg-transparent"
            />
            Background colour. Dark colours work best, as the miner&apos;s text is light.
          </label>
          <a
            href={liveUrl}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-amber-500"
          >
            <ExternalLink className="size-4" /> Open your miner
          </a>
        </section>
      )}
    </div>
  );
}
