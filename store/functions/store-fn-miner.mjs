// Netlify Function: /api/miner?slug=<slug> — public config for a hosted branded miner (/m/<slug>).
//   → {slug, name, tipWallet, degens[25]{name,image,mint?}}   (404 if unknown / not approved)
// Written by /api/miner-requests on approve (Netlify Blobs "miner-requests", key miner:<slug>).
// Public data only (a tip wallet is a public address). Cached briefly at the edge.
import { getStore } from "@netlify/blobs";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const json = (o, s = 200, cache = "no-store") =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": cache } });

export default async (request) => {
  if (request.method !== "GET") return new Response("GET only", { status: 405 });
  const slug = (new URL(request.url).searchParams.get("slug") || "").toLowerCase();
  if (!SLUG_RE.test(slug)) return json({ error: "bad slug" }, 400);
  const m = await getStore({ name: "miner-requests", consistency: "strong" }).get(`miner:${slug}`, { type: "json" });
  if (!m) return json({ error: "not found" }, 404, "public, max-age=15");
  return json(
    { slug: m.slug, name: m.name, tipWallet: m.tipWallet, degens: m.degens },
    200,
    "public, max-age=60, stale-while-revalidate=300",
  );
};

export const config = { path: "/api/miner" };
