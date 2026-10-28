// Scheduled Netlify Function — the weekly Dojo Pot payout, hands-off up to the ONE "Pay" click.
//
// Every 10 minutes it advances one step (see cronTick in store-payout-core.mjs):
//   • DRAW_DAY at DRAW_HOUR_UTC (default Sunday 18:00 UTC) has passed and this week's round isn't
//     committed → commit (secret seed + public commitment to a future slot)
//   • the committed round's target slot has finalized → draw (provably fair, pot snapshotted)
//   • the drawn round has no payout plan → build it (winners + preachers + fraud flags), store it
//     in Blobs "payouts" round:<n>, and notify Telegram/Discord with a link to /payouts
//   • once a week: sweep expired sign-in nonces, old one-time markers and the legacy ticket sink (sweepTick)
//   • the Burn Raffle (store-raffle-core raffleTick) on the same schedule, FIRST: commit at draw time, draw once its
//     target slot is final — the week's payout plan waits for it (up to RAFFLE_WAIT_MS) so its winners are in the batch
// It never sends money and holds no key: the owner pays from /payouts with their own wallet.
// A paid plan is never rebuilt. Needs SOLANA_RPC (+ optional TELEGRAM_* / DISCORD_WEBHOOK_URL).
import { cronTick, sweepTick, lastDrawTime, CATCHUP_MS } from "./store-payout-core.mjs";
import { raffleTick } from "./store-raffle-core.mjs";
import { scanTreasury } from "./store-keeper-core.mjs";
import { notify } from "./store-notify.mjs";

export default async () => {
  if (!process.env.SOLANA_RPC) return;   // not configured yet — nothing to do
  const t0 = Date.now();
  try {
    const rt = await raffleTick({ week: lastDrawTime(t0), catchupMs: CATCHUP_MS });
    if (rt.step !== "raffle-idle") console.log("raffle:", JSON.stringify(rt));
  } catch (e) { console.log("raffle error:", String(e?.message || e)); }
  try {
    const r = await cronTick({ budgetMs: 20e3 });
    console.log("payout-cron:", JSON.stringify(r));
  } catch (e) {
    const m = String(e?.message || e);
    console.log("payout-cron error:", m);
    // only shout about real failures, at most once an hour (the cron retries every 10 min)
    if (new Date().getUTCMinutes() < 10) await notify("⚠ Dojo payout cron error: " + m.slice(0, 300));
  }
  // weekly: delete expired sign-in nonces / old one-time markers / the legacy ticket sink (a few seconds per run)
  const roomForSweep = 26e3 - (Date.now() - t0) - 10e3;
  if (roomForSweep > 2e3) {
    try { const s = await sweepTick({ budgetMs: Math.min(5e3, roomForSweep) }); if (s.step !== "sweep-idle") console.log("sweep:", JSON.stringify(s)); }
    catch (e) { console.log("sweep error:", String(e?.message || e)); }
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
