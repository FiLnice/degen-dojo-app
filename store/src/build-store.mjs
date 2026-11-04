// ============================================================================
//  Degen Dojo — build the STORE page (the Pagoda, owner 2026-11-03; was "the Tower") from indexed listings.
//
//  Injects scripts/listings.json into scripts/store-template.html and writes a
//  standalone page. Run the indexer first (or pass --index to chain it).
//
//    node scripts/build-store.mjs            -> scripts/store.html
//    node scripts/build-store.mjs --index    -> re-index listings, then build
//    node scripts/build-store.mjs --open     -> also copy to site-build/store/
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { ddStats } from "./lore-maps.mjs";
import { jsonForScript } from "./html-safe.mjs";
import { CARD_V } from "./keeper-mint-layout.mjs";
import { BELTS, beltOf, TORN_V } from "./belts.mjs";
import { isCrackedCard } from "./belt-web.mjs";

const ROOT = "C:/Users/sazei/Documents/DEGEN DOJO/BULKITOR/bulkitor";
const TEMPLATE = `${ROOT}/scripts/store-template.html`;
const DATA = `${ROOT}/scripts/listings.json`;
const OUT = `${ROOT}/scripts/store.html`;

// The same enrichment the explore/framed pages show: per-fighter special move
// (from the founders' D table), rank-based stats, the long diary and the short
// quote. Keyed by mint AND number, so a listing resolves either way.
const STATS = ddStats();
const MINT2NUM = (() => { try { return JSON.parse(readFileSync(`${ROOT}/scripts/mint-to-num.json`, "utf8")); } catch { return {}; } })();
// CARD NUMBERS (owner 2026-10-29): display + links only (Framed #1–#42, Mint #43–#597, cracked the rest). `number` above stays the old id
// for every data lookup; the live map (dd-states.js) overrides this build-time copy after a repair.
const CARDNO = (() => { try { const b = JSON.parse(readFileSync(`${ROOT}/scripts/card-numbers.json`, "utf8")).byMint || {}; return Object.fromEntries(Object.entries(b).filter(([, v]) => v && v.no != null).map(([m, v]) => [m, v.no])); } catch { return {}; } })();
// listings.json keeps the picture links from when it was indexed and --nofetch reuses them: point each at the card's
// current condition and cache key, or a re-rendered or repaired card shows its old picture from cache. A cracked piece is Belt
// Torn: its picture is its torn card, degen/card-cracked/<mint>.png?v=TORN_V (owner 2026-11-04: no plain OG art alone).
const CARD_KIND = (() => { try { return JSON.parse(readFileSync(`${ROOT}/scripts/card-numbers.json`, "utf8")).byMint || {}; } catch { return {}; } })();
const freshCard = (u) => String(u || "").replace(/degen\/card(?:-cracked)?\/([1-9A-HJ-NP-Za-km-z]{32,44})\.png(?:\?[\w=.-]*)?/, (all, mint) =>
  !CARD_KIND[mint] ? all : CARD_KIND[mint].kind === "cracked" ? `degen/card-cracked/${mint}.png?v=${TORN_V}` : `degen/card/${mint}.png?v=${CARD_V}`);
// Mints that must NEVER appear in the Degen store: demons (now in Demon Dojo). They share
// character NAMES with real degens (e.g. "Teary Goro"), so a name-level filter won't do —
// exclude them by MINT, or their cardless copies leak into a degen floor and render raw
// (demon) art. Derived from the on-chain race cache. The Senseis are cards, so they stay in.
const CARDLESS_RACES = new Set(["demons", "oni senseis"]);
const CARDLESS_MINTS = (() => {
  try {
    const c = JSON.parse(readFileSync(`${ROOT}/scripts/claim-onchain-cache.json`, "utf8"));
    return Object.values(c).filter((v) => v.mint && CARDLESS_RACES.has(String(v.race || "").toLowerCase())).map((v) => v.mint);
  } catch { return []; }
})();
const CARDLESS_SET = new Set(CARDLESS_MINTS);
// Nov 2 (owner 2026-10-24): the Demons + Oni Senseis join Degen Dojo as cards. Their listings always stay in the data;
// the page drops them from CARDLESS_MINTS from Nov 2 (or ?labels=new) and shows their card.
const DEMON_RACES = new Set(["demons", "oni senseis"]);
const DEMON_MINTS = (() => {
  try {
    const c = JSON.parse(readFileSync(`${ROOT}/scripts/claim-onchain-cache.json`, "utf8"));
    return Object.values(c).filter((v) => v.mint && DEMON_RACES.has(String(v.race || "").toLowerCase())).map((v) => v.mint);
  } catch { return []; }
})();
const DEMON_SET = new Set(DEMON_MINTS);

// Trait emoji come from the site's lore explorer (site-template.html) so the two
// surfaces always agree. Pulled at build time rather than copied.
const TRAIT_EMOJI = (() => {
  const tpl = readFileSync(`${ROOT}/scripts/site-template.html`, "utf8");
  const grab = (name) => {
    const at = tpl.indexOf(`const ${name}=`);
    if (at < 0) return {};
    const s = tpl.indexOf("{", at);
    let depth = 0, e = -1;
    for (let i = s; i < tpl.length; i++) { const c = tpl[i]; if (c === "{") depth++; else if (c === "}" && --depth === 0) { e = i + 1; break; } }
    try { return JSON.parse(tpl.slice(s, e)); } catch { return {}; }
  };
  return { cat: grab("TRAIT_EMOJIS"), val: grab("TRAIT_ITEM_EMOJIS") };
})();

function dossier(mint) {
  const num = MINT2NUM[mint];
  const st = STATS[mint] || STATS[String(num)] || null;
  return {
    stats: st ? { attack: st.a, defence: st.d, hitpoints: st.h, smdamage: st.s } : null,
    number: num ?? null,
    cardNo: CARDNO[mint] ?? null,
  };
}

if (process.argv.includes("--index")) {
  execSync("node scripts/index-listings.mjs", { cwd: ROOT, stdio: "inherit" });
}
if (!existsSync(DATA)) {
  console.error("No listings.json — run: node scripts/index-listings.mjs");
  process.exit(1);
}

const data = JSON.parse(readFileSync(DATA, "utf8"));
// THE PAGODA = ONE FLOOR PER BELT, six (owner 2026-11-03): Red at the summit … White at the ground, every Degen Dojo card,
// listed or held. A card's belt = belts.mjs beltOf on its downloaded metadata (run download-metadata.mjs first), so the rules
// hold before and after the S3 Belt rewrite (an old Brown → Purple, a 1/1 → Black). Belt Torn (a cracked piece: Belt Torn / None,
// the torn picture or Condition Cracked) stays off the Pagoda as -1; the page lifts one repaired since the build to the White
// floor by itself (dd-states.js). /market is not touched. Fails closed: no metadata, no build.
const META = "C:/Users/sazei/Documents/DEGEN DOJO/BULKITOR/degen-dojo-metadata";
const BELT_OF = {};   // first 8 chars of the mint → index in BELTS
{
  let manifest = null; try { manifest = JSON.parse(readFileSync(`${META}/_manifest.json`, "utf8")); } catch {}
  if (!Array.isArray(manifest) || !manifest.length) { console.error(`${META}/_manifest.json unreadable — run node scripts/download-metadata.mjs first; nothing built.`); process.exit(1); }
  let none = 0;
  for (const e of manifest) {
    let j = null; try { j = JSON.parse(readFileSync(e.file, "utf8")); } catch {}
    const at = (j && j.attributes) || [];
    if (!at.some((a) => a.trait_type === "Belt" || a.trait_type === "Condition")) { none++; continue; }
    const files = ((j.properties && j.properties.files) || []).map((f) => f && (f.uri || f));
    const key = beltOf(at, { cracked: isCrackedCard(at, j.image, ...files) });
    BELT_OF[e.mint.slice(0, 8)] = key === "none" ? -1 : BELTS.findIndex((b) => b.key === key);
  }
  if (none) console.warn(`  ${none} cards in the metadata have no Belt trait — they stay off the Pagoda`);
}
// What the page needs of belts.mjs: name, title, colours, plus the text ink that reads best on the belt (dark or light;
// the black belt writes in its gold) and the light colour of its lanterns and windows (the black belt glows gold).
const lum = (hex) => { const c = hex.slice(1).match(/../g).map((h) => { const v = parseInt(h, 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const PAGODA_BELTS = BELTS.map((b) => ({ key: b.key, name: b.name, title: b.title, base: b.base, hi: b.hi, lo: b.lo,
  ink: b.key === "black" ? "#f3d889" : (lum(b.base) + 0.05) / 0.05 >= 1.05 / (lum(b.base) + 0.05) ? "#22170f" : "#fff3d6",
  glow: b.key === "black" ? "#e8b84b" : b.base }));
const pagodaListings = data.listings;
const charOf = (l) => ((l.attributes || []).find((a) => a.trait_type === "Character") || {}).value || l.name || "Unknown";
const listedBy = new Map();
for (const l of pagodaListings) { const c = charOf(l); if (!listedBy.has(c)) listedBy.set(c, []); listedBy.get(c).push(l); }
const characters = (data.characters || []).map((c) => {
  const items = listedBy.get(c.character) || [], unlisted = c.unlisted || [];
  return { ...c, image: freshCard(c.image), unlisted, supply: items.length + unlisted.length, listedCount: items.length,
    floorAllIn: items.length ? Math.min(...items.map((l) => l.priceAllIn)) : null };
}).filter((c) => c.supply > 0);
const minOf = (k) => (pagodaListings.length ? Math.min(...pagodaListings.map((l) => l[k])) : null);
console.log(`Pagoda: ${PAGODA_BELTS.map((b, i) => `${b.name} ${Object.values(BELT_OF).filter((x) => x === i).length}`).join(" · ")} · Torn (off the Pagoda) ${Object.values(BELT_OF).filter((x) => x === -1).length} · ${pagodaListings.length} listed`);
// Only what the page needs — keep the served payload lean.
const slim = {
  updatedAt: data.updatedAt,
  supply: characters.reduce((s, c) => s + c.supply, 0),
  listedCount: pagodaListings.length,
  floorPrice: minOf("price"),
  floorPriceAllIn: minOf("priceAllIn"),
  sources: pagodaListings.reduce((o, l) => ((o[l.source] = (o[l.source] || 0) + 1), o), {}),
  characters,
  // Demons always in the data: the page hides them (CARDLESS_MINTS) until Nov 2 by itself, so no re-upload then.
  listings: pagodaListings.filter((l) => !CARDLESS_SET.has(l.mint) || DEMON_SET.has(l.mint)).map((l) => ({
    mint: l.mint, name: l.name, image: freshCard(l.image), attributes: l.attributes,
    externalUrl: l.externalUrl || "",
    source: l.source, price: l.price, priceAllIn: l.priceAllIn,
    royaltyBps: l.royaltyBps, royaltySol: l.royaltySol, takerFeeSol: l.takerFeeSol,
    seller: l.seller, tradeState: l.tradeState,
    // everything the buy transaction needs, straight from on-chain state
    creators: (l.creators || []).map((c) => c.address),
    sellerReferral: l.sellerReferral || null,
    tokenAccount: l.tokenAccount || null,
    ...dossier(l.mint),
  })),
};

const withStats = slim.listings.filter((l) => l.stats).length;

const template = readFileSync(TEMPLATE, "utf8");
for (const ph of ["__STORE_DATA__", "__TRAIT_EMOJI__", "__CARDLESS_MINTS__", "__DEMON_MINTS__", "__BELTS__", "__BELT_OF__"]) {
  if (!template.includes(ph)) { console.error(`Template is missing the ${ph} placeholder.`); process.exit(1); }
}
// JSON is injected as a JS literal: escape < > & U+2028/9 (html-safe.mjs) so no NFT string can close
// the block, and splice with FUNCTION replacers — a string replacement would expand "$'" / "$&" inside
// an NFT name and re-inject template text (incl. a raw </script>) into the page.
const safe = (o) => jsonForScript(o);
writeFileSync(
  OUT,
  template
    .replace("__STORE_DATA__", () => safe(slim))
    .replace("__TRAIT_EMOJI__", () => safe(TRAIT_EMOJI))
    .replace("__CARDLESS_MINTS__", () => safe(CARDLESS_MINTS))
    .replace("__DEMON_MINTS__", () => safe(DEMON_MINTS))
    .replace("__BELTS__", () => safe(PAGODA_BELTS))
    .replace("__BELT_OF__", () => safe(BELT_OF)),
);

console.log(`Built ${OUT}`);
console.log(`  ${slim.listedCount} listings · floor ${slim.floorPriceAllIn} ◎ all-in · ${Object.entries(slim.sources).map(([k, v]) => `${v} ${k}`).join(", ")}`);
console.log(`  ${slim.characters.length} chambers (${slim.characters.filter((c) => c.listedCount).length} with stock, ${slim.characters.filter((c) => !c.listedCount).length} faded)`);
console.log(`  dossiers: ${withStats}/${slim.listedCount} stat lines`);

if (process.argv.includes("--open")) {
  const dir = `${ROOT}/scripts/site-build/store`;
  mkdirSync(dir, { recursive: true });
  copyFileSync(OUT, `${dir}/index.html`);
  console.log(`  → ${dir}/index.html`);
}
