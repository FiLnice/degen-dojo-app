// Netlify Function: verify coin purchases on-chain at /api/verify?key=ADMIN_KEY
//
// Coin purchases are POSTed as untrusted hints (store-fn-coinbuy). This re-reads
// each unverified one on the chain, confirms the TREASURY actually received the
// tokens, values the REAL amount in USD at the live price, and mints coins from the
// server pack table — the client's claimed coins/usd are never trusted. Shared with
// verify-cron via store-verify-core.mjs so the crediting rule can't drift.
//
// Run it on a schedule or hit it manually. Needs SOLANA_RPC + TREASURY_WALLET + ADMIN_KEY.
import { verifyPurchases } from "./store-verify-core.mjs";

export default async (request) => {
  const url = new URL(request.url);
  if ((url.searchParams.get("key") || "") !== (process.env.ADMIN_KEY || "\0")) return new Response("forbidden", { status: 403 });
  const summary = await verifyPurchases({ strictReject: true });   // admin path rejects unreadable txs
  return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

export const config = { path: "/api/verify" };
