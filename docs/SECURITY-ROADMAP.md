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
   - referral (`ref`) front-running needs an on-chain memo;
   - Next 16.4.0 bump for local dev and the standalone miner site.
