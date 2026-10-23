// Scheduled Netlify Function — the weekly Dojo Pot payout, hands-off up to the ONE "Pay" click.
//
// Every 10 minutes it advances one step (see cronTick in store-payout-core.mjs):
//   • DRAW_DAY at DRAW_HOUR_UTC (default Sunday 18:00 UTC) has passed and this week's round isn't
//     committed → commit (secret seed + public commitment to a future slot)
//   • the committed round's target slot has finalized → draw (provably fair, pot snapshotted)
//   • the drawn round has no payout plan → build it (winners + preachers + fraud flags), store it
//     in Blobs "payouts" round:<n>, and notify Telegram/Discord with a link to /payouts
// It never sends money and holds no key: the owner pays from /payouts with their own wallet.
// A paid plan is never rebuilt. Needs SOLANA_RPC (+ optional TELEGRAM_* / DISCORD_WEBHOOK_URL).
import { cronTick } from "./store-payout-core.mjs";
import { scanTreasury } from "./store-keeper-core.mjs";
import { notify } from "./store-notify.mjs";

export default async () => {
  if (!process.env.SOLANA_RPC) return;   // not configured yet — nothing to do
  const t0 = Date.now();
  try {
    const r = await cronTick({ budgetMs: 20e3 });
    console.log("payout-cron:", JSON.stringify(r));
  } catch (e) {
    const m = String(e?.message || e);
    console.log("payout-cron error:", m);
    // only shout about real failures, at most once an hour (the cron retries every 10 min)
    if (new Date().getUTCMinutes() < 10) await notify("⚠ Dojo payout cron error: " + m.slice(0, 300));
  }
  // Dojo Keeper: read the Treasury's new transactions — royalties → card vaults, repair payments, cards sent
  // in to burn (store-keeper-core). Uses what's left of the ~30s run.
  const left = 26e3 - (Date.now() - t0);
  if (left > 4e3) {
    try { console.log("keeper-scan:", JSON.stringify(await scanTreasury({ max: 60, budgetMs: left - 2e3 }))); }
    catch (e) { console.log("keeper-scan error:", String(e?.message || e)); }
  }
};

export const config = { schedule: "*/10 * * * *" };
