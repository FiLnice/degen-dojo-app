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
//
// Env: SOLANA_RPC (DAS-capable, for holdings → tier), ATTR_ADMIN_KEY, OUR_FEE_BPS (opt).
import { getStore } from "@netlify/blobs";
import crypto from "crypto";

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
async function bindCode(codes, wallet, display) {
  const lc = display.toLowerCase();
  const old = await currentCode(codes, wallet);
  if (old && old.toLowerCase() !== lc) { try { await codes.delete("code:" + old.toLowerCase()); } catch {} }
  await codes.set("code:" + lc, wallet);   // lc → wallet (payout + ref resolve)
  await codes.set("wallet:" + wallet, display);   // wallet → chosen casing (display)
}

const OUR_FEE_BPS = Number(process.env.OUR_FEE_BPS || 200);
// Tiers (verified against LIVE holdings at claim AND before every payout):
//   Wanderer 0–1 fighters = 20% · Disciple 2–4 = 25% · Sensei 5+ OR holds a Mythic = 30%.
const tierShare = (h, m) => (h >= 5 || m ? 0.30 : h >= 2 ? 0.25 : 0.20);
const tierName  = (h, m) => (h >= 5 || m ? "Sensei" : h >= 2 ? "Disciple" : "Wanderer");
// Pot entries are earned by ACTIVITY (per 0.1 SOL of buys + referred volume) and
// multiplied by holdings — never granted for free, so splitting a wallet is
// pointless. Only counts once the holder has opted into the cycle. 2× for Sensei/Mythic.
const potMult = (h, m) => (h >= 5 || m ? 2 : h >= 2 ? 1 : 0);
const entriesFor = (activitySol, held, m) => potMult(held, m) ? Math.floor(activitySol / 0.1) * potMult(held, m) : 0;
// ISO-week cycle id (e.g. 2026-W30). One draw per cycle.
function cycleId(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function das(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
const DD_COLLECTION = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";
const MYTHIC_RE = /gods?|devil|sensei|mutants?|pirate|rowdy|rugger/i;   // mythic Body/Race values
const bodyOf = (a) => ((a.content?.metadata?.attributes || []).find((x) => /^(body|race)$/i.test(x.trait_type || x.key)) || {}).value;
// Returns live { count, mythic } — recomputed on every claim and before every payout, so a
// preacher who sold their fighters drops a tier (or out of the pot) automatically.
async function ddHeld(wallet) {
  let page = 1, count = 0, mythic = false;
  for (;;) {
    const res = await das("getAssetsByOwner", { ownerAddress: wallet, page, limit: 1000 });
    const items = res?.items || [];
    for (const a of items) {
      if ((a.grouping || []).some((g) => g.group_key === "collection" && g.group_value === DD_COLLECTION)) {
        count++;
        if (MYTHIC_RE.test(String(bodyOf(a) || ""))) mythic = true;
      }
    }
    if (items.length < 1000) break; page++;
  }
  return { count, mythic };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (request) => {
  const codes = getStore("preacher-codes");     // code:<code> → wallet ; wallet:<wallet> → code
  const ledger = getStore("preacher-ledger");   // sale:<sig> → record (written by /api/attr)
  const paidS  = getStore("preacher-paid");      // paid:<oreSig> → { ref, payoutSol, sigs } (payout)
  const pot    = getStore("preacher-pot");       // optin:<cycle>:<wallet> → "1"
  const url = new URL(request.url);

  if (request.method === "GET") {
    if ((url.searchParams.get("key") || "") !== (process.env.ATTR_ADMIN_KEY || "\0")) return new Response("forbidden", { status: 403 });
    const exp = url.searchParams.get("export");
    if (exp === "codes") {
      const { blobs } = await codes.list({ prefix: "code:" });
      const map = {};
      for (const b of blobs) { const w = await codes.get(b.key, { type: "text" }); if (w) map[b.key.slice(5)] = w; }
      return json(map);
    }
    if (exp === "optins") {
      const cy = url.searchParams.get("cycle") || cycleId();
      const { blobs } = await pot.list({ prefix: `optin:${cy}:` });
      return json({ cycle: cy, wallets: blobs.map((b) => b.key.split(":").pop()) });
    }
    return new Response("ok", { status: 200 });
  }
  if (request.method !== "POST") return new Response("POST only", { status: 405 });

  let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const { action, wallet, sig, msg } = body;

  // Admin write (payout script marks a preacher paid). Gated by the admin key,
  // not a wallet signature, since the payout runs headless on the treasury box.
  if (action === "markPaid") {
    if ((body.adminKey || "") !== (process.env.ATTR_ADMIN_KEY || "\0")) return json({ error: "forbidden" }, 403);
    if (!body.oreSig) return json({ error: "oreSig required" }, 400);
    await paidS.setJSON("paid:" + body.oreSig, { ref: body.ref, wallet: body.wallet, payoutSol: +body.payoutSol || 0, sigs: body.sigs || [], at: Date.now() });
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
    // Everything this preacher has driven. Amounts are the RECORDED ledger
    // (fast, shown as "pending"); the payout run verifies each on-chain before ORE moves.
    const { blobs } = await ledger.list({ prefix: "sale:" });
    let volumeLamports = 0, buyLamports = 0; const sales = [];
    for (const b of blobs) {
      const rec = await ledger.get(b.key, { type: "json" });
      if (!rec) continue;
      if (rec.buyer === wallet) buyLamports += rec.priceLamports || 0;   // their own buys → pot entries
      if (rec.ref !== code) continue;                                     // their referred sales → cut + entries
      volumeLamports += rec.priceLamports || 0;
      sales.push({ mint: rec.mint, sol: (rec.priceLamports || 0) / 1e9, external: !!rec.external, ts: rec.ts, paid: false, sig: rec.sig });
    }
    // paid so far — each payout record carries the sigs it covered
    let paidOreSol = 0;
    const { blobs: pb } = await paidS.list({ prefix: "paid:" });
    for (const b of pb) {
      const p = await paidS.get(b.key, { type: "json" });
      if (!p || p.ref !== code) continue;
      paidOreSol += p.payoutSol || 0;
      const covered = new Set(p.sigs || []);
      for (const s of sales) if (covered.has(s.sig)) s.paid = true;
    }

    const { count: held, mythic } = await ddHeld(wallet);
    const volumeSol = volumeLamports / 1e9;
    const buyVolumeSol = buyLamports / 1e9;
    const feeSol = volumeSol * OUR_FEE_BPS / 10000;
    const owedSol = feeSol * tierShare(held, mythic);
    const cycle = cycleId();
    const optedIn = !!(await pot.get(`optin:${cycle}:${wallet}`, { type: "text" }));
    const entries = optedIn ? entriesFor(volumeSol + buyVolumeSol, held, mythic) : 0;
    sales.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return json({
      ok: true, code: display, links: linksFor(display), wallet, held, mythic, tier: tierName(held, mythic), share: tierShare(held, mythic),
      salesCount: sales.length, volumeSol, buyVolumeSol, feeSol,
      pendingSol: Math.max(0, owedSol - paidOreSol), paidSol: paidOreSol,
      cycle, optedIn, potMult: potMult(held, mythic), entries,
      recent: sales.slice(0, 12),
    });
  }

  return json({ error: "unknown action" }, 400);
};

export const config = { path: "/api/preacher" };
