// Degen Dojo card states for the store pages that build a card picture from its mint alone (store cases, market
// shelves + drawer, List page, profile). degen/card-states.json — written by crack-batch.mjs and
// keeper-apply-repairs.mjs — lists the Cracked / Faded cards by the first 8 characters of the mint.
//   DDStates.cond(mint) → "Mint" | "Cracked" | "Faded"        DDStates.card(mint) → the picture to show: the card, or for a
//   cracked piece its TORN CARD, degen/card-cracked/<mint>.png?v=TORN_V (Belt Torn — owner 2026-11-04: no plain OG art alone)
//   DDStates.ok() → true once the list arrived (until then, and if it fails, cond() says "Mint" for every card — the Pagoda
//   only trusts cond() when ok() is true)
//   DDStates.no(mint) → the card number (display only)        DDStates.path(mint, id) → "/<no>" (or "/old/<id>")
// Any <img> showing degen/card/<mint>.png (directly or through the wsrv.nl resizer) of a cracked piece is switched to its torn
// card once the list arrives, an old torn picture (another ?v) to today's, and a torn picture of a repaired card to the card; so is
// every image added later — pages don't have to wait for it.
(function () {
  // card v8d / cracked v2d = the new renders (labels HITPOINTS · POWER; cracked keeps its numbers readable; twins' half and
  // half border) — on since the early crack (owner 2026-10-29)
  var NOV2 = Date.now() >= Date.UTC(2026, 9, 29);
  var S3 = "https://degendojo.s3.us-west-1.amazonaws.com/degen/", CARD_V = "9e", TORN_V = "3d";   // TORN_V = belts.mjs TORN_V
  var c = {}, m = {}, loaded = false, okList = false;
  function cond(mint) { var k = String(mint || "").slice(0, 8); return m[k] ? "Faded" : c[k] ? "Cracked" : "Mint"; }
  function card(mint) { return cond(mint) === "Mint" ? S3 + "card/" + mint + ".png?v=" + CARD_V : S3 + "card-cracked/" + mint + ".png?v=" + TORN_V; }
  var CARD_RE = /degen\/card(-cracked)?\/([1-9A-HJ-NP-Za-km-z]{32,44})\.png/;
  function fix(img) {
    var src = img.getAttribute("src") || "", plain = src;
    try { plain = decodeURIComponent(src); } catch (e) {}
    var hit = CARD_RE.exec(plain); if (!hit) return;
    if (cond(hit[2]) === "Mint" && !hit[1]) return;   // a card showing its card: leave it
    var want = card(hit[2]);   // a cracked piece → its torn card; a torn picture of a repaired card → the card
    // through the resizer: swap the inner url, keep its size options. Already right → leave it (no endless src rewrites)
    var next = plain === src ? want : src.replace(/([?&]url=)[^&]*/, "$1" + encodeURIComponent(want));
    if (next !== src && plain.indexOf(want) < 0) img.setAttribute("src", next);
  }
  function sweep(root) { if (!loaded) return; (root.querySelectorAll ? root.querySelectorAll("img") : []).forEach(fix); if (root.tagName === "IMG") fix(root); }
  var ready = fetch(S3 + "card-states.json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      ((j && j.c) || []).forEach(function (k) { c[k] = 1; }); ((j && j.m) || []).forEach(function (k) { m[k] = 1; });
      okList = !!(j && j.c && j.c.length); loaded = true; sweep(document);
    })
    .catch(function () { loaded = true; });
  new MutationObserver(function (list) {
    if (!loaded) return;
    list.forEach(function (x) {
      if (x.type === "attributes") fix(x.target);
      else x.addedNodes.forEach(function (n) { if (n.nodeType === 1) sweep(n); });
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  // CARD NUMBERS (owner 2026-10-29): Framed #1–#42, Mint #43–#597, cracked the rest — degen/card-numbers.json (card-numbers.mjs).
  // DISPLAY + LINKS ONLY: pages keep every data lookup on the old fighter number (id). A page may inline a build-time
  // fallback as window.DD_CARD_NO (mint → no); the live map overrides it, so a repair shows without a rebuild.
  var nos = window.DD_CARD_NO || {};
  var numbersReady = fetch(S3 + "card-numbers.json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      var b = (j && j.byMint) || {};
      for (var k in b) if (b[k] && b[k].no != null) nos[k] = b[k].no;
      try { window.dispatchEvent(new Event("dd-cardno")); } catch (e) {}
    })
    .catch(function () {});
  function no(mint) { var v = nos[mint]; return v == null ? null : v; }
  // the link a card prints / opens: /<no>, or /old/<id> for a card that has no number yet (the old id route never moves)
  function hasNumbers() { for (var k in nos) return true; return false; }   // false until the renumbering is published
  function path(mint, id) { var n = no(mint); if (n != null) return "/" + n; if (id == null || id === "") return ""; return hasNumbers() ? "/old/" + id : "/" + id; }
  window.DDStates = { ready: ready, ok: function () { return okList; }, cond: cond, card: card, no: no, path: path, hasNumbers: hasNumbers, numbersReady: numbersReady };
})();
