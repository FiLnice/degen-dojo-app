// Scheduled Netlify Function — auto-verifies coin purchases on-chain every minute so
// NOBODY has to sit at a laptop hitting /api/verify. Uses the SAME shared logic as
// /api/verify (store-verify-core.mjs): re-read each unverified purchase, confirm the
// TREASURY received the tokens, value the real amount in USD at the live price, and
// mint coins from the server pack table. A not-yet-propagated tx is left pending so
// the next run retries (no false rejects). Needs SOLANA_RPC + TREASURY_WALLET.
import { verifyPurchases } from "./store-verify-core.mjs";

export default async () => {
  if (!process.env.SOLANA_RPC) return;   // not configured yet — nothing to do
  const { verified, rejected } = await verifyPurchases({ strictReject: false });
  console.log(`verify-cron: verified ${verified}, rejected ${rejected}`);
};

// Every minute → coins land within ~60s of a purchase, hands-off.
export const config = { schedule: "* * * * *" };
