# Whitelabel — branded miners (hosted on the store)

Any NFT collection can get its own ORE mining grid, **hosted by us** on the Degen Dojo
store at `store.degendojo.xyz/m/<slug>`. No fork, no deploy, no RPC key on their side.

## How a collection signs up — `/create`

1. **Name + contact** (website optional).
2. **Paste the collection address** → we read its NFTs (DAS `getAssetsByGroup` through the
   store's `/api/rpc`) and pick 25 at random (Shuffle to re-roll). Or paste 25 mints by hand.
3. **Pay the one-time 5 ORE setup fee** with the store wallet (same session as every store
   page). The fee goes to the operator wallet — the store treasury
   `5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp` by default (`lib/config.ts`
   `STORE_TREASURY_WALLET`, override with `NEXT_PUBLIC_OPERATOR_WALLET`).
4. The request is POSTed to the store function **`/api/miner-requests`**, which re-reads the
   payment on-chain (tx succeeded, payer signed it, < ~1h old, operator's ORE up by ≥ fee)
   and stores it as *pending*. Each payment signature can only be used once.
5. `/create?id=<id>` shows the status. Once approved it shows the live link
   `store.degendojo.xyz/m/<slug>` and the code to embed it, each with a copy button.

## Reviewing — `/miner-admin` (store)

Enter the store's `ADMIN_KEY` (kept in that tab's sessionStorage only). Each request shows
name, contact, the payment on Solscan and the 25 thumbnails.
**Approve** (optionally choose the slug; default = from the name, de-duplicated) publishes
`miner:<slug>` → live immediately at `/m/<slug>`. **Reject** takes it offline again.

## How a hosted miner works

The store serves the `/mine` page at `/m/*`. At runtime it reads the slug from the URL
(or `?c=<slug>`), loads `{name, degens}` from `/api/miner?slug=`, and uses that name and grid.
Unknown slug → "Miner not found". Plain `/mine` is the Degen Dojo miner, configured at build
time exactly as before.

A hosted miner shows no Degen Dojo menu or links: the store bar and the "add your collection"
button are gone, it has its own Connect button, the fee reads "Miner fee", and its Vault link
is `/mine/vault?c=<slug>` (no menu, back goes to `/m/<slug>`).

`/m/<slug>` is the one store page other sites may frame (`frame-ancestors https:`, owner
2026-10-31), so a collection can embed its miner with the iframe code `/create` shows once
approved. Every other store page keeps `X-Frame-Options: DENY` and `frame-ancestors 'none'`
against clickjacking. `_headers` can't relax one path, so `store-fn-miner-page.mjs` serves
`/mine.html` at `/m/*` with its own headers. In a frame, a phone's Connect opens the full page
in a new tab (phone wallets can't be relied on in a frame), desktop adds an "open in a new
tab" link, and the Vault always opens in its own tab.

## Store env (Netlify)

| Key | Notes |
| --- | --- |
| `ADMIN_KEY` | gates `/miner-admin` list + approve/reject |
| `SOLANA_RPC` (or `HELIUS_RPC`) | `getTransaction` for fee verification |
| `OPERATOR_WALLET` | optional; default store treasury. **Must match** the wallet baked into `/create` |
| `SETUP_FEE_ORE` | optional; default `5`. Keep in sync with `NEXT_PUBLIC_SETUP_FEE_ORE` |

## Revenue model
- **Us:** a one-time **5 ORE** setup fee per collection.
- **Us, ongoing:** the same 1% fee as `/mine`, paid by miners to the Reserve. It keeps the miner hosted.
- **The collection:** no fee share and no tips (owner 2026-10-30). They get a miner for their holders.

## Notes
- Every miner stakes real SOL (24/25 tiles lose each round). The risk disclaimer is built
  into the page; make sure each client owns that with their community. Not financial advice.
- Self-hosting a fork (env vars `NEXT_PUBLIC_COLLECTION_NAME`, `NEXT_PUBLIC_TIP_WALLET`,
  `NEXT_PUBLIC_DEGENS_JSON`/`_URL`, `HELIUS_RPC`, `ALLOW_RPC_PROXY=1`) still works, but it is
  no longer the offered path.
