// Build guard: refuse to zip a deploy folder that contains a secret. Both builds (build-all.mjs for degendojo.xyz,
// build-store-deploy.mjs for the store) call it right before zipping. Prints only file + line, never the value.
import { readdirSync, readFileSync, statSync } from "fs";
import { join, extname } from "path";

const TEXT = new Set([".html", ".js", ".mjs", ".cjs", ".json", ".css", ".txt", ".toml", ".xml", ".map", ""]);
const PATTERNS = [
  ["RPC/API key in a URL", /api[-_]?key=[A-Za-z0-9-]{16,}/i],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["64-byte secret key array", /\[\s*(\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
];

export function assertNoSecrets(dir) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(d, name), st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!TEXT.has(extname(name).toLowerCase()) || st.size > 20 * 1024 * 1024) continue;
      const lines = readFileSync(p, "utf8").split(/\r?\n/);
      lines.forEach((l, i) => { for (const [what, re] of PATTERNS) if (re.test(l)) hits.push(`${p}:${i + 1}  ${what}`); });
    }
  };
  walk(dir);
  if (hits.length) throw new Error(`SECRET FOUND in the deploy folder — not zipping:\n  ${hits.slice(0, 20).join("\n  ")}`);
}
