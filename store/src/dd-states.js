// Degen Dojo card states for the store pages that build a card picture from its mint alone (store cases, market
// shelves + drawer, List page, profile). degen/card-states.json — written by crack-batch.mjs and
// keeper-apply-repairs.mjs — lists the Cracked / Mono cards by the first 8 characters of the mint.
//   DDStates.cond(mint) → "Mint" | "Cracked" | "Mono"        DDStates.card(mint) → the card picture to show
// Any <img> already showing degen/card/<mint>.png (directly or through the wsrv.nl resizer) is switched to the cracked
// card once the list arrives, and so is every image added later — pages don't have to wait for it.
(function () {
  // card v8 / cracked v2 = the Nov 2 renders (labels HITPOINTS · POWER, cracked = stats faded) — on from Nov 2
  var NOV2 = Date.now() >= Date.UTC(2026, 10, 2);
  var S3 = "https://degendojo.s3.us-west-1.amazonaws.com/degen/", CARD_V = NOV2 ? "8" : "7", CRACK_V = NOV2 ? "2" : "1";
  var c = {}, m = {}, loaded = false;
  function cond(mint) { var k = String(mint || "").slice(0, 8); return m[k] ? "Mono" : c[k] ? "Cracked" : "Mint"; }
  function card(mint) { return cond(mint) === "Mint" ? S3 + "card/" + mint + ".png?v=" + CARD_V : S3 + "card-cracked/" + mint + ".png?v=" + CRACK_V; }
  var CARD_RE = /degen\/card\/([1-9A-HJ-NP-Za-km-z]{32,44})\.png/;
  function fix(img) {
    var src = img.getAttribute("src") || "", plain = src;
    try { plain = decodeURIComponent(src); } catch (e) {}
    var hit = CARD_RE.exec(plain); if (!hit || cond(hit[1]) === "Mint") return;
    var cracked = S3 + "card-cracked/" + hit[1] + ".png?v=" + CRACK_V;
    // through the resizer: swap the inner url, keep its size options
    img.setAttribute("src", plain === src ? cracked : src.replace(/([?&]url=)[^&]*/, "$1" + encodeURIComponent(cracked)));
  }
  function sweep(root) { if (!loaded) return; (root.querySelectorAll ? root.querySelectorAll("img") : []).forEach(fix); if (root.tagName === "IMG") fix(root); }
  var ready = fetch(S3 + "card-states.json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      ((j && j.c) || []).forEach(function (k) { c[k] = 1; }); ((j && j.m) || []).forEach(function (k) { m[k] = 1; });
      loaded = true; sweep(document);
    })
    .catch(function () { loaded = true; });
  new MutationObserver(function (list) {
    if (!loaded) return;
    list.forEach(function (x) {
      if (x.type === "attributes") fix(x.target);
      else x.addedNodes.forEach(function (n) { if (n.nodeType === 1) sweep(n); });
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  window.DDStates = { ready: ready, cond: cond, card: card };
})();
