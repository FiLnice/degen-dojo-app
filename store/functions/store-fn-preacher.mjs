// Netlify Function: preacher identity + dashboard at /api/preacher
//
// Everything the "Become a Preacher" page needs, gated by a wallet SIGNATURE so
// a preacher only ever sees their own numbers (the signature proves they hold the
// wallet — it moves no funds). No external npm deps: ed25519 verification uses
// Node's built-in crypto, and base58 is inlined, so this bundles on a plain
// drag-and-drop deploy. State lives in Netlify Blobs (provided by the runtime).
//
//   POST {action:'claim', wallet, sig, msg}  → verify, mint/return the ref code + links
//   POST {action:'stats', wallet, sig, msg}  → verify, return THIS preacher's dashboard
//   GET  ?key=<ATTR_ADMIN_KEY>&export=codes   → code→wallet map, for referral-ledger.mjs
//   GET  ?key=<ATTR_ADMIN_KEY>&export=referrals → verified referred coin packs + tips (raw records)
//   GET  ?key=<ATTR_ADMIN_KEY>&export=owed      → the payout sheet (computePreacherOwed), read by referral-ledger.mjs
//
// Env: SOLANA_RPC (DAS-capable, for holdings → tier), ATTR_ADMIN_KEY.
import { getStore } from "@netlify/blobs";
import crypto from "crypto";
import { adminKeyOk } from "./store-session-core.mjs";
import { tierShare, tierName, earnedUsd, ddHeld, purchases, computePreacherOwed, markPreacherPaid, verifyReferredSales, NFT_ELIGIBLE_HALF } from "./store-preacher-core.mjs";

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
const day = (d = new Date()) => d.toISOString().slice(0, 10);
// The exact message the page asks the wallet to sign. Bound to wallet + day so a
// captured signature can't be replayed forever or against another wallet.
function expectedMsg(wallet, d) { return `Degen Dojo — prove preacher ownership\nWallet: ${wallet}\nDay: ${d}`; }
function okSig(wallet, sig, msg) {
  if (!MINT_RE.test(wallet || "") || !sig || !msg) return false;
  // accept today or yesterday (timezone slack), and the message must be ours
  if (msg !== expectedMsg(wallet, day()) && msg !== expectedMsg(wallet, day(new Date(Date.now() - 864e5)))) return false;
  return verifySig(msg, sig, wallet);
}
// Default code if the preacher doesn't pick a custom one. Custom (vanity) codes
// are 2–20 of [a-z0-9_-]; matching is case-insensitive (keyed by lowercase) but
// the chosen casing is preserved for display.
const codeFor = (wallet) => crypto.createHash("sha256").update(wallet).digest("hex").slice(0, 8);
const CODE_RE = /^[a-zA-Z0-9_-]{2,20}$/;
const linksFor = (code) => ({
  store: `https://degendojo.xyz/preacher/${code}`,
  miner: `https://mine.degendojo.xyz/preacher/${code}`,
});
async function currentCode(codes, wallet) {
  return (await codes.get("wallet:" + wallet, { type: "text" })) || null;
}
// A code that a preacher moves AWAY from is NOT released: code:<old> keeps pointing at the same wallet.
// The payout sheet resolves ref code → wallet at payout time, so releasing it let anyone re-claim the old
// code and collect every still-unpaid referral (and every old /preacher/<old> link) recorded under it.
async function bindCode(codes, wallet, display) {
  const lc = display.toLowerCase();
  await codes.set("code:" + lc, wallet);   // lc → wallet (payout + ref resolve)
  await codes.set("wallet:" + wallet, display);   // wallet → chosen casing (display)
}

// Earnings rules, tiers, holdings and the owed sheet live in store-preacher-core.mjs (shared with the payout engine).
// Pot entries are earned by ACTIVITY (per $10 of own coin buys + referred volume) and
// multiplied by holdings — never granted for free, so splitting a wallet is
// pointless. Only counts once the holder has opted into the cycle. 2× for Sensei/Mythic.
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
  const codes = getStore("preacher-codes");     // code:<code> → wallet ; wallet:<wallet> → code
  const paidS  = getStore("preacher-paid");      // paid:<oreSig> → { ref, payoutSol, sigs } (payout)
  const pot    = getStore("preacher-pot");       // optin:<cycle>:<wallet> → "1"
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (!adminKeyOk(url.searchParams.get("key"), "ATTR_ADMIN_KEY")) return new Response("forbidden", { status: 403 });
    const exp = url.searchParams.get("export");
    if (exp === "codes") {
      const { blobs } = await codes.list({ prefix: "code:" });
      const map = {};
      for (const b of blobs) { const w = await codes.get(b.key, { type: "text" }); if (w) map[b.key.slice(5)] = w; }
      return json(map);
    }
    // Verified, referred coin packs + tips — what the payout script settles.
    if (exp === "referrals") {
      const recs = (await purchases()).filter((r) => r.ref && r.verified);
      return json(recs.map((r) => ({ sig: r.sig, ref: String(r.ref).toLowerCase(), buyer: r.buyer, kind: r.kind, currency: r.currency, verifiedUsd: r.verifiedUsd || 0, verifiedAt: r.verifiedAt || 0 })));
    }
    // Admin payout sheet: per preacher, what's owed (unpaid, verified, not self-referred) in USD and
    // in the token actually paid (ORE / SKR / SOL / USDC) — coin packs, miner tips and referred DD NFT sales
    // (share × half the royalty received). Also verifies a bounded batch of new NFT sales on-chain.
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
  const { action, wallet, sig, msg } = body;

  // Admin write (payout script marks a preacher paid). Gated by the admin key,
  // not a wallet signature, since the payout runs headless on the treasury box.
  if (action === "markPaid") {
    if (!adminKeyOk(body.adminKey, "ATTR_ADMIN_KEY")) return json({ error: "forbidden" }, 403);
    if (!body.oreSig) return json({ error: "oreSig required" }, 400);
    await markPreacherPaid({ paySig: body.oreSig, ref: body.ref, wallet: body.wallet, payoutUsd: body.payoutUsd, payoutSol: body.payoutSol, sigs: body.sigs });
    return json({ ok: true });
  }

  if (!okSig(wallet, sig, msg)) return json({ error: "signature check failed" }, 403);

  if (action === "optin") {
    await pot.set(`optin:${cycleId()}:${wallet}`, "1");
    return json({ ok: true, cycle: cycleId() });
  }

  if (action === "claim") {
    let display = await currentCode(codes, wallet);
    if (!display) { display = codeFor(wallet); await bindCode(codes, wallet, display); }
    return json({ ok: true, code: display, links: linksFor(display) });
  }

  if (action === "setCode") {
    const want = String(body.code || "").trim();
    if (!CODE_RE.test(want)) return json({ error: "2–20 letters, numbers, - or _ only." }, 400);
    const lc = want.toLowerCase();
    const owner = await codes.get("code:" + lc, { type: "text" });
    if (owner && owner !== wallet) return json({ error: "That code is taken — try another." }, 409);
    await bindCode(codes, wallet, want);
    return json({ ok: true, code: want, links: linksFor(want) });
  }

  if (action === "stats") {
    const display = (await currentCode(codes, wallet)) || codeFor(wallet);
    const code = display.toLowerCase();
    // Everything this preacher has driven: referred coin packs + miner tips (USD).
    // Unverified records show as "checking" and earn nothing until verify-core confirms them on-chain.
    const { count: held, mythic } = await ddHeld(wallet);
    const share = tierShare(held, mythic);
    let volumeUsd = 0, buyUsd = 0, owedUsd = 0; const items = [];
    for (const rec of await purchases()) {
      if (rec.buyer === wallet && rec.verified && rec.kind !== "tip") buyUsd += rec.verifiedUsd || 0;   // own coin buys → pot entries
      if (String(rec.ref || "").toLowerCase() !== code || rec.buyer === wallet) continue;   // no self-referrals
      if (rec.rejected) continue;
      if (rec.verified) { volumeUsd += rec.verifiedUsd || 0; owedUsd += earnedUsd(rec, share); }
      items.push({ kind: rec.kind === "tip" ? "tip" : "coins", usd: rec.verified ? rec.verifiedUsd || 0 : rec.usd || 0,
        earnUsd: earnedUsd(rec, share), verified: !!rec.verified, ts: rec.ts, paid: false, sig: rec.sig });
    }
    // Referred Degen Dojo NFT sales: share × the eligible half (6.5%) of the royalty actually received.
    // Check a few of this preacher's new sales on-chain first (each sale is verified once, then cached).
    let nftUsd = 0;
    try { await verifyReferredSales({ ref: code, max: 8, walletOf: { [code]: wallet } }); } catch {}
    try {
      const ledger = getStore("preacher-ledger");
      const { blobs: lb } = await ledger.list({ prefix: "sale:" });
      for (const b of lb) {
        const s = await ledger.get(b.key, { type: "json" });
        if (!s || String(s.ref || "").toLowerCase() !== code || s.rejected) continue;
        if (s.txBuyer === wallet || s.txRecipient === wallet) continue;                // no self-referrals
        const earn = s.verified ? (s.royaltyUsd || 0) * NFT_ELIGIBLE_HALF * share : 0;
        if (s.verified) { owedUsd += earn; nftUsd += earn; }
        items.push({ kind: "nft", usd: s.verified ? s.royaltyUsd || 0 : 0, earnUsd: earn, verified: !!s.verified,
          currency: s.royaltyCurrency || s.currency || "SOL",
          earnAmount: s.verified ? (s.royaltyAmount || 0) * NFT_ELIGIBLE_HALF * share : 0,
          ts: s.ts || s.recordedAt, paid: false, sig: s.sig });
      }
    } catch {}
    // paid so far — each payout record carries the sigs it covered (old records carried SOL only)
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
