// Shared Dojo Pot ledger — the ONE place the weekly prize pot is accumulated, so the
// "% into the pot" shown to buyers becomes TRUE and on-chain-verifiable instead of a
// manual number. Every VERIFIED contribution (a share of each coin purchase, 100% of a
// tip, the Cluck-Fu sweep, …) is tallied here in USD + per-route, per-currency — the exact
// shape the /pot ledger page renders.
//
// Imported by store-verify-core.mjs (adds each verified purchase's pot share) and
// store-fn-draw.mjs (reads the live pot for the prize, archives+resets it on a draw).
import { getStore } from "@netlify/blobs";
import { casUpdate, readWithEtag, putIfMatch, putIfNew, pushId, CasError } from "./store-cas-core.mjs";

// Games economics (owner, 2026-10-23) — every verified coin buy AND every mining tip splits:
//   22% the Pot · 22% the Reserve · 12% operations · 44% preacher pool (the referring preacher's tier takes
//   28 / 36 / 44% of the WHOLE payment; whatever the tier doesn't take, or all 44% when nobody referred, → Reserve).
// Exception: a mining tip with NO preacher goes 100% to the Reserve (no Pot, no ops) — store-verify-core.mjs.
// Royalties never feed the Pot any more (88% Card Vault / 12% ops — store-keeper-core.mjs).
export const POT_FRAC = 0.22;             // the Pot's share of a coin buy / mining tip (what /pot shows as "potPct")
export const LEGACY_POT_FRAC = 0.65;      // records verified before 2026-10-23 (no `split`) gave the Pot 65%
export const GAME_SPLIT = { pot: 22n, ops: 12n, preacherPool: 44n };   // percent; the Reserve gets the rest
// Exact split of a raw token amount (BigInt). `preacherPct` = the locked tier share (0, 28, 36 or 44).
// The Reserve absorbs the preacher pool's unused part and all rounding dust, so the four parts always sum to `raw`.
export function splitGame(raw, preacherPct = 0) {
  raw = BigInt(raw);
  const pct = BigInt(Math.max(0, Math.min(Number(GAME_SPLIT.preacherPool), Math.round(Number(preacherPct) || 0))));
  const pot = (raw * GAME_SPLIT.pot) / 100n, ops = (raw * GAME_SPLIT.ops) / 100n, preacher = (raw * pct) / 100n;
  return { pot, ops, preacher, reserve: raw - pot - ops - preacher };
}
const KEY = "current";
// Recent contribution ids kept INSIDE the pot blob, so "add" and "already added?" are one atomic
// write: a cron run that overlaps another, or resumes after a crash, can never add the same
// signature twice. Carried across the weekly reset. Long-term idempotency is the callers' own
// per-signature records; this window only has to cover minutes.
const APPLIED_MAX = 1000;
const ROUTES = ["coinbuy", "minetip", "royalty", "tip", "cluck", "game", "shelves", "other"];   // "royalty": history only (retired 2026-10-23)
const curKey = (c) => ({ SOL: "sol", ORE: "ore", SKR: "skr" }[c] || null);

function zero() {
  const o = { usd: 0, routes: {}, since: null, updatedAt: null };
  for (const r of ROUTES) o.routes[r] = { sol: 0, skr: 0, ore: 0 };
  return o;
}

function normalize(p) {
  if (!p) return zero();
  const z = zero();
  const routes = { ...z.routes };
  for (const r of ROUTES) routes[r] = { ...z.routes[r], ...((p.routes || {})[r] || {}) };
  return { ...z, ...p, routes };
}
export async function getPot() {
  let raw = await getStore("pot").get(KEY, { type: "json" });
  if (hasRoyalty(raw)) raw = await retireRoyalty();
  const { applied, ...p } = normalize(raw);
  return p;
}

// Royalties stopped feeding the Pot on 2026-10-23, but royalty money booked before that sat in the live pot and rolled
// over (round 1 had no entrants) — the Pot showed ~0.25 SOL that is really Treasury money. Owner 2026-10-25: the Pot
// holds only what the arena brings in. Once: zero the royalty route and take its value out of the pot's USD (all of it
// when nothing else came in; otherwise its value at today's prices, never below 0). Marked, so it never runs twice.
const hasRoyalty = (p) => !!p && !p.royaltyRetiredAt && Object.values((p.routes || {}).royalty || {}).some((v) => +v > 0);
const PRICE_IDS = { sol: "So11111111111111111111111111111111111111112", ore: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", skr: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3" };
async function retireRoyalty() {
  let px = {};
  try { const j = await (await fetch("https://lite-api.jup.ag/price/v3?ids=" + Object.values(PRICE_IDS).join(","))).json();
    for (const [k, m] of Object.entries(PRICE_IDS)) px[k] = +j?.[m]?.usdPrice || 0; } catch {}
  const { value } = await casUpdate(getStore("pot"), KEY, (cur) => {
    if (!hasRoyalty(cur)) return undefined;
    const p = normalize(cur), roy = p.routes.royalty;
    const othersEmpty = Object.entries(p.routes).every(([r, v]) => r === "royalty" || Object.values(v).every((x) => !(+x > 0)));
    const royUsd = (+roy.sol || 0) * (px.sol || 0) + (+roy.ore || 0) * (px.ore || 0) + (+roy.skr || 0) * (px.skr || 0);
    if (!othersEmpty && !(royUsd > 0)) throw new CasError("no prices to take the old royalties out of the pot — try again in a minute");
    p.retiredRoyalty = { ...roy, usd: othersEmpty ? p.usd : Math.min(p.usd, royUsd) };
    p.usd = othersEmpty ? 0 : Math.max(0, p.usd - royUsd);
    p.routes.royalty = { sol: 0, skr: 0, ore: 0 };
    p.royaltyRetiredAt = Date.now();
    return p;
  });
  return value;
}

// Add a verified contribution. `usd` is authoritative for the prize; `currency`+`native`
// fill the transparent per-route breakdown. Atomic (compare-and-swap, so concurrent adds are
// never lost) and, when `id` is given (e.g. "coinbuy:<sig>"), idempotent: a repeat id is a no-op.
export async function addToPot({ usd = 0, currency = null, native = 0, route = "other", id = null }) {
  if (!(usd > 0)) return;
  const { value } = await casUpdate(getStore("pot"), KEY, (cur) => {
    const p = normalize(cur);
    if (id && (p.applied || []).includes(id)) return undefined;   // already counted
    p.usd += usd;
    const rt = p.routes[ROUTES.includes(route) ? route : "other"];
    const k = curKey(currency);
    if (k && rt[k] != null) rt[k] += native || 0;
    p.since = p.since || Date.now();
    p.updatedAt = Date.now();
    if (id) p.applied = pushId(p.applied, id, APPLIED_MAX);
    return p;
  });
  const { applied, ...out } = normalize(value);
  return out;
}

// Run on a draw: snapshot the pot to the round's archive and reset to zero so next week
// accumulates fresh. Returns the snapshot that was paid out. The reset is conditional on the pot
// not having changed since the snapshot was taken, so a contribution landing mid-reset is never
// lost (it is either in this round's snapshot or in next week's pot).
export async function archiveAndResetPot(round) {
  const store = getStore("pot");
  for (let i = 0; i < 10; i++) {
    const { value, etag } = await readWithEtag(store, KEY);
    const { applied, ...snap } = normalize(value);
    await store.setJSON("round:" + round, { ...snap, round, closedAt: Date.now() });
    const fresh = { ...zero(), ...(applied ? { applied } : {}) };
    if (etag ? await putIfMatch(store, KEY, fresh, etag) : await putIfNew(store, KEY, fresh)) return snap;
  }
  throw new CasError("pot busy — retry the draw reset");
}
