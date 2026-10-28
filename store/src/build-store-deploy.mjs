// ============================================================================
//  Degen Dojo — package THE STORE for a private Netlify test deploy.
//
//  Builds the store, drops it in its own folder with headers that keep it out of
//  search engines, and zips it for drag-and-drop onto Netlify.
//
//    node scripts/build-store-deploy.mjs           -> re-index + build + zip
//    node scripts/build-store-deploy.mjs --nofetch -> reuse the current listings
//
//  Output: scripts/store-deploy/  and  Downloads/degendojo-store.zip
//
//  PRIVACY: the zip ships `X-Robots-Tag: noindex` + a disallow-all robots.txt,
//  so the site is unlisted — reachable only by its random Netlify URL. That is
//  "unlisted", not "locked". For a real password use Netlify's own
//  Site configuration → Access & security → Password protection (a paid
//  feature); it cannot be set from the deploy bundle.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, rmSync, existsSync, readdirSync } from "fs";
import { assertNoSecrets, assertZipClean } from "./build-leak-guard.mjs";
import { STORE_CSP as CSP } from "./csp.mjs";   // the store loads nothing from cdnjs (security review L8)
import { execSync } from "child_process";

const ROOT = "C:/Users/sazei/Documents/DEGEN DOJO/BULKITOR/bulkitor";
const OUT = `${ROOT}/scripts/store-deploy`;
const ZIP = "C:/Users/sazei/Downloads/degendojo-store.zip";

const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: "inherit" });

console.log("\n[1/4] Building the store…");
run(`node scripts/build-store.mjs${process.argv.includes("--nofetch") ? "" : " --index"}`);

console.log("[2/4] Assembling the deploy folder…");
// Every file below is rewritten, so a locked folder (preview server holding a
// handle on Windows) is not a reason to fail the build.
try { rmSync(OUT, { recursive: true, force: true }); } catch {}
mkdirSync(OUT, { recursive: true });
copyFileSync(`${ROOT}/scripts/store.html`, `${OUT}/index.html`);
// Strip the "Paste any Magic Eden / Tensor link — own it in ORE" search bar (not wanted on the
// store). Done here so it stays gone even if the source file gets re-saved with it.
{
  let _idx = readFileSync(`${OUT}/index.html`, "utf8");
  _idx = _idx.replace(/\s*<div class="pastebar">[\s\S]*?<\/div>\s*<div class="pastemsg"[^>]*>\s*<\/div>/, "");
  writeFileSync(`${OUT}/index.html`, _idx);
}
// The Become a Preacher page — same origin so /api/preacher is same-origin too.
copyFileSync(`${ROOT}/scripts/become-a-preacher.html`, `${OUT}/become-a-preacher.html`);
// Economy / tokenomics page — kept private here (the store site is password-locked) until it's
// ready to go public. Self-contained (logo + favicon embedded, nav links absolute to degendojo.xyz).
mkdirSync(`${OUT}/economy`, { recursive: true });
copyFileSync(`${ROOT}/scripts/economy-page.html`, `${OUT}/economy/index.html`);
// NFT rescue tool — read-only scanner for NFTs stuck in a rugged staking program. Lives on the
// STORE (not the main site) because recovery needs a wallet connection. Optional SOL/ORE/SKR tip.
mkdirSync(`${OUT}/rescue`, { recursive: true });
copyFileSync(`${ROOT}/scripts/rescue-template.html`, `${OUT}/rescue/index.html`);
// GAMES — the store IS the wallet-connected app, so Play + its games live here too (same origin →
// the wallet connection + game session carry across store/shelves/play). Hub at /play; games under
// /play/* and /dojo-flip/. Games reference /dojo-credits.js /dojo-scores.js /dojo-wallet.js /wallet-picker.js.
mkdirSync(`${OUT}/play/cluck-fu`, { recursive: true });
mkdirSync(`${OUT}/play/teto-wars`, { recursive: true });
mkdirSync(`${OUT}/dojo-flip`, { recursive: true });
copyFileSync(`${ROOT}/scripts/store-play-hub.html`, `${OUT}/play/index.html`);
copyFileSync(`${ROOT}/scripts/dojo-flip.html`, `${OUT}/dojo-flip/index.html`);
copyFileSync(`${ROOT}/scripts/chicken-game-mockup.html`, `${OUT}/play/cluck-fu/index.html`);
copyFileSync(`${ROOT}/scripts/teto-wars-game.html`, `${OUT}/play/teto-wars/index.html`);
mkdirSync(`${OUT}/play/degen-duel`, { recursive: true });
copyFileSync(`${ROOT}/scripts/dojo-duel.html`, `${OUT}/play/degen-duel/index.html`);   // standalone Degen Duel (4th game)
mkdirSync(`${OUT}/play/cock-brawl`, { recursive: true });
copyFileSync(`${ROOT}/scripts/cock-brawl.html`, `${OUT}/play/cock-brawl/index.html`);   // 5th game — kept IN the store so its nav is the store nav, not the public site's
for (const f of ["dojo-credits.js", "dojo-scores.js", "dojo-wallet.js", "teto.png", "teto-board.jpg", "dd-logo.png"])
  copyFileSync(`${ROOT}/scripts/${f}`, `${OUT}/${f}`);
// Coins page — buy game coins (ORE/SKR/SOL), server-credited; the hub + games read the balance.
mkdirSync(`${OUT}/credits`, { recursive: true });
copyFileSync(`${ROOT}/scripts/dojo-credits.html`, `${OUT}/credits/index.html`);
mkdirSync(`${OUT}/pot`, { recursive: true });
copyFileSync(`${ROOT}/scripts/weekly-pot.html`, `${OUT}/pot/index.html`);   // transparent weekly Dojo Pot
// The games ship with the MAIN-SITE nav (Lore/Traits/Framed/ORE…). Inside the store that's the
// wrong menu, so swap in the STORE nav (same .flips-nav styling) for the store's copies only.
// Self-contained (inline-styled) so ALL games get the IDENTICAL store nav regardless of each
// game's own .flips-nav / .gsite-nav CSS — fixes both the "wrong menu" and the "font changes
// between games" issues. Matches whichever nav class the game shipped with.
// ── THE canonical top menu — identical on every store page + game. Same DD logo + "DEGEN DOJO"
//    with a per-page sublabel below it, and the same pills (the current section highlighted). Only
//    `sub` + `active` change per page. `extra` appends a right-side element (wallet button / coins). ──
const navPill = (href, label, on) =>
  `<a href="${href}" style="font-family:'Cinzel',serif;font-size:11px;font-weight:700;letter-spacing:.08em;border-radius:8px;padding:9px 14px;text-decoration:none;white-space:nowrap;${on ? "color:#e8b84b;border:1px solid rgba(201,151,58,.6);background:rgba(201,151,58,.14);" : "color:#efe6d2;border:1px solid rgba(201,151,58,.32);"}">${label}</a>`;
// Responsive: desktop shows the pills inline (unchanged); ≤640px collapses them behind a ☰
// hamburger (dropdown), matching the store home. One <style> block + classes; the toggle is a
// self-contained inline handler (no globals).
const ddNavCss =
  `<style>.dn-ham{display:none}.dn-connect{display:none}.dn-extra{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}` +
  `@media(max-width:640px){` +
  `.dn-bar{gap:10px!important;padding:10px 14px!important;}.dn-extra{display:none!important;}.dn-connect{display:block!important;}` +
  `.dn-ham{display:flex!important;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;cursor:pointer;background:rgba(201,151,58,.12);border:1px solid rgba(201,151,58,.45);color:#e8b84b;font-size:22px;line-height:1;margin-left:auto;flex:0 0 auto;}` +
  `.dn-links{position:absolute!important;top:calc(100% - 2px);right:10px;min-width:214px;flex-direction:column!important;align-items:stretch;gap:5px!important;background:rgba(12,10,18,.98);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(201,151,58,.4);border-radius:12px;padding:9px;box-shadow:0 16px 36px rgba(0,0,0,.6);display:none!important;z-index:80;}` +
  `.dn-links.dn-open{display:flex!important;}` +
  `.dn-links a{text-align:left;font-size:13px!important;padding:11px 13px!important;}}` +
  `</style>`;
const ddNav = (sub, active, extra = "") =>
  ddNavCss +
  `<div class="dn-bar" style="position:sticky;top:0;z-index:72;background:rgba(10,10,15,.94);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-bottom:1px solid rgba(201,151,58,.18);display:flex;align-items:center;gap:16px;padding:11px 20px;flex-wrap:wrap;font-family:'Cinzel',serif;">` +
  `<a href="/" style="display:flex;align-items:center;gap:11px;text-decoration:none;color:#efe6d2;"><img src="/dd-mark.jpg" alt="Degen Dojo" style="width:40px;height:40px;border-radius:9px;object-fit:cover;display:block;box-shadow:0 0 0 1px rgba(201,151,58,.35);" onerror="this.style.display='none'"/>` +
  `<div style="text-align:left;"><b style="font-family:'Cinzel',serif;font-size:15px;letter-spacing:.16em;display:block;color:#efe6d2;">DEGEN DOJO</b><small style="font-family:'Cinzel',serif;font-size:9px;letter-spacing:.26em;color:#a99a7e;">${sub}</small></div></a>` +
  `<nav class="dn-links" style="display:flex;gap:8px;flex-wrap:wrap;"><a href="#" class="dn-connect" onclick="var b=this.closest('.dn-bar').querySelector('.dn-extra button');if(b)b.click();return false;" style="font-family:'Cinzel',serif;font-size:11px;font-weight:700;letter-spacing:.08em;border-radius:8px;padding:9px 14px;text-decoration:none;white-space:nowrap;color:#e8b84b;border:1px solid rgba(201,151,58,.5);background:rgba(201,151,58,.12);">🔑 Connect</a>${navPill("/", "⌂ Store", active === "store")}${navPill("/market", "🛒 Market", active === "market")}${navPill("/list", "🏷 List", active === "list")}${navPill("/play", "▶ Play", active === "play")}${navPill("/mine", "⛏ Mine", active === "mine")}${navPill("/sweep", "💰 Claim", active === "sweep")}${navPill("/launch", "🚀 Launch", active === "launch")}${navPill("/pot", "🏆 Pot", active === "pot")}${navPill("/become-a-preacher", "📣 Preacher", active === "preacher")}</nav><span class="dn-extra">${extra}</span>` +
  `<button class="dn-ham" type="button" aria-label="Menu" onclick="var n=this.closest('.dn-bar').querySelector('.dn-links');if(n)n.classList.toggle('dn-open');">☰</button>` +
  `</div>`;   // Market = browse/buy any collection; Launch = mining-drip launchpad (preview); List = sell your Degen
const walletBtnHtml = `<button id="dojoNavWallet" style="font-family:'Cinzel',serif;font-size:11px;font-weight:700;letter-spacing:.05em;color:#0a0814;background:linear-gradient(135deg,#c8962a,#8b6018);border:none;padding:9px 16px;border-radius:8px;cursor:pointer;white-space:nowrap;margin-left:auto;">Connect wallet</button>`;
const storeGameNav = ddNav("PLAY", "play", walletBtnHtml);
// The Play hub's own header (coin badge + "Buy coins" + wallet) is wiped by the nav swap below,
// so re-add a coins group as the nav's right-hand extra: balance readout + a Buy-coins button
// (links to /credits) + the shared wallet button. The button has no data-dc-credits, so it shows
// even in demo mode; the badge number fills in when the local economy is on.
const playNavExtra =
  `<span style="margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">` +
  `<span style="font-family:'Teko',sans-serif;font-size:16px;color:#e8b84b;padding:6px 12px;border:1px solid rgba(201,151,58,.3);border-radius:9px;">🪙 <b data-dc-credits>0</b> coins</span>` +
  `<a href="/credits" style="color:#e8b84b;font-family:'Cinzel',serif;font-size:11px;font-weight:700;letter-spacing:.06em;padding:9px 14px;border:1px solid #c9973a;border-radius:8px;text-decoration:none;white-space:nowrap;">＋ Buy coins</a>` +
  walletBtnHtml.replace("margin-left:auto;", "") +
  `</span>`;
// Wire the nav wallet button through the shared picker. autoConnect shares ONE session across every
// page (connect once → connected everywhere). Disconnected = gold; connected = subtle pill (matches
// the store home). Sets window.DOJO_WALLET for the games' economy.
const walletWire = `<script src="/dojo-credits.js"></script><script src="/dojo-wallet.js"></script><script src="/dojo-profile.js"></script><script src="/mwa.js"></script><script src="/wallet-picker.js"></script><script>/*navwallet-wire*/(function(){var b=document.getElementById('dojoNavWallet');if(!b)return;var A=null,sh=function(p){return p.slice(0,4)+'\\u2026'+p.slice(-4);};var G="font-family:'Cinzel',serif;font-size:11px;font-weight:700;letter-spacing:.05em;color:#0a0814;background:linear-gradient(135deg,#c8962a,#8b6018);border:none;padding:9px 16px;border-radius:8px;cursor:pointer;white-space:nowrap;margin-left:auto;",C="font-family:'Cinzel',serif;font-size:11px;font-weight:700;letter-spacing:.05em;color:#e8b84b;background:rgba(201,151,58,.12);border:1px solid rgba(201,151,58,.5);padding:9px 14px;border-radius:8px;cursor:pointer;white-space:nowrap;margin-left:auto;";function set(a){A=a;window.DOJO_WALLET=a||null;window.dispatchEvent(new Event('dojo-wallet-change'));if(a){b.textContent='\\u25ce '+sh(a.pubkey);b.setAttribute('style',C);}else{b.textContent='Connect wallet';b.setAttribute('style',G);}document.querySelectorAll('.dn-connect').forEach(function(x){x.textContent=a?'\\u25ce '+sh(a.pubkey):'\\ud83d\\udd11 Connect';});}window.dojoNavSetWallet=set;b.onclick=function(){if(A){var dc=function(){try{A.disconnect&&A.disconnect();}catch(e){}set(null);};if(window.DojoProfile)DojoProfile.menu(b,A.pubkey,dc);else dc();return;}if(window.DojoWalletPicker)DojoWalletPicker.pick().then(set).catch(function(){});};if(window.DojoWalletPicker&&DojoWalletPicker.autoConnect)DojoWalletPicker.autoConnect().then(function(a){if(a&&!A)set(a);});})();</script>`;
for (const gf of ["dojo-flip/index.html", "play/cluck-fu/index.html", "play/teto-wars/index.html", "play/degen-duel/index.html", "play/cock-brawl/index.html"]) {
  const gp = `${OUT}/${gf}`;
  let gh = readFileSync(gp, "utf8");
  gh = gh.replace(/<nav class="(?:flips-nav|gsite-nav)">[\s\S]*?<\/nav>/, storeGameNav);
  // The store IS the coin app: every game here is PAID from the SERVER coin ledger — a play
  // signs in (once, 12h) and /api/play debits the coin + verifies the outcome (DojoWallet.begin).
  // Set BEFORE any game script runs. Main-site copies stay free demos (no flag).
  if (!gh.includes("DOJO_SERVER_ECON=1")) gh = gh.replace(/<head(\s[^>]*)?>/i, (m) => m + "\n<script>window.DOJO_SERVER_ECON=1;</script>");
  // A consistent wallet button in the nav on every game (connect / ◎ shortPk), shared session.
  if (!gh.includes("navwallet-wire")) gh = gh.replace(/<\/body>/i, walletWire + "</body>");
  writeFileSync(gp, gh);
}
// Solana web3.js, self-hosted so checkout has no third-party runtime dependency.
copyFileSync(`${ROOT}/scripts/site-assets/web3.js`, `${OUT}/web3.js`);
copyFileSync(`${ROOT}/scripts/site-assets/buffer.js`, `${OUT}/buffer.js`);
copyFileSync(`${ROOT}/scripts/site-assets/dd-mark.jpg`, `${OUT}/dd-mark.jpg`);   // brand logo
copyFileSync(`${ROOT}/scripts/site-assets/demon-mark.png`, `${OUT}/demon-mark.png`);   // Demon Dojo case crest (collection image)
copyFileSync(`${ROOT}/scripts/site-assets/teto-mark.png`, `${OUT}/teto-mark.png`);     // TETO case crest (the coin)
// Same-origin RPC proxy, so the page never carries a keyed endpoint.
mkdirSync(`${OUT}/netlify/functions`, { recursive: true });
copyFileSync(`${ROOT}/scripts/store-fn-rpc.mjs`, `${OUT}/netlify/functions/rpc.mjs`);
// Preacher referral ledger (writes to Netlify Blobs; @netlify/blobs is provided
// by the Netlify functions runtime, no install needed). Needs env ATTR_ADMIN_KEY.
copyFileSync(`${ROOT}/scripts/store-fn-attr.mjs`, `${OUT}/netlify/functions/attr.mjs`);
// Preacher identity + dashboard (claim code, stats). Needs env ATTR_ADMIN_KEY + DAS SOLANA_RPC.
copyFileSync(`${ROOT}/scripts/store-fn-preacher.mjs`, `${OUT}/netlify/functions/preacher.mjs`);
// Per-mint SEO pages, rendered on first visit + edge-cached. The function imports
// the pure renderer and the DD rarity table, so both are co-located for bundling.
copyFileSync(`${ROOT}/scripts/store-fn-nft.mjs`, `${OUT}/netlify/functions/nft.mjs`);
copyFileSync(`${ROOT}/scripts/seo-nft.mjs`, `${OUT}/netlify/functions/seo-nft.mjs`);
copyFileSync(`${ROOT}/scripts/csp.mjs`, `${OUT}/netlify/functions/csp.mjs`);   // /nft/<mint> sends the same CSP (_headers doesn't reach functions)
copyFileSync(`${ROOT}/scripts/dd-trait-rarity.json`, `${OUT}/netlify/functions/dd-trait-rarity.json`);
// Cross-collection browse: live collection search + a collection's live listings.
copyFileSync(`${ROOT}/scripts/store-fn-collection.mjs`, `${OUT}/netlify/functions/collection.mjs`);
copyFileSync(`${ROOT}/scripts/store-fn-search.mjs`, `${OUT}/netlify/functions/search.mjs`);
// Top ~100 collections by weekly volume (ME stats leaderboard) — powers the shelf hall.
copyFileSync(`${ROOT}/scripts/store-fn-topcollections.mjs`, `${OUT}/netlify/functions/topcollections.mjs`);
// Coin economy: record purchases + the admin dashboard aggregation. Needs env ADMIN_KEY.
copyFileSync(`${ROOT}/scripts/store-fn-coinbuy.mjs`, `${OUT}/netlify/functions/coinbuy.mjs`);
// LIVE Magic Eden listings per collection — the shelves fetch this so they show only
// real, currently-buyable NFTs. Standard NFTs buy via our own engine now; once the ME key is
// activated set ME_BUY_ACTIVE=1 and pNFT/Core buy via ME too. Needs MAGICEDEN_API_KEY (+ SOLANA_RPC).
copyFileSync(`${ROOT}/scripts/store-fn-listings.mjs`, `${OUT}/netlify/functions/listings.mjs`);
copyFileSync(`${ROOT}/scripts/store-fn-admin.mjs`, `${OUT}/netlify/functions/admin.mjs`);
// Payment verification (on-chain) + provably-fair weekly draw. Need ADMIN_KEY + SOLANA_RPC.
copyFileSync(`${ROOT}/scripts/store-fn-verify.mjs`, `${OUT}/netlify/functions/verify.mjs`);
// Auto-verify on a 1-minute cron so coins credit without anyone hitting /api/verify by hand.
copyFileSync(`${ROOT}/scripts/store-fn-verify-cron.mjs`, `${OUT}/netlify/functions/verify-cron.mjs`);
// Shared verification core — coins are derived from the VERIFIED on-chain USD via the
// server pack table (client's claimed amount ignored). Imported by BOTH verify fns.
copyFileSync(`${ROOT}/scripts/store-verify-core.mjs`, `${OUT}/netlify/functions/store-verify-core.mjs`);
// Shared Dojo Pot ledger — verify-core adds each purchase's pot share; draw reads/resets it.
copyFileSync(`${ROOT}/scripts/store-pot-core.mjs`, `${OUT}/netlify/functions/store-pot-core.mjs`);
copyFileSync(`${ROOT}/scripts/store-cas-core.mjs`, `${OUT}/netlify/functions/store-cas-core.mjs`);   // atomic (compare-and-swap) ledger writes
// Rate limits (audit DD-04). Two layers:
//  • Netlify platform rules (global per IP+domain; the plan allows only 2 code-defined rules per site on
//    Free/Personal, 5 on Pro): /api/rpc 300/min, /api/collection 90/min — declared in each function's config.
//  • store-ratelimit-core.mjs, an in-memory per-IP window in EVERY public function (per warm instance):
//    rpc 240 · nft 120 · collection/search/topcollections/listings/tensor-listings/resolve/dd-listings/miner/play 60
//    · preacher/draw/payouts 30 · attr/coinbuy/mebuy/tensorbuy/dd-cosign/dd-royalty/miner-requests 20
//    · admin/verify/launch-apply 10 (per minute). Crons are not limited. On Pro, spend the 3 extra platform
//    rules on /api/dd-cosign, /api/mebuy and /api/play.
copyFileSync(`${ROOT}/scripts/store-ratelimit-core.mjs`, `${OUT}/netlify/functions/store-ratelimit-core.mjs`);
copyFileSync(`${ROOT}/scripts/store-preacher-core.mjs`, `${OUT}/netlify/functions/store-preacher-core.mjs`);   // shared preacher maths (dashboard + payouts)
copyFileSync(`${ROOT}/scripts/store-ref-core.mjs`, `${OUT}/netlify/functions/store-ref-core.mjs`);   // signed "ddref:" memo → preacher referral
copyFileSync(`${ROOT}/scripts/store-min-core.mjs`, `${OUT}/netlify/functions/store-min-core.mjs`);
copyFileSync(`${ROOT}/scripts/store-genuine-core.mjs`, `${OUT}/netlify/functions/store-genuine-core.mjs`);   // genuine vs look-alike Degens (one rule everywhere)   // 1.5 SOL listing floor (dd-listings + dd-cosign)
// (/api/ticket — the old unauthenticated ticket POST — is retired: security review LOW-3. Tickets come only from /api/play.)
copyFileSync(`${ROOT}/scripts/store-fn-draw.mjs`, `${OUT}/netlify/functions/draw.mjs`);
// Weekly payout: the cron commits + draws + plans + notifies; /api/payouts backs the owner's /payouts
// page (ONE wallet-signed "Pay" click — no key on the server). Shared cores ride along.
copyFileSync(`${ROOT}/scripts/store-draw-core.mjs`, `${OUT}/netlify/functions/store-draw-core.mjs`);     // commit/draw/verify (draw + payouts)
copyFileSync(`${ROOT}/scripts/store-payout-core.mjs`, `${OUT}/netlify/functions/store-payout-core.mjs`); // plan + fraud checks + paid verification
copyFileSync(`${ROOT}/scripts/store-notify.mjs`, `${OUT}/netlify/functions/store-notify.mjs`);           // Telegram / Discord (no-op if unset)
copyFileSync(`${ROOT}/scripts/store-fn-payout-cron.mjs`, `${OUT}/netlify/functions/payout-cron.mjs`);    // every 10 min: weekly commit → draw → plan → notify
copyFileSync(`${ROOT}/scripts/store-fn-payouts.mjs`, `${OUT}/netlify/functions/payouts.mjs`);            // /api/payouts (ADMIN_KEY)
copyFileSync(`${ROOT}/scripts/store-raffle-core.mjs`, `${OUT}/netlify/functions/store-raffle-core.mjs`);  // Burn Raffle: tickets from burns, pot, weekly draw
copyFileSync(`${ROOT}/scripts/store-fn-raffle.mjs`, `${OUT}/netlify/functions/raffle.mjs`);              // /api/raffle — status, burn reports, draw records
// Anti-cheat backbone: wallet sign-in + server-authoritative play lifecycle.
// Coins live server-side (credited only by verify.mjs on a confirmed purchase);
// tickets are minted only by play.mjs after it recomputes the outcome itself.
copyFileSync(`${ROOT}/scripts/store-fn-auth.mjs`, `${OUT}/netlify/functions/auth.mjs`);
// Dojo Keeper money backend: card vaults (88/12), repairs (0.01 ORE), burn claims (stORE) — store-keeper-core.mjs
copyFileSync(`${ROOT}/scripts/store-keeper-core.mjs`, `${OUT}/netlify/functions/store-keeper-core.mjs`);
copyFileSync(`${ROOT}/scripts/store-fn-vault.mjs`, `${OUT}/netlify/functions/vault.mjs`);         // /api/vault
copyFileSync(`${ROOT}/scripts/store-fn-repair.mjs`, `${OUT}/netlify/functions/repair.mjs`);       // /api/repair
copyFileSync(`${ROOT}/scripts/store-fn-burnclaim.mjs`, `${OUT}/netlify/functions/burnclaim.mjs`); // /api/burnclaim
copyFileSync(`${ROOT}/scripts/store-helius-core.mjs`, `${OUT}/netlify/functions/store-helius-core.mjs`);   // Helius batch history (keeper + reserve)
copyFileSync(`${ROOT}/scripts/store-fn-reserve.mjs`, `${OUT}/netlify/functions/reserve.mjs`);   // /api/reserve — last-7-days inflow by source for the Reserve page
// Shared auth primitives (SESSION_SECRET tokens, fail-closed; constant-time admin-key checks) — imported by
// auth/play and the admin-gated functions. Not a function itself (no default export / config).
copyFileSync(`${ROOT}/scripts/store-session-core.mjs`, `${OUT}/netlify/functions/store-session-core.mjs`);
copyFileSync(`${ROOT}/scripts/store-fn-mebuy.mjs`, `${OUT}/netlify/functions/mebuy.mjs`);   // Magic Eden universal buy builder (/api/mebuy)
copyFileSync(`${ROOT}/scripts/store-fn-tensorbuy.mjs`, `${OUT}/netlify/functions/tensorbuy.mjs`);   // Tensor aggregator buy builder — buys ME AMM pools too (/api/tensorbuy)
copyFileSync(`${ROOT}/scripts/store-fn-floors.mjs`, `${OUT}/netlify/functions/floors.mjs`);   // collection floors for the burn lists (/api/floors)
copyFileSync(`${ROOT}/scripts/store-fn-dd-listings.mjs`, `${OUT}/netlify/functions/dd-listings.mjs`);   // DD ORE/SKR/USDC AuctionHouse listing index (/api/dd-listings)
copyFileSync(`${ROOT}/scripts/store-fn-dd-cosign.mjs`, `${OUT}/netlify/functions/dd-cosign.mjs`);   // pNFT buy cosigner (/api/dd-cosign) — holds COSIGNER_SECRET
copyFileSync(`${ROOT}/scripts/store-fn-dd-royalty.mjs`, `${OUT}/netlify/functions/dd-royalty.mjs`);
copyFileSync(`${ROOT}/scripts/store-fn-launch-apply.mjs`, `${OUT}/netlify/functions/launch-apply.mjs`);   // /api/launch-apply — launchpad application intake
// Branded miners: paid signups (ORE fee verified on-chain) + the public config each /m/<slug> loads.
// Need ADMIN_KEY + SOLANA_RPC; optional OPERATOR_WALLET (default store treasury) + SETUP_FEE_ORE.
copyFileSync(`${ROOT}/scripts/store-fn-miner-requests.mjs`, `${OUT}/netlify/functions/miner-requests.mjs`);   // /api/miner-requests
copyFileSync(`${ROOT}/scripts/store-miner-core.mjs`, `${OUT}/netlify/functions/store-miner-core.mjs`);   // pure payment/slug checks, imported by miner-requests
copyFileSync(`${ROOT}/scripts/store-fn-miner.mjs`, `${OUT}/netlify/functions/miner.mjs`);   // /api/miner?slug= — hosted miner config
copyFileSync(`${ROOT}/scripts/store-fn-resolve.mjs`, `${OUT}/netlify/functions/resolve.mjs`);   // /api/resolve — find a live listing for a pasted/clicked mint
copyFileSync(`${ROOT}/scripts/store-fn-tensor-listings.mjs`, `${OUT}/netlify/functions/tensor-listings.mjs`);   // live Tensor book for the tower (/api/tensor-listings)
copyFileSync(`${ROOT}/scripts/store-royalty-core.mjs`, `${OUT}/netlify/functions/store-royalty-core.mjs`);   // MARKETPLACES list (keeper + reserve); its royalty→Pot sweep is retired
// royalty-cron RETIRED 2026-10-23 (royalties no longer feed the Pot; the Keeper core handles them) — not shipped any more,
// so the next deploy removes the every-minute scheduled function.
copyFileSync(`${ROOT}/scripts/store-fn-play.mjs`, `${OUT}/netlify/functions/play.mjs`);
// Shared Dojo Flip engine + card pool — bundled WITH play.mjs (server verifies the
// winner) and also served at root so the browser animates the identical game.
copyFileSync(`${ROOT}/scripts/dojo-flip-engine.mjs`, `${OUT}/netlify/functions/dojo-flip-engine.mjs`);
copyFileSync(`${ROOT}/scripts/flip-pool.mjs`, `${OUT}/netlify/functions/flip-pool.mjs`);
copyFileSync(`${ROOT}/scripts/dojo-duel-engine.mjs`, `${OUT}/netlify/functions/dojo-duel-engine.mjs`);
copyFileSync(`${ROOT}/scripts/duel-pool.mjs`, `${OUT}/netlify/functions/duel-pool.mjs`);
// Public verification page for the weekly draw.
copyFileSync(`${ROOT}/scripts/dojo-draw.html`, `${OUT}/draw.html`);
copyFileSync(`${ROOT}/scripts/dojo-admin.html`, `${OUT}/admin.html`);
copyFileSync(`${ROOT}/scripts/miner-admin.html`, `${OUT}/miner-admin.html`);   // /miner-admin — approve/reject branded-miner requests (key kept in sessionStorage)
copyFileSync(`${ROOT}/scripts/preacher-admin.html`, `${OUT}/preacher-admin.html`);   // /preacher-admin — who each preacher brought in + what's owed (ATTR_ADMIN_KEY)
copyFileSync(`${ROOT}/scripts/payouts.html`, `${OUT}/payouts.html`);   // /payouts — weekly winners + preachers, ONE wallet-signed Pay (ADMIN_KEY in sessionStorage)
copyFileSync(`${ROOT}/scripts/payout-tx.js`, `${OUT}/payout-tx.js`);   // its tx builder (Jupiter swap + SPL transfers, packed ≤1232B)
copyFileSync(`${ROOT}/scripts/dojo-credits.html`, `${OUT}/credits.html`);
// Force the coin-buy page onto the same-origin /api/rpc proxy — never a public/keyed RPC
// (public mainnet-beta 403s; the proxy uses our Helius with the key held server-side).
{ let _c = readFileSync(`${OUT}/credits.html`, "utf8");
  _c = _c.replace(/const RPC = '[^']*';/, "const RPC = location.origin + '/api/rpc';");
  writeFileSync(`${OUT}/credits.html`, _c); }
// Shelves RETIRED — the "buy any top collection in ORE" aggregation was broken by Magic Eden's
// pool cosigner lock (most listings are un-buyable MMM pools; showing only the buyable ones
// misrepresents the floor). Replaced by a DD-native ORE/SKR marketplace for the Degen collection.
// (build-shelves-standalone.mjs + shelves-100.html kept in the repo but no longer deployed.)

// ── The games + shared economy client, co-located with /api so sign-in, coins and
// the verified play loop are all same-origin (one Netlify Blobs ledger). ──
copyFileSync(`${ROOT}/scripts/dojo-scores.js`, `${OUT}/dojo-scores.js`);
copyFileSync(`${ROOT}/scripts/dojo-credits.js`, `${OUT}/dojo-credits.js`);
copyFileSync(`${ROOT}/scripts/dojo-profile.js`, `${OUT}/dojo-profile.js`);   // connected-wallet menu + profile card
copyFileSync(`${ROOT}/scripts/dojo-wallet.js`, `${OUT}/dojo-wallet.js`);
// Wallet Standard picker (official icons: Phantom / Solflare / Backpack / Jupiter). Used by
// the coin-buy page (credits.html) and the games (via dojo-wallet.js).
copyFileSync(`${ROOT}/scripts/wallet-picker.js`, `${OUT}/wallet-picker.js`);
copyFileSync(`${ROOT}/scripts/mwa.js`, `${OUT}/mwa.js`);   // Solana Mobile Wallet Adapter (Seeker/Saga native connect)
copyFileSync(`${ROOT}/scripts/dojo-buy.js`, `${OUT}/dojo-buy.js`);   // shared inline "buy any NFT in ORE/SKR/SOL" engine for shelves
// DD AuctionHouse client (list/buy/cancel pNFTs in ORE/SKR/USDC) — bake in the buy lookup-table address.
{
  let ah = readFileSync(`${ROOT}/scripts/dojo-ah.js`, "utf8");
  let alt = "", auth = "";
  try { alt = JSON.parse(readFileSync(`${ROOT}/scripts/dd-alt.json`, "utf8")).address || ""; } catch {}
  try { auth = JSON.parse(readFileSync(`${ROOT}/scripts/dd-authority.json`, "utf8")).authority || ""; } catch {}
  ah = ah.replace("__DD_ALT_TABLE__", alt);
  if (auth) ah = ah.replace("__DD_AUTHORITY__", auth);
  writeFileSync(`${OUT}/dojo-ah.js`, ah);
  copyFileSync(`${ROOT}/scripts/dojo-swap.js`, `${OUT}/dojo-swap.js`);   // "Get ORE" swap (SOL/USDC → ORE via Jupiter, checked before signing)
  console.log(alt ? `  buy lookup-table baked in: ${alt}` : "  ⚠ no scripts/dd-alt.json — buy stays disabled until you run create-lookup-table.mjs");
  console.log(auth ? `  house authority (cosigner) baked in: ${auth}` : "  · house authority: ED3GMC (default — run set-ah-authority.mjs to switch to the cosigner)");
}
mkdirSync(`${OUT}/list`, { recursive: true });
copyFileSync(`${ROOT}/scripts/dd-list.html`, `${OUT}/list/index.html`);   // the ORE/SKR/USDC "List a Degen" page → /list
copyFileSync(`${ROOT}/scripts/dojo-flip-engine.mjs`, `${OUT}/dojo-flip-engine.mjs`);   // client loads it as a module
copyFileSync(`${ROOT}/scripts/dojo-duel-engine.mjs`, `${OUT}/dojo-duel-engine.mjs`);   // Degen Duel deals the server's seeded hands with it (window.DuelEngine)
// (The old free-demo copies /cluck-fu.html, /teto.html and /flip.html are no longer shipped — they
// 301 to the real coin-paid games, see _redirects.)
copyFileSync(`${ROOT}/scripts/teto.png`, `${OUT}/teto.png`);   // the TETO potato image (referenced as /teto.png)
copyFileSync(`${ROOT}/scripts/teto-board.jpg`, `${OUT}/teto-board.jpg`);   // shoji + DD logo board background
copyFileSync(`${ROOT}/scripts/dd-logo.png`, `${OUT}/dd-logo.png`);
// Digital Asset Links — verifies the Android TWA (xyz.degendojo.store.twa) so the installed
// app opens FULL-SCREEN with no browser address bar. Served at /.well-known/assetlinks.json.
mkdirSync(`${OUT}/.well-known`, { recursive: true });
copyFileSync(`${ROOT}/scripts/assetlinks.json`, `${OUT}/.well-known/assetlinks.json`);

// The market (shelf) browse page — featured collections from the bundled index.
{
  const index = JSON.parse(readFileSync(`${ROOT}/scripts/collections-index.json`, "utf8"));
  const featured = index.slice(0, 8);
  let shelf = readFileSync(`${ROOT}/scripts/shelf-mockup.html`, "utf8");
  // Collection names/logos come from Magic Eden (untrusted): HTML-safe JSON (no </script> breakout) and a
  // FUNCTION replacer (a string one would expand "$'"/"$&" inside a collection name).
  const { jsonForScript } = await import("./html-safe.mjs");
  shelf = shelf.replace("let COLLECTIONS = window.__DATA__ || [];",
    () => `window.__DATA__ = ${jsonForScript(featured)};\nlet COLLECTIONS = window.__DATA__ || [];`);
  writeFileSync(`${OUT}/market.html`, shelf);
  copyFileSync(`${ROOT}/scripts/collections-index.json`, `${OUT}/collections-index.json`);
}

// ── ONE top menu everywhere: swap each store page's nav for the canonical ddNav (DD logo +
//    "DEGEN DOJO" + per-page sublabel + pills), so the header is identical on every page. ──
const STORENAV_RE = /<nav class="dojo-storenav"[\s\S]*?<\/nav>/;
// nav + the shared wallet button + its wiring (before </body>) — one session across every page.
const applyNavWire = (rel, re, sub, active, walletBtn = walletBtnHtml, wire = true) => {
  const fp = `${OUT}/${rel}`;
  try { let h = readFileSync(fp, "utf8");
    if (re.test(h)) h = h.replace(re, ddNav(sub, active, walletBtn));
    if (wire && !h.includes("navwallet-wire")) h = h.replace(/<\/body>/i, walletWire + "</body>");
    writeFileSync(fp, h);
  } catch {}
};
applyNavWire("pot/index.html", STORENAV_RE, "POT", "pot");
// Coins + Buy coins now sit under the Play hub's title (visible on phones); the top bar keeps just the wallet.
applyNavWire("play/index.html", /<header class="top">[\s\S]*?<\/header>/, "PLAY", "play", walletBtnHtml);
// Play hub had its own wallet JS bound to the removed #wBtn — strip that script so it can't error.
{ const fp = `${OUT}/play/index.html`;
  try { let h = readFileSync(fp, "utf8");
    h = h.replace(/<script>(?:(?!<\/script>)[\s\S])*var WADAPTER=null;(?:(?!<\/script>)[\s\S])*<\/script>/, "");
    writeFileSync(fp, h);
  } catch {} }
// Preacher: put the wallet button in the nav (runs the preacher's own connect+sign flow start()),
// and KEEP the central desk button: a visitor who arrives already connected has no other way to sign and open the
// desk (the nav button then opens the profile menu). The page labels it by state. No generic wire — start() drives it.
{ const fp = `${OUT}/become-a-preacher.html`;
  try { let h = readFileSync(fp, "utf8");
    const preachWallet = walletBtnHtml.replace('id="dojoNavWallet"', 'id="preachNavWallet" onclick="navWalletClick()"');
    if (!h.includes("/dojo-profile.js")) h = h.replace('<script src="/wallet-picker.js"', '<script src="/dojo-profile.js"></script><script src="/wallet-picker.js"');
    if (STORENAV_RE.test(h)) h = h.replace(STORENAV_RE, ddNav("PREACHER", "preacher", preachWallet));
    writeFileSync(fp, h);
  } catch {} }
// Credits/coins page shipped with the OLD static store nav (Store/Shelves/Play/Preacher) — swap it
// for the canonical ddNav so the top menu matches every other store page. The page's own in-page
// wallet (connectWallet) drives the nav button; no generic wire (it already loads wallet-picker.js).
for (const cf of ["credits/index.html", "credits.html"]) {
  const fp = `${OUT}/${cf}`;
  try { let h = readFileSync(fp, "utf8");
    // Use the SHARED wallet button + wire (same as every game/page) so it actually connects,
    // shows the connected pill, auto-reconnects, and sets window.DOJO_WALLET. The page's buy()
    // reads window.DOJO_WALLET — one session across the whole store.
    if (STORENAV_RE.test(h)) h = h.replace(STORENAV_RE, ddNav("COINS", "", walletBtnHtml));
    if (!h.includes("navwallet-wire")) h = h.replace(/<\/body>/i, walletWire + "</body>");
    writeFileSync(fp, h);
  } catch {} }
// The weekly-draw verification page ships with NO top menu — insert the canonical ddNav after
// <body> so it matches every other store page (it had no nav at all). Read-only page → no wallet.
{ const fp = `${OUT}/draw.html`;
  try { let h = readFileSync(fp, "utf8");
    if (!h.includes("dn-bar")) h = h.replace(/<body[^>]*>/i, (m) => m + "\n" + ddNav("THE DRAW", "pot"));
    writeFileSync(fp, h);
  } catch {} }
// Market (shelf browse) — replace its bespoke top bar with the canonical ddNav (so the header
// matches every other store page), wire the shared wallet button, make the copy ORE-only, and
// mount the live Degen Dojo case (our own ORE/SKR/USDC AuctionHouse listings) ABOVE the external
// cases — this is where a listed Degen now shows (the old strip on the Store/tower page is gone).
copyFileSync(`${ROOT}/scripts/dd-case.js`, `${OUT}/dd-case.js`);
{ const fp = `${OUT}/market.html`;
  const ddCaseHtml = `
<section id="ddCase" style="display:none;max-width:1100px;margin:6px auto 22px;padding:0 20px;">
  <div style="border:1px solid rgba(201,151,58,.28);border-radius:16px;background:linear-gradient(180deg,rgba(201,151,58,.06),rgba(0,0,0,.15));padding:20px 20px 22px;">
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
      <h3 style="margin:0;font-family:'Cinzel',serif;color:#e8b84b;font-size:19px;letter-spacing:.04em;">⛩ Listed on Degen Dojo — pay in ORE</h3>
      <span style="color:#a99a7e;font-size:12px;">(<span id="ddCaseCount">0</span>)</span>
    </div>
    <div style="color:#c9bda3;font-size:12.5px;margin:6px 0 16px;line-height:1.5;"><b style="color:#e8b84b;">0% marketplace fee.</b> Royalties come off the seller's side, so you pay the flat price you see — the only place you can buy <b>any</b> NFT with <b>ORE</b>.</div>
    <div id="ddCaseRow" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;"></div>
  </div>
</section>`;
  // NOTE: buffer.js (a browserify UMD) only sets window.buffer — it does NOT set window.Buffer,
  // which dojo-buy.js reads as global.Buffer. Without this shim, clicking Buy on the market throws
  // "Cannot read properties of undefined (reading 'from')" (global.Buffer.from in resolveListing).
  const ddCaseScripts = `<script src="/buffer.js"></script><script>window.Buffer=window.Buffer||(window.buffer&&window.buffer.Buffer);</script><script src="/web3.js"></script><script src="/dojo-ah.js"></script><script src="/dojo-swap.js"></script><script src="/dojo-buy.js"></script><script src="/dd-case.js"></script>`;
  try { let h = readFileSync(fp, "utf8");
    // Swap the bespoke top bar for the canonical ddNav AND drop the Dojo Pot notice in one go:
    // the old markup runs <div class="top">…</div><div class="pot">…</div> right before <div class="intro">.
    h = h.replace(/<div class="top">[\s\S]*?<div class="intro">/, ddNav("THE MARKET", "market", walletBtnHtml) + '<div class="intro">');
    if (!h.includes("navwallet-wire")) h = h.replace(/<\/body>/i, walletWire + "</body>");
    // ORE-only marketplace: drop the "SKR or SOL" from the intro copy.
    h = h.replace(/own it with\s*<b>ORE<\/b>,\s*SKR or SOL\./, "own it in <b>ORE</b>.");
    // Mount the Degen Dojo case BELOW the hero title/search, just above the external cases.
    if (!h.includes('id="ddCase"')) h = h.replace(/<div class="filters">/, ddCaseHtml + "\n<div class=\"filters\">");
    if (!h.includes("/dd-case.js")) h = h.replace(/<\/body>/i, ddCaseScripts + "</body>");
    writeFileSync(fp, h);
  } catch {} }
// Launchpad preview page (/launch) — the ORE mining-drip mint concept + the milestone escrow
// rug-guard. PREVIEW only (no live mint yet); gets the canonical ddNav + shared wallet.
copyFileSync(`${ROOT}/scripts/launch.html`, `${OUT}/launch.html`);
mkdirSync(`${OUT}/launch/apply`, { recursive: true });
copyFileSync(`${ROOT}/scripts/launch-apply.html`, `${OUT}/launch/apply/index.html`);   // /launch/apply intake form
for (const fp of [`${OUT}/launch.html`, `${OUT}/launch/apply/index.html`]) {
  try { let h = readFileSync(fp, "utf8");
    h = h.replace('<div id="ddnav-mount"></div>', ddNav("THE LAUNCHPAD", "launch", walletBtnHtml));
    if (!h.includes("navwallet-wire")) h = h.replace(/<\/body>/i, walletWire + "</body>");
    writeFileSync(fp, h);
  } catch {} }
// List page (/list): give it the canonical ddNav + shared wallet, like every other page (its JS
// now syncs WALLET from window.DOJO_WALLET). dd-list.html has no </body>, so append the wire.
{ const fp = `${OUT}/list/index.html`;
  try { let h = readFileSync(fp, "utf8");
    h = h.replace('<div id="ddnav-mount"></div>', ddNav("LIST", "list", walletBtnHtml));
    if (!h.includes("navwallet-wire")) h = h.includes("</body>") ? h.replace(/<\/body>/i, walletWire + "</body>") : (h + walletWire);
    writeFileSync(fp, h);
  } catch {} }
// Degen Dojo Reserve page (/reserve): what the Reserve wallets hold, read live (read-only) — same nav + shared wallet as /list.
mkdirSync(`${OUT}/reserve`, { recursive: true });
copyFileSync(`${ROOT}/scripts/store-wallets.html`, `${OUT}/reserve/index.html`);
{ const fp = `${OUT}/reserve/index.html`;
  try { let h = readFileSync(fp, "utf8");
    h = h.replace('<div id="ddnav-mount"></div>', ddNav("RESERVE", "reserve", walletBtnHtml));
    if (!h.includes("navwallet-wire")) h = h.includes("</body>") ? h.replace(/<\/body>/i, walletWire + "</body>") : (h + walletWire);
    writeFileSync(fp, h);
  } catch {} }
// Repair (/repair) page: paste a wallet (or connect) → Cracked/Mono → Mint for 0.01 ORE a card (Mint cap shown).
// The Burn page (store-burn.html) is NOT shipped while burning is off (BURN_ENABLED) — kept in the repo for later:
// add ["store-burn.html", "burn", "BURN"] back to the list below when the owner opens burning. Same nav + wallet as /list.
copyFileSync(`${ROOT}/scripts/dojo-card-tx.js`, `${OUT}/dojo-card-tx.js`);   // repair (ORE + ddfix memos) / burn (BurnV1) txs
copyFileSync(`${ROOT}/scripts/dojo-qr.js`, `${OUT}/dojo-qr.js`);             // inline QR encoder for Solana Pay links
// Dojo Sweep (/sweep, alias /claim): free — empty token accounts, burnable NFTs, Magic Eden bid escrow, staking; txs built + simulated in the browser
copyFileSync(`${ROOT}/scripts/dojo-burn.js`, `${OUT}/dojo-burn.js`);     // shared burn + close + tip logic (/sweep and the miner's burn mode, /mine?burn=1)
copyFileSync(`${ROOT}/scripts/dojo-sweep.js`, `${OUT}/dojo-sweep.js`);
copyFileSync(`${ROOT}/scripts/dojo-raffle.js`, `${OUT}/dojo-raffle.js`);   // Burn Raffle (/raffle): burns + the freed rent → raffle wallet + ddraffle memo, one tx
copyFileSync(`${ROOT}/scripts/dojo-gift.js`, `${OUT}/dojo-gift.js`);       // "Add to the prize" (/raffle) + the raffle's gift payouts (/payouts): transfers of any asset
// Degen Dojo card numbers (#123) for the raffle's burn list — fetched by /raffle only when the wallet holds a card
writeFileSync(`${OUT}/dd-nums.json`, JSON.stringify(JSON.parse(readFileSync(`${ROOT}/scripts/mint-to-num.json`, "utf8"))));
for (const [src, dir, label] of [["store-repair.html", "repair", "REPAIR"], ["store-sweep.html", "sweep", "SWEEP"], ["store-raffle.html", "raffle", "RAFFLE"], ["store-privacy.html", "privacy", "PRIVACY"], ["store-terms.html", "terms", "TERMS"]]) {   // /privacy + /terms: the dApp-store / app listing pages
  mkdirSync(`${OUT}/${dir}`, { recursive: true });
  copyFileSync(`${ROOT}/scripts/${src}`, `${OUT}/${dir}/index.html`);
  const fp = `${OUT}/${dir}/index.html`;
  try { let h = readFileSync(fp, "utf8");
    h = h.replace('<div id="ddnav-mount"></div>', ddNav(label, dir, walletBtnHtml));
    if (!h.includes("navwallet-wire")) h = h.includes("</body>") ? h.replace(/<\/body>/i, walletWire + "</body>") : (h + walletWire);
    writeFileSync(fp, h);
  } catch {} }
// Store home keeps its own (reference) nav but build-store.mjs regenerates it, so patch the copy to
// highlight its own "Store" pill — matching how every other page highlights its active pill.
{ const fp = `${OUT}/index.html`;
  try { let h = readFileSync(fp, "utf8");
    h = h.replace('<a href="/">⌂ Store</a>', '<a href="/" class="here">⌂ Store</a>');
    h = h.replace('.topnav a:hover{', '.topnav a.here{border-color:rgba(201,151,58,.6);color:var(--gold-l);background:rgba(201,151,58,.14);}\n.topnav a:hover{');
    writeFileSync(fp, h);
  } catch {} }

// Keep the test deploy out of search results and off the record.
writeFileSync(`${OUT}/robots.txt`, "User-agent: *\nDisallow: /\n");

// ── PWA: makes the store installable so it can be wrapped as a TWA/APK for the
// Solana dApp Store (Seeker). See SEEKER-PUBLISHING.md. ──
copyFileSync(`${ROOT}/scripts/store-manifest.json`, `${OUT}/manifest.json`);
copyFileSync(`${ROOT}/scripts/store-sw.js`, `${OUT}/sw.js`);
for (const ic of ["icon-192.png", "icon-512.png", "icon-192-maskable.png", "icon-512-maskable.png"]) {
  if (existsSync(`${ROOT}/scripts/${ic}`)) copyFileSync(`${ROOT}/scripts/${ic}`, `${OUT}/${ic}`);
}
// Digital Asset Links: served from scripts/assetlinks.json (copied above, package xyz.degendojo.store.twa).
// A leftover block here used to OVERWRITE it with a "REPLACE_ME_WITH_APK_SHA256" / xyz.degendojo.app
// placeholder, so the live store never verified the TWA. Guard against that ever coming back:
if (/REPLACE_ME/.test(readFileSync(`${OUT}/.well-known/assetlinks.json`, "utf8"))) {
  throw new Error("assetlinks.json is a placeholder — put the real APK signing fingerprint in scripts/assetlinks.json");
}
// Inject the manifest link, theme color, and SW registration into the store shell.
{
  let idx = readFileSync(`${OUT}/index.html`, "utf8");
  if (!idx.includes("/manifest.json")) {
    idx = idx.replace(/<head(\s[^>]*)?>/i, (m) => m +
      '\n<link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#c9973a"><link rel="apple-touch-icon" href="/icon-192.png">');
    idx = idx.replace(/<\/body>/i,
      "<script>if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script></body>");
    writeFileSync(`${OUT}/index.html`, idx);
  }
}

// Route /api/rpc to the function's default path too, in case in-code routing
// (config.path) isn't honoured on a drag-and-drop deploy.
writeFileSync(`${OUT}/_redirects`,
  // the zip carries function sources + node_modules in the publish root — never serve them
  "/netlify/*  /404.html  404!\n/node_modules/*  /404.html  404!\n/package.json  /404.html  404!\n/package-lock.json  /404.html  404!\n/netlify.toml  /404.html  404!\n" +
  "/api/rpc  /.netlify/functions/rpc  200\n" +
  "/api/attr  /.netlify/functions/attr  200\n" +
  "/api/preacher  /.netlify/functions/preacher  200\n" +
  "/api/collection  /.netlify/functions/collection  200\n" +
  "/api/search  /.netlify/functions/search  200\n" +
  "/api/topcollections  /.netlify/functions/topcollections  200\n" +
  "/api/coinbuy  /.netlify/functions/coinbuy  200\n" +
  "/api/listings  /.netlify/functions/listings  200\n" +
  "/api/admin  /.netlify/functions/admin  200\n" +
  "/api/verify  /.netlify/functions/verify  200\n" +
  "/api/draw  /.netlify/functions/draw  200\n" +
  "/api/payouts  /.netlify/functions/payouts  200\n" +
  "/api/raffle  /.netlify/functions/raffle  200\n" +
  "/api/auth  /.netlify/functions/auth  200\n" +
  "/api/vault  /.netlify/functions/vault  200\n" +
  "/api/repair  /.netlify/functions/repair  200\n" +
  "/api/burnclaim  /.netlify/functions/burnclaim  200\n" +
  "/api/play  /.netlify/functions/play  200\n" +
  "/api/mebuy  /.netlify/functions/mebuy  200\n" +
  "/api/tensorbuy  /.netlify/functions/tensorbuy  200\n" +
  "/api/dd-listings  /.netlify/functions/dd-listings  200\n" +
  "/api/dd-cosign  /.netlify/functions/dd-cosign  200\n" +
  "/api/dd-royalty  /.netlify/functions/dd-royalty  200\n" +
  "/api/launch-apply  /.netlify/functions/launch-apply  200\n" +
  "/api/resolve  /.netlify/functions/resolve  200\n" +
  "/api/tensor-listings  /.netlify/functions/tensor-listings  200\n" +
  "/api/miner-requests  /.netlify/functions/miner-requests  200\n" +
  "/api/miner  /.netlify/functions/miner  200\n" +
  "/nft/*  /.netlify/functions/nft  200\n" +
  // Hosted branded miners: /m/<slug> is the /mine page; it reads the slug from the URL and
  // loads that collection's name/tip wallet/25 NFTs from /api/miner?slug=.
  "/m/*  /mine.html  200\n" +
  "/wallets  /reserve/  301\n/wallets/*  /reserve/  301\n" +
  // Dojo Sweep's short alias on the STORE only (nothing here used /claim; degendojo.xyz/claim is the main site's gallery)
  "/claim  /sweep  301\n/claim/*  /sweep  301\n" +
  // Shelves retired → send any old links to the store home so nothing 404s.
  "/shelves  /  301\n" +
  "/shelves-100  /  301\n" +
  "/shelves-100.html  /  301\n" +
  // Old free-demo game copies → the real coin-paid games (no free side door around server coins).
  "/cluck-fu.html  /play/cluck-fu/  301\n" +
  "/teto.html  /play/teto-wars/  301\n" +
  "/flip.html  /dojo-flip/  301\n" +
  // The games' shared nav points at main-site-only content (/lore /traits /framed /ore /teahouse);
  // the store hosts Play + the games itself, so send only those to the main site (Play/dojo-flip stay local).
  "/lore  https://degendojo.xyz/lore  301\n" +
  "/traits  https://degendojo.xyz/traits  301\n" +
  "/framed  https://degendojo.xyz/framed  301\n" +
  "/ore  https://degendojo.xyz/ore  301\n" +
  "/teahouse  https://degendojo.xyz/teahouse  301\n" +
  // Pretty vanity links: store.degendojo.xyz/preacher/<code> → the store, ref set.
  // (The apex degendojo.xyz/preacher/<code> rule lives in the main site's build.)
  "/preacher/*  /?ref=:splat  302\n");
writeFileSync(
  `${OUT}/_headers`,
  [
    "/*",
    "  X-Robots-Tag: noindex, nofollow, noarchive",
    "  Referrer-Policy: no-referrer",
    "  X-Content-Type-Options: nosniff",
    // no other site may frame the store (a hidden frame could trick a click onto Own / List / Sign)
    "  X-Frame-Options: DENY",
    "  Content-Security-Policy: " + CSP,   // scripts/csp.mjs — what pages may load / talk to (+ frame-ancestors 'none')
    // The miner's Next export references content-hashed /_next assets that change every build.
    // If an old HTML page is cached it points at chunks the new deploy removed → CSS 404 → the
    // page renders unstyled (huge images/icons). So: cache the hashed _next assets forever
    // (safe — new build = new filename), but always REVALIDATE HTML so a redeploy is picked up
    // immediately. `mine.html`/`mine/vault.html` are served at the extension-less /mine routes.
    "/_next/static/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/*.html",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "/mine",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "/mine/vault",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "/mine/burn",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "/whitelabel",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "/create",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "/m/*",
    "  Cache-Control: public, max-age=0, must-revalidate",
    // operator pages: never cached by the browser (security review L7) — the service worker skips them too (store-sw.js)
    "/admin",
    "  Cache-Control: no-store",
    "/admin.html",
    "  Cache-Control: no-store",
    "/miner-admin",
    "  Cache-Control: no-store",
    "/miner-admin.html",
    "  Cache-Control: no-store",
    "/preacher-admin.html",
    "  Cache-Control: no-store",
    "/preacher-admin",
    "  Cache-Control: no-store",
    "/payouts",
    "  Cache-Control: no-store",
    "/payouts.html",
    "  Cache-Control: no-store",
    "",
  ].join("\n"),
);

// The store fetches thumbnails through Netlify's image CDN; it must be told which
// remote hosts it may resize, or every tile 404s on the deploy.
// Single-quoted TOML = literal string, so the regex needs no double-escaping.
writeFileSync(
  `${OUT}/netlify.toml`,
  [
    "[functions]",
    '  directory = "netlify/functions"',
    "",
    "[images]",
    "  remote_images = ['https://degendojo\\.s3\\.us-west-1\\.amazonaws\\.com/.*']",
    "",
    // TREASURY_PUBKEY / TREASURY_WALLET are PUBLIC on-chain addresses (a receive wallet is not a
    // secret), but Netlify's secrets scanner flags any env-var value that lands in built files.
    // Exempt only public-address keys (also OPERATOR_PUBKEYS and PREACHER_RESERVED_WALLETS, the owner wallets allowed
    // to claim reserved preacher codes) so the deploy stops failing; nothing sensitive is exposed.
    "[build.environment]",
    '  SECRETS_SCAN_OMIT_KEYS = "TREASURY_PUBKEY,TREASURY_WALLET,OPERATOR_PUBKEYS,PREACHER_RESERVED_WALLETS"',
    "",
  ].join("\n"),
);

// Vendor the functions' only npm dependency (@netlify/blobs) INTO the deploy — a drag-and-drop
// zip gets no `npm install`, so without this the functions crash with "Cannot find package
// '@netlify/blobs'". Installed at the deploy root so Node resolves it for every function.
console.log("Vendoring @netlify/blobs into the deploy (functions dependency)…");
// @netlify/blobs is PINNED to 10.7.13: conditional writes (onlyIfMatch/onlyIfNew, store-cas-core.mjs)
// need >= 10, setJSON only honours them from 10.7.12, and 11.x requires Node >= 22.12.
writeFileSync(`${OUT}/package.json`, JSON.stringify({ private: true, dependencies: { "@netlify/blobs": "10.7.13", "bs58": "^6.0.0" } }, null, 2));   // dd-cosign is web3-free (Node crypto) — only bs58 needed
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: OUT, stdio: "inherit" });

// The ORE miner (degen-dojo-ore) is a separate Next.js app; we fold its STATIC EXPORT
// into the store so /mine lives inside this one deploy (Seeker-ready). Build the export
// first in that project:  (in degen-dojo-ore, with output:"export" + images.unoptimized)
//   npx next build   ->   degen-dojo-ore/out/
// Its client calls /api/rpc, which the store already proxies (store-fn-rpc.mjs, allowlist
// now includes getSlot/getTransaction). We copy the shared _next chunks, the /mine pages and the
// whitelabel pages (/whitelabel pitch + /create: any collection previews its own 25-NFT branded grid)
// — NOT the miner's own index/admin (index.html would clobber the store home; admin is operator-only).
{
  const MINER_OUT = "C:/Users/sazei/Documents/DEGEN DOJO/degen-dojo-ore/out";
  if (existsSync(`${MINER_OUT}/mine.html`) && existsSync(`${MINER_OUT}/_next`)) {
    console.log("Folding the ORE miner static export into the store (/mine)…");
    cpSync(`${MINER_OUT}/_next`, `${OUT}/_next`, { recursive: true });
    copyFileSync(`${MINER_OUT}/mine.html`, `${OUT}/mine.html`);
    cpSync(`${MINER_OUT}/mine`, `${OUT}/mine`, { recursive: true });
    for (const pg of ["whitelabel", "create"]) {
      if (!existsSync(`${MINER_OUT}/${pg}.html`)) { console.log(`  ! miner export has no ${pg}.html — skipped`); continue; }
      copyFileSync(`${MINER_OUT}/${pg}.html`, `${OUT}/${pg}.html`);
      if (existsSync(`${MINER_OUT}/${pg}`)) cpSync(`${MINER_OUT}/${pg}`, `${OUT}/${pg}`, { recursive: true });
    }
    // The store top bar is rendered by the miner's React (StoreNav) so it survives Next
    // hydration (an HTML-injected bar flashes then vanishes). We only need wallet-picker.js
    // loaded so window.DojoWalletPicker exists for the wallet-bridge → ONE shared session
    // across the store. Load it in <head> so it's ready before React hydrates.
    for (const rel of ["mine.html", "mine/vault.html", "mine/burn.html", "whitelabel.html", "create.html"]) {
      const p = `${OUT}/${rel}`;
      if (!existsSync(p)) continue;
      let h = readFileSync(p, "utf8");
      if (!h.includes("wallet-picker.js")) {
        h = h.replace(/<head(\s[^>]*)?>/i, (m) => m + '\n<script src="/mwa.js"></script><script src="/wallet-picker.js"></script><script src="/dojo-profile.js"></script>');
        writeFileSync(p, h);
      }
    }
    console.log("  /mine (+ burn mode) + /mine/vault + /mine/burn (→ /mine?burn=1) + /whitelabel + /create + _next chunks copied; wallet-picker.js injected (React renders the nav).");
  } else {
    console.log("  ! ORE miner export not found at degen-dojo-ore/out — /mine will 404.");
    console.log("    Build it first: in degen-dojo-ore set output:'export'+images.unoptimized, `npx next build`.");
  }
}

// Every page that offers wallets must load mwa.js BEFORE wallet-picker.js, or the Seeker's Seed Vault
// (Mobile Wallet Adapter) never registers there — no option to pick, and no silent reconnect.
{
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (["_next", "netlify", "node_modules"].includes(e.name) ? [] : walk(`${d}/${e.name}`)) : e.name.endsWith(".html") ? [`${d}/${e.name}`] : []);
  let added = 0;
  for (const p of walk(OUT)) {
    const h = readFileSync(p, "utf8");
    if (h.includes("/wallet-picker.js") && !h.includes("/mwa.js")) {
      writeFileSync(p, h.replace(/<script src="\/wallet-picker\.js"/, '<script src="/mwa.js"></script><script src="/wallet-picker.js"'));
      added++;
    }
  }
  console.log(`  mwa.js added to ${added} page(s) that loaded the wallet picker without it.`);
  // Cracked / Mono cards (Nov 2 on): every page that shows Degen Dojo card pictures loads dd-states.js in <head>,
  // which swaps a cracked card's picture to its cracked card (degen/card-states.json).
  copyFileSync(`${ROOT}/scripts/dd-states.js`, `${OUT}/dd-states.js`);
  let st = 0;
  for (const p of walk(OUT)) {
    const h = readFileSync(p, "utf8");
    if (/degen\/card\/|card\/'\s*\+|\/dd-case\.js/.test(h) && !h.includes("/dd-states.js")) {
      const tag = '<script src="/dd-states.js"></script>';
      // some pages (List, Repair) are bare fragments with no <head> — put it at the very top there
      writeFileSync(p, /<head(\s[^>]*)?>/i.test(h) ? h.replace(/<head(\s[^>]*)?>/i, (m) => m + tag) : h.replace(/^(\s*<!doctype[^>]*>)?/i, (m) => m + tag));
      st++;
    }
  }
  console.log(`  dd-states.js (cracked card pictures) added to ${st} page(s).`);
}

writeFileSync(`${OUT}/404.html`, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found · Degen Dojo</title><body style="background:#0a0a0f;color:#e8e0d0;font:16px Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#e8b84b">Not found</h1><a href="/" style="color:#e8b84b">← Back to the store</a></div>');
assertNoSecrets(OUT);   // never ship a key
console.log("[3/4] Zipping for drag-and-drop…");
// PowerShell 5.1 writes backslash paths into zips, which Netlify then serves as
// 404s. The helper writes forward slashes (same one build-all.mjs uses).
const zps = `${ROOT}/scripts/zip-forward.ps1`.replaceAll("/", "\\");
execSync(
  `powershell -NoProfile -ExecutionPolicy Bypass -File "${zps}" -Src "${OUT.replaceAll("/", "\\")}" -Zip "${ZIP.replaceAll("/", "\\")}"`,
  { stdio: "inherit" },
);
assertZipClean(ZIP);   // scan what Netlify will actually receive (deletes the zip on a hit)

const kb = (p) => (readFileSync(p).length / 1024).toFixed(0);
console.log(`\n[4/4] ===== STORE READY FOR NETLIFY =====`);
console.log(`  index.html   ${kb(`${OUT}/index.html`)} KB`);
console.log(`  deploy zip   ${ZIP}  (${kb(ZIP)} KB)`);
console.log(`\n  Drag the zip onto https://app.netlify.com/drop (or a new site's Deploys tab).`);
console.log(`  It ships noindex + robots disallow, so it stays unlisted.`);
console.log(`  For an actual password: Site configuration → Access & security → Password protection.`);
console.log(`
  BEFORE CHECKOUT WORKS: set the env var SOLANA_RPC to your Helius URL in`);
console.log(`  Site configuration → Environment variables. The page calls /api/rpc, so the`);
console.log(`  key is never served to visitors.`);
