// Scheduled Netlify Function — auto-verifies coin purchases on-chain every minute so
// NOBODY has to sit at a laptop hitting /api/verify. Uses the SAME shared logic as
// /api/verify (store-verify-core.mjs): re-read each unverified purchase, confirm the
// TREASURY received the tokens, value the real amount in USD at the live price, and
// mint coins from the server pack table. A not-yet-propagated tx is left pending so
// the next run retries (no false rejects). Needs SOLANA_RPC + TREASURY_WALLET.
// Only the pending list is read (verify-core: pending:<sig>), so the work per minute doesn't grow with the ledger;
// once an hour the rejected junk and expired quotes older than 3 days are purged.
import { verifyPurchases, purgeJunk } from "./store-verify-core.mjs";

export default async () => {
  if (!process.env.SOLANA_RPC) return;   // not configured yet — nothing to do
  const purge = new Date().getUTCMinutes() === 17;   // functions stop at 30 s: leave the purge its share of the run
  const { verified, rejected, left } = await verifyPurchases({ strictReject: false, ...(purge ? { budgetMs: 14_000 } : {}) });
  console.log(`verify-cron: verified ${verified}, rejected ${rejected}${left ? `, ${left} left for the next run` : ""}`);
  if (purge) {
    const p = await purgeJunk({ budgetMs: 6000 }).catch((e) => ({ error: String(e?.message || e) }));
    console.log("verify-cron purge:", JSON.stringify(p));
  }
};

// Every minute → coins land within ~60s of a purchase, hands-off.
export const config = { schedule: "* * * * *" };
