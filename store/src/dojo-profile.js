/* Dojo Profile — the connected-wallet menu + profile card, shared across every store page.
 * Clicking the connected wallet button opens a small menu: Profile / Disconnect.
 * Profile shows the player's coins, games played, and their affiliate link + returns
 * (the full affiliate dashboard, with the signed stats, lives on /become-a-preacher).
 * Depends only on window.DojoCredits (coins/games — the SERVER balance via DojoWallet) and
 * window.DOJO_WALLET (address). Coins show "–" until the player has signed in.
 */
(function () {
  if (window.DojoProfile) return;
  var sh = function (p) { return p ? p.slice(0, 4) + '…' + p.slice(-4) : ''; };
  var coins = function () { try { return window.DojoCredits && (!DojoCredits.known || DojoCredits.known()) ? DojoCredits.get().toLocaleString() : '–'; } catch (e) { return '–'; } };
  var games = function () { try { return window.DojoCredits && DojoCredits.gamesPlayed ? DojoCredits.gamesPlayed() : Number(localStorage.getItem('dojo_games_played') || 0); } catch (e) { return 0; } };

  // ---- one-time styles ----
  var css = document.createElement('style');
  css.textContent = [
    ".dp-menu{position:fixed;z-index:120;min-width:172px;background:#141019;border:1px solid rgba(201,151,58,.45);border-radius:11px;",
    "box-shadow:0 14px 34px rgba(0,0,0,.6);padding:6px;font-family:'Cinzel',serif;opacity:0;transform:translateY(-6px);transition:opacity .13s,transform .13s;}",
    ".dp-menu.on{opacity:1;transform:none;}",
    ".dp-menu button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:transparent;border:none;color:#efe6d2;",
    "font-family:'Cinzel',serif;font-size:12px;font-weight:700;letter-spacing:.04em;padding:10px 12px;border-radius:8px;cursor:pointer;}",
    ".dp-menu button:hover{background:rgba(201,151,58,.14);color:#e8b84b;}",
    ".dp-menu .dp-dc{color:#e0655c;} .dp-menu .dp-dc:hover{background:rgba(224,101,92,.12);color:#e0655c;}",
    ".dp-back{position:fixed;inset:0;z-index:119;background:rgba(6,5,10,.72);backdrop-filter:blur(5px);display:none;}",
    ".dp-back.on{display:flex;align-items:center;justify-content:center;padding:18px;}",
    ".dp-card{width:min(420px,100%);background:#120f18;border:1px solid rgba(201,151,58,.4);border-radius:18px;overflow:hidden;",
    "box-shadow:0 24px 60px rgba(0,0,0,.6);background-image:radial-gradient(520px 240px at 100% -20%,rgba(192,57,43,.18),transparent 60%);font-family:'Inter',sans-serif;}",
    ".dp-hd{display:flex;align-items:center;gap:12px;padding:20px 22px 16px;border-bottom:1px solid rgba(201,151,58,.18);}",
    ".dp-av{width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#c8962a,#8b6018);display:grid;place-items:center;font-size:22px;flex:0 0 auto;}",
    ".dp-who{font-family:'Cinzel',serif;font-size:15px;font-weight:700;color:#efe6d2;letter-spacing:.04em;}",
    ".dp-addr{font-size:12px;color:#a99a80;cursor:pointer;margin-top:2px;} .dp-addr:hover{color:#e8b84b;}",
    ".dp-x{margin-left:auto;background:transparent;border:none;color:#a99a80;font-size:20px;cursor:pointer;line-height:1;}",
    ".dp-x:hover{color:#efe6d2;}",
    ".dp-stats{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:18px 22px 6px;}",
    ".dp-st{border:1px solid rgba(201,151,58,.22);border-radius:12px;background:rgba(201,151,58,.05);padding:13px 14px;}",
    ".dp-st .k{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#a99a80;font-weight:600;}",
    ".dp-st .v{font-family:'Teko',sans-serif;font-size:30px;line-height:1;color:#e8b84b;margin-top:3px;}",
    ".dp-sec{padding:14px 22px 6px;}",
    ".dp-sec .lbl{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#a99a80;font-weight:600;margin-bottom:8px;}",
    ".dp-aff{display:flex;align-items:center;gap:10px;border:1px solid rgba(201,151,58,.25);border-radius:12px;padding:12px 14px;background:rgba(0,0,0,.2);}",
    ".dp-aff .t{font-size:13px;color:#efe6d2;flex:1;} .dp-aff .t b{color:#e8b84b;}",
    ".dp-foot{display:flex;gap:10px;padding:16px 22px 22px;}",
    ".dp-btn{flex:1;text-align:center;text-decoration:none;font-family:'Cinzel',serif;font-size:12px;font-weight:700;letter-spacing:.05em;",
    "padding:12px 10px;border-radius:10px;cursor:pointer;}",
    ".dp-btn.g{background:linear-gradient(135deg,#c8962a,#8b6018);color:#0a0814;border:none;}",
    ".dp-btn.o{background:transparent;border:1px solid rgba(201,151,58,.5);color:#e8b84b;}",
    ".dp-btn:hover{filter:brightness(1.08);}"
  ].join('');
  document.head.appendChild(css);

  var menuEl = null, backEl = null;

  function closeMenu() { if (menuEl) { menuEl.classList.remove('on'); var m = menuEl; setTimeout(function () { if (m && m.parentNode) m.parentNode.removeChild(m); }, 140); menuEl = null; document.removeEventListener('click', onDoc, true); } }
  function onDoc(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }

  function menu(anchor, pubkey, onDisconnect) {
    closeMenu();
    var r = anchor.getBoundingClientRect();
    menuEl = document.createElement('div');
    menuEl.className = 'dp-menu';
    menuEl.innerHTML = '<button type="button" class="dp-pf">👤 Profile</button><button type="button" class="dp-dc">⏻ Disconnect</button>';
    document.body.appendChild(menuEl);
    // place under the button, right-aligned, kept on-screen
    var w = menuEl.offsetWidth, left = Math.min(r.right - w, window.innerWidth - w - 8);
    menuEl.style.left = Math.max(8, left) + 'px';
    menuEl.style.top = (r.bottom + 8) + 'px';
    menuEl.querySelector('.dp-pf').onclick = function () { closeMenu(); open(pubkey); };
    menuEl.querySelector('.dp-dc').onclick = function () { closeMenu(); if (onDisconnect) onDisconnect(); };
    requestAnimationFrame(function () { if (menuEl) menuEl.classList.add('on'); });
    setTimeout(function () { document.addEventListener('click', onDoc, true); }, 0);
  }

  function open(pubkey) {
    pubkey = pubkey || (window.DOJO_WALLET && window.DOJO_WALLET.pubkey) || '';
    if (!backEl) {
      backEl = document.createElement('div');
      backEl.className = 'dp-back';
      backEl.addEventListener('click', function (e) { if (e.target === backEl) hide(); });
      document.body.appendChild(backEl);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    }
    backEl.innerHTML =
      '<div class="dp-card">' +
        '<div class="dp-hd"><div class="dp-av">道</div>' +
          '<div><div class="dp-who">Your Dojo</div><div class="dp-addr" title="Copy address">' + sh(pubkey) + ' ⧉</div></div>' +
          '<button class="dp-x" aria-label="Close">×</button></div>' +
        '<div class="dp-stats">' +
          '<div class="dp-st"><div class="k">Coins</div><div class="v dp-coins">🪙 ' + coins() + '</div></div>' +
          '<div class="dp-st"><div class="k">Games played</div><div class="v">' + games().toLocaleString() + '</div></div>' +
        '</div>' +
        '<div class="dp-sec"><div class="lbl">Affiliate &amp; returns</div>' +
          '<div class="dp-aff"><div class="t">Your <b>preacher link</b> + referral earnings</div>' +
          '<a class="dp-btn o" style="flex:0 0 auto;padding:9px 14px;text-decoration:none;" href="/become-a-preacher">Open →</a></div></div>' +
        '<div class="dp-foot">' +
          '<a class="dp-btn g" href="/credits">＋ Buy coins</a>' +
          '<a class="dp-btn o" href="/play">▶ Play</a>' +
        '</div>' +
      '</div>';
    backEl.querySelector('.dp-x').onclick = hide;
    var addr = backEl.querySelector('.dp-addr');
    if (addr) addr.onclick = function () { try { navigator.clipboard.writeText(pubkey); addr.textContent = 'Copied ✓'; setTimeout(function () { addr.textContent = sh(pubkey) + ' ⧉'; }, 1200); } catch (e) {} };
    backEl.classList.add('on');
    // pull the live server balance (signed-in players) and update the card in place
    if (window.DojoWallet && DojoWallet.signedIn && DojoWallet.signedIn()) DojoWallet.refresh().then(function () {
      var v = backEl.querySelector('.dp-coins'); if (v) v.textContent = '🪙 ' + coins();
    }).catch(function () {});
  }
  function hide() { if (backEl) backEl.classList.remove('on'); }

  window.DojoProfile = { menu: menu, open: open };
})();
