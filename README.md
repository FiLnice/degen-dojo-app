# Degen Dojo — the NFT economy that runs on ORE

> ORE gets mined every minute. We gave it something to buy.

Degen Dojo is a Solana dApp built for the **Seeker**: trade, mint, mine and play — priced in **ORE**, with **SKR** for game coins. Built for the Solana Mobile **CLOCK IN** hackathon (ORE track).

- **Live dApp:** https://store.degendojo.xyz
- **Site:** https://degendojo.xyz
- **Android app:** a Trusted Web Activity wrapping the live store (package `xyz.degendojo.store.twa`), so every deploy reaches the app instantly.
- **Built by:** Filios Sazeides ([@filnice8](https://x.com/filnice8)) — solo founder.

## What's in the app

| Feature | What it does | Where |
|---|---|---|
| **ORE marketplace** | List any pNFT for ORE on our own non-custodial AuctionHouse (0% marketplace fee, royalties seller-side), and buy from the top 100 Solana collections in ORE (ORE → SOL swap via Jupiter, then the Magic Eden / Tensor buy). Every buy re-checks the live price before signing. From Nov 2, Degen Dojo pNFTs trade only here (store-only rule set). | `store/src/shelf-mockup.html`, `store/src/dd-list.html`, `store/src/dojo-ah.js`, `store/src/dojo-buy.js`, `store/functions/` |
| **Card conditions & repairs** | Each Degen card is Mint or Cracked; a holder restores a cracked card to Mint (protected for good) with 0.01 ORE — no wallet connection needed. | `store/src/store-repair.html`, `store/functions/store-keeper-core.mjs` |
| **Degen Dojo Reserve** | A public page tracking everything that comes into and goes out of the Treasury. | `store/src/store-wallets.html`, `store/functions/store-fn-reserve.mjs` |
| **Mine the Mint** | An anti-rug, anti-bot launchpad: commit 1 ORE, everyone gets one NFT, one drips out per minute at random; funds stay in escrow until milestones. | `store/src/launch.html` |
| **ORE grid miner** | Mine real ORE on a 5×5 grid of Degens — native ORE program instructions, auto-mining, live slot timing. | `miner/` (Next.js) |
| **Your own miner** | Any collection pastes its collection address and gets its own branded 25-NFT ORE grid (5 ORE setup). | `miner/app/create`, `miner/app/whitelabel` |
| **3 games & 2 arenas** | Dojo Flip, Teto Wars, Degen Duel, Cluck-Fu, Cock Brawl — provably fair; coins bought with ORE, SKR or SOL. | `store/src/*.html` |
| **Preachers** | Anyone gets a personal link and earns 28 / 36 / 44% (by fighters held) of every game-coin pack and ORE mining tip they bring. | `store/src/become-a-preacher.html`, `store/functions/store-fn-preacher.mjs` |

## Solana Mobile Stack

- **Mobile Wallet Adapter / Seed Vault:** `store/mwa-build/` bundles `@solana-mobile/wallet-standard-mobile` into `mwa.js`, registered as a Wallet-Standard wallet so the Seeker's Seed Vault appears in the wallet picker (`store/src/wallet-picker.js`) and the session is restored silently across pages.
  The build applies two asserted bundle-time patches: a grace period for Chrome's Local-Network-Access prompt (which never appeared on the Seeker, hanging the connect) and a 60s association timeout. See the comments in `store/mwa-build/build.mjs`.
- **Seeker Connect** (experimental): MWA over a Nostr relay, offered on Seeker devices.
- **SKR:** players buy game coins with SKR (alongside ORE and SOL); the SKR from coin sales feeds the weekly Dojo Pot.

## Repository layout

```
miner/            Next.js app — ORE grid miner (/mine), branded-miner pitch (/whitelabel) and request flow (/create)
store/src/        the store's pages and client scripts (marketplace, launchpad, games, coins, Preachers, wallet picker)
store/functions/  Netlify Functions — RPC proxy, listings, Tensor/Magic Eden buy builders, coins, Preachers, cosigner
store/mwa-build/  esbuild bundle of the Mobile Wallet Adapter (+ Seed Vault fixes)
store/dist/       the store exactly as deployed to store.degendojo.xyz (static site + functions, miner folded in at /mine)
```

## Build & deploy

```bash
# Mobile Wallet Adapter bundle -> store mwa.js
cd store/mwa-build && npm install && node build.mjs

# Miner (static export, folded into the store at /mine)
cd miner && npm install && node export-mine.mjs
```

`store/dist/` is a ready-to-deploy Netlify site (drag-and-drop or `netlify deploy`). The store's build script (`store/src/build-store-deploy.mjs`) assembles it from the sources and the miner export.

**Environment** (set in Netlify — never committed): `SOLANA_RPC` (Helius), `TENSOR_API_KEY`, `MAGICEDEN_API_KEY`, `ADMIN_KEY`, `ATTR_ADMIN_KEY`, `SESSION_SECRET` (required, ≥32 chars), `COSIGNER_SECRET`; optional `OPS_WALLET`, `MINT_CAP`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`, `TEAM_WALLETS`.

## Security

Two external reviews (October 2026) — eight issues in the first, fifteen (DD-01…DD-15) in the second — are all fixed and covered by regression tests (700+ checks). Highlights: domain-bound wallet sign-in (SIWS) with one-time nonces, per-IP rate limits on every function, admin keys only in an Authorization header, commit-reveal Degen Duel, coin buys price-locked at payment time, a crash-safe weekly draw, a strict co-signer that only signs recognised store sales, buy prices re-checked before signing, a Content-Security-Policy on both sites, and every Treasury transaction inspected and simulated before the owner signs. See [docs/SECURITY-ROADMAP.md](docs/SECURITY-ROADMAP.md). Payouts are a weekly one-click batch signed by the owner — see [docs/PAYOUTS-SETUP.md](docs/PAYOUTS-SETUP.md); no private key is held server-side.

## Tech

Solana web3.js · Mobile Wallet Adapter (wallet-standard-mobile) · ORE program (native instructions) · Jupiter swap API · Helius DAS · Magic Eden M2 & Tensor buy builders · Metaplex AuctionHouse · Next.js · Netlify Functions & Blobs.
