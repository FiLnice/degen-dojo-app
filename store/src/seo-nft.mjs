// ============================================================================
//  Per-mint SEO pages — the PURE renderer + gatherer (no fs, no deps).
//
//  renderNftPage(data) → full standalone HTML (SEO meta, OG, JSON-LD). gatherNft
//  does the chain reads through injected resolver/DAS fns and an injected rarity
//  table, so it runs identically in the Netlify function (scripts/store-fn-nft.mjs)
//  and in the node CLI (scripts/seo-nft-cli.mjs). Keeping this file import-clean
//  is what lets the function bundle on a drag-and-drop deploy (no web3.js pulled in).
//
//  Degen Dojo mints get real per-trait rarity + a read; outside collections get
//  name, image, price and trait values.
// ============================================================================
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const thumb = (u, w = 700) => u ? `https://wsrv.nl/?url=${encodeURIComponent(u)}&w=${w}&h=${w}&fit=cover&output=webp` : "";

// A generic, per-value rarity sentence — real numbers make each page non-thin.
function rarityLine(a) {
  if (a.pct == null) return "";
  const band = a.pct < 1 ? "a chase trait" : a.pct < 3 ? "rare" : a.pct < 10 ? "uncommon" : a.pct < 30 ? "common" : "part of the base look";
  return `${band} — ${a.pct}% of the collection, #${a.rank} rarest of ${a.catSize} in ${a.trait_type}.`;
}

/** PURE — data → full standalone HTML page (inline CSS, SEO meta, JSON-LD). */
export function renderNftPage(d) {
  const title = `${d.name}${d.collectionName ? " · " + d.collectionName : ""} — own it in ORE`;
  const rarest = (d.attributes || []).filter((a) => a.pct != null).sort((a, b) => a.pct - b.pct)[0];
  const desc = d.isDD
    ? `${d.name}, a Degen Dojo fighter${rarest ? ` — rarest trait ${rarest.value} at ${rarest.pct}%` : ""}. Rarity and a read on every trait, priced in ORE. ${d.price ? `Listed at ${d.price} SOL.` : "Not currently listed."}`
    : `${d.name}${d.collectionName ? " from " + d.collectionName : ""}. ${d.price ? `Listed at ${d.price} SOL — buy it in ORE on the Degen Dojo market.` : "Buy any Solana NFT in ORE on the Degen Dojo market."}`;
  const buyUrl = `https://store.degendojo.xyz/?buy=${d.mint}`;
  const ld = {
    "@context": "https://schema.org", "@type": "Product",
    name: d.name, image: d.image || undefined,
    description: desc, brand: d.collectionName || "Degen Dojo",
    ...(d.price ? { offers: { "@type": "Offer", price: d.price, priceCurrency: "SOL", availability: "https://schema.org/InStock", url: buyUrl } } : {}),
  };
  const traits = (d.attributes || []).map((a) => `
      <div class="trait${a.pct != null && a.pct < 1 ? " chase" : ""}">
        <div class="th"><span class="tt">${esc(a.trait_type)}</span>${a.pct != null ? `<span class="tr">${a.pct}%</span>` : ""}</div>
        <div class="tv">${esc(a.value)}</div>
        ${a.note ? `<div class="ti">${esc(a.note)}</div>` : (a.pct != null ? `<div class="ti">${esc(rarityLine(a))}</div>` : "")}
      </div>`).join("");

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"/>
<link rel="canonical" href="https://store.degendojo.xyz/nft/${d.mint}"/>
<meta property="og:type" content="product"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(desc)}"/>
${d.image ? `<meta property="og:image" content="${esc(thumb(d.image, 1200))}"/>` : ""}
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:description" content="${esc(desc)}"/>
${d.image ? `<meta name="twitter:image" content="${esc(thumb(d.image, 1200))}"/>` : ""}
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700;900&family=Inter:wght@300;400;500;600&family=Teko:wght@500;600;700&display=swap" rel="stylesheet"/>
<style>
:root{--ink:#0a0a0f;--panel:#16161f;--border:rgba(255,255,255,.08);--gold:#c9973a;--gold-l:#e8b84b;--red:#c0392b;--text:#e8e0d0;--muted:#8a7f6f;}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--ink);color:var(--text);font-family:'Inter',sans-serif;min-height:100vh;
  background-image:radial-gradient(900px 500px at 50% -8%,rgba(192,57,43,.18),transparent 62%),linear-gradient(#0d0b12,#0a0a0f 60%);}
a{color:inherit;}
.top{display:flex;align-items:center;gap:12px;padding:13px 22px;border-bottom:1px solid var(--border);}
.mk{width:34px;height:34px;border-radius:8px;object-fit:cover;box-shadow:0 0 0 1px rgba(201,151,58,.35);}
.brand b{font-family:'Cinzel',serif;font-size:13px;letter-spacing:.16em;}
.wrap{max-width:960px;margin:0 auto;padding:24px 20px 80px;display:grid;grid-template-columns:360px 1fr;gap:30px;align-items:start;}
@media(max-width:780px){.wrap{grid-template-columns:1fr;}}
.rail{position:sticky;top:20px;}
@media(max-width:780px){.rail{position:static;}}
.art{width:100%;aspect-ratio:1;border-radius:14px;object-fit:cover;background:#000;border:1px solid var(--border);box-shadow:0 20px 44px -22px rgba(0,0,0,.85);}
.col{font-family:'Teko',sans-serif;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:14px;}
.name{font-family:'Cinzel',serif;font-weight:900;font-size:28px;line-height:1.05;margin:2px 0 10px;}
.price{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);}
.price .o{font-family:'Cinzel',serif;font-weight:900;font-size:24px;color:var(--gold-l);}
.price .a{font-family:'Teko',sans-serif;font-size:14px;color:var(--muted);}
.buy{display:block;text-align:center;text-decoration:none;margin:16px 0 6px;border-radius:11px;padding:14px 0;font-family:'Cinzel',serif;
  font-size:13px;font-weight:700;letter-spacing:.09em;background:linear-gradient(135deg,#c8962a,#8b6018);color:#0a0814;}
.sec{font-family:'Teko',sans-serif;font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);margin:2px 0 14px;}
.trait{border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:11px;background:var(--panel);}
.trait.chase{border-color:rgba(201,151,58,.5);background:linear-gradient(160deg,rgba(201,151,58,.1),var(--panel));}
.trait .th{display:flex;justify-content:space-between;align-items:baseline;gap:8px;}
.trait .tt{font-family:'Teko',sans-serif;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);}
.trait .tr{font-family:'Cinzel',serif;font-weight:900;font-size:15px;color:var(--gold-l);}
.trait .tv{font-family:'Cinzel',serif;font-weight:900;font-size:17px;margin-top:1px;}
.trait .ti{font-size:13px;line-height:1.55;color:#a99d88;margin-top:6px;}
.lore{border:1px solid var(--border);border-radius:13px;padding:16px 18px;background:linear-gradient(180deg,rgba(192,57,43,.06),var(--panel));margin-bottom:20px;}
.lore .lh{font-family:'Teko',sans-serif;font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);margin-bottom:7px;}
.lore p{font-size:14px;line-height:1.65;color:#cbbfa9;}
.foot{max-width:960px;margin:0 auto;padding:0 20px 40px;font-size:11.5px;color:var(--muted);line-height:1.6;}
</style></head><body>
<div class="top"><img class="mk" src="https://degendojo.xyz/dd-mark.jpg" onerror="this.style.display='none'"/><div class="brand"><b>DEGEN DOJO</b></div></div>
<div class="wrap">
  <div class="rail">
    <img class="art" src="${esc(thumb(d.image, 760))}" alt="${esc(d.name)}" onerror="this.style.opacity=.2"/>
    <div class="col">${esc(d.collectionName || (d.isDD ? "Degen Dojo" : "Solana NFT"))}</div>
    <div class="name">${esc(d.name)}</div>
    ${d.price ? `<div class="price"><span class="o">${d.priceOre ? d.priceOre.toLocaleString("en-US", { maximumFractionDigits: 2 }) + " ◎ ORE" : d.price + " SOL"}</span><span class="a">${d.price} SOL${d.royaltyBps ? " · royalty " + d.royaltyBps / 100 + "%" : ""}</span></div>` : `<div class="price"><span class="a">Not currently listed — last seen on the market.</span></div>`}
    <a class="buy" href="${buyUrl}">${d.price ? "⚔ Own it · pay in ORE" : "Browse the market"}</a>
  </div>
  <div>
    ${d.story ? `<div class="lore"><div class="lh">Who they are</div><p>${esc(d.story)}</p></div>` : ""}
    <div class="sec">${d.isDD ? "Every trait, read deeper" : "Traits"}</div>
    ${traits || '<div class="trait"><div class="ti">No traits on this asset.</div></div>'}
  </div>
</div>
<div class="foot">Rarity computed from live on-chain traits${d.isDD ? " across 2,473 Degen Dojo fighters" : ""}. Prices convert to ORE at the live rate; buying routes an on-chain ORE→SOL swap + purchase. <a href="https://store.degendojo.xyz">The Degen Dojo market →</a></div>
</body></html>`;
}

/** Gather everything a page needs for `mint`. Inject resolver + DAS + rarity so
 *  this stays dependency-free (works in the function and the CLI alike). */
export async function gatherNft(mint, { resolveMagicEden, getAsset, ddCreators = [], rarity = {} }) {
  const das = await getAsset(mint);
  const name = das?.content?.metadata?.name || ("NFT " + mint.slice(0, 4));
  const image = das?.content?.links?.image || das?.content?.files?.[0]?.uri || "";
  const collectionName = (das?.grouping || []).find((g) => g.group_key === "collection")?.collection_metadata?.name || "";
  const creators = (das?.creators || []).map((c) => c.address);
  const isDD = creators.some((c) => ddCreators.includes(c)) || /degen dojo/i.test(collectionName);

  let listing = null;
  try { listing = await resolveMagicEden(mint); } catch {}

  const rar = isDD ? rarity : {};
  const attributes = (das?.content?.metadata?.attributes || []).map((a) => {
    const r = rar[`${a.trait_type}|${a.value}`];
    return { trait_type: a.trait_type, value: a.value, ...(r ? { pct: r.pct, rank: r.rank, catSize: r.catSize } : {}) };
  }).sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999));

  return {
    mint, name, image, collectionName, isDD,
    price: listing ? listing.price : null,
    priceOre: null,
    royaltyBps: (listing && listing.royaltyBps) || das?.royalty?.basis_points || 0,
    attributes,
  };
}
