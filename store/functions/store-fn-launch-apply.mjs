// Netlify Function: /api/launch-apply — launchpad application intake.
//   POST { name, supply, price, art, site, x, discord, wallet, milestones, notes }
//        → validates + stores the application in Netlify Blobs. No funds, no auth needed.
//   GET  ?key=<ADMIN_KEY>            → list all applications (for you to review).
// Env: ADMIN_KEY (to read the list). Storage: Netlify Blobs (provided by the runtime).
import { getStore } from "@netlify/blobs";

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
const store = () => getStore({ name: "launch-apps", consistency: "strong" });
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

export default async (request) => {
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (url.searchParams.get("key") !== process.env.ADMIN_KEY || !process.env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
    const s = store();
    const { blobs } = await s.list();
    const apps = [];
    for (const b of blobs) { const r = await s.get(b.key, { type: "json" }); if (r) apps.push(r); }
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
  const key = rec.at + "-" + wallet.slice(0, 8);
  await store().setJSON(key, rec);
  return json({ ok: true });
};

export const config = { path: "/api/launch-apply" };
