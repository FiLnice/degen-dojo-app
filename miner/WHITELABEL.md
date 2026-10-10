# Whitelabel — onboard a new collection

The whole app (ORE mining, grid, vault, auto-mine, RPC proxy) is
collection-agnostic. Only **three things** change per collection:

| What | Where | How |
| --- | --- | --- |
| The 25 images | `public/mine/degens.json` | Replace the file |
| The tip wallet | `NEXT_PUBLIC_TIP_WALLET` env var | Set in Netlify |
| The collection name | `NEXT_PUBLIC_COLLECTION_NAME` env var | Set in Netlify |

## Easiest: the `/create` tool (fully automatic)

Point the collection at **`/create`** on your master deploy. They enter their
name + tip wallet + a **25-mint hashlist**; it fetches the art, previews the grid,
and hands them a **Deploy-to-Netlify button + one env-var block that already
contains their 25 images** (`NEXT_PUBLIC_DEGENS_JSON`). They paste it into Netlify
and deploy — **no files to edit, no code.** The manual steps below are the same
thing by hand.

## Steps to spin up a client (manual)

1. **Fork/copy this repo** into a new private GitHub repo for the client
   (or a new branch), so each client is isolated.

2. **Drop in their 25 images.** Replace `public/mine/degens.json` with their
   collection's entries — an array of exactly 25 objects:
   ```json
   [
     { "name": "Cool Ape #1", "image": "https://.../1.png" },
     { "name": "Cool Ape #2", "image": "https://.../2.png" }
   ]
   ```
   `image` can be any public https URL (S3, Arweave, IPFS gateway, etc.) —
   they're auto-resized/cached by Next/Image, so size doesn't matter.
   (`mint` is optional and unused.)

3. **Deploy to Netlify** and set these environment variables
   (*Site configuration → Environment variables*):

   | Key | Value | Notes |
   | --- | --- | --- |
   | `HELIUS_RPC` | a Helius mainnet RPC URL | **Tip:** have each client bring their **own** free Helius key so your RPC bill doesn't grow with their traffic |
   | `ALLOW_RPC_PROXY` | `1` | turns the data connection on in production |
   | `NEXT_PUBLIC_COLLECTION_NAME` | e.g. `Cool Apes` | shows in the tab title + tip label |
   | `NEXT_PUBLIC_TIP_WALLET` | the client's Solana wallet address | receives the optional tips |
   | `NEXT_PUBLIC_DEGENS_JSON` | `[{"name":"…","image":"…"}, …]` (25 items) | the images inline — skips editing `degens.json`. (Too long? use `NEXT_PUBLIC_DEGENS_URL` instead.) |
   | `NEXT_PUBLIC_TIP_ENABLED` | `true` (or `false` to hide tips) | optional |

That's it — they get their own link, their art on the grid, and their wallet
collects the tips. Defaults (if the env vars are unset) = **Degen Dojo**.

## Revenue model
- **You:** a one-time setup fee (e.g. 2–5 SOL) per collection.
- **The collection:** the optional per-round tips from their miners.

## Before scaling
- RPC cost scales with total traffic. Either require each client to bring their
  own Helius key (recommended — free tier covers a lot), or build the global
  board-state caching layer so cost scales with active miners, not page views.
- Every deploy stakes real SOL (24/25 tiles lose each round). The risk
  disclaimer is built into the page; make sure each client owns that with their
  community. Not financial advice.
