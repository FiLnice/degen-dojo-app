// Wallet Standard picker — lists every installed Solana wallet (Phantom, Solflare, Backpack,
// Jupiter, …) WITH its official icon, lets the user choose, and returns a normalized adapter:
//   { name, icon, pubkey, account, signMessage(bytes)->{signature}, signAndSendTransaction(serializedBytes)->{signature:bs58} }
// The Wallet Standard is the only interface Jupiter Mobile (JUP) speaks, and it hands us each
// wallet's icon, so we don't have to hardcode logos.
(function (global) {
  var CHAIN = 'solana:mainnet';

  // Preacher links: every page that loads this script (store, miner, games, coins) keeps a ?ref=code
  // in the shared dd_ref cookie — same 30-day last-touch rule as the store home.
  (function captureRef() {
    try {
      var r = new URLSearchParams(location.search).get('ref');
      if (!r || !/^[a-zA-Z0-9_-]{2,32}$/.test(r)) return;
      var dom = /(^|\.)degendojo\.xyz$/.test(location.hostname) ? '; domain=.degendojo.xyz' : '';
      document.cookie = 'dd_ref=' + encodeURIComponent(r.toLowerCase()) + dom + '; max-age=' + (30 * 86400) + '; path=/; SameSite=Lax';
    } catch (_) {}
  })();

  // The referral travels INSIDE the purchase: every buy path adds a tiny SPL Memo "ddref:<code>" to the
  // buyer's own transaction, so it's covered by their signature and the server credits the preacher from
  // the chain (store-ref-core.mjs) — never from a separate, unsigned POST.
  // DojoRef.instruction(web3) → a Memo TransactionInstruction for the current referral, or null if none.
  global.DojoRef = {
    MEMO_PROGRAM: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    code: function () {
      try { var m = document.cookie.match(/(?:^|;\s*)dd_ref=([^;]+)/); var c = m ? decodeURIComponent(m[1]).toLowerCase() : '';
        return /^[a-z0-9_-]{2,32}$/.test(c) ? c : null; } catch (_) { return null; }
    },
    memoText: function () { var c = this.code(); return c ? 'ddref:' + c : null; },
    instruction: function (web3) {
      var t = this.memoText(); if (!t || !web3) return null;
      var data = (typeof Buffer !== 'undefined' && Buffer.from) ? Buffer.from(t, 'utf8') : (web3.Buffer ? web3.Buffer.from(t, 'utf8') : new TextEncoder().encode(t));
      return new web3.TransactionInstruction({ programId: new web3.PublicKey(this.MEMO_PROGRAM), keys: [], data: data });
    },
    // ixs + the referral memo (unchanged when there's no referral)
    withRef: function (web3, ixs) { var m = this.instruction(web3); return m ? ixs.concat([m]) : ixs; },
    // Add the memo to a transaction a marketplace API built for us (Magic Eden / Tensor). Returns the new tx,
    // or the ORIGINAL untouched when there's no referral, it is already partly signed, or it would no longer
    // fit — a buy must never fail because of the referral. rpc(method, params) → result.
    addToTx: async function (web3, tx, rpc) {
      try {
        var memo = this.instruction(web3); if (!memo || !tx) return tx;
        var signed = function (s) { if (!s) return false; var b = s.signature || s; for (var i = 0; i < (b.length || 0); i++) if (b[i]) return true; return false; };
        if ((tx.signatures || []).some(signed)) return tx;
        if (tx.version === undefined) {                                   // legacy Transaction
          var copy = web3.Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
          copy.add(memo);
          return copy.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232 ? copy : tx;
        }
        var lookups = tx.message.addressTableLookups || [], alts = [];
        for (var i = 0; i < lookups.length; i++) {
          var ai = await rpc('getAccountInfo', [lookups[i].accountKey.toBase58(), { encoding: 'base64' }]);
          if (!ai || !ai.value) return tx;
          var raw = atob(ai.value.data[0]), bytes = new Uint8Array(raw.length);
          for (var k = 0; k < raw.length; k++) bytes[k] = raw.charCodeAt(k);
          alts.push(new web3.AddressLookupTableAccount({ key: lookups[i].accountKey, state: web3.AddressLookupTableAccount.deserialize(bytes) }));
        }
        var tm = web3.TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: alts });
        // a memo costs a few thousand compute units: lift an explicit compute limit so the original budget still fits
        tm.instructions.forEach(function (ix) {
          if (ix.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111' || ix.data[0] !== 2 || ix.data.length < 5) return;
          var u = (ix.data[1] | (ix.data[2] << 8) | (ix.data[3] << 16) | (ix.data[4] << 24)) >>> 0;
          u = Math.min(1400000, u + 20000);
          var d = new Uint8Array(ix.data); d[1] = u & 255; d[2] = (u >> 8) & 255; d[3] = (u >> 16) & 255; d[4] = (u >>> 24) & 255;
          ix.data = (typeof Buffer !== 'undefined' && Buffer.from) ? Buffer.from(d) : d;
        });
        tm.instructions.push(memo);
        var out = new web3.VersionedTransaction(tm.compileToV0Message(alts));
        return out.serialize().length <= 1232 ? out : tx;
      } catch (e) { this.lastError = String((e && e.message) || e); return tx; }   // kept for debugging; the buy proceeds without the memo
    },
  };

  // Enumerate Wallet-Standard wallets (dispatch app-ready + listen for late registrations).
  function enumerate() {
    var wallets = [];
    function register() {
      for (var i = 0; i < arguments.length; i++) {
        var w = arguments[i];
        var isSolana = w && w.chains && [].some.call(w.chains, function (c) { return String(c).indexOf('solana') === 0; });
        if (isSolana && wallets.indexOf(w) < 0) wallets.push(w);
      }
      return function () {};
    }
    var api = { version: '1.0.0', register: register, get: function () { return wallets.slice(); }, on: function () { return function () {}; } };
    try { window.addEventListener('wallet-standard:register-wallet', function (e) { try { e.detail({ register: register }); } catch (_) {} }); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })); } catch (_) {}
    return wallets;
  }

  var ORDER = ['Phantom', 'Solflare', 'Backpack', 'Jupiter'];
  function sortWallets(ws) {
    return ws.slice().sort(function (a, b) {
      var ia = ORDER.indexOf(a.name); ia = ia < 0 ? 99 : ia;
      var ib = ORDER.indexOf(b.name); ib = ib < 0 ? 99 : ib;
      return ia - ib || String(a.name).localeCompare(String(b.name));
    });
  }

  // base58 encode a Uint8Array (signatures come back as bytes from the standard)
  function bs58(bytes) {
    var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', d = [0], i, j, c, s = '';
    for (i = 0; i < bytes.length; i++) { c = bytes[i]; for (j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
    for (i = 0; i < bytes.length && bytes[i] === 0; i++) s += '1';
    for (j = d.length - 1; j >= 0; j--) s += A[d[j]];
    return s;
  }

  function adapt(w, account) {
    var F = w.features || {};
    return {
      name: w.name, icon: w.icon, pubkey: account.address, account: account, wallet: w,
      signMessage: function (message) {
        return F['solana:signMessage'].signMessage({ account: account, message: message })
          .then(function (o) { return { signature: o[0].signature }; });
      },
      // Accepts EITHER a serialized Uint8Array OR a web3.js Transaction/VersionedTransaction
      // (so it's a drop-in for code that passes tx objects to a provider). Returns {signature}.
      signAndSendTransaction: function (txOrBytes) {
        var ser = txOrBytes;
        if (txOrBytes && typeof txOrBytes.serialize === 'function') {
          try { ser = txOrBytes.serialize(); }                                  // VersionedTransaction
          catch (_) { ser = txOrBytes.serialize({ requireAllSignatures: false, verifySignatures: false }); } // legacy
        }
        if (!(ser instanceof Uint8Array)) { try { ser = new Uint8Array(ser); } catch (_) {} }
        if (F['solana:signAndSendTransaction']) {
          return F['solana:signAndSendTransaction'].signAndSendTransaction({ account: account, transaction: ser, chain: CHAIN })
            .then(function (o) { return { signature: bs58(o[0].signature) }; });
        }
        return Promise.reject(new Error(w.name + ' cannot send transactions'));
      },
      // best-effort disconnect + no-op event hook so it drops into provider-style call sites
      // Disconnect also forgets the remembered wallet, or the next page would silently reconnect it.
      disconnect: function () { try { localStorage.removeItem('dojo_wallet'); } catch (_) {} try { return F['standard:disconnect'] ? F['standard:disconnect'].disconnect() : Promise.resolve(); } catch (_) { return Promise.resolve(); } },
      on: function () { return function () {}; },
      // fallback for wallets that only sign (caller sends via RPC); returns signed tx bytes
      signTransaction: function (serialized) {
        return F['solana:signTransaction'].signTransaction({ account: account, transaction: serialized, chain: CHAIN })
          .then(function (o) { return o[0].signedTransaction; });
      },
      // Sign MANY transactions in ONE wallet approval. Takes an array of web3.js tx OBJECTS and
      // returns an array of signed, serialized bytes. Used by the pay-in-token flow so the ORE→SOL
      // swap and the buy are one click instead of two. Rejects with 'cannot sign multiple' when the
      // wallet offers no batch signer, so the caller can fall back to the two-prompt flow BEFORE
      // anything is broadcast.
      signAll: function (txs) {
        // Preferred: the injected provider's signAllTransactions (Phantom, Solflare, …) — ONE prompt
        // for the whole batch. Phantom shares its connection state with the Wallet-Standard wallet we
        // connected through, so its publicKey is already set and must match this account.
        var g = (typeof window !== 'undefined') ? window : {};
        var prov = w.provider || (g.phantom && g.phantom.solana) || g.solana || g.solflare || null;
        if (prov && typeof prov.signAllTransactions === 'function' && prov.publicKey && String(prov.publicKey) === account.address) {
          return Promise.resolve(prov.signAllTransactions(txs)).then(function (signed) {
            return signed.map(function (t) { return (t && typeof t.serialize === 'function') ? t.serialize() : t; });
          });
        }
        // Fallback: Wallet Standard signTransaction is variadic (one prompt per spec) — some wallets
        // support the multi-input form even without an injected provider.
        var f = F['solana:signTransaction'];
        if (!f) return Promise.reject(new Error(w.name + ' cannot sign multiple transactions'));
        // A legacy (non-versioned) Transaction can't serialize unsigned without these flags.
        var ser = function (t) { return (t && t.version === undefined && typeof t.serializeMessage === 'function') ? t.serialize({ requireAllSignatures: false, verifySignatures: false }) : t.serialize(); };
        var inputs = txs.map(function (t) { return { account: account, transaction: ser(t), chain: CHAIN }; });
        return f.signTransaction.apply(f, inputs).then(function (o) { return o.map(function (x) { return x.signedTransaction; }); });
      }
    };
  }

  function connect(w) {
    return Promise.resolve(w.features['standard:connect'].connect()).then(function (res) {
      function finish(acc) { try { localStorage.setItem('dojo_wallet', w.name); } catch (_) {} return adapt(w, acc); }   // remember for cross-page auto-reconnect
      var acc = ((res && res.accounts) || [])[0] || (w.accounts || [])[0];
      if (acc) return finish(acc);
      // Mobile Wallet Adapter can resolve connect() BEFORE w.accounts is populated — poll briefly
      // for the authorized account instead of failing immediately with "No account returned".
      return new Promise(function (resolve, reject) {
        var n = 0;
        (function check() {
          var a = (w.accounts || [])[0];
          if (a) return resolve(finish(a));
          if (++n > 20) return reject(new Error('No account returned by ' + w.name));
          setTimeout(check, 150);
        })();
      });
    });
  }

  // Silent reconnect of the last wallet the user picked — no popup (only reconnects a wallet
  // that already authorised this origin). Lets a connection made on one same-origin page
  // (store) carry to the next (shelves, preacher) without asking again. Resolves null if none.
  function autoConnect() {
    return new Promise(function (resolve) {
      var name; try { name = localStorage.getItem('dojo_wallet'); } catch (_) {}
      if (!name) { resolve(null); return; }
      // Keep the session across pages. Wallets register late — Mobile Wallet Adapter (Seed Vault) in
      // particular registers after mwa.js finishes, and its saved authorization loads a beat after
      // that — so a single early attempt found nothing and every page showed "Connect wallet" again.
      // Look for the remembered wallet for up to ~6s, and give an empty silent answer one retry.
      var deadline = Date.now() + 6000, retried = false;
      function attempt() {
        var w = sortWallets(enumerate()).filter(function (x) { return x.name === name; })[0];
        if (!w || !w.features['standard:connect']) {
          if (Date.now() < deadline) { setTimeout(attempt, 250); return; }
          resolve(null); return;
        }
        try {
          w.features['standard:connect'].connect({ silent: true }).then(function (res) {
            var acc = ((res && res.accounts) || [])[0] || (w.accounts || [])[0];
            if (acc) { resolve(adapt(w, acc)); return; }
            if (!retried) { retried = true; setTimeout(attempt, 900); return; }
            resolve(null);
          }).catch(function () {
            if (!retried) { retried = true; setTimeout(attempt, 900); return; }
            resolve(null);
          });
        } catch (_) { resolve(null); }
      }
      attempt();
    });
  }

  function ensureCss() {
    if (document.getElementById('dwp-css')) return;
    var s = document.createElement('style'); s.id = 'dwp-css';
    s.textContent = '.dwp-ov{position:fixed;inset:0;background:rgba(6,5,4,.72);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:99999}'
      + '.dwp-box{background:#15121b;border:1px solid rgba(200,150,42,.35);border-radius:16px;padding:18px;width:min(340px,90vw);box-shadow:0 20px 60px rgba(0,0,0,.6)}'
      + '.dwp-h{font-family:"Cinzel",Georgia,serif;text-transform:uppercase;letter-spacing:.1em;font-size:14px;color:#e8b84b;text-align:center;margin-bottom:14px}'
      + '.dwp-w{display:flex;align-items:center;gap:12px;width:100%;background:#1b1622;border:1px solid rgba(200,150,42,.2);border-radius:12px;padding:11px 14px;margin-bottom:9px;cursor:pointer;color:#efe6d2;font-size:15px;font-family:inherit}'
      + '.dwp-w:hover{border-color:#e8b84b;background:#221a2b}.dwp-w img{width:28px;height:28px;border-radius:7px;object-fit:contain}'
      + '.dwp-x{width:100%;background:transparent;border:none;color:#a99a80;font-size:13px;cursor:pointer;padding:6px;margin-top:2px}'
      + '.dwp-empty{color:#a99a80;font-size:13px;text-align:center;line-height:1.6}.dwp-empty a{color:#e8b84b}';
    document.head.appendChild(s);
  }

  // Official wallet marks (Phantom / Solflare from @solana/wallet-adapter-*, Jupiter from jup.ag) so
  // the phone-side buttons look like the wallets people already know.
  var WALLET_ICONS = {
    Phantom: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiB2aWV3Qm94PSIwIDAgMTA4IDEwOCIgZmlsbD0ibm9uZSI+CjxyZWN0IHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiByeD0iMjYiIGZpbGw9IiNBQjlGRjIiLz4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik00Ni41MjY3IDY5LjkyMjlDNDIuMDA1NCA3Ni44NTA5IDM0LjQyOTIgODUuNjE4MiAyNC4zNDggODUuNjE4MkMxOS41ODI0IDg1LjYxODIgMTUgODMuNjU2MyAxNSA3NS4xMzQyQzE1IDUzLjQzMDUgNDQuNjMyNiAxOS44MzI3IDcyLjEyNjggMTkuODMyN0M4Ny43NjggMTkuODMyNyA5NCAzMC42ODQ2IDk0IDQzLjAwNzlDOTQgNTguODI1OCA4My43MzU1IDc2LjkxMjIgNzMuNTMyMSA3Ni45MTIyQzcwLjI5MzkgNzYuOTEyMiA2OC43MDUzIDc1LjEzNDIgNjguNzA1MyA3Mi4zMTRDNjguNzA1MyA3MS41NzgzIDY4LjgyNzUgNzAuNzgxMiA2OS4wNzE5IDY5LjkyMjlDNjUuNTg5MyA3NS44Njk5IDU4Ljg2ODUgODEuMzg3OCA1Mi41NzU0IDgxLjM4NzhDNDcuOTkzIDgxLjM4NzggNDUuNjcxMyA3OC41MDYzIDQ1LjY3MTMgNzQuNDU5OEM0NS42NzEzIDcyLjk4ODQgNDUuOTc2OCA3MS40NTU2IDQ2LjUyNjcgNjkuOTIyOVpNODMuNjc2MSA0Mi41Nzk0QzgzLjY3NjEgNDYuMTcwNCA4MS41NTc1IDQ3Ljk2NTggNzkuMTg3NSA0Ny45NjU4Qzc2Ljc4MTYgNDcuOTY1OCA3NC42OTg5IDQ2LjE3MDQgNzQuNjk4OSA0Mi41Nzk0Qzc0LjY5ODkgMzguOTg4NSA3Ni43ODE2IDM3LjE5MzEgNzkuMTg3NSAzNy4xOTMxQzgxLjU1NzUgMzcuMTkzMSA4My42NzYxIDM4Ljk4ODUgODMuNjc2MSA0Mi41Nzk0Wk03MC4yMTAzIDQyLjU3OTVDNzAuMjEwMyA0Ni4xNzA0IDY4LjA5MTYgNDcuOTY1OCA2NS43MjE2IDQ3Ljk2NThDNjMuMzE1NyA0Ny45NjU4IDYxLjIzMyA0Ni4xNzA0IDYxLjIzMyA0Mi41Nzk1QzYxLjIzMyAzOC45ODg1IDYzLjMxNTcgMzcuMTkzMSA2NS43MjE2IDM3LjE5MzFDNjguMDkxNiAzNy4xOTMxIDcwLjIxMDMgMzguOTg4NSA3MC4yMTAzIDQyLjU3OTVaIiBmaWxsPSIjRkZGREY4Ii8+Cjwvc3ZnPg==",
    Solflare: "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJTIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MCA1MCI+PGRlZnM+PHN0eWxlPi5jbHMtMXtmaWxsOiMwMjA1MGE7c3Ryb2tlOiNmZmVmNDY7c3Ryb2tlLW1pdGVybGltaXQ6MTA7c3Ryb2tlLXdpZHRoOi41cHg7fS5jbHMtMntmaWxsOiNmZmVmNDY7fTwvc3R5bGU+PC9kZWZzPjxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMCIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIiByeD0iMTIiIHJ5PSIxMiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTI0LjIzLDI2LjQybDIuNDYtMi4zOCw0LjU5LDEuNWMzLjAxLDEsNC41MSwyLjg0LDQuNTEsNS40MywwLDEuOTYtLjc1LDMuMjYtMi4yNSw0LjkzbC0uNDYuNS4xNy0xLjE3Yy42Ny00LjI2LS41OC02LjA5LTQuNzItNy40M2wtNC4zLTEuMzhoMFpNMTguMDUsMTEuODVsMTIuNTIsNC4xNy0yLjcxLDIuNTktNi41MS0yLjE3Yy0yLjI1LS43NS0zLjAxLTEuOTYtMy4zLTQuNTF2LS4wOGgwWk0xNy4zLDMzLjA2bDIuODQtMi43MSw1LjM0LDEuNzVjMi44LjkyLDMuNzYsMi4xMywzLjQ2LDUuMThsLTExLjY1LTQuMjJoMFpNMTMuNzEsMjAuOTVjMC0uNzkuNDItMS41NCwxLjEzLTIuMTcuNzUsMS4wOSwyLjA1LDIuMDUsNC4wOSwyLjcxbDQuNDIsMS40Ni0yLjQ2LDIuMzgtNC4zNC0xLjQyYy0yLS42Ny0yLjg0LTEuNjctMi44NC0yLjk2TTI2LjgyLDQyLjg3YzkuMTgtNi4wOSwxNC4xMS0xMC4yMywxNC4xMS0xNS4zMiwwLTMuMzgtMi01LjI2LTYuNDMtNi43MmwtMy4zNC0xLjEzLDkuMTQtOC43Ny0xLjg0LTEuOTYtMi43MSwyLjM4LTEyLjgxLTQuMjJjLTMuOTcsMS4yOS04Ljk3LDUuMDktOC45Nyw4Ljg5LDAsLjQyLjA0LjgzLjE3LDEuMjktMy4zLDEuODgtNC42MywzLjYzLTQuNjMsNS44LDAsMi4wNSwxLjA5LDQuMDksNC41NSw1LjIybDIuNzUuOTItOS41Miw5LjE0LDEuODQsMS45NiwyLjk2LTIuNzEsMTQuNzMsNS4yMmgwWiIvPjwvc3ZnPg==",
    Jupiter: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGZpbGw9Im5vbmUiIHZpZXdCb3g9IjAgMCAzMyAzMiI+CiAgPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzExNTY1XzE2OTYyMSkiIGZpbHRlcj0idXJsKCNmaWx0ZXIwX2RfMTE1NjVfMTY5NjIxKSI+CiAgICA8cGF0aCBmaWxsPSJ1cmwoI3BhaW50MF9saW5lYXJfMTE1NjVfMTY5NjIxKSIgZD0iTTMuMDkgMjUuMTY3YTE2LjQzMyAxNi40MzMgMCAwIDAgMTEuNjIxIDYuNzVjLTEuMTg1LTEuNzg0LTIuOTA3LTMuNDI0LTUuMDU3LTQuNjczLTIuMTUtMS4yNS00LjQyOC0xLjkzMS02LjU2My0yLjA3N1oiLz4KICAgIDxwYXRoIGZpbGw9InVybCgjcGFpbnQxX2xpbmVhcl8xMTU2NV8xNjk2MjEpIiBkPSJNMTIuNTQzIDIyLjI3QzguNCAxOS44NjQgMy45MTYgMTkuMjUuNzA4IDIwLjMzNGMuMzEgMS4wMjQuNzE4IDIuMDE1IDEuMjIgMi45NiAyLjc4Ny0uMDY1IDUuODMuNjkyIDguNjYzIDIuMzM3IDIuODMyIDEuNjQ1IDQuOTk4IDMuOTE1IDYuMzIzIDYuMzY5IDEuMDctLjAzMyAyLjEzNC0uMTcgMy4xNzctLjQwNy0uNjQ4LTMuMzIzLTMuNDA2LTYuOTE1LTcuNTQ4LTkuMzIzWiIvPgogICAgPHBhdGggZmlsbD0idXJsKCNwYWludDJfbGluZWFyXzExNTY1XzE2OTYyMSkiIGQ9Ik0zMi4yODUgMTIuNUExNi40MiAxNi40MiAwIDAgMCAxMS44NDYuNjI3YzMuNTQ2LjQzNCA3LjQ4IDEuNzY1IDExLjM0IDQuMDA3IDMuODYgMi4yNDIgNi45NjcgNS4wMDEgOS4xIDcuODY4WiIvPgogICAgPHBhdGggZmlsbD0idXJsKCNwYWludDNfbGluZWFyXzExNTY1XzE2OTYyMSkiIGQ9Ik0yNy4xMjcgMjAuMzU4Yy0xLjgxNS0zLjAxMy00LjkyMy01LjktOC43NTMtOC4xMjQtMy44My0yLjIyNS03Ljg3NS0zLjQ5NS0xMS4zODktMy41OC0zLjA5MS0uMDcyLTUuNDExLjgyNi02LjM2MyAyLjQ2NmwtLjAyLjAyOGMtLjA4NS4zMDgtLjE1OS42MTYtLjIyNi45MjUgMS4zMy0uNTI1IDIuODctLjgxNyA0LjU4NC0uODUgMy44MS0uMDcxIDguMDczIDEuMTQ3IDEyLjAwOCAzLjQzMyAzLjkzNSAyLjI4NiA3LjEwOCA1LjM4OCA4LjkzMiA4LjczMi44MTggMS41MDYgMS4zMjkgMi45OSAxLjUzIDQuNDA3LjIzNi0uMjEuNDY3LS40MjguNjkxLS42NTRsLjAxNi0uMDMyYy45NTItMS42NDEuNTg0LTQuMTAxLTEuMDEtNi43NVoiLz4KICAgIDxwYXRoIGZpbGw9InVybCgjcGFpbnQ0X2xpbmVhcl8xMTU2NV8xNjk2MjEpIiBkPSJNMTUuNDYgMTcuMjQ4QzkuNTk4IDEzLjg0MiAzLjExNyAxMy4zMDkgMCAxNS42ODVjLjAwNi43NDUuMDYzIDEuNDg4LjE3IDIuMjI0YTEyLjkwNCAxMi45MDQgMCAwIDEgMi44MTctLjUyMmMzLjQ4My0uMjYyIDcuMzIyLjcwOSAxMC44MDYgMi43MzQgMy40ODQgMi4wMjUgNi4yMyA0Ljg4IDcuNzI4IDguMDMzLjQxNC44NjQuNzMgMS43NzEuOTQxIDIuNzA2YTE2LjQzIDE2LjQzIDAgMCAwIDIuMDE3LS45NTNjLjUyMi0zLjg4Ni0zLjE1Mi05LjI1MS05LjAxOC0xMi42NTlaIi8+CiAgICA8cGF0aCBmaWxsPSJ1cmwoI3BhaW50NV9saW5lYXJfMTE1NjVfMTY5NjIxKSIgZD0iTTMwLjE0MyAxNS4zMTRjLTEuODM1LTMuMDEtNC45Ny01LjkwNC04LjgyNy04LjE0NC0zLjg1Ny0yLjIzOS03LjkxOC0zLjUzLTExLjQ0My0zLjYzMy0yLjY4OC0uMDc4LTQuNzcuNTc0LTUuODQ4IDEuODA0IDQuNDgtLjc2IDEwLjM5Mi41MTcgMTYuMTIxIDMuODQ1IDUuNzMgMy4zMjkgOS43NjcgNy44MzIgMTEuMzI2IDEyLjEuNTM0LTEuNTQ1LjA3LTMuNjc2LTEuMzI5LTUuOTcyWiIvPgogIDwvZz4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8xMTU2NV8xNjk2MjEiIHgxPSIyMS41IiB4Mj0iNi42NjciIHkxPSI2LjUiIHkyPSIzMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNDN0YyODQiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMDBCRUYwIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJwYWludDFfbGluZWFyXzExNTY1XzE2OTYyMSIgeDE9IjIxLjUiIHgyPSI2LjY2NyIgeTE9IjYuNSIgeTI9IjMyIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI0M3RjI4NCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMwMEJFRjAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InBhaW50Ml9saW5lYXJfMTE1NjVfMTY5NjIxIiB4MT0iMjEuNSIgeDI9IjYuNjY3IiB5MT0iNi41IiB5Mj0iMzIiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjQzdGMjg0Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzAwQkVGMCIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQzX2xpbmVhcl8xMTU2NV8xNjk2MjEiIHgxPSIyMS41IiB4Mj0iNi42NjciIHkxPSI2LjUiIHkyPSIzMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNDN0YyODQiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMDBCRUYwIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJwYWludDRfbGluZWFyXzExNTY1XzE2OTYyMSIgeDE9IjIxLjUiIHgyPSI2LjY2NyIgeTE9IjYuNSIgeTI9IjMyIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI0M3RjI4NCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMwMEJFRjAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InBhaW50NV9saW5lYXJfMTE1NjVfMTY5NjIxIiB4MT0iMjEuNSIgeDI9IjYuNjY3IiB5MT0iNi41IiB5Mj0iMzIiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjQzdGMjg0Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzAwQkVGMCIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxjbGlwUGF0aCBpZD0iY2xpcDBfMTE1NjVfMTY5NjIxIj4KICAgICAgPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMGgzMi4yODV2MzJIMHoiLz4KICAgIDwvY2xpcFBhdGg+CiAgICA8ZmlsdGVyIGlkPSJmaWx0ZXIwX2RfMTE1NjVfMTY5NjIxIiB3aWR0aD0iNzcuNzc1IiBoZWlnaHQ9Ijc3LjQ5IiB4PSItMjIuNzQ1IiB5PSItMjAuNDciIGNvbG9yLWludGVycG9sYXRpb24tZmlsdGVycz0ic1JHQiIgZmlsdGVyVW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgPGZlRmxvb2QgZmxvb2Qtb3BhY2l0eT0iMCIgcmVzdWx0PSJCYWNrZ3JvdW5kSW1hZ2VGaXgiLz4KICAgICAgPGZlQ29sb3JNYXRyaXggaW49IlNvdXJjZUFscGhhIiByZXN1bHQ9ImhhcmRBbHBoYSIgdmFsdWVzPSIwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAxMjcgMCIvPgogICAgICA8ZmVPZmZzZXQgZHk9IjIuMjc0Ii8+CiAgICAgIDxmZUdhdXNzaWFuQmx1ciBzdGREZXZpYXRpb249IjExLjM3MiIvPgogICAgICA8ZmVDb21wb3NpdGUgaW4yPSJoYXJkQWxwaGEiIG9wZXJhdG9yPSJvdXQiLz4KICAgICAgPGZlQ29sb3JNYXRyaXggdmFsdWVzPSIwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwLjEgMCIvPgogICAgICA8ZmVCbGVuZCBpbjI9IkJhY2tncm91bmRJbWFnZUZpeCIgcmVzdWx0PSJlZmZlY3QxX2Ryb3BTaGFkb3dfMTE1NjVfMTY5NjIxIi8+CiAgICAgIDxmZUJsZW5kIGluPSJTb3VyY2VHcmFwaGljIiBpbjI9ImVmZmVjdDFfZHJvcFNoYWRvd18xMTU2NV8xNjk2MjEiIHJlc3VsdD0ic2hhcGUiLz4KICAgIDwvZmlsdGVyPgogIDwvZGVmcz4KPC9zdmc+Cg=="
  };
  var JUPITER_PKG = 'ag.jup.jupiter.android';

  // On a phone there are NO browser-extension wallets. Offer deep links that reopen the dApp INSIDE
  // the wallet's own in-app browser, where its provider is injected and connect works normally.
  function deepLinks() {
    var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    var inWalletBrowser = !!(window.phantom || window.solflare || window.backpack || window.solana);
    if (!isMobile || inWalletBrowser) return [];
    var U = encodeURIComponent(location.href), R = encodeURIComponent(location.origin);
    var jupStore = 'https://play.google.com/store/apps/details?id=' + JUPITER_PKG;
    return [
      { name: 'Phantom',  icon: WALLET_ICONS.Phantom,  dl: 'https://phantom.app/ul/browse/' + U + '?ref=' + R },
      { name: 'Solflare', icon: WALLET_ICONS.Solflare, dl: 'https://solflare.com/ul/v1/browse/' + U + '?ref=' + R },
      // Jupiter Mobile has no "open this URL in your browser" link, so copy the store link first, then
      // open the app through its verified jup.ag App Link (falls back to its Play Store page, which
      // shows "Open" when it is installed).
      { name: 'Jupiter',  icon: WALLET_ICONS.Jupiter,  copyFirst: true,
        dl: 'intent://jup.ag/#Intent;scheme=https;package=' + JUPITER_PKG + ';S.browser_fallback_url=' + encodeURIComponent(jupStore) + ';end' },
    ];
  }

  // Follow one deep link. Resolves to a short note for the user ('' when none is needed).
  function openDeepLink(d) {
    if (!d) return Promise.resolve('');
    var go = function () { window.location.href = d.dl; };
    if (!d.copyFirst) { go(); return Promise.resolve(''); }
    var copied = (navigator.clipboard && navigator.clipboard.writeText)
      ? navigator.clipboard.writeText(location.href).then(function () { return true; }, function () { return false; })
      : Promise.resolve(false);
    return copied.then(function (ok) {
      setTimeout(go, 700);   // let the note render before Android switches to the app
      return ok ? 'Store link copied — in Jupiter tap 🌐, paste it and connect.'
                : 'In Jupiter tap 🌐, open <b>' + location.host + '</b> and connect.';
    });
  }

  // Seeker-native options get a short tag so people know which one is their phone's own wallet.
  function walletTag(name) {
    if (name === 'Mobile Wallet Adapter') return 'Seed Vault';
    if (name === 'Seeker Connect') return 'Seeker';
    return '';
  }
  // Turn wallet-library errors into what to do next (the MWA library used to swallow them).
  function errorHelp(err, name) {
    var m = ((err && err.message) || String(err || 'failed')).replace(/[<&]/g, '');
    if (/local network|loopback/i.test(m)) return 'Chrome blocked the connection to your wallet. Chrome ⋮ → Settings → Site settings → <b>Local network access</b> → allow <b>' + location.hostname + '</b>, then try again.';
    if (name === 'Seeker Connect') return 'Seeker Connect couldn’t reach your wallet. Update <b>Seed Vault Wallet</b> in the dApp Store and try again.';
    if (/timed out|timeout|association/i.test(m)) return 'Your wallet didn’t answer in time. Update <b>Seed Vault Wallet</b> (dApp Store) and try again.';
    if (/not found|no installed wallet|no wallet/i.test(m)) return 'No wallet app answered. Install or update Seed Vault Wallet, Phantom or Solflare.';
    return m;
  }

  // Wallet names/icons are supplied by whatever extension registers itself — treat them as untrusted text.
  function escH(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeIcon(u) {
    u = String(u || '');
    if (/^data:image\/(png|svg\+xml|webp|jpeg|jpg|gif);base64,[A-Za-z0-9+\/=\s]+$/i.test(u) || /^https:\/\/[^\s"'<>]+$/i.test(u)) return escH(u);
    return '';
  }
  function iconImg(u) { var s = safeIcon(u); return s ? '<img src="' + s + '" alt="">' : ''; }

  function dlButton(d, i, extraStyle) { return '<button class="dwp-w" data-dl="' + i + '"' + (extraStyle ? ' style="' + extraStyle + '"' : '') + '>' + iconImg(d.icon) + '<span>Open in ' + escH(d.name) + '</span></button>'; }

  function pick() {
    return new Promise(function (resolve, reject) {
      var ws = sortWallets(enumerate());
      var dls = deepLinks();
      // auto-connect the only option, but only if there's nothing to choose between
      if (ws.length === 1 && !dls.length) { connect(ws[0]).then(resolve, reject); return; }
      ensureCss();
      var ov = document.createElement('div'); ov.className = 'dwp-ov';
      var wbtns = ws.map(function (w, i) {
        var tag = walletTag(w.name);
        return '<button class="dwp-w" data-i="' + i + '">' + iconImg(w.icon) + '<span>' + escH(w.name || 'Wallet') + '</span>' +
          (tag ? '<span style="margin-left:auto;font-size:11px;color:#7fd59b;letter-spacing:.04em">' + tag + '</span>' : '') + '</button>';
      }).join('');
      var dbtns = dls.map(function (d, i) { return dlButton(d, i); }).join('');
      var body = (wbtns + dbtns) || '<div class="dwp-empty">No Solana wallet detected.<br>Install <a href="https://phantom.app" target="_blank">Phantom</a>, <a href="https://solflare.com" target="_blank">Solflare</a> or <a href="https://backpack.app" target="_blank">Backpack</a>.</div>';
      var hint = dls.length ? '<div class="dwp-empty" style="margin-top:4px">On a Seeker, use <b>Mobile Wallet Adapter</b> (Seed Vault). Other phones: open your wallet below.</div>' : '';
      ov.innerHTML = '<div class="dwp-box"><div class="dwp-h">Connect a wallet</div>' + body + hint + '<button class="dwp-x">Cancel</button></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) {
        var d = e.target.closest && e.target.closest('[data-dl]');
        if (d) {   // hand off to the wallet's in-app browser (Jupiter: link copied first, see note)
          openDeepLink(dls[+d.dataset.dl]).then(function (note) {
            if (!note) return;
            var bx = ov.querySelector('.dwp-box'), nb = ov.querySelector('.dwp-note');
            if (!nb && bx) { nb = document.createElement('div'); nb.className = 'dwp-empty dwp-note'; nb.style.marginTop = '8px'; bx.appendChild(nb); }
            if (nb) nb.innerHTML = note;
          });
          return;
        }
        var b = e.target.closest && e.target.closest('.dwp-w');
        if (b && b.dataset.i != null) {
          var w = ws[+b.dataset.i], box = ov.querySelector('.dwp-box');
          var steps = w.name === 'Mobile Wallet Adapter'
            ? 'Tap <b>Continue to Allow</b>, then <b>Connect Wallet</b>, then approve in <b>Seed Vault</b>.'
            : 'Approve in your wallet app.';
          box.innerHTML = '<div class="dwp-h">Connecting to ' + escH(w.name || 'wallet') + '…</div><div class="dwp-empty">' + steps + '</div>';
          connect(w).then(function (a) { ov.remove(); resolve(a); }, function (err) {
            var m = ((err && err.message) || String(err || 'failed'));
            if (/cancel/i.test(m)) { ov.remove(); reject(new Error('cancelled')); return; }
            if (typeof console !== 'undefined') console.warn('[wallet] connect failed', w.name, err);
            var tryDl = deepLinks();
            var alt = tryDl.length ? ('<br><br>Or connect in your wallet’s own browser:' + tryDl.map(function (x, i) { return dlButton(x, i, 'margin-top:8px'); }).join('')) : '<br><br>Make sure a Solana wallet app is installed.';
            box.innerHTML = '<div class="dwp-h">Couldn’t connect</div><div class="dwp-empty">' + errorHelp(err, w.name) + alt + '</div><button class="dwp-x">Close</button>';
          });
          return;
        }
        if ((e.target.closest && e.target.closest('.dwp-x')) || e.target === ov) { ov.remove(); reject(new Error('cancelled')); }
      });
    });
  }

  global.DojoWalletPicker = { enumerate: enumerate, pick: pick, connect: connect, autoConnect: autoConnect, deepLinks: deepLinks, openDeepLink: openDeepLink, icons: WALLET_ICONS, bs58: bs58 };
})(window);
