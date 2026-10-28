// Netlify Function: the Burn Raffle at /api/raffle (store-raffle-core.mjs holds every rule).
//
//   GET  ?action=status[&wallet=]          → the open round: pot (ORE + SOL, ≈ ORE value), tickets, burns, prize tier
//                                            (1 / 3 / 5 winners) and where the next tier starts, the next draw time, the
//                                            wallet's tickets, last round's winners
//   GET  ?sig=<signature>                  → one burn's verdict: credited (round, tickets) | pending | rejected (why)
//   GET  ?action=round&round=N             → round N's public record (commitment; once drawn: seed, blockhash, winners)
//   GET  ?action=entries&round=N           → the [wallet, tickets] list round N is drawn from (published before its slot)
//   GET  ?action=verify&round=N            → re-check a drawn round (commitment, blockhash on-chain, pick, prize split)
//   POST {action:"burn", sigs:[…] | sig}   → the page reports its landed burn transactions (≤ 10). Tickets come ONLY from
//                                            what the transaction itself shows (store-raffle-core inspectRaffleTx) — the
//                                            POST says nothing but the signature, and the cron finds missed ones anyway.
//   POST {action:"gift", sigs:[…] | sig}   → "Add to the prize": the page reports its landed gift transactions (≤ 10). What
//                                            counts is what the raffle wallet received in each one (inspectGiftTx). No tickets.
//   GET  ?gift=<signature>                 → one gift's verdict: credited (round, shown / waiting for review) | pending | rejected
//   GET  ?action=commit | draw (Bearer ADMIN_KEY) → open / draw a round by hand (the payout cron does both weekly)
// No free tickets (owner 2026-10-28, anti-bot): every ticket comes from a verified burn.
// Env: SOLANA_RPC, RAFFLE_WALLET (default TREASURY_WALLET), ADMIN_KEY.
import { limited } from "./store-ratelimit-core.mjs";
import { adminRequestOk } from "./store-session-core.mjs";
import { raffleStatus, burnStatus, recordBurn, recordGift, giftStatusOf, getRafflePublic, raffleEntries, verifyRaffleDraw, commitRaffle, drawRaffle, latestRaffleRound } from "./store-raffle-core.mjs";
import { lastDrawTime } from "./store-payout-core.mjs";
import { DrawError } from "./store-draw-core.mjs";
import { CasError } from "./store-cas-core.mjs";

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (request) => {
  const blocked = limited(request, "raffle", 60); if (blocked) return blocked;   // 60 / minute / IP
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || (url.searchParams.get("sig") ? "sig" : url.searchParams.get("gift") ? "gift" : "status");
  const asked = url.searchParams.get("round");
  const round = asked == null ? null : /^\d{1,6}$/.test(asked) ? Number(asked) : NaN;
  if (Number.isNaN(round)) return json({ error: "bad round" }, 400);
  try {
    if (request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      if (body?.action !== "burn" && body?.action !== "gift") return json({ error: "unknown action" }, 400);
      const slow = limited(request, "raffle-burn", 20); if (slow) return slow;   // 20 reports / minute / IP
      const sigs = [...new Set((Array.isArray(body.sigs) ? body.sigs : [body.sig]).map((s) => String(s || "").trim()).filter(Boolean))].slice(0, 10);
      if (!sigs.length) return json({ error: "no signature" }, 400);
      const record = body.action === "gift" ? recordGift : recordBurn, out = [];
      for (const s of sigs) { try { out.push(await record(s)); } catch (e) { out.push({ sig: s, status: "error", why: String(e?.message || e).slice(0, 120) }); } }
      return json(body.action === "gift" ? { ok: true, gifts: out } : { ok: true, burns: out });
    }
    if (request.method !== "GET") return json({ error: "GET or POST" }, 405);
    if (action === "status") {
      const w = url.searchParams.get("wallet");
      const st = await raffleStatus({ wallet: w && ADDR_RE.test(w) ? w : null });
      const now = Date.now();
      return json({ ...st, nextDrawAt: lastDrawTime(now) + 7 * 86400e3, now });
    }
    if (action === "sig") { const s = await burnStatus(url.searchParams.get("sig")); return s ? json(s) : json({ status: "unknown" }, 404); }
    if (action === "gift") { const s = await giftStatusOf(url.searchParams.get("gift")); return s ? json(s) : json({ status: "unknown" }, 404); }
    if (action === "round") { const pub = await getRafflePublic(round || (await latestRaffleRound())); return pub ? json(pub) : json({ error: "no such round" }, 404); }
    if (action === "entries") { const e = await raffleEntries(round || (await latestRaffleRound())); return e ? json(e) : json({ error: "no published entries for that round" }, 404); }
    if (action === "verify") {
      const slow = limited(request, "raffle-verify", 6); if (slow) return slow;
      return json(await verifyRaffleDraw(round || (await latestRaffleRound())));
    }
    if (!adminRequestOk(request, "ADMIN_KEY")) return json({ error: "forbidden" }, 403);
    if (action === "commit") return json({ ok: true, ...(await commitRaffle()) });
    if (action === "draw") return json({ ok: true, ...(await drawRaffle()) });
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    if (e instanceof DrawError || e instanceof CasError) return json({ error: e.message }, e.status || 500);
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config = { path: "/api/raffle" };
