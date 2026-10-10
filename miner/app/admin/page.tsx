/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useState } from "react";
import { Loader2, Check, X, ExternalLink } from "lucide-react";

type Req = {
  id: string;
  name: string;
  tipWallet: string;
  rpc: string;
  contact: string;
  website: string;
  degens: { name: string; image: string }[];
  paymentSig: string;
  payer: string;
  feeOre: number;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
};

export default function AdminPage() {
  const [mounted, setMounted] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    setKey(new URLSearchParams(window.location.search).get("key"));
  }, []);

  useEffect(() => {
    if (!key) return;
    const load = async () => {
      try {
        const res = await fetch(`/api/requests?admin=${encodeURIComponent(key)}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "unauthorized");
        setReqs(j.requests);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [key]);

  async function decide(id: string, action: "approve" | "reject") {
    if (!key) return;
    setBusy(id + action);
    try {
      const res = await fetch("/api/requests/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, key, action }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "failed");
      setReqs((prev) => prev?.map((r) => (r.id === id ? { ...r, status: j.status } : r)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!mounted) return <main className="min-h-screen" />;
  if (!key)
    return (
      <main className="grid min-h-screen place-items-center px-5 text-center text-sm text-slate-400">
        Add <code className="mx-1 text-slate-200">?key=YOUR_ADMIN_KEY</code> to the URL.
      </main>
    );

  return (
    <main className="min-h-screen px-5 py-10">
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold text-slate-100">Miner requests</h1>
        {error && <p className="text-sm text-amber-300">{error}</p>}
        {reqs === null && !error && (
          <p className="inline-flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {reqs?.length === 0 && <p className="text-sm text-slate-500">No requests yet.</p>}

        {reqs?.map((r) => (
          <div key={r.id} className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm">
            <div className="flex items-center justify-between">
              <div className="font-medium text-slate-100">
                {r.name} <span className="text-xs text-slate-500">· {r.id}</span>
              </div>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  r.status === "approved"
                    ? "bg-emerald-600/20 text-emerald-300"
                    : r.status === "rejected"
                      ? "bg-red-600/20 text-red-300"
                      : "bg-amber-600/20 text-amber-300"
                }`}
              >
                {r.status}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-1 text-xs text-slate-400 sm:grid-cols-2">
              <div>Tip: <span className="font-mono text-slate-300">{r.tipWallet}</span></div>
              <div>Contact: <span className="text-slate-300">{r.contact}</span></div>
              <div>Paid: {r.feeOre} ORE by <span className="font-mono">{r.payer.slice(0, 6)}…</span></div>
              <div>
                <a href={`https://solscan.io/tx/${r.paymentSig}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-400 underline">
                  verify payment <ExternalLink className="size-3" />
                </a>
              </div>
              {r.website && (
                <div>
                  Site:{" "}
                  <a href={r.website} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline">
                    {r.website}
                  </a>
                </div>
              )}
              <div>RPC: <span className="text-slate-300">{r.rpc.replace(/api-key=.*/i, "api-key=…")}</span></div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {r.degens.slice(0, 12).map((d, i) => (
                <div key={i} className="relative size-8 overflow-hidden rounded ring-1 ring-slate-800">
                  <img src={d.image} alt="" className="h-full w-full object-cover" loading="lazy" />
                </div>
              ))}
              {r.degens.length > 12 && <span className="text-xs text-slate-500">+{r.degens.length - 12}</span>}
            </div>

            {r.status === "pending" && (
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => decide(r.id, "approve")}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy === r.id + "approve" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Approve
                </button>
                <button
                  onClick={() => decide(r.id, "reject")}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 rounded border border-red-700 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-50"
                >
                  <X className="size-3" /> Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
