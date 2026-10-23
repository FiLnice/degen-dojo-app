// Netlify Function: /api/dd-royalty — feed the Dojo Pot from marketplace royalties.
//
// When a Degen sells, the 13% creator royalty lands in the creator wallet (ED3GMC). This
// routes HALF of that royalty (ROYALTY_TO_POT) into the weekly pot ledger — verified against
// the ACTUAL amount the creator wallet received in the sale tx, so the pot only ever grows by
// real, on-chain royalty income (never a claimed number). Idempotent per signature.
//
//   POST { sig, currency? }  → credits 50% of the royalty in `sig` to the pot's "royalty" route.
//
// It runs the SAME per-signature rule as the every-minute sweep (store-royalty-core.mjs
// processRoyaltySig): the tx must touch a known marketplace program, every currency the wallet
// gained is counted (the client's `currency` is ignored — a wrong one used to mark a real royalty
// "credited: 0" and hide it from the sweep), a sale from before the sweep's baseline / older than
// 48h is refused (no retroactive pot inflation from old sales), and the pot add is idempotent by
// royalty:<sig>:<cur>. A tx that isn't readable yet is left to the sweep (which scans the wallet itself);
// a tx that doesn't involve the royalty wallet is refused without writing anything.
//
// Env: SOLANA_RPC, optionally ROYALTY_WALLET (defaults to the Degen Dojo Reserve 5w55).
import { limited } from "./store-ratelimit-core.mjs";
import { getStore } from "@netlify/blobs";
import { processRoyaltySig, CURSOR_KEY } from "./store-royalty-core.mjs";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const MAX_AGE_MS = 48 * 3600e3;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RETIRED 2026-10-23: royalties no longer feed the Pot (see store-royalty-core.mjs). Kept so the store pages'
// best-effort report after a sale gets a clean answer instead of a 404; it never credits anything.
export default async (request) => {
  const blocked = limited(request, "dd-royalty", 20); if (blocked) return blocked;   // 20 / minute / IP (DD-04)
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  if (!process.env.SOLANA_RPC) return json({ error: "SOLANA_RPC not set" }, 500);
  let d; try { d = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const sig = String(d?.sig || "");
  if (!SIG_RE.test(sig)) return json({ error: "bad fields" }, 400);

  const store = getStore("dd-royalties");
  const prior = await store.get(sig, { type: "json" });
  if (prior && (prior.credited || prior.skip || prior.gaveUp)) return json({ ok: true, already: true, potUsd: prior.potUsd || 0 });

  const cursor = await store.get(CURSOR_KEY, { type: "json" });
  const notBefore = Math.max(cursor?.since || 0, Date.now() - MAX_AGE_MS);
  // a just-confirmed sale may take a moment to be readable — retry a few times, then hand it to the sweep
  let out = null;
  for (let i = 0; i < 5; i++) {
    out = await processRoyaltySig(sig, { notBefore });
    if (out.final || out.refuse || !/not readable/.test(out.retry || "")) break;
    await sleep(1500);
  }
  if (out.refuse) return json({ ok: false, refused: out.refuse });
  if (out.final) {
    await store.setJSON(sig, out.final);
    await store.delete("retry:" + sig).catch(() => {});
    return json({ ok: true, credited: !!out.final.credited, skip: out.final.skip || null, potUsd: out.final.potUsd || 0, routes: out.final.routes || {} });
  }
  // Not readable / no price yet: nothing is written here (anyone can POST any signature, so this
  // endpoint never queues). The every-minute sweep scans the royalty wallet itself and will find it.
  return json({ ok: false, pending: true, retry: out.retry });
};

export const config = { path: "/api/dd-royalty" };
