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
| **ORE marketplace** | List any NFT, buy any NFT, paid in ORE (ORE → SOL swap via Jupiter, then the buy). Magic Eden, Tensor and our own non-custodial AuctionHouse listings. 6.5% back in ORE. | `store/src/store-template.html`, `store/src/dojo-buy.js`, `store/functions/` |
| **Mine the Mint** | An anti-rug, anti-bot launchpad: commit 1 ORE, everyone gets one NFT, one drips out per minute at random; funds stay in escrow until milestones. | `store/src/launch.html` |
| **ORE grid miner** | Mine real ORE on a 5×5 grid of Degens — native ORE program instructions, auto-mining, live slot timing. | `miner/` (Next.js) |
| **Your own miner** | Any collection pastes its collection address and gets its own branded 25-NFT ORE grid (5 ORE setup). | `miner/app/create`, `miner/app/whitelabel` |
| **3 games & 2 arenas** | Dojo Flip, Teto Wars, Degen Duel, Cluck-Fu, Cock Brawl — provably fair; coins bought with ORE, SKR or SOL. | `store/src/*.html` |
| **Preachers** | Holders get a personal link and earn up to 30% of our cut, in ORE, on every buy, miner tip and coin pack they bring. | `store/src/become-a-preacher.html`, `store/functions/store-fn-preacher.mjs` |

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

**Environment** (set in Netlify — never committed): `SOLANA_RPC` (Helius), `TENSOR_API_KEY`, `MAGICEDEN_API_KEY`, `ADMIN_KEY`, `ATTR_ADMIN_KEY`, `SESSION_SECRET` (required, ≥32 chars), `COSIGNER_SECRET`; optional `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`, `TEAM_WALLETS`.

## Security

An external review of this repo (October 2026) found eight issues, all fixed and covered by regression tests. See [docs/SECURITY-ROADMAP.md](docs/SECURITY-ROADMAP.md) for each finding, the fix, the test evidence and the remaining operator steps. Weekly prize and Preacher payouts are described in [docs/PAYOUTS-SETUP.md](docs/PAYOUTS-SETUP.md); no private key is held server-side.

## Tech

Solana web3.js · Mobile Wallet Adapter (wallet-standard-mobile) · ORE program (native instructions) · Jupiter swap API · Helius DAS · Magic Eden M2 & Tensor buy builders · Metaplex AuctionHouse · Next.js · Netlify Functions & Blobs.
