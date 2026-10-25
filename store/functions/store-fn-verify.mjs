// Netlify Function: verify coin purchases on-chain at /api/verify (Authorization: Bearer ADMIN_KEY)
//
// Coin purchases are POSTed as untrusted hints (store-fn-coinbuy). This re-reads
// each unverified one on the chain, confirms the TREASURY actually received the
// tokens, values the REAL amount in USD at the live price, and mints coins from the
// server pack table — the client's claimed coins/usd are never trusted. Shared with
// verify-cron via store-verify-core.mjs so the crediting rule can't drift.
//
//   GET / POST (no action)            → verify the pending purchases now (unreadable txs are rejected — re-queueable)
//   POST {action:"requeue", sig}      → put a rejected purchase back in the queue (e.g. a buyer who wrote in after an
//                                       RPC outage, or a payment you've checked by hand) — the cron re-judges it
//   POST {action:"delete", sig}       → delete a purchase record that never credited anything (credited ones are kept)
//
// Needs SOLANA_RPC + TREASURY_WALLET + ADMIN_KEY.
import { limited } from "./store-ratelimit-core.mjs";
import { verifyPurchases, adminRequeue, adminDelete } from "./store-verify-core.mjs";
import { adminRequestOk } from "./store-session-core.mjs";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const JSONH = { "content-type": "application/json", "cache-control": "no-store" };

export default async (request) => {
  const blocked = limited(request, "verify", 10); if (blocked) return blocked;   // 10 / minute / IP (DD-04)
  if (!adminRequestOk(request, "ADMIN_KEY")) return new Response("forbidden", { status: 403 });
  if (request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch { /* no body → verify */ }
    if (b?.action === "requeue" || b?.action === "delete") {
      if (!SIG_RE.test(String(b.sig || ""))) return new Response(JSON.stringify({ error: "bad sig" }), { status: 400, headers: JSONH });
      const out = b.action === "requeue" ? await adminRequeue(b.sig) : await adminDelete(b.sig);
      return new Response(JSON.stringify(out), { status: out.ok ? 200 : 409, headers: JSONH });
    }
  }
  const summary = await verifyPurchases({ strictReject: true });   // admin path rejects unreadable txs
  return new Response(JSON.stringify(summary), { headers: JSONH });
};

export const config = { path: "/api/verify" };
