// Netlify Function: /api/payouts — the owner's weekly payout desk (backs /payouts). ADMIN_KEY only.
//
//   GET  ?key=&round=              → plan (default: latest) + open flags + draw status
//   POST {key, action:'rebuild', round}          → rebuild the plan (refused once any payment landed)
//   POST {key, action:'exclude', round, who, undo} → drop (or restore) a flagged payee. An excluded
//        WINNER's share stays in the pot: it's added back to the live pot when the round is paid, so
//        it's in next week's prize. An excluded PREACHER stays owed (records remain unpaid).
//   POST {key, action:'send', tx}                → relay ONE wallet-signed tx (base64) to SOLANA_RPC.
//        /api/rpc deliberately has no sendTransaction; this admin-only relay exists so the batch-signed
//        payout txs can be broadcast in order. It can't sign anything — the tx is already signed.
//   POST {key, action:'paid', round, sigs, payer, swapOre, reviewed} → verify each sig on-chain
//        (success, fee payer = payer), check every payee received their due, mark the plan paid
//        (or 'partial'), mark preacher records paid, notify "Paid ✓".
//
// No private key anywhere: the owner signs in their own wallet on /payouts.
import { timingSafeEqual } from "node:crypto";
import { getPlan, latestPlanRound, buildAndStore, setExcluded, recordPayment, openFlags, alreadyPaidElsewhere, reservedWallets } from "./store-payout-core.mjs";
import { latestRound, getPublic, DrawError } from "./store-draw-core.mjs";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" } });
function keyOk(k) {
  const want = process.env.ADMIN_KEY || "";
  if (!want || typeof k !== "string") return false;
  const a = Buffer.from(k), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function view(round) {
  const plan = await getPlan(round);
  const pub = await getPublic(round);
  const out = { round, latestDrawRound: await latestRound(), latestPlanRound: await latestPlanRound(), draw: pub, plan, reserved: [...reservedWallets().keys()] };
  if (plan) {
    out.openFlags = openFlags(plan);
    try {
      const dup = await alreadyPaidElsewhere(plan);
      for (const [id, n] of Object.entries(dup)) out.openFlags.push({ severity: "block", who: id, check: "g", reason: `${n} of this preacher's records were already marked paid elsewhere since this plan was built — rebuild the plan` });
    } catch {}
  } else out.canBuild = pub?.status === "drawn";
  return out;
}

export default async (request) => {
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      if (!keyOk(url.searchParams.get("key"))) return json({ error: "forbidden" }, 403);
      const round = Number(url.searchParams.get("round")) || (await latestPlanRound()) || (await latestRound());
      return json(await view(round));
    }
    if (request.method !== "POST") return json({ error: "GET or POST" }, 405);
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!keyOk(body.key || url.searchParams.get("key"))) return json({ error: "forbidden" }, 403);
    const round = Number(body.round) || (await latestPlanRound()) || (await latestRound());

    if (body.action === "rebuild") {
      await buildAndStore(round, { budgetMs: 8e3, notify: body.notify !== false });
      return json({ ok: true, ...(await view(round)) });
    }
    if (body.action === "exclude") {
      await setExcluded(round, String(body.who || ""), !body.undo);
      return json({ ok: true, ...(await view(round)) });
    }
    if (body.action === "send") {
      if (typeof body.tx !== "string" || body.tx.length > 2000 || !/^[A-Za-z0-9+/=]+$/.test(body.tx)) return json({ error: "bad tx" }, 400);
      const upstream = [process.env.SOLANA_RPC, process.env.HELIUS_RPC, "https://api.mainnet-beta.solana.com"].find((v) => typeof v === "string" && /^https?:\/\//.test(v.trim()));
      const r = await fetch(upstream.trim(), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [body.tx, { encoding: "base64", skipPreflight: !!body.skipPreflight, maxRetries: 5 }] }) });
      const j = await r.json().catch(() => ({}));
      if (j.error) return json({ error: j.error.message || "send failed", logs: j.error.data?.logs || null }, 502);
      return json({ ok: true, signature: j.result });
    }
    if (body.action === "paid") {
      const res = await recordPayment({ round, sigs: body.sigs, payer: body.payer, swapOre: body.swapOre || {}, reviewed: !!body.reviewed });
      return json({ ...res, ...(await view(round)) });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    if (e instanceof DrawError) return json({ error: e.message }, e.status);
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config = { path: "/api/payouts" };
