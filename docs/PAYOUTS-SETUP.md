# Weekly payouts — setup and routine

The store now runs the weekly Dojo Pot by itself. Every week it:

1. **Opens the round** on draw day (default Sunday 18:00 UTC). It locks in a secret seed and publishes its fingerprint.
2. **Draws the winners** a few minutes later from a future Solana blockhash. It's provably fair, so nobody can pick the winner, not even you.
3. **Works out the payout**. The winners split the week's pot equally in each token. Preachers get what they're owed (anyone owed $1 or more).
4. **Checks for anything fishy** (see "Flags" below).
5. **Messages you** on Telegram and/or Discord with a link to **https://store.degendojo.xyz/payouts**.

Then you open the page, connect the wallet that holds the money, and press **Pay everything**. You approve once in your wallet. The server never holds a private key.

---

## 1. Notifications (pick one or both, both free)

### Telegram
1. In Telegram, open a chat with **@BotFather** and send `/newbot`. Pick a name and a username ending in `bot`.
2. BotFather replies with a **token** like `123456789:AAH...`. That's your `TELEGRAM_BOT_TOKEN`.
3. Open a chat with your new bot and send it any message (e.g. "hi"). A bot can't message you until you message it first.
4. In a browser, open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`, with your token in place of `<YOUR_TOKEN>`.
   Find `"chat":{"id":123456789,...}`. That number is your `TELEGRAM_CHAT_ID`.
   (For a group: add the bot to the group, send a message there, and use the group's id. It starts with `-`.)

### Discord
1. In your Discord server: **Server Settings → Integrations → Webhooks → New Webhook**.
2. Choose the channel, then press **Copy Webhook URL**. That's your `DISCORD_WEBHOOK_URL`.

## 2. Netlify environment variables

Netlify → the store site → **Site configuration → Environment variables**. Add:

| Variable | Needed? | What it is |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | optional | from BotFather |
| `TELEGRAM_CHAT_ID` | optional | from getUpdates |
| `DISCORD_WEBHOOK_URL` | optional | the copied webhook URL |
| `DRAW_DAY` | optional | 0 = Sunday … 6 = Saturday (default 0) |
| `DRAW_HOUR_UTC` | optional | hour of the draw in UTC, 0–23 (default 18) |
| `PAYOUT_CAP_USD` | optional | flag any week paying out more than this (default 300) |
| `MIN_PREACHER_PAYOUT_USD` | optional | smallest preacher payout (default 1) |
| `TEAM_WALLETS` | optional | comma-separated wallets of yours that must never win (treasury, pot/royalty and creator wallets are already covered) |
| `COSIGNER_PUBKEY` | optional | the marketplace cosigner's **public** address, so it's never paid |

`ADMIN_KEY` and `SOLANA_RPC` are already set. The /payouts page uses `ADMIN_KEY`, the same key as /admin and the draw.

If no Telegram/Discord variable is set, the store simply doesn't send messages. Everything else still works.
Redeploy after changing variables.

## 3. The weekly routine (about 2 minutes)

1. You get a message like *"Weekly payout ready — round 7: 1 winner + 3 preachers, 0.8 ORE + 120 SKR (≈ $95). Flags: none ✓"*.
2. Open **store.degendojo.xyz/payouts** and enter your admin key (it's only kept in that browser tab).
3. Check the page:
   - **Proof**: the commitment, the revealed seed, the blockhash and a link to the public draw record.
   - **Winners / Preachers**: who gets what in ORE and SKR. "SOL → ORE" and "USDC → ORE" amounts are swapped to ORE when you pay.
   - **Flags**: red = **block**, amber = **warn**.
4. Press **Connect the paying wallet** and connect the wallet that holds the funds. Coin-pack money arrives in the treasury `5w55…WMuWp`. Tips and royalties arrive in `ED3G…pvwJe`. The page shows what's needed per token against what that wallet holds, including a little SOL for fees and new token accounts. If anything is short, Pay stays locked. Move funds into that wallet first.
5. If there are flags, read them. Then either press **Exclude** on a flagged winner or preacher, or tick **"I reviewed these flags"**.
6. Press **Pay everything** and approve once in your wallet. The page:
   - swaps the SOL/USDC part to ORE on Jupiter (the minimum guaranteed amount is what gets handed out; any extra stays with you),
   - sends ORE/SKR to everyone, creating their token accounts if needed,
   - and reports back. The server re-checks every transaction on-chain, marks the round paid, marks the preachers' records paid, and messages you "Paid ✓".
   Each transaction gets a Solscan link.

If something breaks halfway (a wallet hiccup, a timeout), press **Pay** again. Finished steps are remembered, so the swap never runs twice and nobody gets paid twice.

## Flags (what makes a payout "fishy")

- One wallet holds more than 40% of the week's tickets.
- A winner's wallet is less than 7 days old.
- Two or more winners were first funded by the same wallet.
- A winner or preacher is one of our own wallets (treasury, pot, royalty, creator, cosigner, team).
- The draw doesn't re-check: the seed doesn't match its commitment, the blockhash is wrong, or the archived tickets don't reproduce the same winners.
- The total payout is over `PAYOUT_CAP_USD`.
- A preacher's referred buyer was funded by the preacher's own wallet, or the preacher's referred spend jumped more than 10× vs. what they were paid before.
- The pot ledger doesn't match the verified coin-pack and tip records for the week.
- A check couldn't run (RPC busy, out of time). It shows as a warning, so you know it wasn't checked.

**Excluding** a winner keeps their share in the pot: it's added to next week's pot once the round is paid. Excluding a preacher keeps them owed, so they show up again next week.

## Good to know

- If nobody played (no tickets), there are no winners and the pot carries over to next week. Preachers still get paid.
- If the store was down on draw day and more than 2 days have passed, it waits for the next draw day rather than drawing late.
- The manual buttons still work. `/api/draw?action=commit|draw&key=…` runs the same engine. The weekly job notices a round you opened by hand and won't open a second one.
- A plan is never rebuilt once any payment has landed. Before that, **Rebuild plan** re-reads everything and re-runs the checks.
- Only the newest plan pays preachers. If an older week was never paid, its preachers move to the newest plan, so nobody is paid twice.
