/* Dojo Credits — the coin readout + paid/free gate shared by every game.
 *
 * Coins live on the SERVER (credited only by verified on-chain purchases, plus one free
 * coin per Seeker phone) and are spent only through /api/play — see dojo-wallet.js
 * (DojoWallet.begin). Nothing in localStorage is ever spendable; the old local
 * 'dojo_credits' balance (and its free welcome coins) is retired.
 * Include this on every game page:  <script src="/dojo-credits.js"></script>
 *
 * The balance is shown INSIDE each game (not a floating top badge): place a
 *   <span data-dc-credits></span>
 * wherever you want it — this script keeps every such element in sync with the server
 * balance (on load, after every play/purchase, on wallet change). "icon" style → 🪙 N.
 *
 * DojoCredits.paid() — true where games cost a coin (the store sets window.DOJO_SERVER_ECON;
 * ?ranked turns it on elsewhere). When it's false (the public main-site demos) every game is
 * FREE and DojoCredits.play() just returns true.
 */
(function () {
  if (window.DojoCredits) return;   // loaded by the page AND the shared nav wire — keep the first copy
  var CREDITS_URL = '/credits';     // where to buy more
  try { localStorage.removeItem('dojo_credits'); } catch (e) {}   // retire the old local (spendable) balance

  function W() { return window.DojoWallet; }
  function signedIn() { var w = W(); return !!(w && w.signedIn && w.signedIn()); }

  var DojoCredits = {
    /** The player's SERVER coin balance (0 until signed in — see known()). */
    get: function () { return signedIn() ? (W().coins || 0) : 0; },
    /** True once the server balance is known (signed in). */
    known: function () { return signedIn(); },
    // Coins are server-held: the client can't set or add them. Kept as no-ops for old callers.
    set: function () { paint(); },
    add: function () { paint(); },
    /** Paid economy on? (store / ranked). Games use the server path (DojoWallet.begin) when true. */
    paid: function () { return econOn(); },
    /** FREE demo gate. Returns true to let a demo game start. With the paid economy on, a coin can
     *  only be spent through the server (DojoWallet.begin) — never here — so this refuses. */
    play: function (game) {
      if (!econOn()) {
        try { localStorage.setItem('dojo_games_played', String(this.gamesPlayed() + 1)); } catch (e) {}
        return true;   // free demo (economy off)
      }
      var w = W();
      if (w && w.begin) toast('Sign in to play — tap Play again', true);
      else toast('Loading the coin wallet — one moment', true);
      return false;
    },
    /** Games played (server count when signed in; the local demo count otherwise). */
    gamesPlayed: function () {
      if (signedIn()) return W().plays || 0;
      return Number(localStorage.getItem('dojo_games_played') || 0);
    },
    creditsUrl: CREDITS_URL,
    /** Re-pull the server balance (if signed in) and repaint every readout. */
    refresh: function () { var w = W(); if (signedIn()) w.refresh().then(paint, paint); else paint(); },
    toast: function (msg, warn, href) { toast(msg, warn, href); },
  };
  window.DojoCredits = DojoCredits;

  // ---- ranked/demo gate (canonical, loaded first so every game shares it) ----
  // ?ranked turns it on (persists); ?noranked turns it off.
  if (!window.dojoRankedOn) window.dojoRankedOn = function () {
    try {
      if (/[?&]noranked\b/.test(location.search)) localStorage.removeItem('dojo_ranked');
      else if (/[?&]ranked\b/.test(location.search)) localStorage.setItem('dojo_ranked', '1');
      return localStorage.getItem('dojo_ranked') === '1';
    } catch (e) { return false; }
  };

  // Paid economy is ON in the store (it injects window.DOJO_SERVER_ECON before any game script),
  // or when explicitly ranked. A leftover DOJO_LOCAL_ECON flag from an old page also means "paid"
  // — but always via the server ledger, never a local balance.
  function econOn() { return !!(window.DOJO_SERVER_ECON || window.DOJO_LOCAL_ECON) || !!(window.dojoRankedOn && window.dojoRankedOn()); }

  // ---- keep every in-game credits readout in sync (and enforce the demo gate) ----
  function paint() {
    if (!econOn()) {
      // demo mode: hide coin balances, 🏆 scoreboard buttons, and any economy copy
      // (pots, raffle chances, coin prices) marked `.dojo-econ`. Pure free game only.
      var hide = document.querySelectorAll('[data-dc-credits],[title="Scoreboard"],.dojo-econ');
      for (var h = 0; h < hide.length; h++) hide[h].style.display = 'none';
      return;
    }
    var els = document.querySelectorAll('[data-dc-credits]');
    // Coins belong to a wallet — no wallet connected and no session → no coin readout at all.
    if (!window.DOJO_WALLET && !signedIn()) {
      for (var j = 0; j < els.length; j++) els[j].style.display = 'none';
      return;
    }
    var known = signedIn(), n = DojoCredits.get();
    for (var i = 0; i < els.length; i++) {
      var style = els[i].getAttribute('data-dc-credits');   // "" = plain number, "icon" = 🪙 N
      els[i].style.display = '';
      // connected but not signed in yet: the balance isn't known → "–" (tap it to sign in)
      els[i].textContent = (style === 'icon' ? '🪙 ' : '') + (known ? n : '–');
      els[i].title = known ? 'Your coins' : 'Sign in to see your coins';
      els[i].style.cursor = known ? '' : 'pointer';
    }
  }
  // tapping an unknown "–" balance signs in (one free signature) and shows the real number
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-dc-credits]') : null;
    if (!el || !econOn() || signedIn()) return;
    var w = W(); if (w && w.signIn) w.signIn().then(paint).catch(function () {});
  });

  // ---- tiny transient toast (feedback only, auto-hides — not a persistent bar) ----
  // With `href` it becomes a tappable link (e.g. "Out of coins → /credits") and stays longer.
  var toastEl, toastT;
  function toast(msg, warn, href) {
    if (!toastEl) {
      var css = document.createElement('style');
      css.textContent = '#dc-toast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,140%);z-index:99999;' +
        'background:#241d18;border:1px solid #c9973a;color:#ece4d6;padding:9px 16px;border-radius:11px;max-width:90vw;text-align:center;' +
        "font-family:'Teko','Trebuchet MS',sans-serif;font-size:17px;letter-spacing:.03em;opacity:0;text-decoration:none;display:block;" +
        'transition:transform .28s,opacity .28s;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.5);}' +
        '#dc-toast.show{transform:translate(-50%,0);opacity:1;}#dc-toast.warn{border-color:#c1443a;color:#f0c9c4;}' +
        '#dc-toast.link.show{pointer-events:auto;cursor:pointer;}';
      document.head.appendChild(css);
      toastEl = document.createElement('a'); toastEl.id = 'dc-toast'; document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.className = (warn ? 'warn' : '') + (href ? ' link' : '');
    if (href) toastEl.setAttribute('href', href); else toastEl.removeAttribute('href');
    void toastEl.offsetWidth; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('show'); }, href ? 5000 : 2600);
  }

  window.addEventListener('dojo-wallet-change', paint);   // show/hide coins the moment a wallet connects/disconnects
  window.addEventListener('dojo-coins-change', paint);    // DojoWallet fires this after every refresh/play/claim
  window.addEventListener('pageshow', function () { DojoCredits.refresh(); });   // back from /credits → fresh balance
  // a light interval catches changes made by other scripts without an event
  setInterval(paint, 900);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
})();
