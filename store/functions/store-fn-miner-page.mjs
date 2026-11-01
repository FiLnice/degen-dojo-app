// Netlify Function: a hosted branded miner's page at /m/:slug
//
// The one store page other sites may frame, so a collection can put its miner on its own website. _headers forbids framing on
// every static file and can't be relaxed for one path, but it doesn't reach functions, so this serves the same /mine.html with
// its own headers. The page then reads the slug from the URL and loads the collection from /api/miner?slug=.
import { limited } from "./store-ratelimit-core.mjs";
import { MINER_EMBED_CSP } from "./csp.mjs";

// As every other store page, except frame-ancestors, and no X-Frame-Options (it would forbid the framing again).
const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": MINER_EMBED_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "public, max-age=0, must-revalidate",   // as /mine: a new deploy's chunks must be picked up at once
};

export default async (request) => {
  const blocked = limited(request, "miner-page", 120); if (blocked) return blocked;   // 120 / minute / IP (DD-04)
  try {
    const page = await fetch(new URL("/mine.html", request.url));
    if (!page.ok) throw new Error(String(page.status));
    return new Response(await page.text(), { status: 200, headers: HEADERS });
  } catch {
    return new Response("temporarily unavailable", { status: 503 });
  }
};

export const config = { path: ["/m/:slug", "/m/:slug/"] };
