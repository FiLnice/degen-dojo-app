// Netlify Function: /api/jpeg — JPEG DOJO (the /jpeg-dojo/ page, 2026-11-05). Rules in store-jpeg-core.mjs.
//
//   GET                       → { taken: [design ids already brought in], seats: { seats, inside, pending, left }, wall }   (CDN 30 s)
//   GET ?owner=<wallet>       → { pieces: [{ mint, std, name, image, ok, why }], holder, off, brought, next, credits, credit, min } that wallet's Rugged Dojo NFTs (bodies / trade-ins), holder price, trade-in credits
//   POST { sig }              → "check my payment / trade-in now": decides + applies it once (the payout cron reads it anyway within ~10 min)
//   GET ?orders=1   (Bearer ADMIN_KEY) → { orders, refunds } for scripts/keeper-apply-jpeg.mjs
//   POST { applied: [ids] } (Bearer ADMIN_KEY) → marks those orders applied (White card on S3 + on the Back to Degen Dojo list)
import { limited } from "./store-ratelimit-core.mjs";
import { adminRequestOk } from "./store-session-core.mjs";
import { processSig, getJpegBook, jpegWallet, jpegSeats, listJpegOrders, markJpegApplied, jpegActivitySince, SIG_RE, MAX_AGE_MS, isAddr, KeeperError } from "./store-keeper-core.mjs";
import { vesselProblem, wallSize, RD_COLL, DD_COLL, offFor, TRADE_CREDIT_RAW, MIN_PAY_RAW } from "./store-jpeg-core.mjs";
import { getTx } from "./store-payout-core.mjs";
import { rpc } from "./store-draw-core.mjs";

const json = (o, s = 200, cache = "no-store") => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": cache } });
function ownOrigin(request) {   // same-origin POSTs only (Origin, or Referer from in-app wallet browsers) — like /api/repair
  const o = request.headers.get("origin") || request.headers.get("referer") || "";
  let h; try { h = new URL(o).host.toLowerCase(); } catch { return false; }
  const own = new Set(); const hh = (request.headers.get("host") || "").trim().toLowerCase(); if (hh) own.add(hh);
  try { own.add(new URL(request.url).host.toLowerCase()); } catch {}
  return own.has(h);
}
const OWNERS = new Map();   // owner → { at, pieces } (30 s per warm instance)
const httpsImg = (u) => { try { const x = new URL(String(u || "")); return x.protocol === "https:" ? x.href : ""; } catch { return ""; } };

export default async (request) => {
  const url = new URL(request.url), admin = adminRequestOk(request, "ADMIN_KEY");
  if (!process.env.SOLANA_RPC) return json({ error: "SOLANA_RPC is not set" }, 500);
  try {
    if (request.method === "GET") {
      if (url.searchParams.get("orders")) {
        if (!admin) return json({ error: "admin only" }, 401);
        const [orders, act] = await Promise.all([listJpegOrders(), jpegActivitySince(0)]);
        const book = await getJpegBook();
        return json({ orders, refunds: act.refunded, credits: book.credits || {}, trades: book.trades || {} });
      }
      const owner = url.searchParams.get("owner");
      if (owner) {
        const blocked = limited(request, "jpeg-owner", 30); if (blocked) return blocked;
        if (!isAddr(owner)) return json({ error: "bad wallet" }, 400);
        // trade-in credits + the JPEG count are read fresh every time (they change the moment a payment is decided).
        // off = this wallet's % now (holder 25, +5 per JPEG it already brought in, max 40); next = its % after one more
        const terms = async (holder) => { const w = await jpegWallet(owner);
          return { off: offFor(holder, w.brought), brought: w.brought, next: offFor(true, w.brought + 1), credits: w.credits, credit: Number(TRADE_CREDIT_RAW) / 1e11, min: Number(MIN_PAY_RAW) / 1e11 }; };
        const c = OWNERS.get(owner); if (c && Date.now() - c.at < 30e3) return json({ pieces: c.pieces, holder: c.holder, ...(await terms(c.holder)) });
        const r = await rpc("getAssetsByOwner", { ownerAddress: owner, page: 1, limit: 1000, displayOptions: { showFungible: false } });
        const book = await getJpegBook();
        const pieces = (r?.items || []).filter((a) => !a.burnt && (a.grouping || []).some((g) => g.group_key === "collection" && g.group_value === RD_COLL)).map((a) => {
          const why = book.vessels[a.id] ? "already carrying a JPEG" : vesselProblem(a, owner);
          return { mint: a.id, std: a.interface === "ProgrammableNFT" ? "pnft" : "nft", name: String(a.content?.metadata?.name || "").slice(0, 40), image: httpsImg(a.content?.links?.image || a.content?.files?.[0]?.uri), ok: !why, why: why || null };
        });
        // holder price: a Degen Dojo card in this wallet (the Keeper checks again when the payment lands)
        const holder = (r?.items || []).some((a) => !a.burnt && (a.grouping || []).some((g) => g.group_key === "collection" && g.group_value === DD_COLL));
        OWNERS.set(owner, { at: Date.now(), pieces, holder }); if (OWNERS.size > 500) OWNERS.clear();
        return json({ pieces, holder, ...(await terms(holder)) });
      }
      const blocked = limited(request, "jpeg", 60); if (blocked) return blocked;
      const [book, seats] = await Promise.all([getJpegBook(), jpegSeats().catch(() => null)]);
      return json({ taken: Object.keys(book.designs || {}), seats, wall: wallSize() }, 200, "public, max-age=30");
    }
    if (request.method !== "POST") return json({ error: "GET or POST" }, 405);
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (Array.isArray(body?.applied)) {
      if (!admin) return json({ error: "admin only" }, 401);
      return json({ applied: await markJpegApplied(body.applied.slice(0, 200)) });
    }
    const blocked = limited(request, "jpeg-pay", 20); if (blocked) return blocked;
    if (!ownOrigin(request)) return json({ error: "use the Degen Dojo store page" }, 403);
    const sig = String(body?.sig || "");
    if (!SIG_RE.test(sig)) return json({ error: "bad signature" }, 400);
    let tx = null;
    for (let i = 0; i < 4 && !tx; i++) { tx = await getTx(sig, "jsonParsed").catch(() => null); if (!tx) await new Promise((r) => setTimeout(r, 1500)); }
    if (!tx) return json({ error: "that transaction isn't on-chain yet — try again in a moment" }, 404);
    if (tx.meta?.err) return json({ error: "that transaction failed on-chain" }, 400);
    if (tx.blockTime && Date.now() - tx.blockTime * 1000 > MAX_AGE_MS) return json({ error: "that payment is older than 48 hours — it was already handled (or contact us)" }, 400);
    const d = await processSig(sig, { tx });
    if (d.kind === "retry") return json({ error: "couldn't check it right now — it is picked up automatically within ~10 minutes" }, 503);
    // a trade-in (Rugged Dojo pieces sent with the ddtrade memo) → the wallet's credits now
    if (d.kind === "trade") return json({ ok: true, trade: true, credited: d.result?.credited || {}, credits: d.result?.credits || {} });
    if (d.kind !== "jpeg") return json({ ok: false, error: d.why || "not a JPEG DOJO payment" }, 400);
    const r = d.result || {};
    return json({ ok: (r.brought || []).length > 0, brought: r.brought || [], late: r.late || [], refused: d.refused || [],
      refundOre: r.refundRaw && r.refundRaw !== "0" ? String(Number(BigInt(r.refundRaw)) / 1e11) : null,
      note: "The card is written within a day and walks into Degen Dojo in the next daily batch." });
  } catch (e) {
    if (e instanceof KeeperError) return json({ error: e.message }, e.status);
    return json({ error: "couldn't check it right now — try again in a minute" }, 502);
  }
};

export const config = { path: "/api/jpeg" };
