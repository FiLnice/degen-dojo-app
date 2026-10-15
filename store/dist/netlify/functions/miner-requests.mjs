// Netlify Function: /api/miner-requests — branded ORE miner signups (any collection, hosted by us).
//
//   POST {name, tipWallet, contact, website?, collection?, degens[25]{name,image,mint?}, paymentSig, payer}
//        → verifies the ORE setup fee ON-CHAIN (getTransaction jsonParsed: tx ok, payer signed it,
//          < ~1h old, operator's ORE balance up by ≥ fee×0.999), replay-guards the signature,
//          stores req:<id> as "pending". Returns {id, status}.
//   GET  ?id=<id>        → {status, slug?, url?} (slug/url only once approved)
//   GET  ?admin=<KEY>    → {requests:[…]} newest first (operator review)
//   POST {action:'decide', id, key, decision:'approve'|'reject', slug?}
//        → approve: assigns a unique URL-safe slug (given or from the name) and publishes
//          miner:<slug> = {slug,name,tipWallet,degens,collection,approvedAt} → live at /m/<slug>.
//          reject: marks it rejected (and unpublishes its miner if it had been approved).
//
// Env: ADMIN_KEY (admin list/decide), SOLANA_RPC (fallback HELIUS_RPC) for getTransaction,
//      OPERATOR_WALLET (default = STORE_TREASURY_WALLET in store-miner-core.mjs), SETUP_FEE_ORE (default 5).
// Storage: Netlify Blobs "miner-requests" (req:<id>, sig:<paymentSig>, miner:<slug>).
import { getStore } from "@netlify/blobs";
import {
  STORE_TREASURY_WALLET, DEFAULT_FEE_ORE, B58_ADDR, SLUG_RE,
  checkOrePayment, validateRequest, uniqueSlug, slugify,
} from "./store-miner-core.mjs";
import { adminKeyOk } from "./store-session-core.mjs";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const store = () => getStore({ name: "miner-requests", consistency: "strong" });
const OPERATOR = () => {
  const v = (process.env.OPERATOR_WALLET || "").trim();
  return B58_ADDR.test(v) ? v : STORE_TREASURY_WALLET;
};
const FEE_ORE = () => parseFloat(process.env.SETUP_FEE_ORE || "") || DEFAULT_FEE_ORE;
const RPC = () => {
  const pick = (v) => (typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim() : "");
  return pick(process.env.SOLANA_RPC) || pick(process.env.HELIUS_RPC);
};
const isAdmin = (k) => adminKeyOk(k, "ADMIN_KEY");   // constant-time; an unset ADMIN_KEY matches nothing
const liveUrl = (request, slug) => `${new URL(request.url).origin}/m/${slug}`;

async function getTransaction(sig) {
  const rpc = RPC();
  if (!rpc) throw new Error("RPC not configured");
  // A just-confirmed tx can take a moment to be served by getTransaction — retry briefly.
  let ver = 0;   // mainnet now serves v1 transactions too — a v0-capped call errors -32015 on them
  for (let i = 0; i < 4; i++) {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getTransaction",
        params: [sig, { maxSupportedTransactionVersion: ver, encoding: "jsonParsed", commitment: "confirmed" }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.result) return j.result;
    if (ver === 0 && (j?.error?.code === -32015 || /transaction version/i.test(j?.error?.message || ""))) { ver = 1; i--; continue; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

async function listRequests(s) {
  const { blobs } = await s.list({ prefix: "req:" });
  const out = [];
  for (const b of blobs) {
    const r = await s.get(b.key, { type: "json" });
    if (r) out.push(r);
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function decide(request, d) {
  if (!isAdmin(d.key)) return json({ error: "unauthorized" }, 401);
  const s = store();
  const id = String(d.id || "");
  const r = await s.get(`req:${id}`, { type: "json" });
  if (!r) return json({ error: "not found" }, 404);

  if (d.decision === "reject") {
    if (r.slug) {
      const m = await s.get(`miner:${r.slug}`, { type: "json" });
      if (m && m.requestId === r.id) await s.delete(`miner:${r.slug}`);
    }
    r.status = "rejected";
    r.decidedAt = Date.now();
    await s.setJSON(`req:${id}`, r);
    return json({ ok: true, status: r.status });
  }
  if (d.decision !== "approve") return json({ error: "decision must be approve or reject" }, 400);

  // A slug is "taken" if some OTHER request's miner already owns it.
  const taken = async (slug) => {
    const m = await s.get(`miner:${slug}`, { type: "json" });
    return !!m && m.requestId !== r.id;
  };
  let slug;
  if (d.slug) {
    const want = slugify(d.slug);
    if (!SLUG_RE.test(want)) return json({ error: "slug must be a-z, 0-9 and dashes" }, 400);
    if (await taken(want)) return json({ error: `slug "${want}" is already in use` }, 409);
    slug = want;
  } else if (r.slug && !(await taken(r.slug))) {
    slug = r.slug; // re-approve keeps its link
  } else {
    slug = await uniqueSlug(r.name, taken);
  }
  // Moving to a new slug → unpublish the old one so the link doesn't linger.
  if (r.slug && r.slug !== slug) {
    const old = await s.get(`miner:${r.slug}`, { type: "json" });
    if (old && old.requestId === r.id) await s.delete(`miner:${r.slug}`);
  }
  const approvedAt = Date.now();
  await s.setJSON(`miner:${slug}`, {
    slug, name: r.name, tipWallet: r.tipWallet, degens: r.degens, collection: r.collection || "",
    approvedAt, requestId: r.id,
  });
  r.status = "approved";
  r.slug = slug;
  r.decidedAt = approvedAt;
  await s.setJSON(`req:${id}`, r);
  return json({ ok: true, status: r.status, slug, url: liveUrl(request, slug) });
}

export default async (request) => {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const admin = url.searchParams.get("admin");
    if (admin != null) {
      if (!isAdmin(admin)) return json({ error: "unauthorized" }, 401);
      return json({ requests: await listRequests(store()), operator: OPERATOR(), feeOre: FEE_ORE() });
    }
    const id = url.searchParams.get("id");
    if (!id || !/^[a-z0-9]{4,32}$/i.test(id)) return json({ error: "bad request" }, 400);
    const r = await store().get(`req:${id}`, { type: "json" });
    if (!r) return json({ error: "not found" }, 404);
    return json(
      r.status === "approved" && r.slug
        ? { status: r.status, name: r.name, slug: r.slug, url: liveUrl(request, r.slug) }
        : { status: r.status, name: r.name },
    );
  }

  if (request.method !== "POST") return new Response("GET/POST only", { status: 405 });
  let d;
  try { d = await request.json(); } catch { return json({ error: "bad json" }, 400); }

  try {
    if (d && d.action === "decide") return await decide(request, d);

    const v = validateRequest(d);
    if (!v.ok) return json({ error: v.error }, 400);
    const b = v.value;
    const s = store();
    if (await s.get(`sig:${b.paymentSig}`)) return json({ error: "That payment was already used." }, 409);
    // Cross-product replay: the setup fee goes to the same treasury as ORE coin purchases, so the same
    // signature must not buy coins AND a miner. If the payer already filed it as their own coin purchase,
    // refuse. (A coin record under a DIFFERENT buyer is someone else front-running the payer's sig — the
    // payer still owns this payment; it's flagged for review instead.)
    let coinClaim = null;
    try { coinClaim = await getStore({ name: "coin-purchases", consistency: "strong" }).get(`buy:${b.paymentSig}`, { type: "json" }); } catch { coinClaim = null; }
    if (coinClaim && coinClaim.buyer === b.payer) return json({ error: "That payment was already used for a coin purchase." }, 409);

    const operator = OPERATOR();
    const feeOre = FEE_ORE();
    const tx = await getTransaction(b.paymentSig);
    const chk = checkOrePayment(tx, { operator, payer: b.payer, feeOre });
    if (!chk.ok) return json({ error: chk.error }, 402);

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const rec = {
      id, ...b, feeOre, operator, received: chk.received.toString(),
      status: "pending", createdAt: Date.now(),
      ...(coinClaim ? { flag: `same signature was also filed as a coin purchase by ${String(coinClaim.buyer || "?").slice(0, 8)}…` } : {}),
    };
    // Replay guard first, then the record. onlyIfNew makes the claim atomic on runtimes that support
    // conditional writes (two simultaneous submits of one sig → the loser gets 409); older runtimes
    // ignore the option and fall back to the read-check above.
    const claim = await s.set(`sig:${b.paymentSig}`, id, { onlyIfNew: true });
    if (claim && claim.modified === false) return json({ error: "That payment was already used." }, 409);
    await s.setJSON(`req:${id}`, rec);
    return json({ id, status: "pending" });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Server error." }, 500);
  }
};

export const config = { path: "/api/miner-requests" };
