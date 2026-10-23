// Netlify Function: preacher identity + dashboard at /api/preacher
//
// Everything the "Become a Preacher" page needs, gated by a wallet SIGNATURE so
// a preacher only ever sees their own numbers (the signature proves they hold the
// wallet â€” it moves no funds). No external npm deps: ed25519 verification uses
// Node's built-in crypto, and base58 is inlined, so this bundles on a plain
// drag-and-drop deploy. State lives in Netlify Blobs (provided by the runtime).
//
// Signatures (audit DD-13, 2026-10-23): every signed message is Sign-In-With-Solana style â€” bound to this site's
// domain, a one-time server nonce, the ACTION and its parameters, and a 5-minute expiry â€” and is consumed ONCE.
// One signature opens the desk (claim + stats + pot opt-in) for 30 minutes via a desk token; changing the code
// needs its own signature naming the new code. The old "Wallet + Day" message is no longer accepted.
//
//   POST {action:'nonce', wallet, for:'desk'|'setCode', code?} â†’ { nonce, message }   (the wallet signs `message`)
//   POST {action:'desk', wallet, nonce, sig}       â†’ verify + consume â†’ { token, exp, code, links }
//   POST {action:'claim'|'stats'|'optin', token}   â†’ the desk (token from 'desk', same site, unexpired)
//   POST {action:'setCode', wallet, nonce, sig, code} â†’ verify + consume â†’ claim the code (create-only: the first
//        wallet to take a code keeps it; up to ALIASES_MAX custom codes per wallet)
//   GET  ?export=codes   â†’ codeâ†’wallet map, for referral-ledger.mjs
//   GET  ?export=referrals â†’ verified referred coin packs + tips (raw records)
//   GET  ?export=owed      â†’ the payout sheet (computePreacherOwed), read by referral-ledger.mjs
//
// Env: SOLANA_RPC (DAS-capable, for holdings â†’ tier), ATTR_ADMIN_KEY, SESSION_SECRET (signs desk tokens).
import { limited } from "./store-ratelimit-core.mjs";
import { getStore } from "@netlify/blobs";
import crypto from "crypto";
import { adminRequestOk, sessionSecret, sessionUnavailable } from "./store-session-core.mjs";
import { putIfNew, casUpdate, readWithEtag } from "./store-cas-core.mjs";
import { tierShare, tierName, earnedUsd, recordShare, legacyTierShare, ddHeld, purchases, computePreacherOwed, markPreacherPaid } from "./store-preacher-core.mjs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58dec(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = B58.indexOf(str[i]); if (c < 0) return null;
    for (let j = 0; j < bytes.length; j++) { c += bytes[j] * 58; bytes[j] = c & 0xff; c >>= 8; }
    while (c > 0) { bytes.push(c & 0xff); c >>= 8; }
  }
  for (let i = 0; i < str.length && str[i] === "1"; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}
// Solana signs the raw message bytes with ed25519; verify with node crypto by
// wrapping the 32-byte pubkey in the standard Ed25519 SPKI DER prefix.
function verifySig(message, sigB58, pubB58) {
  try {
    const sig = b58dec(sigB58), pub = b58dec(pubB58);
    if (!sig || !pub || pub.length !== 32 || sig.length !== 64) return false;
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch { return false; }
}
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE_TTL = 5 * 60e3, DESK_TTL = 30 * 60e3;
const NONCE_RE = /^[0-9a-f]{32}$/;
// Same-origin only (Origin, or Referer from in-app wallet browsers) â†’ the host that is bound into the message.
function ownOrigin(request) {
  const o = request.headers.get("origin") || request.headers.get("referer") || "";
  let h; try { h = new URL(o).host.toLowerCase(); } catch { return null; }
  const own = new Set(); const hh = (request.headers.get("host") || "").trim().toLowerCase(); if (hh) own.add(hh);
  try { own.add(new URL(request.url).host.toLowerCase()); } catch {}
  return own.has(h) ? h : null;
}
// The exact text the wallet signs (SIWS layout, so wallets that understand it warn on a foreign site).
export function preachMsg({ domain, wallet, act, code = "", nonce, iso, expIso }) {
  const what = act === "setCode" ? `change my referral code to "${code}"` : "open my preacher desk (my link, my stats, the pot opt-in)";
  return `${domain} wants you to sign in with your Solana account:\n${wallet}\n\nDegen Dojo preacher: ${what}. This is free and never a transaction.\n\n` +
    `URI: https://${domain}/become-a-preacher\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce}\nIssued At: ${iso}\nExpiration Time: ${expIso}\n` +
    `Request ID: ${act}${act === "setCode" ? ":" + code : ""}`;
}
// Check a signed request against its stored nonce, then consume the nonce (create-only marker â€” two racing
// requests with one signature can't both pass). â†’ { ok:true, rec } | { ok:false, status, error }
async function useNonce(nonces, { domain, wallet, nonce, sig, act, code = "" }) {
  if (!NONCE_RE.test(String(nonce || "")) || !MINT_RE.test(String(wallet || "")) || typeof sig !== "string" || sig.length > 100)
    return { ok: false, status: 400, error: "bad request" };
  const rec = (await readWithEtag(nonces, "n:" + nonce)).value;
  if (!rec || Date.now() > rec.exp) return { ok: false, status: 401, error: "That request expired â€” sign again." };
  if (rec.domain !== domain) return { ok: false, status: 403, error: "Sign from the page that asked for it." };
  if (rec.wallet !== wallet || rec.act !== act || (rec.code || "") !== code) return { ok: false, status: 403, error: "That signature is for a different request â€” sign again." };
  if (!verifySig(preachMsg({ domain, wallet, act, code, nonce, iso: rec.iso, expIso: rec.expIso }), sig, wallet)) return { ok: false, status: 403, error: "signature check failed" };
  if (!(await putIfNew(nonces, "used:" + nonce, { wallet, act, at: Date.now() }))) return { ok: false, status: 401, error: "That signature was already used â€” sign again." };
  await nonces.delete("n:" + nonce).catch(() => {});
  return { ok: true, rec };
}
// Desk token: "pd1.<wallet>.<exp>.<hmac>" â€” HMAC(SESSION_SECRET) over purpose + site + wallet + expiry, so it
// opens only THIS preacher's desk on THIS site and can never pass as a game session token (different shape + MAC).
const deskMac = (secret, domain, wallet, exp) => crypto.createHmac("sha256", secret).update(`preacher-desk|${domain}|${wallet}|${exp}`).digest("hex");
function deskToken(domain, wallet) {
  const secret = sessionSecret(); if (!secret) return null;
  const exp = Date.now() + DESK_TTL;
  return { token: `pd1.${wallet}.${exp}.${deskMac(secret, domain, wallet, exp)}`, exp };
}
function deskWallet(token, domain) {
  const secret = sessionSecret();
  const m = /^pd1\.([1-9A-HJ-NP-Za-km-z]{32,44})\.(\d{13})\.([0-9a-f]{64})$/.exec(String(token || ""));
  if (!secret || !m || Date.now() > Number(m[2])) return null;
  const want = deskMac(secret, domain, m[1], m[2]);
  return crypto.timingSafeEqual(Buffer.from(m[3]), Buffer.from(want)) ? m[1] : null;
}

// Default code if the preacher doesn't pick a custom one (8 hex of sha256(wallet); longer on the rare clash).
// Custom (vanity) codes are 2â€“20 of [a-z0-9_-]; matching is case-insensitive (keyed by lowercase) but the chosen
// casing is preserved for display. Codes that look like default codes (8/12/16 hex) are reserved.
const hashOf = (wallet) => crypto.createHash("sha256").update(wallet).digest("hex");
const codeFor = (wallet) => hashOf(wallet).slice(0, 8);
const CODE_RE = /^[a-zA-Z0-9_-]{2,20}$/;
const DEFAULT_LIKE = /^(?:[0-9a-f]{8}|[0-9a-f]{12}|[0-9a-f]{16})$/;
export const ALIASES_MAX = 5;   // custom codes one wallet may claim (each stays bound to it forever)
const linksFor = (code) => ({
  store: `https://degendojo.xyz/preacher/${code}`,
  miner: `https://mine.degendojo.xyz/preacher/${code}`,
});
async function strongText(store, key) {
  try { return await store.get(key, { type: "text", consistency: "strong" }); }
  catch (e) { if (!/uncachedEdgeURL|strong consistency/i.test(String(e?.message || e))) throw e; return store.get(key, { type: "text" }); }
}
async function currentCode(codes, wallet) {
  return (await strongText(codes, "wallet:" + wallet)) || null;
}
// A code is claimed CREATE-ONLY (no check-then-write): the first wallet to take code:<lc> keeps it. A code that a
// preacher moves AWAY from is NOT released either: code:<old> keeps pointing at the same wallet, because the payout
// sheet resolves ref code â†’ wallet at payout time (releasing it let anyone collect old unpaid referrals).
async function claimCode(codes, lc, wallet) {
  const r = await codes.set("code:" + lc, wallet, { onlyIfNew: true });
  if (!r || typeof r.modified !== "boolean") throw new Error("conditional writes unavailable â€” the vendored @netlify/blobs must be >= 10.7.12");
  return r.modified || (await strongText(codes, "code:" + lc)) === wallet;   // already ours (e.g. re-picking an old code)
}
// The wallet's default code: 8 hex, or 12/16/24 if a shorter one is somehow taken by another wallet.
async function claimDefault(codes, wallet) {
  for (const n of [8, 12, 16, 24]) { const c = hashOf(wallet).slice(0, n); if (await claimCode(codes, c, wallet)) return c; }
  throw new Error("couldn't allocate a referral code");
}
class AliasCap extends Error {}

// Earnings rules, tiers, holdings and the owed sheet live in store-preacher-core.mjs (shared with the payout engine).
// Pot entries are earned by ACTIVITY (per $10 of own coin buys + referred volume) and
// multiplied by holdings â€” never granted for free, so splitting a wallet is
// pointless. Only counts once the holder has opted into the cycle. 2Ã— for Sensei/Mythic.
const potMult = (h, m) => (h >= 5 || m ? 2 : h >= 2 ? 1 : 0);
const entriesFor = (activityUsd, held, m) => potMult(held, m) ? Math.floor(activityUsd / 10) * potMult(held, m) : 0;
// ISO-week cycle id (e.g. 2026-W30). One draw per cycle.
function cycleId(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (request) => {
  const blocked = limited(request, "preacher", 30); if (blocked) return blocked;   // 30 / minute / IP (DD-04)
  const codes = getStore("preacher-codes");     // code:<code> â†’ wallet ; wallet:<wallet> â†’ code
  const paidS  = getStore("preacher-paid");      // paid:<oreSig> â†’ { ref, payoutSol, sigs } (payout)
  const pot    = getStore("preacher-pot");       // optin:<cycle>:<wallet> â†’ "1"
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (!adminRequestOk(request, "ATTR_ADMIN_KEY")) return new Response("forbidden", { status: 403 });
    const exp = url.searchParams.get("export");
    if (exp === "codes") {
      const { blobs } = await codes.list({ prefix: "code:" });
      const map = {};
      for (const b of blobs) { const w = await codes.get(b.key, { type: "text" }); if (w) map[b.key.slice(5)] = w; }
      return json(map);
    }
    // Verified, referred coin packs + tips â€” what the payout script settles.
    if (exp === "referrals") {
      const recs = (await purchases()).filter((r) => r.ref && r.verified);
      return json(recs.map((r) => ({ sig: r.sig, ref: String(r.ref).toLowerCase(), buyer: r.buyer, kind: r.kind, currency: r.currency, verifiedUsd: r.verifiedUsd || 0, verifiedAt: r.verifiedAt || 0 })));
    }
    // Admin payout sheet: per preacher, what's owed (unpaid, verified, not self-referred) in USD and
    // in the token actually paid (ORE / SKR / SOL / USDC) â€” coin packs, miner tips and referred DD NFT sales
    // (share Ã— half the royalty received). Also verifies a bounded batch of new NFT sales on-chain.
    if (exp === "owed") return json(await computePreacherOwed());
    if (exp === "optins") {
      const cy = url.searchParams.get("cycle") || cycleId();
      const { blobs } = await pot.list({ prefix: `optin:${cy}:` });
      return json({ cycle: cy, wallets: blobs.map((b) => b.key.split(":").pop()) });
    }
    return new Response("ok", { status: 200 });
  }
  if (request.method !== "POST") return new Response("POST only", { status: 405 });

  let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "bad json" }, 400);
  const { action, wallet, sig } = body;

  // Admin write (payout script marks a preacher paid). Gated by the admin key,
  // not a wallet signature, since the payout runs headless on the treasury box.
  if (action === "markPaid") {
    if (!adminRequestOk(request, "ATTR_ADMIN_KEY")) return json({ error: "forbidden" }, 403);
    if (!body.oreSig) return json({ error: "oreSig required" }, 400);
    await markPreacherPaid({ paySig: body.oreSig, ref: body.ref, wallet: body.wallet, payoutUsd: body.payoutUsd, payoutSol: body.payoutSol, sigs: body.sigs });
    return json({ ok: true });
  }

  // ---- everything below is signed by the preacher's wallet (DD-13) ----
  const domain = ownOrigin(request);
  if (!domain) return json({ error: "use the Degen Dojo preacher page" }, 403);
  if (!sessionSecret()) return sessionUnavailable();
  const nonces = getStore("preacher-nonces");
  const want = String(body.code || "").trim();
  const codeError = (c) => (!CODE_RE.test(c) ? "2â€“20 letters, numbers, - or _ only."
    : DEFAULT_LIKE.test(c.toLowerCase()) && c.toLowerCase() !== codeFor(wallet) ? "That looks like an automatic code â€” pick something else." : null);

  // 1) a one-time message to sign, bound to this site + wallet + action (+ the new code)
  if (action === "nonce") {
    if (!MINT_RE.test(String(wallet || ""))) return json({ error: "bad wallet" }, 400);
    const act = body.for === "setCode" ? "setCode" : "desk";
    if (act === "setCode") {
      const err = codeError(want); if (err) return json({ error: err }, 400);
      const owner = await strongText(codes, "code:" + want.toLowerCase());
      if (owner && owner !== wallet) return json({ error: "That code is taken â€” try another." }, 409);   // early hint; the claim itself is atomic
    }
    const nonce = crypto.randomBytes(16).toString("hex"), now = Date.now();
    const rec = { wallet, domain, act, code: act === "setCode" ? want : "", iso: new Date(now).toISOString(), exp: now + NONCE_TTL, expIso: new Date(now + NONCE_TTL).toISOString() };
    await nonces.setJSON("n:" + nonce, rec);
    return json({ ok: true, nonce, message: preachMsg({ ...rec, nonce }) });
  }

  // the code, claimed for the wallet (default code if none yet)
  async function ensureCode(w) {
    let display = await currentCode(codes, w);
    if (!display) {
      display = await claimDefault(codes, w);
      const r = await codes.set("wallet:" + w, display, { onlyIfNew: true });   // a concurrent claim may have set it
      if (r && r.modified === false) display = (await currentCode(codes, w)) || display;
    }
    return display;
  }

  // 2) open the desk: one signature â†’ a 30-minute desk token (+ the referral link)
  if (action === "desk") {
    const u = await useNonce(nonces, { domain, wallet, nonce: body.nonce, sig, act: "desk" });
    if (!u.ok) return json({ error: u.error }, u.status);
    const t = deskToken(domain, wallet); if (!t) return sessionUnavailable();
    const display = await ensureCode(wallet);
    return json({ ok: true, ...t, code: display, links: linksFor(display) });
  }

  // 3) change the code: its own signature naming the new code
  if (action === "setCode") {
    const err = codeError(want); if (err) return json({ error: err }, 400);
    const u = await useNonce(nonces, { domain, wallet, nonce: body.nonce, sig, act: "setCode", code: want });
    if (!u.ok) return json({ error: u.error }, u.status);
    const lc = want.toLowerCase();
    // reserve a slot in this wallet's (capped) alias list first, then claim the code create-only
    try {
      await casUpdate(codes, "aliases:" + wallet, (a) => {
        a = a || { codes: [] };
        if (a.codes.includes(lc)) return undefined;
        if (a.codes.length >= ALIASES_MAX) throw new AliasCap();
        return { codes: [...a.codes, lc], updatedAt: Date.now() };
      });
    } catch (e) { if (e instanceof AliasCap) return json({ error: `You've used all ${ALIASES_MAX} custom codes â€” your current one stays.` }, 409); throw e; }
    if (!(await claimCode(codes, lc, wallet))) {
      await casUpdate(codes, "aliases:" + wallet, (a) => (a && a.codes.includes(lc) ? { ...a, codes: a.codes.filter((c) => c !== lc) } : undefined));
      return json({ error: "That code is taken â€” try another." }, 409);
    }
    await codes.set("wallet:" + wallet, want);   // wallet â†’ chosen casing (display)
    return json({ ok: true, code: want, links: linksFor(want) });
  }

  // 4) the desk itself â€” needs the token from step 2 (a bare signature no longer works)
  const deskW = deskWallet(body.token, domain);
  if (!deskW) return json({ error: "Your preacher session ended â€” connect and sign again.", signIn: true }, 401);

  if (action === "optin") {
    await pot.set(`optin:${cycleId()}:${deskW}`, "1");
    return json({ ok: true, cycle: cycleId() });
  }

  if (action === "claim") {
    const display = await ensureCode(deskW);
    return json({ ok: true, code: display, links: linksFor(display) });
  }

  if (action === "stats") {
    const wallet = deskW;
    const display = (await currentCode(codes, wallet)) || codeFor(wallet);
    const code = display.toLowerCase();
    // Everything this preacher has driven: referred coin packs + miner tips (USD).
    // Unverified records show as "checking" and earn nothing until verify-core confirms them on-chain.
    const { count: held, mythic } = await ddHeld(wallet);
    const share = tierShare(held, mythic), legacy = legacyTierShare(held, mythic);   // legacy = records verified before 2026-10-23
    let volumeUsd = 0, buyUsd = 0, owedUsd = 0; const items = [];
    for (const rec of await purchases()) {
      if (rec.buyer === wallet && rec.verified && rec.kind !== "tip") buyUsd += rec.verifiedUsd || 0;   // own coin buys â†’ pot entries
      if (String(rec.ref || "").toLowerCase() !== code || rec.buyer === wallet) continue;   // no self-referrals
      if (rec.rejected || rec.route === "tip") continue;   // a Dojo Pot tip earns preachers nothing (100% Pot)
      // new records carry the share locked when the payment was verified; older ones the 20/25/30% rules
      const earn = earnedUsd(rec, legacy), pct = Math.round(recordShare(rec, legacy) * 100);
      if (rec.verified) { volumeUsd += rec.verifiedUsd || 0; owedUsd += earn; }
      items.push({ kind: rec.route === "minetip" || rec.kind === "tip" ? "tip" : "coins", usd: rec.verified ? rec.verifiedUsd || 0 : rec.usd || 0,
        earnUsd: earn, sharePct: rec.verified ? pct : null, verified: !!rec.verified, ts: rec.ts, paid: false, sig: rec.sig });
    }
    // Referred NFT sales: since 2026-10-23 preachers earn on games + mining tips only â€” old sale records are shown
    // as history and earn nothing (royalties now go to the collection Card Vaults + the Reserve).
    const nftUsd = 0;
    try {
      const ledger = getStore("preacher-ledger");
      const { blobs: lb } = await ledger.list({ prefix: "sale:" });
      for (const b of lb) {
        const s = await ledger.get(b.key, { type: "json" });
        if (!s || String(s.ref || "").toLowerCase() !== code || s.rejected) continue;
        if (s.txBuyer === wallet || s.txRecipient === wallet) continue;                // no self-referrals
        items.push({ kind: "nft", usd: s.verified ? s.royaltyUsd || 0 : 0, earnUsd: 0, retired: true, verified: !!s.verified,
          currency: s.royaltyCurrency || s.currency || "SOL", earnAmount: 0, ts: s.ts || s.recordedAt, paid: false, sig: s.sig });
      }
    } catch {}
    // paid so far â€” each payout record carries the sigs it covered (old records carried SOL only)
    let paidUsd = 0, paidSol = 0;
    const { blobs: pb } = await paidS.list({ prefix: "paid:" });
    for (const b of pb) {
      const p = await paidS.get(b.key, { type: "json" });
      if (!p || String(p.ref || "").toLowerCase() !== code) continue;
      if (p.payoutUsd != null) paidUsd += +p.payoutUsd || 0; else paidSol += +p.payoutSol || 0;
      const covered = new Set(p.sigs || []);
      for (const s of items) if (covered.has(s.sig)) s.paid = true;
    }
    const pendingUsd = items.filter((s) => s.verified && !s.paid).reduce((t, s) => t + s.earnUsd, 0);
    const cycle = cycleId();
    const optedIn = !!(await pot.get(`optin:${cycle}:${wallet}`, { type: "text" }));
    const entries = optedIn ? entriesFor(volumeUsd + buyUsd, held, mythic) : 0;
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return json({
      ok: true, code: display, links: linksFor(display), wallet, held, mythic, tier: tierName(held, mythic), share,
      salesCount: items.length, nftSales: items.filter((s) => s.kind === "nft").length, nftUsd,
      volumeUsd, buyUsd, earnedUsd: owedUsd,
      pendingUsd, paidUsd, paidSol,
      cycle, optedIn, potMult: potMult(held, mythic), entries,
      recent: items.slice(0, 12).map(({ sig, ...s }) => s),
    });
  }

  return json({ error: "unknown action" }, 400);
};

export const config = { path: "/api/preacher" };
