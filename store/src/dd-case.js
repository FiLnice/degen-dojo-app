/* Degen Dojo case for the Market page — the live DD-native ORE/SKR/USDC listings
   (our own AuctionHouse), shown as a case above the external "cases". Self-contained:
   brings its own rpcCall + toast, uses the shared wallet (window.DOJO_WALLET, set by the
   nav wallet wire), window.solanaWeb3 (web3.js) and window.DojoAH (dojo-ah.js). Buy is a
   simulate-first flow; Delist is a single seller signature. Mirrors the store's doBuyDD /
   doDelistDD exactly so behaviour is identical to the old strip. */
(function () {
  var RPC = location.origin + "/api/rpc";
  var DD = [], BUSY = false, META = {}; // META[mint] = {name, img} resolved from DAS
  var ddImg = function (m) { return "https://degendojo.s3.us-west-1.amazonaws.com/degen/img/" + m + ".png"; };
  var assetName = function (a) { return (a && a.content && a.content.metadata && a.content.metadata.name) || ""; };
  var assetImg = function (a) { if (!a) return ""; var c = a.content || {}; return (c.links && c.links.image) || (c.files && c.files[0] && (c.files[0].cdn_uri || c.files[0].uri)) || ""; };
  var W3 = function () { return window.solanaWeb3; };
  var wallet = function () { return window.DOJO_WALLET || null; };
  // Listing data, DAS names and image URLs are UNTRUSTED (anyone can mint an NFT with a hostile name).
  // Everything placed in markup is fully escaped; images must be https (else our S3 art); mints base58.
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"'`]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]; }); };
  var safeImg = function (u) { try { var x = new URL(String(u || "")); return x.protocol === "https:" ? x.href : ""; } catch (e) { return ""; } };
  var isB58 = function (m) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(m || "")); };

  async function rpcCall(method, params) {
    var r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }) });
    var j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
  function toast(msg) {
    var t = document.getElementById("ddcaseToast");
    if (!t) {
      t = document.createElement("div"); t.id = "ddcaseToast";
      t.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2000;background:#1a1206;color:#f0e6d0;border:1px solid rgba(201,151,58,.5);border-radius:10px;padding:12px 18px;font-family:sans-serif;font-size:13px;max-width:90vw;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.5);";
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.display = "block";
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.style.display = "none"; }, 4400);
  }
  async function ddConfirm(sig) {
    for (var k = 0; k < 40; k++) {
      try {
        var st = await rpcCall("getSignatureStatuses", [[sig]]);
        var s = st && st.value && st.value[0];
        if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
          if (s.err) throw new Error("The transaction failed on-chain — nothing was bought. Try again."); return;
        }
      } catch (e) { if (/failed on-chain/.test(e.message)) throw e; }   // RPC hiccups retry; a real failure surfaces
      await new Promise(function (r) { setTimeout(r, 1200); });
    }
    throw new Error("Couldn't confirm it yet — check your wallet before trying again.");
  }

  function render() {
    var wrap = document.getElementById("ddCase"), row = document.getElementById("ddCaseRow"), cnt = document.getElementById("ddCaseCount");
    if (!wrap || !row) return;
    if (!DD.length) { wrap.style.display = "none"; return; }
    var W = wallet();
    var ready = !!(window.DojoAH && window.DojoAH.ALT_TABLE);
    row.innerHTML = DD.map(function (x, i) {
      var mine = W && x.seller === W.pubkey;
      var m = META[x.mint] || {};
      var art = safeImg(m.img) || safeImg(x.image) || ddImg(x.mint);
      var nm = m.name || x.name || (x.mint.slice(0, 6) + "…");
      var btn = mine
        ? '<button data-act="delist" data-i="' + i + '" style="margin:0 8px 8px;padding:7px 0;border:1px solid rgba(201,151,58,.5);border-radius:8px;background:transparent;color:#e8b84b;font-weight:700;font-size:12px;cursor:pointer">Delist</button>'
        : '<button data-act="buy" data-i="' + i + '" style="margin:0 8px 8px;padding:7px 0;border:0;border-radius:8px;background:#c9973a;color:#1a1206;font-weight:700;font-size:12px;cursor:pointer">' + (ready ? "Buy" : "Buy soon") + "</button>";
      return '<div style="border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden;background:rgba(0,0,0,.25);display:flex;flex-direction:column;">'
        + '<img src="' + esc(art) + '" data-fb="' + esc(ddImg(x.mint)) + '" alt="" style="width:100%;aspect-ratio:1/1;object-fit:cover;background:#151013;" onerror="this.onerror=null;this.src=this.dataset.fb;this.style.opacity=.9">'
        + '<div style="font-size:12.5px;color:#e7ddc9;padding:8px 10px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(nm) + "</div>"
        + '<div style="font-size:13px;color:#c9973a;font-weight:700;padding:0 10px 8px;">' + esc(x.price) + " " + esc(x.currency) + "</div>"
        + btn + "</div>";
    }).join("");
    if (cnt) cnt.textContent = DD.length;
    wrap.style.display = "";
    row.querySelectorAll("button[data-act]").forEach(function (b) {
      b.onclick = function () {
        var i = +b.getAttribute("data-i");
        if (b.getAttribute("data-act") === "buy") buy(i); else delist(i);
      };
    });
  }

  async function resolveMeta() {
    // Pull real name + art for every listed mint via DAS (any collection, not just Degens).
    var need = DD.map(function (x) { return x.mint; }).filter(function (m) { return !META[m]; });
    for (var i = 0; i < need.length; i += 100) {
      var ids = need.slice(i, i + 100);
      try {
        var assets = await rpcCall("getAssetBatch", { ids: ids });
        (assets || []).forEach(function (a) { if (a && isB58(a.id)) META[a.id] = { name: assetName(a), img: safeImg(assetImg(a)) }; });
      } catch (e) {}
    }
  }
  async function load() {
    try { var j = await (await fetch("/api/dd-listings")).json(); DD = ((j && j.listings) || []).filter(function (x) { return x && isB58(x.mint) && isB58(x.seller); }); }
    catch (e) { DD = []; }
    render();                 // paint immediately (S3/fallback art)
    await resolveMeta();      // then upgrade to real DAS art + names
    render();
  }

  // Preacher attribution: a buy made while a dd_ref cookie is set (30 days from a /preacher/<code> visit)
  // is recorded at /api/attr. Best-effort and fire-and-forget — the server verifies it on-chain.
  function recordRef(sig, x, buyer) {
    try {
      var m = document.cookie.match(/(?:^|;\s*)dd_ref=([^;]+)/), ref = m ? decodeURIComponent(m[1]) : "";
      if (!/^[a-zA-Z0-9_-]{2,32}$/.test(ref)) return;
      fetch("/api/attr", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sig: sig, ref: ref.toLowerCase(),
        buyer: buyer, mint: x.mint, currency: x.currency, price: +x.price || null, priceLamports: 0, external: false, ts: Date.now() }) }).catch(function () {});
    } catch (e) {}
  }

  async function buy(i) {
    if (BUSY) return;
    var x = DD[i]; if (!x) return;
    var W = wallet();
    if (!(window.DojoAH && window.DojoAH.ALT_TABLE)) { toast("Buying with ORE/SKR is being switched on — check back shortly."); return; }
    if (!W) { toast("Connect your wallet (top right) to buy."); return; }
    if (W.pubkey === x.seller) { toast("That is your own listing."); return; }
    BUSY = true;
    toast("Checking the purchase — you are not charged yet…");
    try {
      var r = await window.DojoAH.prepareBuy(rpcCall, { currency: x.currency, buyer: W.pubkey, seller: x.seller, mint: x.mint, price: x.price });
      if (r.err) { toast("This purchase would fail — you were NOT charged. It may have just sold, or you don’t have enough " + x.currency + "."); return; }
      toast("Approve in your wallet — you pay " + x.price + " " + x.currency + " (seller nets " + r.breakdown.sellerNet.toFixed(x.currency === "USDC" ? 2 : 3) + " after the 13% royalty)…");
      var s = await window.DojoAH.submitBuy(rpcCall, W, r);
      toast("Confirming your purchase…"); await ddConfirm(s);
      try { fetch("/api/dd-royalty", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sig: s, currency: x.currency }) }); } catch (e) {}
      recordRef(s, x, W.pubkey);   // referring preacher (if any) → /api/attr, verified on-chain server-side
      DD = DD.filter(function (l) { return l.tradeState !== x.tradeState; }); render();
      toast("✓ Bought " + (x.name || "this Degen") + " — it is now in your wallet.");
      setTimeout(load, 9000);
    } catch (e) { toast("Buy failed: " + ((e && e.message) || e)); }
    finally { BUSY = false; }
  }

  async function delist(i) {
    if (BUSY) return;
    var x = DD[i]; if (!x) return;
    var W = wallet();
    if (!W) { toast("Connect your wallet (top right) to delist."); return; }
    if (W.pubkey !== x.seller) { toast("That is not your listing."); return; }
    BUSY = true;
    toast("Building the delist — approve in your wallet…");
    try {
      var Wl = W3();
      var built = window.DojoAH.buildCancelIx({ currency: x.currency, seller: W.pubkey, mint: x.mint, price: x.price });
      var ix = new Wl.TransactionInstruction({ programId: built.programId, keys: built.keys, data: Wl.Buffer ? Wl.Buffer.from(built.data) : built.data });
      var bh = (await rpcCall("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
      var msg = new Wl.TransactionMessage({ payerKey: new Wl.PublicKey(W.pubkey), recentBlockhash: bh, instructions: [ix] }).compileToV0Message();
      var tx = new Wl.VersionedTransaction(msg);
      var sig = await W.signAndSendTransaction(tx); var s = (sig && sig.signature) || sig;
      toast("Confirming the delist…"); await ddConfirm(s);
      DD = DD.filter(function (l) { return l.tradeState !== x.tradeState; }); render();
      toast("✓ Delisted " + (x.name || "this Degen") + " — it stays in your wallet.");
      setTimeout(load, 9000);
    } catch (e) { toast("Delist failed: " + ((e && e.message) || e)); }
    finally { BUSY = false; }
  }

  window.addEventListener("dojo-wallet-change", render);
  if (document.readyState !== "loading") load();
  else document.addEventListener("DOMContentLoaded", load);
  window.DDCase = { load: load, render: render };
})();
