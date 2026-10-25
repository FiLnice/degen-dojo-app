// Netlify Function: /api/launch-apply — launchpad application intake.
//   POST { name, supply, price, art, site, x, discord, wallet, milestones, notes }
//        → validates + stores the application in Netlify Blobs. No funds, no auth needed.
//   GET  (Bearer <ADMIN_KEY>)          → list all applications (for you to review).
// Env: ADMIN_KEY (to read the list). Storage: Netlify Blobs (provided by the runtime).
import { limited } from "./store-ratelimit-core.mjs";
import { getStore } from "@netlify/blobs";
import { adminRequestOk } from "./store-session-core.mjs";
import { casUpdate } from "./store-cas-core.mjs";

const DAILY_CAP = 50;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
const store = () => getStore({ name: "launch-apps", consistency: "strong" });
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

export default async (request) => {
  const blocked = limited(request, "launch-apply", 10); if (blocked) return blocked;   // 10 / minute / IP (DD-04)
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (!adminRequestOk(request, "ADMIN_KEY")) return json({ error: "unauthorized" }, 401);
    const s = store();
    const { blobs } = await s.list();
    const apps = [];
    for (const b of blobs) { if (b.key.startsWith("count:")) continue; const r = await s.get(b.key, { type: "json" }); if (r) apps.push(r); }
    apps.sort((a, b) => (b.at || 0) - (a.at || 0));
    return json({ count: apps.length, apps });
  }

  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  let d; try { d = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const name = clip(d && d.name, 80).trim();
  const wallet = clip(d && d.wallet, 44).trim();
  if (!name || !d.supply || !d.price || !d.art || !d.milestones) return json({ error: "missing required fields" }, 400);
  if (!B58.test(wallet)) return json({ error: "team wallet is not a valid Solana address" }, 400);

  const rec = {
    at: Date.now(),
    name,
    supply: clip(d.supply, 20),
    price: clip(d.price, 20),
    art: clip(d.art, 300),
    site: clip(d.site, 200),
    x: clip(d.x, 120),
    discord: clip(d.discord, 200),
    wallet,
    milestones: clip(d.milestones, 2000),
    notes: clip(d.notes, 2000),
    ua: clip(request.headers.get("user-agent"), 200),
  };
  // The intake is unauthenticated, so its store must not grow without bound (review: Blobs stores grow forever): at most
  // DAILY_CAP applications a day in total (a CAS counter, no list() in the request path) and one per team wallet a day
  // (a second one that day replaces the first).
  const day = new Date(rec.at).toISOString().slice(0, 10);
  try {
    const { changed } = await casUpdate(store(), "count:" + day, (c) => ((c?.n || 0) >= DAILY_CAP ? undefined : { n: (c?.n || 0) + 1 }));
    if (!changed) return json({ error: "we've had a lot of applications today — please try again tomorrow, or reach us on X" }, 429);
  } catch { return json({ error: "busy — try again in a minute" }, 503); }
  await store().setJSON("app:" + day + "-" + wallet, rec);
  return json({ ok: true });
};

export const config = { path: "/api/launch-apply" };
