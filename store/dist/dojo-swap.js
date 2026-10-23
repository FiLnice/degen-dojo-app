// "Get ORE" — swap SOL or USDC → ORE inside the store, routed by Jupiter (public lite-api, no key).
//   DojoSwap.open()                 → pay with SOL/USDC, you choose the amount
//   DojoSwap.open({ needOre: 1.27 }) → "you need 1.27 ORE": quotes the exact ORE (ExactOut) for a buy
// The swap transaction is built by Jupiter's API, so BEFORE the wallet is asked to sign, it is checked:
//   · the buyer pays the fee and none of their OTHER token accounts (NFTs, other coins) is writable in it;
//   · a simulation shows ORE going up by at least the quoted minimum, and only the chosen coin (+ a small
//     SOL fee) going down — anything else and the swap is refused.
// Needs: web3.js (window.solanaWeb3), wallet-picker.js (window.DOJO_WALLET / DojoWalletPicker), /api/rpc.
(function (global) {
  var ORE = 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp';
  var COINS = {
    SOL:  { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
    USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  };
  var ORE_DEC = 11, SLIPPAGE_BPS = 100, QUOTE_TTL = 20000;
  var SOL_FEE_BUFFER = 0.02;          // spend cap in the safety check: fees + account deposits, worst case
  // SOL a swap needs IN THE WALLET on top of the amount. Most of it is only HELD during the transaction —
  // deposits for the temporary wrapped-SOL / route accounts, returned at its end (measured 2026-10-21: up to
  // ~0.004 SOL depending on Jupiter's route). What is actually SPENT: the network fee (~0.0001) plus, the first
  // time only, a ~0.002 SOL deposit that opens the wallet's ORE account (refundable if that account is closed).
  var HELD = 0.0038, FEE = 0.0002, ORE_ACCOUNT_RENT = 0.00204;
  function solCost() { return FEE + (S.hasOreAcct ? 0 : ORE_ACCOUNT_RENT); }                 // what the swap really costs
  function solReserve() { return solCost() + (S.coin === 'SOL' ? HELD : 0.0004); }          // what must be in the wallet
  var TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  var ATA_PROG = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  var JUP = 'https://lite-api.jup.ag/swap/v1';

  var W3 = function () { return global.solanaWeb3; };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n, d) { return (+n).toLocaleString('en-US', { maximumFractionDigits: d == null ? 4 : d }); };
  var toUnits = function (x, dec) { var s = String(x).trim(); if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return 0n; var p = s.split('.'); return BigInt(p[0] || '0') * 10n ** BigInt(dec) + BigInt(((p[1] || '') + '0'.repeat(dec)).slice(0, dec) || '0'); };
  var fromUnits = function (u, dec) { return Number(BigInt(u)) / Math.pow(10, dec); };
  function b64ToBytes(s) { if (global.Buffer && global.Buffer.from) { var b = global.Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); } var r = atob(s), o = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o; }
  function bytesToB64(b) { if (global.Buffer && global.Buffer.from) return global.Buffer.from(b).toString('base64'); var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function u64At(bytes, off) { var v = 0n; for (var i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]); return v; }

  async function rpc(method, params) {
    var r = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) });
    var j = await r.json(); if (j.error) throw new Error(j.error.message || 'RPC error'); return j.result;
  }
  var ataOf = function (owner, mint) { var P = W3().PublicKey; return P.findProgramAddressSync([new P(owner).toBuffer(), new P(TOKEN).toBuffer(), new P(mint).toBuffer()], new P(ATA_PROG))[0].toBase58(); };

  // ── state ──
  var S = { coin: 'SOL', mode: 'in', amount: '', needOre: 0, quote: null, quotedAt: 0, busy: false, timer: null, bal: {} };

  async function loadBalances() {
    var w = global.DOJO_WALLET; if (!w || !w.pubkey) { S.bal = {}; return; }
    try {
      var sol = await rpc('getBalance', [w.pubkey]);
      var bal = { SOL: sol.value / 1e9, USDC: 0, ORE: 0 };
      var r = await rpc('getTokenAccountsByOwner', [w.pubkey, { programId: TOKEN }, { encoding: 'jsonParsed' }]);
      S.hasOreAcct = (r.value || []).some(function (a) { return a.account.data.parsed.info.mint === ORE; });
      (r.value || []).forEach(function (a) { var i = a.account.data.parsed.info;
        if (i.mint === ORE) bal.ORE += +i.tokenAmount.uiAmount || 0; if (i.mint === COINS.USDC.mint) bal.USDC += +i.tokenAmount.uiAmount || 0; });
      S.bal = bal;
    } catch (e) { S.bal = {}; }
    paint();
  }

  async function getQuote() {
    var c = COINS[S.coin], url;
    if (S.mode === 'out') {
      if (!(S.needOre > 0)) { S.quote = null; return paint(); }
      url = JUP + '/quote?inputMint=' + c.mint + '&outputMint=' + ORE + '&amount=' + toUnits(S.needOre.toFixed(ORE_DEC), ORE_DEC) + '&swapMode=ExactOut&slippageBps=' + SLIPPAGE_BPS;
    } else {
      var amt = toUnits(S.amount, c.decimals); if (amt <= 0n) { S.quote = null; return paint(); }
      url = JUP + '/quote?inputMint=' + c.mint + '&outputMint=' + ORE + '&amount=' + amt + '&swapMode=ExactIn&slippageBps=' + SLIPPAGE_BPS + '&restrictIntermediateTokens=true';
    }
    try {
      var q = await (await fetch(url)).json();
      if (q.error || q.errorCode || !q.outAmount) throw new Error(q.error || q.errorCode || 'no route');
      S.quote = q; S.quotedAt = Date.now(); S.err = '';
    } catch (e) {
      S.quote = null; S.err = S.mode === 'out' ? 'No exact-amount route right now — type how much ' + S.coin + ' to swap instead.' : 'No route for this amount right now.';
      if (S.mode === 'out') S.mode = 'in';
    }
    paint();
  }

  // ── the safety check on Jupiter's transaction ──
  async function checkSwapTx(vtx, user, q) {
    var W = W3(), msg = vtx.message;
    if (msg.staticAccountKeys[0].toBase58() !== user) throw new Error('refused: the swap is not paid from your wallet');
    // resolve lookup tables → every account the tx touches, and which are writable
    var alts = [];
    if (msg.addressTableLookups && msg.addressTableLookups.length) {
      var keys = msg.addressTableLookups.map(function (l) { return l.accountKey.toBase58(); });
      var res = await rpc('getMultipleAccounts', [keys, { encoding: 'base64' }]);
      res.value.forEach(function (a, i) { if (!a) throw new Error('refused: unknown lookup table'); alts.push(new W.AddressLookupTableAccount({ key: new W.PublicKey(keys[i]), state: W.AddressLookupTableAccount.deserialize(b64ToBytes(a.data[0])) })); });
    }
    var all = msg.getAccountKeys({ addressLookupTableAccounts: alts }), writable = new Set();
    for (var i = 0; i < all.length; i++) if (msg.isAccountWritable(i)) writable.add(all.get(i).toBase58());
    // none of the buyer's OTHER token accounts (NFTs, other coins) may be writable
    var ok = new Set([ORE, COINS.SOL.mint, COINS[S.coin].mint]);
    for (var p = 0; p < 2; p++) {
      var tk = await rpc('getTokenAccountsByOwner', [user, { programId: p ? TOKEN22 : TOKEN }, { encoding: 'jsonParsed' }]);
      (tk.value || []).forEach(function (a) { if (writable.has(a.pubkey) && !ok.has(a.account.data.parsed.info.mint)) throw new Error('refused: this swap would touch your other tokens/NFTs'); });
    }
    // simulate and compare the buyer's balances
    var oreAta = ataOf(user, ORE), inAta = S.coin === 'SOL' ? null : ataOf(user, COINS[S.coin].mint);
    var watch = [user, oreAta].concat(inAta ? [inAta] : []);
    var pre = await rpc('getMultipleAccounts', [watch, { encoding: 'base64' }]);
    var sim = await rpc('simulateTransaction', [bytesToB64(vtx.serialize()), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: watch } }]);
    if (sim.value.err) {
      var logs = (sim.value.logs || []).join('\n');
      if (/insufficient lamports|insufficient funds/i.test(logs)) throw new Error('This route needs a little more SOL held during the swap — try a slightly smaller amount (or tap Max).');
      throw new Error('The swap would fail right now — the price may have moved. Try again in a moment.');
    }
    var post = sim.value.accounts;
    var tokAmt = function (a) { return a && a.data ? u64At(b64ToBytes(a.data[0]), 64) : 0n; };
    var oreGain = tokAmt(post[1]) - tokAmt(pre.value[1]);
    var minOre = BigInt(q.swapMode === 'ExactOut' ? q.outAmount : q.otherAmountThreshold);
    if (oreGain < minOre) throw new Error('refused: the simulation gives less ORE than quoted');
    var solSpent = BigInt(pre.value[0] ? pre.value[0].lamports : 0) - BigInt(post[0] ? post[0].lamports : 0);
    var maxIn = BigInt(q.swapMode === 'ExactOut' ? q.otherAmountThreshold : q.inAmount);
    var solCap = (S.coin === 'SOL' ? maxIn : 0n) + toUnits(String(SOL_FEE_BUFFER), 9);
    if (solSpent > solCap) throw new Error('refused: the swap would take more SOL than quoted');
    if (inAta && tokAmt(pre.value[2]) - tokAmt(post[2]) > maxIn) throw new Error('refused: the swap would take more ' + S.coin + ' than quoted');
    return fromUnits(oreGain, ORE_DEC);
  }

  async function doSwap() {
    var w = global.DOJO_WALLET;
    if (!w || !w.pubkey) { if (global.DojoWalletPicker) global.DojoWalletPicker.pick().then(function (a) { global.DOJO_WALLET = a; global.dispatchEvent(new Event('dojo-wallet-change')); loadBalances(); }).catch(function () {}); return; }
    if (S.busy) return; S.busy = true; S.err = ''; S.ok = '';
    try {
      if (!S.quote || Date.now() - S.quotedAt > QUOTE_TTL) { status('Refreshing the price…'); await getQuote(); }
      var q = S.quote; if (!q) throw new Error(S.err || 'No quote');
      // enough SOL for the amount AND Solana's deposits + fees? (say so plainly instead of a failed simulation)
      var spend = q.swapMode === 'ExactOut' ? fromUnits(q.otherAmountThreshold, COINS[S.coin].decimals) : fromUnits(q.inAmount, COINS[S.coin].decimals);
      var needSol = (S.coin === 'SOL' ? spend : 0) + solReserve();
      if (S.bal.SOL != null && S.bal.SOL < needSol) throw new Error('Not enough SOL: the swap costs ≈' + fmt(solCost(), 4) + ' SOL' + (S.hasOreAcct ? '' : ' (incl. the one-time ORE account)') + ', and ≈' + fmt(solReserve() - solCost(), 4) + ' SOL more must sit in the wallet during the swap (it comes back). You have ' + fmt(S.bal.SOL, 4) + ' SOL' + (S.coin === 'SOL' ? ' — tap Max for the most you can swap.' : '.'));
      status('Building the swap…');
      var sw = await (await fetch(JUP + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        quoteResponse: q, userPublicKey: w.pubkey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 50000, priorityLevel: 'medium' } } }) })).json();
      if (!sw.swapTransaction) throw new Error(sw.error || 'Jupiter could not build the swap');
      var vtx = W3().VersionedTransaction.deserialize(b64ToBytes(sw.swapTransaction));
      status('Checking the swap…');
      var gets = await checkSwapTx(vtx, w.pubkey, q);
      status('Approve in your wallet…');
      var out = await w.signAndSendTransaction(vtx); var sig = (out && out.signature) || out;
      status('Confirming…');
      for (var i = 0; i < 40; i++) {
        var st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) { if (st.err) throw new Error('The swap failed on chain — nothing was taken except the network fee.'); break; }
        await new Promise(function (r) { setTimeout(r, 1200); });
      }
      S.ok = '✓ Got ' + fmt(gets) + ' ORE'; S.sig = sig; S.quote = null; S.amount = '';
      global.dispatchEvent(new CustomEvent('dojo-ore-change', { detail: { ore: gets } }));
      loadBalances();
    } catch (e) { S.err = (e && e.message) || String(e); }
    S.busy = false; paint();
  }

  // ── UI ──
  function status(t) { var el = $('dswMsg'); if (el) { el.className = 'dsw-msg'; el.textContent = t; } }
  function ensureDom() {
    if ($('dswBack')) return;
    var css = document.createElement('style');
    css.textContent = '.dsw-back{position:fixed;inset:0;background:rgba(5,4,8,.72);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.dsw{width:100%;max-width:380px;background:#16161f;border:1px solid rgba(201,151,58,.35);border-radius:16px;padding:18px;color:#e8e0d0;font:14px Inter,system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)}' +
      '.dsw h3{margin:0 0 4px;font:700 22px Cinzel,serif;color:#e8b84b}.dsw .sub{color:#7a7570;font-size:12px;margin-bottom:12px}' +
      '.dsw .x{float:right;background:none;border:0;color:#7a7570;font-size:22px;cursor:pointer;line-height:1}' +
      '.dsw .tabs{display:flex;gap:6px;margin-bottom:10px}.dsw .tabs b{flex:1;text-align:center;padding:8px 0;border-radius:9px;background:#0d0a06;border:1px solid #3a2f1e;cursor:pointer;font-weight:600}' +
      '.dsw .tabs b.on{background:#c9973a;color:#1b1206;border-color:#c9973a}' +
      '.dsw input{width:100%;box-sizing:border-box;background:#0d0a06;border:1px solid #4a3c26;border-radius:9px;color:#e8e0d0;font:600 22px Teko,Inter,sans-serif;padding:9px 11px}' +
      '.dsw .row{display:flex;justify-content:space-between;font-size:12px;color:#9a917f;margin:6px 2px}.dsw .row a{color:#e8b84b;cursor:pointer}' +
      '.dsw .get{margin:12px 0;padding:12px;border-radius:11px;background:#0d0a06;border:1px solid #2e2618}.dsw .get .big{font:700 24px Teko,Inter,sans-serif;color:#e8b84b}' +
      '.dsw .go{width:100%;padding:12px;border:0;border-radius:11px;background:linear-gradient(135deg,#e8b84b,#8b6018);color:#140d03;font:700 14px Cinzel,serif;letter-spacing:.05em;cursor:pointer}.dsw .go:disabled{opacity:.5;cursor:default}' +
      '.dsw-msg{margin-top:10px;font-size:12px;color:#9a917f;min-height:16px}.dsw-msg.err{color:#e0574a}.dsw-msg.ok{color:#7fd17a}.dsw-msg a{color:inherit}';
    document.head.appendChild(css);
    var d = document.createElement('div'); d.id = 'dswBack'; d.className = 'dsw-back'; d.style.display = 'none';
    d.innerHTML = '<div class="dsw" role="dialog" aria-label="Get ORE"><button class="x" id="dswX" aria-label="Close">×</button><h3>Get ORE</h3>' +
      '<div class="sub">Swap SOL or USDC to ORE — routed by Jupiter, checked before you sign.</div>' +
      '<div class="tabs" id="dswTabs"><b data-c="SOL">SOL</b><b data-c="USDC">USDC</b></div>' +
      '<div id="dswNeed" class="row" style="display:none"></div>' +
      '<input id="dswAmt" inputmode="decimal" placeholder="0.0" autocomplete="off">' +
      '<div class="row"><span id="dswBal"></span><a id="dswMax">Max</a></div>' +
      '<div class="get" id="dswGet"></div><button class="go" id="dswGo">Swap</button><div class="dsw-msg" id="dswMsg"></div></div>';
    document.body.appendChild(d);
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    $('dswX').onclick = close;
    $('dswTabs').onclick = function (e) { var c = e.target && e.target.dataset && e.target.dataset.c; if (!c || c === S.coin) return; S.coin = c; S.quote = null; getQuote(); };
    $('dswAmt').oninput = function () { S.amount = this.value.replace(',', '.'); S.mode = 'in'; S.quote = null; clearTimeout(S.deb); S.deb = setTimeout(getQuote, 350); paint(true); };
    $('dswMax').onclick = function () { var b = S.bal[S.coin] || 0; var m = S.coin === 'SOL' ? Math.max(0, b - solReserve() - 0.0002) : b; S.amount = String(Math.floor(m * 1e6) / 1e6); S.mode = 'in'; $('dswAmt').value = S.amount; getQuote(); };
    $('dswGo').onclick = doSwap;
    global.addEventListener('dojo-wallet-change', function () { if ($('dswBack').style.display !== 'none') loadBalances(); });
  }
  function paint(keepInput) {
    if (!$('dswBack')) return;
    var c = COINS[S.coin], q = S.quote, w = global.DOJO_WALLET;
    [].forEach.call($('dswTabs').children, function (b) { b.classList.toggle('on', b.dataset.c === S.coin); });
    var need = $('dswNeed'); need.style.display = S.needOre > 0 ? '' : 'none';
    need.innerHTML = S.needOre > 0 ? '<span>You need <b>' + esc(fmt(S.needOre)) + ' ORE</b> for this buy</span><a id="dswExact">get exactly that</a>' : '';
    var ex = $('dswExact'); if (ex) ex.onclick = function () { S.mode = 'out'; S.quote = null; getQuote(); };
    if (!keepInput) $('dswAmt').value = S.mode === 'out' && q ? String(fromUnits(q.inAmount, c.decimals)) : S.amount;
    $('dswBal').textContent = S.bal[S.coin] != null ? ('Balance: ' + fmt(S.bal[S.coin]) + ' ' + S.coin + (S.bal.ORE != null ? ' · ' + fmt(S.bal.ORE) + ' ORE' : '')) : '';
    $('dswGet').innerHTML = q
      ? '<div>You get</div><div class="big">' + esc(fmt(fromUnits(q.outAmount, ORE_DEC))) + ' ORE</div>' +
        '<div class="row"><span>' + (q.swapMode === 'ExactOut' ? 'Max you pay' : 'Min you get') + '</span><span>' +
        esc(q.swapMode === 'ExactOut' ? fmt(fromUnits(q.otherAmountThreshold, c.decimals)) + ' ' + S.coin : fmt(fromUnits(q.otherAmountThreshold, ORE_DEC)) + ' ORE') + '</span></div>' +
        '<div class="row"><span>Price impact</span><span>' + esc((+q.priceImpactPct * 100).toFixed(2)) + '%</span></div>' +
        '<div class="row"><span>Slippage</span><span>' + (SLIPPAGE_BPS / 100) + '%</span></div>' +
        '<div class="row"><span>Solana fee</span><span>≈ ' + fmt(solCost(), 4) + ' SOL' + (S.hasOreAcct ? '' : ' (first time: opens your ORE account)') + '</span></div>' +
        (S.coin === 'SOL' ? '<div class="row"><span>Held during the swap</span><span>≈ ' + fmt(HELD, 4) + ' SOL · returned</span></div>' : '')
      : '<div class="row" style="margin:0"><span>Enter an amount to see how much ORE you get.</span></div>';
    var go = $('dswGo');
    go.disabled = S.busy || (!!w && !q);
    go.textContent = !w ? 'Connect wallet' : S.busy ? 'Working…' : 'Swap ' + S.coin + ' → ORE';
    var m = $('dswMsg');
    if (S.err) { m.className = 'dsw-msg err'; m.textContent = S.err; }
    else if (S.ok) { m.className = 'dsw-msg ok'; m.innerHTML = esc(S.ok) + (S.sig ? ' — <a href="https://solscan.io/tx/' + encodeURIComponent(S.sig) + '" target="_blank" rel="noopener">view tx ↗</a>' : ''); }
    else if (!S.busy) { m.className = 'dsw-msg'; m.textContent = ''; }
  }
  function open(opts) {
    opts = opts || {}; ensureDom();
    S.needOre = +opts.needOre > 0 ? +opts.needOre : 0; S.mode = S.needOre ? 'out' : 'in';
    S.err = ''; S.ok = ''; S.sig = ''; S.quote = null; if (opts.coin && COINS[opts.coin]) S.coin = opts.coin;
    $('dswBack').style.display = 'flex'; paint(); loadBalances(); getQuote();
    clearInterval(S.timer); S.timer = setInterval(function () { if (!S.busy && (S.mode === 'out' || S.amount)) getQuote(); }, QUOTE_TTL);
  }
  function close() { var b = $('dswBack'); if (b) b.style.display = 'none'; clearInterval(S.timer); }

  // ORE the wallet is missing for a price (0 = enough). Read-only.
  async function oreShortfall(owner, need) {
    try {
      var r = await rpc('getTokenAccountsByOwner', [owner, { mint: ORE }, { encoding: 'jsonParsed' }]);
      var have = (r.value || []).reduce(function (s, a) { return s + (+a.account.data.parsed.info.tokenAmount.uiAmount || 0); }, 0);
      return have >= need ? 0 : Math.ceil((need - have) * 1e6) / 1e6;
    } catch (e) { return 0; }   // unknown → let the normal simulation decide
  }

  global.DojoSwap = { open: open, close: close, oreShortfall: oreShortfall, _check: checkSwapTx, _state: S, _load: loadBalances, _quote: getQuote, _swap: doSwap };   // _*: test hooks   // _check/_state: for tests only
})(window);
