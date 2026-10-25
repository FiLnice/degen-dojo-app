# Degen Dojo store — security remediation roadmap

Source of truth: `bulkitor/scripts` (built by `build-store-deploy.mjs` into `store-deploy/` →
`Downloads/degendojo-store.zip`; mirrored to github.com/FiLnice/degen-dojo-app).
Findings came from an external source review of the public repo. Each was verified against the
current code before fixing. "Fixed" below means: patched AND regression-tested locally. Nothing here
was deployed, and no transaction was sent; live behaviour still needs the operator steps at the end.

Status legend: ✅ fixed + tested · 🟡 in progress · ⛔ operator action needed · ⏳ not started

| # | Priority | Item | Status |
|---|---|---|---|
| 1 | Critical | Cosigner signature reachable by other programs (AH admin takeover) | ✅ |
| 2 | High | Coin purchase record overwrite / payer not bound to buyer | ✅ |
| 3 | High | Listing submissions trust client fields; stored XSS in listing name | ✅ |
| 4 | High | JSON-LD script injection from NFT metadata | ✅ |
| 5 | High (integrity) | Unauthenticated ticket endpoint feeds the prize draw | ✅ |
| 6 | Medium | Non-atomic coin debit / play finish (double spend / double award) | ✅ |
| 7 | Medium | Royalty sweep can skip credits (unreadable tx, price miss, pagination) | ✅ |
| 9 | Medium | Referral attribution not bound to the buyer (closed: on-chain memo) | ✅ |
| 8 | Medium | Integration risks: auth fallback secrets, RPC proxy limits, asset links, miner request binding, dependency audit | ✅ (⛔ SESSION_SECRET) |

---

## 1 · Cosigner signature reachable by other programs — ✅ FIXED

**Verified finding.** `store-fn-dd-cosign.mjs` only checked *AuctionHouse* instructions and let any other
program into the transaction. A signature covers the whole transaction, so any instruction that lists
the cosigner account can use its signer privilege — including a program that CPIs into the AuctionHouse
admin calls. Read-only chain check (2026-10-14): all three houses (ORE `7jAwmz…`, SKR `EfeSbH…`, USDC
`GnbcBG…`) have authority `8KUWwAH…` = the cosigner. So the bug allowed `update_auction_house`
(change authority, fees up to 100%, `requires_sign_off`, `can_change_sale_price`), `withdraw_from_fee`
(ORE house fee account holds 0.0887 SOL) and cancelling listings. No evidence of exploitation: the live
config is unchanged (fee 0 bps, sign-off off, price-change off, creator ED3GMC…).

**Security invariant.** The cosigner's signature can only be used by an AuctionHouse `buy` or
`execute_sale` instruction on one of our three houses.

**Change.** Every instruction that references the cosigner (as program or account) must be AH
buy/execute_sale whose accounts include one of our houses; every AH instruction must be buy/execute_sale
on one of our houses; at least one such sale must need the cosigner; the cosigner can't be fee payer,
must be a read-only signer, and may appear only once; out-of-range account indices are refused.
Other programs (ComputeBudget, wallet guard programs like Phantom Lighthouse) stay allowed because they
never receive the cosigner account and so cannot use its signature.

**Regression evidence** (`scratchpad/cosigntest.mjs`, `cosigntest2.mjs`, real web3.js v0 transactions):
10/10 pass — legit buy ✓, legit + wallet guard ✓, legit via address-lookup-table ✓; refused: extra program
handed the cosigner (CPI escalation), direct `update_auction_house`, sale on a foreign house, legit sale +
update in one tx, System transfer from cosigner, cosigner as fee payer, no sale at all, legacy tx.
The OLD code signed the CPI-escalation tx (200); the new code refuses it (400).

**Operator action.** Deploy the new zip. No key rotation needed (the key itself was never exposed; the
bug let its *signature* be misused). Optional later: re-check house config after deploy (script above).

---

## 8 · Integration risks — ✅ FIXED (operator step required)

**Verified.**
- (a) Session tokens fell back to `ADMIN_KEY` or a hardcoded dev secret when `SESSION_SECRET` was unset; admin-key
  checks used a `"\0"` sentinel that `?key=%00` matched when the env var was unset.
- (b) `/api/rpc` origin check `origin.includes(host)` was bypassable (`store.degendojo.xyz.evil.com`); no
  body/batch/param caps.
- (c) The LIVE store served a placeholder `/.well-known/assetlinks.json` (`REPLACE_ME…`, package
  `xyz.degendojo.app`) because a leftover build block overwrote the real file.
- (d) Miner-fee payment didn't require the ORE to leave the payer's own token account.
- (e) Dependency audit: no high/critical reachable in the deployed static store or its functions.
- (f) Preacher `setCode` released the old code, so another wallet could claim it and its unpaid referrals.

**Invariants / changes.**
- Sessions fail closed: `SESSION_SECRET` ≥ 32 chars or 503 (`store-session-core.mjs`); no fallback.
- Admin keys are compared in constant time, and an unset env var matches nothing.
- `/api/rpc`:
  - exact-host origin match, Origin `null` refused;
  - body ≤ 64 KB, batch ≤ 10;
  - per-method caps (getMultipleAccounts ≤ 100, getSignatureStatuses ≤ 256, getAssetBatch ≤ 100, single getTransaction);
  - getProgramAccounts pinned to M2 and must carry a pubkey memcmp;
  - user-signed sendTransaction relay limited to one base64 tx ≤ 1700 chars.
- Miner fee:
  - the payer signs and is debited from their own ATA;
  - age ≤ 1 h, no future blockTime;
  - atomic sig claim (`onlyIfNew` where supported);
  - can't be reused as a coin purchase.
- Preacher codes are never released.
- The assetlinks overwrite is removed, and the build fails on any placeholder.
- `scripts/assetlinks.json` now lists the released APK's signing fingerprint `CD:AB:6B…:26:9A`, read from
  `release/DegenDojo.apk`'s certificate, plus the previous `84:8C…E1:61`.

**Evidence.** `scratchpad/sec-c/test.mjs`: 78/78 pass. Miner `tsc` and export are still green.

**Operator actions (⛔).**
1. Set `SESSION_SECRET` on Netlify (≥ 32 random chars, different from ADMIN_KEY) BEFORE deploying the
   full build, or sign-in/play return 503.
2. Make `ATTR_ADMIN_KEY` and `CLAIM_ADMIN_KEY` long and random.
3. After deploy, confirm `https://store.degendojo.xyz/.well-known/assetlinks.json` shows `xyz.degendojo.store.twa`.
4. Optional: bump Next to 16.4.0 for local dev and the standalone miner site (not the static store).

**Still open (design level).** `/api/attr` referrals aren't signed by the buyer, so a bot can tag unreferred
sales within the 6 h window. Miner-request front-running is backstopped by admin review.

## 3 · DD listing submissions — ✅ FIXED (pending deploy)

**Verified.**
- The old `/api/dd-listings` accepted any existing account as the trade state. A control test accepted a
  forged listing that used a borrowed trade state, a fake price and a hostile name.
- `GET` didn't check the account owner.
- Listing data was rendered unescaped in:
  - `dd-list.html`: the name, price and currency, plus the wallet-grid image src (so an airdropped NFT could break out of it);
  - `dd-case.js`: only `<` was escaped, and image srcs were raw;
  - the market page: the mint and symbol in `onclick`, raw `/` images, and the resolver output.
- The store strip was already safe, but it has been hardened anyway.

**Invariant.** A listing is stored or served only if all of the following hold:
- its trade state is the AuctionHouse PDA for (seller, house-for-currency, token account, treasury mint,
  mint, price, 1);
- that trade state is owned by the AuctionHouse and live;
- the seller still holds the NFT.

Display data comes only from DAS, sanitised, and every renderer escapes it.

**Change.**
- `store-fn-dd-listings.mjs` was rewritten:
  - `POST` verifies the listing;
  - `GET` re-verifies each stored record and prunes failures;
  - it fails closed when the RPC is down.
- `dd-list.html`, `dd-case.js`, `store-template.html`, `shelf-mockup.html` and `become-a-preacher.html`:
  - escape everything;
  - allow https images only;
  - accept base58 mints only;
  - JSON-escape inline handler arguments.

**Evidence.** `scratchpad/sec-a/test-listings.mjs`: 76/76.
- The PDA and curve code match web3.js.
- Server derivation matches the real `dojo-ah.js buildSellIx` for 120 listings across all 3 houses.
- Every forged variant is rejected.

`test-render.mjs`: 122/122, and the pre-fix copies fail all controls. `mainnet-check.mjs`: 12/12 (read-only).

**Operator.**
1. Deploy.
2. Call `GET /api/dd-listings` once, so old records are re-verified or pruned.
3. List one real NFT and confirm it shows on `/market`. There are 0 live DD listings today, so a real
   listing hasn't been through the validator yet.

## 4 · JSON-in-`<script>` injection — ✅ FIXED (pending deploy)

**Verified.**
- `seo-nft.mjs` (`/nft/:mint` renders any mint, so it's attacker-reachable) put metadata into JSON-LD with
  `JSON.stringify` alone.
- NEW, found here: `build-store.mjs` and the market `__DATA__` splice used string `.replace`, so `$'` in a
  third-party Magic Eden collection name re-injected template text containing `</script>`. That was a
  stored-XSS path.

**Invariant.** No generator embeds JSON in `<script>` without `jsonForScript` (it escapes `< > & U+2028
U+2029`), and template splices use function replacers.

**Change.** New `html-safe.mjs`, used by:
- `seo-nft.mjs`;
- `build-seo`, `build-site` (14 places), `build-claim`, `build-rank`, `build-store`, `build-store-deploy`,
  `build-duel-standalone`, `build-content-gen`, `build-shelves-standalone`.

**Evidence.** `test-render.mjs` (the old `seo-nft` and `build-store` are flagged).

**Operator.** Rebuild and deploy BOTH the store and the main site, and make sure the CDN-cached `/nft/*`
pages get purged (they had stale-while-revalidate for 7 days).

## 2 · Coin purchase payer binding — ✅ FIXED (pending deploy)

**Verified on the original code.** An attacker posting someone else's payment sig was credited 29 coins
and the real buyer 0. Concurrent cron runs double-credited. Tips had the same flaw.

**Invariant.** Coins are credited only to a signer whose own balance dropped by at least the treasury's gain
(SOL lamports; SPL tokens by account owner), exactly once per signature.

**Change.**
- `store-verify-core.mjs`:
  - payer binding;
  - a front-run claim is re-attributed to the real payer with its referral dropped (strict-reject mode is
    one constant away, `REATTRIBUTE_TO_PAYER`, and both modes are tested);
  - a create-only `credited:<sig>` marker, with balance and pot writes keyed to the sig;
  - a 48h claim window;
  - our own wallets are refused as customers;
  - RPC errors no longer reject genuine purchases;
  - one sig can't pay both a coin pack and a branded-miner fee.
- `store-fn-coinbuy.mjs`: an atomic create-only POST.

**Evidence.** `scratchpad/sec-b/test-payments.mjs`: 77/77.

**Open.** A referral `ref` is still first-write-wins and can be front-run. Closing that needs the
referral bound on-chain with a memo.

## 5 · Ticket endpoint & draw integrity — ✅ FIXED

**Invariant.** Only `/api/play`-verified plays mint draw tickets.

**Change.**
- `/api/ticket` writes only to `tickets-legacy`.
- The draw counts only `player:<valid wallet>` records, archives every round to `tickets-archive`
  (`r<n>:*`), and clears the ledger.
- Admin checks use `adminKeyOk`.

**Evidence.** `test-tickets.mjs`: 14/14. A forged record of 1e9 tickets never won in 10 draws.

**Contaminated past rounds.** Rounds drawn before this fix could include forged weight. To inspect one, use:
- `/api/draw?action=status`
- `/api/payouts?round=n&key=…` (re-checks the draw)
- the archive
- `GET /api/ticket?key=…`

## 6 · Atomic coin debit / play finish — ✅ FIXED (pending deploy)

**Verified on the original code.** Two starts with 1 coin both succeeded; 10 starts with 3 coins all
succeeded; finishes double-awarded. Also, a payout rebuild could overwrite a just-paid plan.

**Invariant.** Every money- or ticket-moving state change is a conditional write.

**Change.**
- The new `store-cas-core.mjs` provides `casUpdate`, `putIfNew` and `putIfMatch`, and fails closed when
  conditional writes aren't available.
- `@netlify/blobs` is pinned to **10.7.13**. Version 8.x has no conditional writes, and 10.0–10.7.11
  silently ignore them in `setJSON`.
- Covered:
  - coin debit;
  - play finish (open → finishing → done, tickets minted once per play);
  - the Seeker claim (create-only per SGT and per wallet);
  - coin credit;
  - pot add and reset;
  - payout paid, exclude and rebuild.

**Evidence.**
- `test-play.mjs` 45/45, `test-payout.mjs` 17/17.
- `pkgcheck/realtest.mjs` 8/8 against the real 10.7.13 library.
- Control runs on the old code: 17 failures.

**Residual.**
- Atomicity relies on Netlify enforcing If-Match server-side (the documented API).
- A play that finishes during a draw can lose its tickets, but can never double them.

## 7 · Royalty sweep durability — ✅ FIXED (pending deploy)

**Verified on the original code.**
- It read only 100 signatures and lost 2 of 3 sales.
- It skipped unreadable or RPC-errored txs forever.
- On a price miss it credited part of the sale and marked it done.
- `/api/dd-royalty` had no marketplace check, trusted the client's currency, and allowed old sales to be
  credited retroactively.

**Change.**
- It reads every page of signatures, and the cursor moves only over handled ones.
- Failures go to a durable `retry:<sig>` queue, given up after 120 tries and 3 days with an audit record.
- Each sale is credited all-or-nothing behind a one-time `claim:<sig>`.
- `/api/dd-royalty` uses the same rule:
  - a marketplace program is required (Tensor TComp is included);
  - trades signed by the royalty wallet are skipped;
  - the client's currency is ignored;
  - nothing older than 48h, or from before the baseline, is credited.
- Mainnet's v1 transactions are read too: getTransaction retries with `maxSupportedTransactionVersion: 1`.

**Evidence.** `test-royalty.mjs`: 22/22. Control on the old code: 9 failures and a crash.

**Operator.** Re-check old `dd-royalties` records noted "no royalty to creator"; some may be hidden real royalties.


## 9 · Referral attribution bound on-chain — ✅ FIXED (2026-10-15)

**Problem.** The preacher `ref` was an unsigned value sent next to a purchase, recorded first-write-wins, so the
credit for a purchase could end up with the wrong preacher.

**Invariant.** A preacher is credited ONLY from a `ddref:<code>` SPL Memo inside the buyer's own signed
transaction. Any `ref` a client POSTs is ignored for attribution and kept only as `postedRef` for audit.

**Change.**
- Client — `wallet-picker.js` `DojoRef`: `instruction`, `withRef`, `addToTx`. The memo is added to:
  - coin packs (`dojo-credits.html`);
  - market buys (`dojo-buy.js`: our M2 build, plus Magic Eden/Tensor-built txs, which are decompiled with
    their lookup tables, get the memo, and have any explicit compute limit raised by 20k);
  - store-home buys (`store-template.html`);
  - our AuctionHouse buys (`dojo-ah.js`, only if the tx still fits);
  - ORE-miner tips (`degen-dojo-ore`: `lib/ore.ts` `refMemoIx`, `app/mine/page.tsx`, default miner only).
- Already-signed or oversized transactions are left untouched, so a buy never fails because of the referral.
- Server: `store-ref-core.mjs` `refFromTx` reads the memo from the verified tx logs.
  - `store-verify-core.mjs` sets `ref` from the memo for coin packs and tips.
  - `store-preacher-core.mjs` requires the memo for NFT sales; a record naming another preacher is
    re-attributed to the memo's preacher, and self-referral is judged against that preacher.

**Evidence.**
- `scratchpad/ref/e2e.mjs`: 9/9, using the real browser helper and real mainnet simulation (read-only):
  - the chain logs `Memo (len 14): "ddref:ronin_42"` and the server parser reads it;
  - ALT-based marketplace txs and legacy txs are rewritten and simulate OK;
  - signed txs are untouched.
- `sec-b/test-payments.mjs`: 81/81 (4 new: posted ref without memo earns nothing; memo beats a posted
  ref; front-run claim gives payer AND preacher back to the chain's values; same for tips).
- `playtest/test-nft.mjs`: 50/50 (no memo → nothing; memo re-attributes).
- Pages load with `DojoRef` reading the cookie; no script errors.

**Note.** Purchases made from a page loaded before this deploy carry no memo, so they credit no preacher.

---

## Operator runbook (what remains outside code)
1. **Netlify env:**
   - `SESSION_SECRET`: ≥ 32 random chars, different from ADMIN_KEY. **Required before deploying the full build.**
   - Long, random `ATTR_ADMIN_KEY` and `CLAIM_ADMIN_KEY`.
   - `TEAM_WALLETS`: your personal wallets that fund the treasury.
   - Optional: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` or `DISCORD_WEBHOOK_URL` (see `PAYOUTS-SETUP.md`).
2. **Deploy** the store zip and the main-site zip. Check the deploy log installs `@netlify/blobs` 10.7.13.
3. **After deploy, check:**
   - `/.well-known/assetlinks.json` shows `xyz.degendojo.store.twa`;
   - call `GET /api/dd-listings` once;
   - list one real NFT;
   - make a small coin purchase (credited once, to you);
   - play one game;
   - make one market buy.
4. **Purge the CDN cache** for `/nft/*` if old pages linger.
5. **Not fixed in code (design level):**
   - Next 16.4.0 bump for local dev and the standalone miner site.

---

## Review round 2 (2026-10-21) — three parallel reviews: browser/wallet signing, server functions, leaked secrets

Fixed + tested locally (store + site zips rebuilt; nothing deployed or sent):

| # | Severity | Item | Fix |
|---|---|---|---|
| 10 | High | Royalties / any deposit into the pot wallet could be claimed as a "tip" → pot paid money it never got (+ preacher share) | tip = plain transfer (System/Token/ATA/ComputeBudget/Memo only) **with the `ddtip` memo**; store tip button adds it (`store-verify-core` `plainPayment`, `store-ref-core` `memosOf`) |
| 11 | High | Store honoured `?rpc=` / `localStorage.ddRpc` in production (fake simulations / fake listings) | override only on localhost (`store-template.html` CONFIG.rpc) |
| 12 | High | `/credits` built payments with web3.js + spl-token from esm.sh | self-hosted `/web3.js` + hand-built ATA-create + Transfer |
| 13 | Med-High | Helius key hard-coded in degendojo.xyz pages | 4 calls → `/api/das` (`site-fn-das.mjs`, getAssetsByOwner only); **owner must rotate the key** |
| 14 | Medium | Cosigner signed a bid alone → house fee account drain → pNFT buys halt | every `buy` must pair with an `execute_sale` on the same buyer trade state |
| 15 | Medium | Junk `/api/coinbuy` records stall the cron | getSignatureStatuses at POST; unreadable records expire after 15 min |
| 16 | Medium | RPC proxy gPA memcmp bypass; DAS cursor paging | memcmp pinned to offset 112; cursor/before/after refused |
| 17 | Medium | No anti-framing headers | `X-Frame-Options: DENY` + `frame-ancestors 'none'` |
| 18 | Low | `/credits` stale fallback prices | live prices only, retry |
| 19 | Info | Function sources / package files downloadable | `_redirects` 404! for /netlify/*, /node_modules/*, package*.json, netlify.toml (both sites) |
| — | Guard | Keys could ship again | `build-leak-guard.mjs` refuses to zip if a key / private key / 64-byte array is in the output |

Still open: counterfeit-Degen labelling (verified-collection badge), inspect ME/Tensor/Jupiter-built txs (payouts), admin keys in URLs, listing GET cap per seller/mint, Duel seed revealed at start, miner-fee front-run, function rate limits. Operator: rotate Helius key; delete local `scripts/dd-cosigner.json` once Netlify has COSIGNER_SECRET; delete `bulkitor/.netlify` cache; one encrypted backup of the APK keystore.
(2026-10-24, review of 2026-10-23 M12: the market price lock — buy refused if the live price moved — IS live: store-template.html PRICE LOCK for Magic Eden/Tensor + dojo-ah.js lockPrice; the repo copy was simply stale because the sync never copied store-template.html — fixed in scripts/sync-github.ps1.)

---

## Review round 3 (report of 2026-10-23, fixed 2026-10-24/25): 7 lanes, every finding re-checked against the current code

Fixed and tested locally in `bulkitor/scripts`. The store and site zips are rebuilt; nothing is deployed or sent. There are 30 suites in `run-all-tests.ps1`, and all pass except `swap-guard-test`: it is a live simulation that needs ≥ 0.01 SOL in the owner's wallet, and its two refusal checks pass.

| # | Severity | Item | Fix |
|---|---|---|---|
| H1 | High | `mine.degendojo.xyz` is a dangling CNAME; the preacher link uses it; the `dd_ref` cookie is domain-wide | Preacher link → `store.degendojo.xyz/mine?ref=`. Cookie is host-only `__Host-dd_ref`, read through `DojoRef.code()`; the old cookie is migrated once. **Owner deletes the DNS record (Spaceship).** |
| H2 | High | Front-run POST with the wrong kind/currency voids a coin buy or tip | Kind, currency and the inspected wallet come from the transaction (POST = hints). Payer/unreadable rejections are re-queueable. Admin `requeue`/`delete` on `/api/verify` |
| M1 | Medium | Keeper double-books an inflow (decoy marketplace key) | Marketplace = programs actually invoked. Royalty branch skips credited coin records. verify-core refuses txs listing a marketplace program |
| M2 | Medium | Repair nullified via `/api/coinbuy` | `ddfix:` decided first. Memo-less ORE waits for the coin verdict. verify-core refuses ddfix and memo-less ORE at POST |
| M3 | Medium | DAS/RPC hiccup → permanent skip | Errors → retry (24 h max), then a desk-visible skip with **Re-decide** |
| M4 | Medium | House fee account drained by rent | Every co-signed buy carries a buyer → fee-account rent refund, computed server-side. 0.001 ORE minimum price. Fee account pinned. Low-balance line on /payouts. SKR/USDC houses retired |
| M5 | Medium | Floor / look-alike checks fail open | Cosigner retries DAS, falls back to on-chain metadata, else 503. Listing POST refuses on DAS failure. GET re-checks old "" records |
| M6 | Medium | Payout swap inspector can't see a stripped slippage floor | Jupiter route args decoded (verified on 4 real swaps). Refuses unknown/v2/ExactOut, fee > 0, slippage > 1%, minimum < quote |
| M7 | Medium | Sign-in lockout by nonce overwrite | Nonces keyed by nonce, single-use. Legacy pointer until 2026-11-09 |
| M8 | Medium | Self-referral via a 2nd wallet | Detection only (owner decides): `few buyers` / `one buyer` / `same tx` warn; `linked wallets` (90-day transfers either way) **blocks** the payout send until reviewed |
| M9 | Medium | Retired `/api/attr` read in request paths | POST → 410. No reads in stats/owed/plan. Client calls removed |
| M10 | Medium | verify-cron reads the whole ledger | `pending:<sig>` index, 20 s budget, readable-tx check at POST, junk purged after 3 days |
| M11 | Medium | Ticket hoarding across rounds | Round stored at start. A late finish gets the base ticket only. 24 h finish deadline. Sweep |
| M12 | Medium | Repo ≠ deployed template | The template had every fix; the sync now copies it (`scripts/sync-github.ps1`) |
| M13 | Medium | degendojo.xyz without CSP/anti-framing | In the site `_headers` (`build-all.mjs`). **Owner uploads the site zip** |
| L | Low | Quote shopping / 4% tolerance | Latest quote per wallet+currency only, 1% tolerance, 20 quotes/h |
| L | Low | Admin dashboard sums POSTed hints | Verified records only |
| L | Low | Double mint after a crash; lendable ×2; `/api/ticket` sink; -32009 slot skip | Play ids in the snapshot; per-asset 1 h claim; endpoint removed; `getBlocks` |
| L | Low | Fairness verifiable by the operator only; randomness fixed while entries are open | Commit closes the round → entries snapshot + hash published → only then the target slot. `/draw` re-runs the pick in the browser |
| L | Low | Rebuild plan re-adds moved preachers; flags page-only; swap-once in localStorage; dust quote | Old rounds get no preachers + create-only `rec:` claims. Server-side review gate on send/preflight. Server-verified `swapped`. 90%-of-spot check |
| L | Low | Cosigner relays without checking the buyer signature; residual price-lock gap; non-ATA listings | Ed25519 check first. Buyer token accounts simulated. Seller ATA required |
| L | Low | Keeper payer = fee payer; `/api/vault` amplifier; stale claim prices; NFT arrival with a marketplace key | Owner of the debited ORE account. Batched/cached reads, cron-only scan. 5-min price age + stORE ≥ ORE band. Arrivals decided first |
| L | Low | Preacher tier read live; brand codes squattable; SIWS relay | 7-day holding (grandfathered until 2026-11-30). Reserved + confusable names. `Sec-Fetch-Site` + `solana:signIn` |
| L | Low | Unbounded Blobs stores | Weekly sweep in payout-cron (nonces, used markers, legacy tickets). Launch intake capped 50/day + 1 per wallet/day |
| L | Low | Memos parsed from any program log | Memo-program instructions only (store + Keeper share the reader) |
| L | Low | Leak guard misses key formats | base58/hex keys, keypair arrays, Telegram/Discord, `apiKey:`, keystores. The finished zip is scanned too (all 3 builds) |
| L | Low | Second assetlinks cert; `?relay=` persisted; unescaped Reserve/credits/admin strings; `/nft` pages without CSP; admin cached by SW | Removed 84:8C (release APK = CD:AB only); overrides tab-only + localhost; escaped; headers added; SW never caches operator pages / no-store |
| I | Info | Legacy miner API routes; Next 16.2.9; `reservedWallets` gaps; stale docs; Keeper conversion quote unchecked | Routes → 410; Next 16.2.11; OPS/owner/cosigner wallets reserved; docs fixed; X→stORE quote sanity-checked against spot |

**Not changed (owner decisions):**
- Duel balance: a greedy strategy wins ~70%, so Duel pays ~2× tickets per coin.
- The 10-minute coin price lock: could be 5 minutes.
- CSP `'unsafe-inline'`: needs per-page nonces.
- `img-src https:`: the market shows art from any collection.
- The rate limiter is per instance.

**Owner actions after round 3:**
1. Delete the `mine` CNAME at Spaceship, and remove the host from Netlify if it's listed.
2. Upload both zips, then sync the repo with `scripts/sync-github.ps1`, delete `store/functions/store-fn-ticket.mjs` from the repo copy, and push.
3. Keep the AuctionHouse ORE fee account above 0.02 SOL (the /payouts line warns).
4. Optional: set `PREACHER_RESERVED_WALLETS`.
5. Confirm the old Helius key was rotated.

Round 2 "still open" items now closed:
- the Duel seed (fixed);
- the miner-fee front-run (ddminer memo);
- ME/Tensor/Jupiter-built txs (inspector + decode);
- admin keys in URLs (Bearer only; the legacy miner routes are retired);
- the listing cap.
