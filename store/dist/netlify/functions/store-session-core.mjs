// Shared, dependency-free auth primitives for the store's Netlify functions.
//
//   sessionSecret()          → SESSION_SECRET if it is set and ≥ 32 chars, else null. NEVER falls back
//                              to ADMIN_KEY (separation of duties: the admin key must not be able to
//                              mint player sessions) and never to a hard-coded dev secret.
//   sessionReady()           → true when a usable SESSION_SECRET is configured.
//   issueToken(wallet, exp)  → "wallet.exp.hmac" (same wire format as before) or null if not configured.
//   checkToken(token)        → wallet if the token is genuine and unexpired, else null (also null when
//                              SESSION_SECRET is missing — fail closed, never "accept anything").
//   keyMatches(given, want)  → constant-time admin-key compare. false when `want` is unset/empty, so a
//                              missing env var can never be matched (not even by "", "\0" or "%00").
//   adminKeyOk(given, ...envNames) → keyMatches against the first env var in the list that is set.
//   adminRequestOk(request, ...envNames) → the same, with the key taken ONLY from "Authorization: Bearer <key>".
//   sessionUnavailable(headers) → the 503 Response auth/play return when SESSION_SECRET isn't configured.
//   siwsText / siwsParse / siwsMatches / signedMessageText → Sign-In With Solana texts (auth + preacher desk),
//                              incl. accepting a wallet-built solana:signIn text only when its fields are exactly ours.
//   fetchSiteOk(request)     → false when the browser says the call came from another site (Sec-Fetch-Site).
//
// Imported by store-fn-auth.mjs (issues tokens) and store-fn-play.mjs (accepts them), plus the admin-gated
// functions. Copied next to them by build-store-deploy.mjs.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_LEN = 32;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  return typeof s === "string" && s.length >= MIN_SECRET_LEN ? s : null;
}
export const sessionReady = () => sessionSecret() !== null;

const mac = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");

export function issueToken(wallet, exp) {
  const secret = sessionSecret();
  if (!secret || !ADDR_RE.test(String(wallet || "")) || !Number.isFinite(exp)) return null;
  const body = wallet + "." + exp;
  return body + "." + mac(secret, body);
}

export function checkToken(token, now = Date.now()) {
  const secret = sessionSecret();
  if (!secret || !token || typeof token !== "string" || token.length > 200) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i), got = token.slice(i + 1);
  const parts = body.split(".");
  if (parts.length !== 2) return null;
  const [wallet, expStr] = parts;
  if (!ADDR_RE.test(wallet) || !/^\d{1,16}$/.test(expStr)) return null;
  const want = mac(secret, body);
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  if (now > Number(expStr)) return null;
  return wallet;
}

// Hash both sides first so the compare is constant-time AND doesn't leak the key's length.
export function keyMatches(given, want) {
  if (typeof want !== "string" || want.length === 0) return false;
  if (typeof given !== "string" || given.length === 0) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(want, "utf8").digest();
  return timingSafeEqual(a, b);
}
export function adminKeyOk(given, ...envNames) {
  const name = envNames.find((n) => typeof process.env[n] === "string" && process.env[n].length > 0);
  return name ? keyMatches(given, process.env[name]) : false;
}

// The admin key travels ONLY in the `Authorization: Bearer <key>` header — never in the URL (query strings end up
// in CDN / function / proxy logs) and never in a request body. Admin pages keep it in memory for the page's life.
export function bearerKey(request) {
  const h = (request && request.headers && request.headers.get && request.headers.get("authorization")) || "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h.trim());
  return m ? m[1] : "";
}
/** true when the request carries a matching admin key in its Authorization header (constant-time compare). */
export const adminRequestOk = (request, ...envNames) => adminKeyOk(bearerKey(request), ...envNames);

// ── Sign-In With Solana (the Wallet Standard `solana:signIn` layout) ──────────────────────────────────────
// Both signed texts (game sign-in at /api/auth, preacher desk at /api/preacher) use EXACTLY this layout, so a
// wallet can sign them either way:
//   • solana:signIn  — the wallet builds the text from the fields and itself checks `domain` against the page that
//                      asks (a phishing site can't relay our nonce to the victim's wallet without a warning);
//   • signMessage    — the fallback; wallets that detect the SIWS layout still warn on a foreign site.
// The server never trusts client text: it rebuilds the fields from its own stored record and only accepts a
// wallet-built text whose fields are those exact values (siwsMatches).
// f = { domain, address, statement, uri, version, chainId, nonce, issuedAt, expirationTime, requestId? }
export function siwsText(f) {
  let m = `${f.domain} wants you to sign in with your Solana account:\n${f.address}`;
  if (f.statement) m += `\n\n${f.statement}`;
  const lines = [];
  if (f.uri) lines.push(`URI: ${f.uri}`);
  if (f.version) lines.push(`Version: ${f.version}`);
  if (f.chainId) lines.push(`Chain ID: ${f.chainId}`);
  if (f.nonce) lines.push(`Nonce: ${f.nonce}`);
  if (f.issuedAt) lines.push(`Issued At: ${f.issuedAt}`);
  if (f.expirationTime) lines.push(`Expiration Time: ${f.expirationTime}`);
  if (f.requestId) lines.push(`Request ID: ${f.requestId}`);
  if (lines.length) m += `\n\n${lines.join("\n")}`;
  return m;
}
const SIWS_KEYS = { "URI": "uri", "Version": "version", "Chain ID": "chainId", "Nonce": "nonce", "Issued At": "issuedAt", "Expiration Time": "expirationTime", "Request ID": "requestId" };
// Strict parse of a SIWS text → fields, or null (unknown field such as Not Before / Resources, duplicate field, bad layout).
export function siwsParse(text) {
  if (typeof text !== "string" || text.length > 2000) return null;
  const m = /^(\S+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})(?:\n\n([^\n]+))?\n\n([\s\S]+)$/.exec(text);
  if (!m) return null;
  const out = { domain: m[1], address: m[2], statement: m[3] || "" };
  for (const line of m[4].split("\n")) {
    const i = line.indexOf(": "); if (i < 0) return null;
    const k = SIWS_KEYS[line.slice(0, i)]; if (!k || k in out) return null;
    out[k] = line.slice(i + 2);
  }
  return out;
}
// Did the wallet sign OUR request? Exact text, or a wallet-built text whose fields equal ours (timestamps may lose
// their milliseconds, the chain id may come back as "solana:mainnet", a URI may gain a trailing slash).
export function siwsMatches(text, f) {
  if (text === siwsText(f)) return true;
  const p = siwsParse(text); if (!p) return false;
  const sameTime = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1000; };
  const chain = (c) => String(c || "").replace(/^solana:/, "");
  return p.domain === f.domain && p.address === f.address && p.statement === (f.statement || "")
    && String(p.uri || "").replace(/\/$/, "") === String(f.uri || "").replace(/\/$/, "")
    && p.version === String(f.version) && chain(p.chainId) === chain(f.chainId) && p.nonce === f.nonce
    && sameTime(p.issuedAt, f.issuedAt) && sameTime(p.expirationTime, f.expirationTime)
    && (p.requestId || "") === (f.requestId || "");
}
// A wallet-built signed message arrives base64-encoded; → its UTF-8 text, or null when absent/oversized/not text.
export function signedMessageText(b64) {
  if (typeof b64 !== "string" || !b64 || b64.length > 2800 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(b64, "base64")); } catch { return null; }
}
// Defence in depth next to the Origin check: a browser that sends Sec-Fetch-Site must call from our own page.
// (Absent header — older Safari, server-side tools — falls through to the Origin/Referer check.)
export function fetchSiteOk(request) {
  const s = (request && request.headers && request.headers.get && request.headers.get("sec-fetch-site")) || "";
  return !s || s.toLowerCase() === "same-origin";
}

export function sessionUnavailable(headers = {}) {
  return new Response(JSON.stringify({ error: "Sign-in is temporarily unavailable (server not configured)." }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
