// Owner notifications — Telegram and/or Discord, both free. Silently does nothing when
// neither is configured, and NEVER throws (a notification must never break a payout step).
//
// Env (set any of them in Netlify → Site configuration → Environment variables):
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   → message from your bot (see PAYOUTS-SETUP.md)
//   DISCORD_WEBHOOK_URL                     → message into a Discord channel
// Returns { telegram: bool|null, discord: bool|null } (null = not configured).
const withTimeout = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

export async function notify(text) {
  const out = { telegram: null, discord: null };
  const msg = String(text || "").slice(0, 3900);
  const tgToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const tgChat = (process.env.TELEGRAM_CHAT_ID || "").trim();
  const hook = (process.env.DISCORD_WEBHOOK_URL || "").trim();
  const jobs = [];
  if (tgToken && tgChat) {
    jobs.push((async () => {
      try {
        const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: withTimeout(6000),
          body: JSON.stringify({ chat_id: tgChat, text: msg, disable_web_page_preview: true }),
        });
        out.telegram = r.ok;
      } catch { out.telegram = false; }
    })());
  }
  if (/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook)) {
    jobs.push((async () => {
      try {
        const r = await fetch(hook, {
          method: "POST", headers: { "content-type": "application/json" }, signal: withTimeout(6000),
          body: JSON.stringify({ content: msg.slice(0, 1990), allowed_mentions: { parse: [] } }),
        });
        out.discord = r.ok;
      } catch { out.discord = false; }
    })());
  }
  try { await Promise.all(jobs); } catch {}
  return out;
}
