// Build guard: refuse to zip a deploy folder that contains a secret. The builds (build-all.mjs + build-site.mjs for
// degendojo.xyz, build-store-deploy.mjs for the store) call assertNoSecrets(dir) right before zipping, and
// assertZipClean(zip) on the finished zip (what Netlify actually receives). Prints only file + line, never the value.
//
// Security review 2026-10-23 (L1): the first version only knew api-key= URLs, AWS keys, PEM blocks and one-line
// 64-number arrays. It now also catches base58 / hex 64-byte secret keys, pretty-printed keypair arrays (whole-file
// scan), Telegram bot tokens, Discord webhooks, apiKey/secret/token assignments, .env-style SECRET= lines, and
// refuses key files by NAME (keystores, .p12/.pem/.key, .env*, *keypair*.json) whatever their content.
import { readdirSync, readFileSync, statSync, rmSync } from "fs";
import { join, extname, basename } from "path";
import { inflateRawSync } from "zlib";

const TEXT = new Set([".html", ".js", ".mjs", ".cjs", ".json", ".css", ".txt", ".toml", ".xml", ".map", ".md", ".yml", ".yaml", ".env", ".ts", ".tsx", ""]);
const B58 = "1-9A-HJ-NP-Za-km-z";
// a run that is NOT part of a longer base64/base58 blob (JPEG/PNG data URIs are long base64 runs — the edges keep them out)
const edge = (core) => new RegExp(`(?<![A-Za-z0-9+/=_-])${core}(?![A-Za-z0-9+/=_-])`);
const LINE_PATTERNS = [
  ["RPC/API key in a URL", /api[-_]?key=[A-Za-z0-9-]{16,}/i],
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["base58 64-byte secret key", edge(`[${B58}]{86,88}`), (m, line) => !/(\/tx\/|signature|[?&]sig=|"sig"|tx_?sig)/i.test(line)],   // tx signatures are the same shape
  ["hex 64-byte secret key", edge("[0-9a-fA-F]{128}")],
  ["Telegram bot token", /(?<![A-Za-z0-9_-])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/],
  ["Discord webhook", /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/i],
  ["secret assignment", /\b(api[_-]?key|apikey|client[_-]?secret|secret[_-]?key|auth[_-]?token|access[_-]?token|bot[_-]?token|private[_-]?key|session[_-]?secret|admin[_-]?key)\b\s*["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i,
    (m) => { const v = m[2]; return !new RegExp(`^[${B58}]{32,44}$`).test(v) && !/^(your|xxx|change|example|placeholder|<)/i.test(v) && !/[{}$]/.test(v); }],
  [".env secret line", /^\s*(export\s+)?[A-Z][A-Z0-9_]*(SECRET|_KEY|TOKEN|PASSWORD|PRIVATE)[A-Z0-9_]*\s*=\s*["']?([^\s"'#]{12,})/,
    (m) => !/^[A-Z0-9_,]+$/.test(m[3])],   // a list of variable NAMES (e.g. SECRETS_SCAN_OMIT_KEYS) is not a secret
];
// whole-file shapes (span lines): a 64-number keypair array, pretty-printed or not
const FILE_PATTERNS = [
  ["64-byte secret key array", /\[\s*(\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
];
// never ship these at all, whatever is inside
const BAD_NAME = /(\.(jks|keystore|p12|pfx|pem|key)$)|(^\.env)|(keypair[^/]*\.json$)|(^id\.json$)|(cosigner[^/]*\.json$)/i;

function scanText(label, text, hits) {
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (l.length > 2_000_000) return;   // a single giant minified/base64 line is still scanned by FILE_PATTERNS below
    for (const [what, re, ok] of LINE_PATTERNS) { const m = l.match(re); if (m && (!ok || ok(m, l))) hits.push(`${label}:${i + 1}  ${what}`); }
  });
  for (const [what, re] of FILE_PATTERNS) if (re.test(text)) hits.push(`${label}  ${what}`);
}

export function assertNoSecrets(dir) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(d, name), st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (BAD_NAME.test(name)) { hits.push(`${p}  key/secret file by name`); continue; }
      if (!TEXT.has(extname(name).toLowerCase()) || st.size > 20 * 1024 * 1024) continue;
      scanText(p, readFileSync(p, "utf8"), hits);
    }
  };
  walk(dir);
  if (hits.length) throw new Error(`SECRET FOUND in the deploy folder — not zipping:\n  ${hits.slice(0, 20).join("\n  ")}`);
}

// Minimal ZIP reader (stored + deflate entries, via the central directory) — enough for the zips zip-forward.ps1 writes.
function* zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory)");
  let n = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16);
  while (n-- > 0) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    off += 46 + nlen + xlen + clen;
    const dataAt = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    yield { name, usize, read: () => { const raw = buf.subarray(dataAt, dataAt + csize); return method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null; } };
  }
}

// Scan the FINISHED zip (what is uploaded). On a hit the zip is deleted so it can't be dragged onto Netlify by mistake.
export function assertZipClean(zipPath) {
  const hits = [];
  for (const e of zipEntries(readFileSync(zipPath))) {
    const name = basename(e.name);
    if (/(^|\/)(node_modules|\.git)\//.test(e.name)) continue;
    if (BAD_NAME.test(name)) { hits.push(`${e.name}  key/secret file by name`); continue; }
    if (!TEXT.has(extname(name).toLowerCase()) || e.usize > 20 * 1024 * 1024) continue;
    const data = e.read(); if (!data) continue;
    scanText(e.name, data.toString("utf8"), hits);
  }
  if (hits.length) {
    try { rmSync(zipPath, { force: true }); } catch {}
    throw new Error(`SECRET FOUND in ${zipPath} — the zip was deleted:\n  ${hits.slice(0, 20).join("\n  ")}`);
  }
}
