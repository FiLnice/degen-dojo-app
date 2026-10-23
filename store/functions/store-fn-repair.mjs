// Netlify Function: /api/repair — "check my repair payment now" (optional: the Treasury reader finds every
// repair payment by itself within ~10 minutes; the /repair page calls this right after its one-click payment).
//
//   POST { sig } → { ok, repaired: [{ mint, from, to: "Mint" }], refused: [{ mint, reason }], status: "pending" }
//
// A repair payment = ORE sent into the Treasury's ORE account by a wallet holding Cracked / Mono Dojo cards
// (0.01 ORE per card; `ddfix:<mint>` memos pick the cards, else the rarest first). Decided ONCE per signature
// (store-keeper-core processSig) — calling this again returns the same answer. The card turns "Mint" (and is
// protected forever) at the next weekly Dojo update; until then it shows as repairPending.
// Over the Mint cap (as it stood when the payment landed) a card comes back in `refused` with refunded: true — its
// 0.01 ORE is refunded in full at the weekly payout (/payouts "Refunds due").
import { limited } from "./store-ratelimit-core.mjs";
import { processSig, getRepair, SIG_RE, MAX_AGE_MS, KeeperError } from "./store-keeper-core.mjs";
import { getTx } from "./store-payout-core.mjs";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
// same-origin only (Origin, or Referer from in-app wallet browsers) — like /api/auth
function ownOrigin(request) {
  const o = request.headers.get("origin") || request.headers.get("referer") || "";
  let h; try { h = new URL(o).host.toLowerCase(); } catch { return false; }
  const own = new Set(); const hh = (request.headers.get("host") || "").trim().toLowerCase(); if (hh) own.add(hh);
  try { own.add(new URL(request.url).host.toLowerCase()); } catch {}
  return own.has(h);
}

export default async (request) => {
  const blocked = limited(request, "repair", 20); if (blocked) return blocked;   // 20 / minute / IP (DD-04)
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!ownOrigin(request)) return json({ error: "use the Degen Dojo store page" }, 403);
  if (!process.env.SOLANA_RPC) return json({ error: "SOLANA_RPC is not set" }, 500);
  let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const sig = String(body?.sig || "");
  if (!SIG_RE.test(sig)) return json({ error: "bad signature" }, 400);
  try {
    let tx = null;
    for (let i = 0; i < 4 && !tx; i++) { tx = await getTx(sig, "jsonParsed").catch(() => null); if (!tx) await new Promise((r) => setTimeout(r, 1500)); }
    if (!tx) return json({ error: "that transaction isn't on-chain yet — try again in a moment" }, 404);
    if (tx.meta?.err) return json({ error: "that transaction failed on-chain" }, 400);
    if (tx.blockTime && Date.now() - tx.blockTime * 1000 > MAX_AGE_MS) return json({ error: "that payment is older than 48 hours — it was already handled by the weekly reader (or contact us)" }, 400);
    const d = await processSig(sig, { tx });
    if (d.kind === "retry" && /coin-purchase/.test(d.why || "")) return json({ ok: false, pending: true, error: "a payment without a ddfix memo is checked about 10 minutes after it lands — it is picked up automatically" }, 202);
    if (d.kind === "retry") return json({ error: "couldn't check it right now — try again in a minute" }, 503);
    if (d.kind !== "repair") return json({ ok: false, error: d.why || "not a repair payment", refused: d.refused || [] }, 400);
    const done = new Set(d.result?.repaired || []), capped = new Set(d.result?.refunded || []);
    const repaired = [], refused = [...(d.refused || [])];
    for (const c of d.cards) {
      if (done.has(c.mint) || (await getRepair(c.mint))?.sig === sig) repaired.push({ mint: c.mint, from: c.from, to: "Mint" });
      else if (capped.has(c.mint)) refused.push({ mint: c.mint, reason: "every Mint spot was taken when this payment arrived — its 0.01 ORE is refunded in full at the weekly payout", refunded: true });
      else refused.push({ mint: c.mint, reason: "another payment repaired this card first — this card's 0.01 ORE went to the Reserve" });
    }
    return json({ ok: repaired.length > 0, repaired, refused, status: "pending", note: "Repaired cards turn Mint (protected forever) at the next weekly Dojo update." });
  } catch (e) {
    if (e instanceof KeeperError) return json({ error: e.message }, e.status);
    return json({ error: "couldn't check it right now — try again in a minute" }, 502);
  }
};

export const config = { path: "/api/repair" };
