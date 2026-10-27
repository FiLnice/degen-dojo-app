// Dojo Burn — get rent back from a wallet: close its EMPTY token accounts and BURN the NFTs its owner ticks (Token
// Metadata BurnV1, standard + programmable; Metaplex Core BurnV1). ONE shared module (window.DojoBurn), served at /dojo-burn.js and used by
// the store's Dojo Sweep page (/sweep) and the miner's burn mode (/mine?burn=1) — so the burn logic exists once.
// The owner gets everything reclaimed minus the 1% Dojo fee (in the same tx; see "the Dojo fee" below — Burn to Mine
// skips it here and pays its one 1% on the mining deposit). Nothing here signs or sends — it scans, builds and SIMULATES; the
// page hands the transactions to the owner's own wallet. Plain JS on window.solanaWeb3 (the store's self-hosted
// /web3.js, or the miner's bundled web3.js set on window before this loads); also runs in node for the tests.
(function (global) {
  var W3 = function () { return global.solanaWeb3 || global.SolanaWeb3 || global.web3; };
  var PK = function (x) { return typeof x === 'string' ? new (W3().PublicKey)(x) : x; };
  var pda = function (seeds, prog) { return W3().PublicKey.findProgramAddressSync(seeds, PK(prog))[0]; };
  var utf8 = function (s) { return new TextEncoder().encode(s); };
  var BufCls = function () { return global.Buffer || (W3() && W3().Buffer); };
  var Buf = function (u8) { var B = BufCls(); return B ? B.from(u8) : u8; };
  var b64 = function (s) { return BufCls().from(s, 'base64'); };
  var rdU64 = function (b, o) { var n = 0n; for (var i = 7; i >= 0; i--) n = (n << 8n) + BigInt(b[o + i]); return n; };
  var keyAt = function (b, o) { return new (W3().PublicKey)(b.subarray(o, o + 32)).toBase58(); };
  function u64le(v) { var b = new Uint8Array(8), n = BigInt(v); for (var i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; }
  var chunks = function (a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

  var TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  var META = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', SYS = '11111111111111111111111111111111';
  var SYSVAR_IX = 'Sysvar1nstructions1111111111111111111111111';
  var CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', CORE_PAGES = 8, CORE_LIMIT = 250;   // Metaplex Core · ≤ 2,000 Core NFTs read a wallet (the proxy caps pages of 250)
  // The owner's own collections are never offered for burning (Degen Dojo · Demon Dojo · TETO).
  var KEEP = { '2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb': 1, 'WyUy9qjJekjqTAYGanANjhtviwgu1uhCkXx1uas8fWb': 1, 'dgd6We3oS4M5LSVzT6Ep39wwVpjLC336tCpyPZkLAHx': 1 };
  // NFTs that represent something (liquidity positions, device passes) — shown, never offered for burning
  // The same three collections by who controls them, for an NFT whose collection isn't verified at the moment (e.g. a Demon
  // mid-move on Nov 2). Checked on-chain 2026-10-27: every Degen Dojo / Demon Dojo / TETO NFT has update authority DfaGo3…
  // and first (only) verified creator HEyazx….
  var KEEP_AUTH = { 'DfaGo3Qht6MC2bqgFCBHgUWjaeXDNmsbE7XjyRKWM3qS': 1 };
  var KEEP_CREATOR = { 'HEyazxpV2wxMUvNx53UZUXthRS9Rjsbv7hoHYJNbVedC': 1 };
  var KEEP_RE = /\b(position|liquidity|whirlpool|orca|raydium|meteora|kamino|lifinity|crema|invariant|concentrated|genesis token|seeker genesis|saga genesis)\b/i;
  // Floor-price guard (owner 2026-10-27): an NFT whose collection floor is at least FLOOR_MAX SOL is worth more listed than
  // burned — hidden from the burn lists by default and never bulk-picked. Floors come from the store's /api/floors (Magic Eden).
  var FLOOR_MAX = 0.05, FLOORS_URL = '/api/floors', FLOOR_BATCH = 40, FLOOR_TRIES = 6, FLOOR_PAUSE = 600, FLOOR_PAR = 2, FLOOR_REQS = 10, FLOOR_DEADLINE = 10000;   // ≤ 10 floor requests a scan (the server allows 12 a minute per visitor); no new round after 10 s   // the server does ≤ 10 new Magic Eden lookups a request, so a fresh wallet takes a few asks
  var floorsFetch = null;   // tests: DojoBurn.useFloors(fn) swaps in a stub
  var TX_MAX = 1232, CU_PRICE = 100000;   // packet limit; priority fee ≈ 0.00001–0.00005 SOL a transaction
  // Token-2022 account extensions that don't stop a plain close (anything else is left alone)
  var CLOSE_OK_EXT = { immutableOwner: 1, transferFeeAmount: 1, memoTransfer: 1, cpiGuard: 1, nonTransferableAccount: 1, transferHookAccount: 1 };
  var SPAM = /(claim|airdrop|reward|visit|voucher|gift|bonus|giveaway|winner|congrat|redeem|free\s|\$\d|https?:|www\.|\.com\b|\.io\b|\.xyz\b|\.net\b|\.app\b|\.site\b|\.link\b|\.org\b|t\.me)/i;

  var metaOf = function (mint) { return pda([utf8('metadata'), PK(META).toBuffer(), PK(mint).toBuffer()], META); };
  var editionOf = function (mint) { return pda([utf8('metadata'), PK(META).toBuffer(), PK(mint).toBuffer(), utf8('edition')], META); };
  var tokenRecordOf = function (mint, ta) { return pda([utf8('metadata'), PK(META).toBuffer(), PK(mint).toBuffer(), utf8('token_record'), PK(ta).toBuffer()], META); };
  var acct = function (pk, s, w) { return { pubkey: PK(pk), isSigner: s, isWritable: w }; };
  var ix = function (programId, keys, data) { return new (W3().TransactionInstruction)({ programId: PK(programId), keys: keys, data: Buf(data) }); };

  // ── one paced JSON-RPC client for the pages (live bug 2026-10-26: a heavy wallet's scan hit 429 and died) ──────────
  // ≤ 4 requests in flight and ≥ 100 ms between starts (≤ 10 a second; a scan is ~15 calls + ~10–20 burn simulations, well
  // under the proxy's 480 a minute and its 90 DAS calls a minute — a scan makes ~5); 429 / 502 / 503 / 504 / network errors are retried after 2, 5, 10, 20 and 30 s — or the server's
  // Retry-After (capped at 30 s). opts: { fetch, inFlight, gapMs, waits, onRetry(attempt, ms, method) }.
  // rpc.stats = { calls, retries } counts every HTTP request (the scan logs its share on localhost).
  function makeRpc(url, opts) {
    opts = opts || {};
    var doFetch = opts.fetch || function (u, o) { return global.fetch(u, o); };
    // Netlify's own limit on /api/rpc counts 60-second windows per IP and answers an empty 429 with no Retry-After, so the
    // waits reach past a full window (2+5+10+20+30 s) — and while ANY call waits, the whole client pauses: queued calls
    // firing into the same window would only keep the counter high (live 2026-10-26: the owner's own tabs + scans).
    var maxIn = opts.inFlight || 4, gap = opts.gapMs == null ? 100 : opts.gapMs, waits = opts.waits || [2000, 5000, 10000, 20000, 30000];
    var inFlight = 0, lastStart = 0, pausedUntil = 0, queue = [], stats = { calls: 0, retries: 0 };
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    function pump() {
      if (!queue.length || inFlight >= maxIn) return;
      var paused = pausedUntil - Date.now();
      if (paused > 0) { setTimeout(pump, paused); return; }
      var wait = lastStart + gap - Date.now();
      if (wait > 0) { setTimeout(pump, wait); return; }
      inFlight++; lastStart = Date.now(); queue.shift()();
      if (queue.length) setTimeout(pump, gap);
    }
    var acquire = function () { return new Promise(function (res) { queue.push(res); pump(); }); };
    var release = function () { inFlight--; pump(); };
    var busyMsg = function (m) { return /rate.?limit|too many requests|busy|try again/i.test(String(m || '')); };
    async function call(method, params) {
      for (var attempt = 0; ; attempt++) {
        await acquire();
        var status = 0, ra = null, j = null, netErr = null;
        try {
          stats.calls++;
          var r = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) });
          status = r.status; ra = r.headers && r.headers.get ? r.headers.get('retry-after') : null;
          j = await r.json().catch(function () { return null; });
        } catch (e) { netErr = e; } finally { release(); }
        var busy = !!netErr || status === 429 || status === 502 || status === 503 || status === 504 || (!!j && !!j.error && (j.error.code === 429 || busyMsg(j.error.message)));
        if (busy && attempt < waits.length) {
          var raMs = ra == null ? NaN : (isFinite(ra) ? Number(ra) * 1000 : Date.parse(ra) - Date.now());
          var ms = isFinite(raMs) && raMs > 0 ? Math.min(raMs, 30000) : waits[attempt];
          pausedUntil = Math.max(pausedUntil, Date.now() + ms);   // everyone waits, not just this call
          stats.retries++;
          if (opts.onRetry) try { opts.onRetry(attempt + 1, ms, method); } catch (e) { /* UI only */ }
          await sleep(ms);
          continue;
        }
        if (netErr) throw netErr;
        if (j && j.error) { var er = new Error(j.error.message || 'RPC error'); er.status = status; throw er; }
        if (status >= 400 || !j) { var eh = new Error('HTTP ' + status); eh.status = status; throw eh; }
        return j.result;
      }
    }
    call.stats = stats;
    return call;
  }
  var devLog = function () { try { if (global.DOJO_DEBUG || (global.location && /^(localhost|127\.0\.0\.1)$/.test(global.location.hostname))) console.info.apply(console, ['[DojoBurn]'].concat([].slice.call(arguments))); } catch (e) { /* no console */ } };

  // ── scan: empty token accounts + the NFTs that could be burned (and the ones a staking program holds) ──────────
  // Independent reads run side by side through the paced client (owner 2026-10-27: "quite slow"): balance, both token
  // programs, the Core search and the rent minimum start together; the NFT batches, collection reads and account reads each
  // go out as one parallel round. onList(out) fires as soon as the burn list is known — BEFORE the floor prices
  // (out.floorsPending = true): a page may show the NFTs then, but nothing may be ticked until the scan resolves (floors in).
  // The NFT candidates come from the token accounts
  // already read — amount 1, decimals 0, classic Token and Token-2022 — then getAssetBatch in chunks of 100 (compressed
  // spam has no token account, so it never costs a call), then the exact rent from getMultipleAccounts (no simulation).
  // Metaplex Core NFTs have no token account at all, so they come from one DAS searchAssets call (interface MplCoreAsset,
  // 1,000 a page) and their rent from the same getMultipleAccounts batches.
  // A chunk that still fails after the client's retries is skipped, not fatal: out.unread counts what couldn't be read.
  // A Core NFT frozen by a FreezeDelegate / PermanentFreezeDelegate plugin (as DAS reports it: snake_case or camelCase keys)
  // can't be burned by its owner → { by: the plugin authority's address, or null when no address holds it }; not frozen → null.
  /** A Core NFT whose TransferDelegate / BurnDelegate is held by another address — a marketplace listing or a lend. */
  function coreDelegated(a, owner) {
    var p = a.plugins || {}, by = null;
    Object.keys(p).forEach(function (k) {
      var n = k.replace(/_/g, '').toLowerCase(), x = p[k], au = x && x.authority;
      if (!by && (n === 'transferdelegate' || n === 'burndelegate') && au && au.address && au.address !== owner && String(au.type || 'Address').toLowerCase() === 'address') by = au.address;
    });
    return by;
  }
  /** A FreezeDelegate / PermanentFreezeDelegate plugin with frozen = true (on an asset, or on a Core collection). */
  function pluginFrozen(a) {
    var p = (a && a.plugins) || {}, hit = null;
    Object.keys(p).forEach(function (k) {
      var n = k.replace(/_/g, '').toLowerCase(), x = p[k];
      if (!hit && (n === 'freezedelegate' || n === 'permanentfreezedelegate') && x && x.data && x.data.frozen) hit = { by: (x.authority && x.authority.address) || null };
    });
    return hit;
  }
  function coreHold(a) {
    var hit = pluginFrozen(a);
    if (!hit && a.ownership && a.ownership.frozen) hit = { by: a.ownership.delegate || null };
    return hit;
  }
  // Collection floors for the offered NFTs: one group per floor key (collection → creator → mint), collections first,
  // ≤ FLOOR_BATCH a request; keys the server couldn't settle in time come back as "pending" and are asked again. Any
  // failure leaves floorSol null = "floor unknown" (shown with a tag) — it never stops the scan.
  async function attachFloors(items, step) {
    var groups = {}, order = [];
    items.forEach(function (c) { if (!groups[c.floorKey]) { groups[c.floorKey] = { key: c.floorKey, sampleMint: c.mint, coll: !!c.collection, mintKey: c.floorKey === c.mint }; order.push(groups[c.floorKey]); } });
    order.sort(function (a, b) { return (b.coll - a.coll) || (a.mintKey - b.mintKey); });
    var floors = {}, todo = order.map(function (g) { return { key: g.key, sampleMint: g.sampleMint }; }), calls = 0, t0 = Date.now();
    var fetcher = floorsFetch || (typeof location !== 'undefined' && global.fetch ? function (body) {
      return global.fetch(FLOORS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.ok ? r.json() : null; });
    } : null);
    for (var tryN = 0, stuck = 0, dead = 0; fetcher && todo.length && tryN < FLOOR_TRIES && calls < FLOOR_REQS && Date.now() - t0 < FLOOR_DEADLINE; tryN++) {
      // a round that settled nothing (Magic Eden busy / budgets spent) waits longer before asking again
      if (tryN) await new Promise(function (r) { setTimeout(r, Math.min(FLOOR_PAUSE * (1 + 2 * stuck), Math.max(0, FLOOR_DEADLINE - (Date.now() - t0)))); });
      if (tryN && Date.now() - t0 >= FLOOR_DEADLINE) break;   // the pause ran into the deadline: stop here (unknown floors fall back to the safe rules)
      var before = todo.length, answered = 0;
      // small batches, FLOOR_PAR at a time: the server settles ≤ ~10 new Magic Eden lookups a request (≈ 5 collections),
      // so one round of a few small requests beats rounds of one big one (live 43S5…: 5 rounds, 11 s → 1–2 rounds)
      var next = [], size = Math.min(FLOOR_BATCH, Math.max(6, Math.ceil(todo.length / 6))), bs = chunks(todo, size);
      step && step('Checking floor prices… ' + Object.keys(floors).length + ' of ' + order.length + ' collections');
      for (var bi = 0; bi < bs.length; bi += FLOOR_PAR) {
        var wave = bs.slice(bi, bi + Math.min(FLOOR_PAR, FLOOR_REQS - calls));
        if (!wave.length) { for (var rest = bi; rest < bs.length; rest++) next = next.concat(bs[rest]); break; }
        var ress = await Promise.all(wave.map(function (b) { calls++; return Promise.resolve().then(function () { return fetcher({ groups: b }); }).catch(function () { return null; }); }));
        wave.forEach(function (b, wi) {
          var res = ress[wi], pend = {}; if (res) answered++; ((res && res.pending) || []).forEach(function (k) { pend[k] = 1; });
          b.forEach(function (g) {
            var v = res && res.floors ? res.floors[g.key] : undefined;
            if (!res || pend[g.key]) next.push(g); else floors[g.key] = typeof v === 'number' && v > 0 ? v : null;
          });
        });
      }
      todo = next; stuck = todo.length >= before ? stuck + 1 : 0;
      dead = answered ? 0 : dead + 1; if (dead >= 2) break;   // no answer at all twice (the service is down / unreachable): stop — unknown floors fall back to the safe rules
    }
    items.forEach(function (c) { var v = floors[c.floorKey]; c.floorSol = typeof v === 'number' ? v : null; });
    // "degraded": the floors of verified collections couldn't be read for more than a few — Magic Eden down, rate-limited, or
    // /api/floors unreachable. Then those NFTs aren't shown by default (they could be worth something); spam stays visible.
    var vg = order.filter(function (g) { return g.coll; }), vu = vg.filter(function (g) { return !(typeof floors[g.key] === 'number'); });
    var unknownVerified = vu.length, degraded = !fetcher ? false : unknownVerified > Math.max(2, Math.floor(vg.length * 0.25));
    return { groups: order.length, calls: calls, unknown: items.filter(function (c) { return c.floorSol == null; }).length, unknownVerified: unknownVerified, degraded: degraded, high: items.filter(floorHigh).length, ms: Date.now() - t0 };
  }
  /** Worth more listed than burned: a known collection floor of at least FLOOR_MAX SOL. */
  function floorHigh(c) { return !!c && typeof c.floorSol === 'number' && c.floorSol >= FLOOR_MAX; }
  /** A verified-collection NFT whose floor couldn't be read. */
  function floorUnknownVerified(c) { return !!c && !!c.collection && c.floorSol == null; }
  /** The burn list as shown: by default ("Floor below 0.05 SOL") without the high-floor ones — and, when the floors are
   *  degraded, without verified-collection NFTs of unknown floor; showAll = everything. */
  function visibleNfts(list, showAll, degraded) {
    return showAll ? list : list.filter(function (c) { return !floorHigh(c) && !(degraded && floorUnknownVerified(c)); });
  }
  /** Bulk picks ("Select all likely spam"): burnable + flagged by the spam check, never a high floor, and a verified-collection
   *  NFT only when its floor is KNOWN to be under FLOOR_MAX (the spam check alone can flag a real project). */
  function junkPicks(list) {
    return list.filter(function (c) {
      return c.burnable && c.junk >= 3 && !floorHigh(c) && (!c.collection || (typeof c.floorSol === 'number' && c.floorSol < FLOOR_MAX));
    });
  }
  // L6: a thumbnail the resizer refuses may load from its original host only when that host is a storage network (not a spam
  // tracker that would see the visitor's IP next to the wallet being scanned)
  var RAW_IMG_HOSTS = /(^|\.)(arweave\.net|irys\.xyz|ipfs\.io|dweb\.link|nftstorage\.link|w3s\.link|cloudflare-ipfs\.com|mypinata\.cloud|pinata\.cloud|degendojo\.s3\.us-west-1\.amazonaws\.com)$/i;
  function rawImageOk(url) {
    try { var u = new URL(url); return u.protocol === 'https:' && RAW_IMG_HOSTS.test(u.hostname); } catch (e) { return false; }
  }

  async function scan(rpc, owner, onStep, onList) {
    var step = onStep || function () {};
    var t0 = Date.now(), c0 = rpc.stats ? rpc.stats.calls : 0;
    var out = { owner: owner, sol: 0, empties: [], skipped: [], nfts: [], soft: [], locked: [], unread: 0, floorsPending: true };
    var miss = function (n) { out.unread += n; };
    var settle = function (p) { return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; }); };
    step('Reading wallet…');
    var progs = [TOKEN, TOKEN22];
    var balP = settle(rpc('getBalance', [owner]));
    var taP = progs.map(function (pr) { return settle(rpc('getTokenAccountsByOwner', [owner, { programId: pr }, { encoding: 'jsonParsed' }])); });
    // Metaplex Core NFTs have no token account: their DAS search runs alongside (pages one after another, only while full)
    var coreP = (async function () {
      var items = [];
      for (var pg = 1; pg <= CORE_PAGES; pg++) {
        var sa;
        try { sa = await rpc('searchAssets', { ownerAddress: owner, interface: 'MplCoreAsset', burnt: false, page: pg, limit: CORE_LIMIT }); }
        catch (e) { miss(1); break; }
        var its = (sa && sa.items) || []; items = items.concat(its);
        if (its.length < CORE_LIMIT) break;
      }
      return items;
    })();
    var keep1P = settle(rpc('getMinimumBalanceForRentExemption', [1]));   // the Core burn's 1-byte tombstone (cheap; read early)
    var bal = await balP; if (!bal.ok) throw bal.e; out.sol = (bal.v && bal.v.value) || 0;
    var nftAccts = {}, tas = await Promise.all(taP);
    for (var p = 0; p < progs.length; p++) {
      if (!tas[p].ok) { if (p === 0) throw tas[p].e; miss(1); continue; }   // classic Token is the scan; a Token-2022 failure is partial
      var r = tas[p].v;
      ((r && r.value) || []).forEach(function (a) {
        var info = a.account.data.parsed.info, amt = info.tokenAmount, row = { pubkey: a.pubkey, program: progs[p], lamports: a.account.lamports, mint: info.mint };
        if (amt.amount === '0') {
          var why = null;
          if (info.state !== 'initialized') why = 'frozen';
          else if (info.closeAuthority && info.closeAuthority !== owner) why = 'another wallet controls closing it';
          else (info.extensions || []).forEach(function (e) {
            if (!CLOSE_OK_EXT[e.extension]) why = why || ('has a ' + e.extension + ' extension');
            else if (e.extension === 'transferFeeAmount' && e.state && Number(e.state.withheldAmount) > 0) why = why || 'holds withheld transfer fees';
          });
          if (why) out.skipped.push(Object.assign(row, { reason: why })); else out.empties.push(row);
        } else if (amt.decimals === 0 && amt.amount === '1') {
          nftAccts[info.mint] = { tokenAccount: a.pubkey, tokenLamports: a.account.lamports, tokenProgram: progs[p], frozen: info.state === 'frozen', delegate: info.delegate || null };
        }
      });
    }
    // NFT details for exactly those mints
    var mints = Object.keys(nftAccts), assets = {}, mc = chunks(mints, 50);   // DAS answers 50-id batches far faster than 100
    step('Reading ' + mints.length + ' NFTs…');
    await Promise.all(mc.map(function (ids) {
      return rpc('getAssetBatch', { ids: ids }).then(function (ab) { (ab || []).forEach(function (a) { if (a && a.id) assets[a.id] = a; }); },
        function () { miss(ids.length); ids.forEach(function (m) { nftAccts[m].unread = true; }); });
    }));
    var cands = [], collOf = {};
    // what every NFT kind is judged on: its collection, name, spam score and the "it IS something" guard. null = never offered.
    var judge = function (a) {
      var g = ((a.grouping || []).filter(function (x) { return x.group_key === 'collection'; })[0]) || null;
      if (g && KEEP[g.group_value]) return null;   // the owner's own collections: never offered
      if ((a.authorities || []).some(function (x) { return x && KEEP_AUTH[x.address]; })) return null;
      if ((a.creators || []).some(function (c) { return c && c.verified && KEEP_CREATOR[c.address]; })) return null;
      var md = (a.content && a.content.metadata) || {}, name = String(md.name || 'Unnamed NFT');
      // spam = a lure in the name / symbol, or a description that pairs a lure word with a link ("claim at https://…")
      var desc = String(md.description || ''), lure = SPAM.test([name, md.symbol].join(' ')) || (/(claim|airdrop|reward|visit|voucher|redeem|giveaway|winner)/i.test(desc) && /(https?:|www\.|\.com\b|\.io\b|\.xyz\b|t\.me)/i.test(desc));
      var image = (a.content && a.content.links && a.content.links.image) || '';
      // Never burn an NFT that IS something: a DeFi liquidity position (burning it strands the liquidity for good) or a
      // device / genesis pass (Seeker, Saga). Most have no master edition and fail the checks below anyway — this makes it explicit.
      var keep = KEEP_RE.test([name, md.symbol].join(' ')) || /^(OWP|RCL|DLMM|DAMM|LP)$/i.test(String(md.symbol || ''));
      if (g) collOf[g.group_value] = '';
      var vc = (a.creators || []).filter(function (c) { return c && c.verified && c.address; })[0];
      return { g: g, fk: g ? g.group_value : (vc ? vc.address : null), name: name, image: image, junk: (g ? 0 : 2) + (lure ? 3 : 0) + (image ? 0 : 1), why: keep ? 'a DeFi position or pass — never burned here' : null };
    };
    mints.forEach(function (mint) {
      var t = nftAccts[mint], a = assets[mint];
      if (t.unread || !a || (a.compression && a.compression.compressed) || a.burnt) return;
      if (a.interface !== 'V1_NFT' && a.interface !== 'ProgrammableNFT' && a.interface !== 'LEGACY_NFT') return;
      var j = judge(a); if (!j) return;
      var pnft = a.interface === 'ProgrammableNFT', why = j.why;
      if (!why && !pnft && t.frozen) why = 'locked (staked or frozen)';
      else if (!why && !pnft && t.delegate) why = 'listed or delegated somewhere';
      cands.push({ mint: mint, name: j.name, image: j.image, collection: j.g ? j.g.group_value : null, collectionName: '', floorKey: j.fk || mint, floorSol: null,
        pnft: pnft, tokenAccount: t.tokenAccount, tokenLamports: t.tokenLamports, tokenProgram: t.tokenProgram, junk: j.junk, reason: why, frozen: t.frozen, delegate: t.delegate || (a.ownership && a.ownership.delegate) || null });
    });
    // Metaplex Core: one account per NFT, the owner burns it directly. Frozen by a freeze plugin = held by whoever holds that
    // plugin (a Core staking program) — listed with the staked ones, never offered.
    var cores = [], coreItems = await coreP;
    {
      coreItems.forEach(function (a) {
        if (!a || !a.id || a.burnt || a.interface !== 'MplCoreAsset' || (a.ownership && a.ownership.owner && a.ownership.owner !== owner)) return;
        var j = judge(a); if (!j) return;
        var held = coreHold(a), lent = held ? null : coreDelegated(a, owner);
        cores.push({ mint: a.id, core: true, name: j.name, image: j.image, collection: j.g ? j.g.group_value : null, collectionName: '', floorKey: j.fk || a.id, floorSol: null, pnft: false,
          junk: j.junk, reason: j.why || (held && !held.by ? 'Frozen by its project — can’t be burned' : null) || (lent ? 'listed or delegated somewhere' : null), coreHeld: !!(held && held.by), delegate: held ? held.by : lent, frozen: !!held });
      });
    }
    // collection names: one batch per 100 distinct collections (usually a single call); cosmetic, so a failure is ignored.
    // Read in the same parallel round as the Token Metadata accounts and the Core accounts below.
    var colls = chunks(Object.keys(collOf), 100), collFrozen = {};
    var collP = Promise.all(colls.map(function (ids) {
      return rpc('getAssetBatch', { ids: ids }).then(function (cb) {
        (cb || []).forEach(function (a) {
          if (!a || !a.id) return;
          collOf[a.id] = String((a.content && a.content.metadata && a.content.metadata.name) || '');
          if (pluginFrozen(a)) collFrozen[a.id] = 1;   // the whole collection is frozen (soulbound)
        });
      }, function () { /* names stay blank */ });
    }));
    // exact rent per NFT (Token Metadata: token account + metadata + edition (+ token record)); Core: the asset account
    var keys = [];
    cands.forEach(function (c) { c._k = keys.length; keys.push(metaOf(c.mint).toBase58(), editionOf(c.mint).toBase58(), c.pnft ? tokenRecordOf(c.mint, c.tokenAccount).toBase58() : null); });
    var flat = keys.filter(Boolean), info = {}, failed = {}, groups = chunks(flat, 100);
    step('Pricing ' + (cands.length + cores.length) + ' NFTs…');
    var tmP = Promise.all(groups.map(function (gk) {
      return rpc('getMultipleAccounts', [gk, { encoding: 'base64', dataSlice: { offset: 0, length: 3 } }])
        .then(function (m) { ((m && m.value) || []).forEach(function (v, j) { info[gk[j]] = v; }); }, function () { gk.forEach(function (k) { failed[k] = 1; }); });
    }));
    var cg = chunks(cores, 100);
    var coreAcctP = Promise.all(cg.map(function (grp) {
      return settle(rpc('getMultipleAccounts', [grp.map(function (c) { return c.mint; }), { encoding: 'base64', dataSlice: { offset: 0, length: 1 } }]));
    }));
    await collP;
    cores.forEach(function (c) { if (c.collection && collFrozen[c.collection] && !c.reason) c.reason = 'Frozen by its collection (soulbound) — can’t be burned'; });
    cands.concat(cores).forEach(function (c) { if (c.collection) c.collectionName = collOf[c.collection] || ''; });
    // only master editions are offered (a print edition needs its master's accounts to burn); a pNFT's token record also
    // says whether it is locked (staked) or listed
    await tmP;
    cands = cands.filter(function (c) {
      var ks = [keys[c._k], keys[c._k + 1], keys[c._k + 2]].filter(Boolean);
      if (ks.some(function (k) { return failed[k]; })) { miss(1); return false; }
      return true;
    });
    cands.forEach(function (c) {
      var mv = info[keys[c._k]], ev = info[keys[c._k + 1]], rk = keys[c._k + 2], rv = rk ? info[rk] : null;
      var ekey = ev && ev.data && ev.data[0] ? b64(ev.data[0])[0] : null;
      var rstate = rv && rv.data && rv.data[0] ? b64(rv.data[0])[2] : null;   // TokenRecord.state: 0 unlocked · 1 locked · 2 listed
      if (c.pnft && rstate === 1) c.lockedPnft = true; else if (c.pnft && rstate === 2) c.reason = c.reason || 'listed for sale';
      if (!mv) c.reason = c.reason || 'no metadata account';
      else if (!ev) c.reason = c.reason || 'no edition account';
      else if (ekey !== 6 && ekey !== 2) c.reason = c.reason || 'a print edition (needs its master to burn)';
      c.lamports = (c.tokenLamports || 0) + (mv ? mv.lamports : 0) + (ev ? ev.lamports : 0) + (rv ? rv.lamports : 0);
      c.burnable = !c.reason; delete c._k;
    });
    // Core: a burn leaves the asset as a 1-byte tombstone holding the rent-exempt minimum for 1 byte (read live — it is
    // not the textbook 897,840; it was 655,320 on 2026-10-27), and everything above that comes back to the owner
    var coreAccts = await coreAcctP, k1 = await keep1P;
    if (cores.length) {
      var keep1 = k1.ok ? k1.v : null;   // the estimate below falls back if the live read failed
      if (typeof keep1 !== 'number') keep1 = 897840;   // only if the live read failed: the older, higher minimum (shows less, never more)
      for (var k = 0; k < cg.length; k++) {
        try {
          if (!coreAccts[k].ok) throw coreAccts[k].e;
          var cm = coreAccts[k].v;
          ((cm && cm.value) || []).forEach(function (v, j) {
            var c = cg[k][j];
            if (!v || v.owner !== CORE) return;   // gone since DAS indexed it
            // mpl-core Key: 0 Uninitialized (a burned stub) · 1 AssetV1 · 2 HashedAssetV1 (compressed — burning needs a compression proof) · 5 CollectionV1
            var key = v.data && v.data[0] ? b64(v.data[0])[0] : null;
            if (key === 0) return;   // a 1-byte Uninitialized stub: already burned (DAS can lag) — nothing to offer
            if (key === 2 && !c.reason) c.reason = 'Compressed Core NFT — can’t be burned here';
            c.lamports = Math.max(0, v.lamports - keep1); c.burnable = !c.reason; cands.push(c);
          });
        } catch (e) { miss(cg[k].length); }
      }
    }
    cands.sort(function (a, b) { return (b.burnable - a.burnable) || (b.junk - a.junk) || a.name.localeCompare(b.name); });
    // staked NFTs leave the burn list: a delegate on an unfrozen NFT = soft stake (a Revoke frees it); frozen with a
    // delegate, a locked pNFT or a Core NFT a freeze plugin holds = held by a staking program
    var held = cands.filter(function (c) { return c.core ? c.coreHeld : ((!c.pnft && (c.frozen || c.delegate)) || c.lockedPnft); });
    out.nfts = cands.filter(function (c) { return held.indexOf(c) < 0; });
    held.forEach(function (c) { if (!c.core && !c.pnft && c.delegate && !c.frozen) out.soft.push(c); else out.locked.push(c); });
    out.emptyLamports = out.empties.reduce(function (s, e) { return s + e.lamports; }, 0);
    out.nftLamports = out.nfts.filter(function (c) { return c.burnable; }).reduce(function (s, c) { return s + c.lamports; }, 0);
    out.listMs = Date.now() - t0;
    if (onList) try { onList(out); } catch (e) { /* the page's business */ }
    // which program holds each locked NFT (display only) — read alongside the floor prices
    var dels = out.locked.map(function (c) { return c.delegate; }).filter(function (x, i, a) { return x && a.indexOf(x) === i; }), progOf = {};
    var delP = Promise.all(chunks(dels, 100).map(function (dk) {
      return rpc('getMultipleAccounts', [dk, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])
        .then(function (dm) { ((dm && dm.value) || []).forEach(function (v, j) { progOf[dk[j]] = v ? v.owner : null; }); }, function () { miss(1); });
    }));
    out.floors = await attachFloors(out.nfts.filter(function (c) { return c.burnable; }), step);
    out.floorsPending = false;
    await delP;
    out.locked.forEach(function (c) { var pr = c.delegate ? progOf[c.delegate] : null; c.program = pr && pr !== SYS ? pr : null; c.byWallet = pr === SYS; });
    out.calls = rpc.stats ? rpc.stats.calls - c0 : null;
    out.ms = Date.now() - t0;
    devLog('scan ' + owner.slice(0, 4) + '…: ' + (out.calls == null ? '?' : out.calls) + ' RPC calls, ' + (out.ms / 1000).toFixed(1) + ' s, ' + mints.length + ' NFT accounts, ' + cores.length + ' Core NFTs, ' + out.unread + ' unread');
    return out;
  }

  // ── transactions ────────────────────────────────────────────────────────────
  function closeIx(e, owner) { return ix(e.program, [acct(e.pubkey, false, true), acct(owner, false, true), acct(owner, true, false)], new Uint8Array([9])); }
  function burnIx(owner, c, withCollection) {
    var data = new Uint8Array(10); data[0] = 41; data[1] = 0; data.set(u64le(1), 2);   // Burn → BurnArgs::V1 { amount: 1 }
    return ix(META, [
      acct(owner, true, true),                                                              // authority (the holder)
      (withCollection && c.collection) ? acct(metaOf(c.collection), false, true) : acct(META, false, false),   // collection metadata
      acct(metaOf(c.mint), false, true),                                                    // metadata
      acct(editionOf(c.mint), false, true),                                                 // edition (the master edition)
      acct(c.mint, false, true),                                                            // mint
      acct(c.tokenAccount, false, true),                                                    // token account
      acct(META, false, false), acct(META, false, false), acct(META, false, false), acct(META, false, false),   // print-edition accounts: none
      c.pnft ? acct(tokenRecordOf(c.mint, c.tokenAccount), false, true) : acct(META, false, false),   // token record (pNFT only)
      acct(SYS, false, false), acct(SYSVAR_IX, false, false), acct(c.tokenProgram || TOKEN, false, false),
    ], data);
  }
  // Metaplex Core BurnV1 { compression_proof: None } — the owner burns and gets the rent; absent optional accounts = the program id
  function coreBurnIx(owner, c) {
    return ix(CORE, [
      acct(c.mint, false, true),                                             // asset
      c.collection ? acct(c.collection, false, true) : acct(CORE, false, false),   // its collection (Core updates the collection's size)
      acct(owner, true, true),                                               // payer — receives the rent
      acct(CORE, false, false),                                              // authority: none → the payer (the owner)
      acct(SYS, false, false),                                               // system program
      acct(CORE, false, false),                                              // log wrapper: none
    ], new Uint8Array([12, 0]));
  }
  var burnIxOf = function (owner, c) { return c.core ? coreBurnIx(owner, c) : burnIx(owner, c, c._coll !== false); };
  var burnUnits = function (items) { return Math.min(1400000, items.reduce(function (s, c) { return s + (c.core ? 25000 : 150000); }, 10000)); };
  function budget(units) { var CB = W3().ComputeBudgetProgram; return [CB.setComputeUnitLimit({ units: units }), CB.setComputeUnitPrice({ microLamports: CU_PRICE })]; }
  function compile(owner, ixs, blockhash) {
    var W = W3();
    return new W.VersionedTransaction(new W.TransactionMessage({ payerKey: PK(owner), recentBlockhash: blockhash || '11111111111111111111111111111111', instructions: ixs }).compileToV0Message());
  }
  var sizeOf = function (owner, ixs) { try { return compile(owner, ixs).serialize().length; } catch (e) { return Infinity; } };
  // simulate a transaction; `watch` = addresses whose post-simulation state to return
  async function simulate(rpc, owner, ixs, watch) {
    var tx = compile(owner, ixs), ser = tx.serialize();
    if (ser.length > TX_MAX) return { err: 'too big', size: ser.length };
    var sim = await rpc('simulateTransaction', [Buf(ser).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed',
      accounts: watch ? { encoding: 'base64', addresses: watch } : undefined }]);
    var v = (sim && sim.value) || {};
    return { err: v.err || null, logs: v.logs || [], units: v.unitsConsumed || 0, accounts: v.accounts || null, size: ser.length };
  }
  var failedIndex = function (err) { var e = err && err.InstructionError; return Array.isArray(e) ? e[0] : -1; };
  // plain words for the errors people actually hit (SPL Token / Anchor / Token Metadata codes)
  var KNOWN = { '0x11': 'the NFT is frozen (locked by its project or a staking program)', '0x1': 'not enough SOL in this wallet (for the network or the farm fee)', '0x7d0': 'an account the program needs is read-only', '0x7dc': 'the program expects a different account (it was upgraded)', '0x7d3': 'an account belongs to a different program', '0x9b': 'the NFT is locked or delegated (staked or listed)' };
  var reasonOf = function (sim) {
    if (sim.err === 'AccountNotFound' || (sim.err && sim.err === 'AccountNotFound')) return 'this wallet has no SOL to pay the network fee';
    var code = ((sim.logs || []).join(' ').match(/custom program error: (0x[0-9a-f]+)/) || [])[1];
    if (code && KNOWN[code]) return KNOWN[code] + ' (' + code + ')';
    var l = (sim.logs || []).filter(function (x) { return /Error|failed|Program log: /.test(x) && !/consumed/.test(x); }).slice(-1)[0] || '';
    return (l.replace(/^Program log: /, '').replace(/^Program \w+ /, '').slice(0, 120)) || JSON.stringify(sim.err).slice(0, 120);
  };

  // ── Can it really be burned? (owner 2026-10-27) ──────────────────────────────────────────────────────────────────
  // A project can block a burn in ways a scan can't see (an Oracle plugin, a soulbound collection…). After the list
  // renders, every remaining candidate's burn is SIMULATED (nothing signed) in packed batches through the paced client; a
  // failing batch is narrowed down (the failing instruction when the error names it, halves otherwise) and the NFT gets
  // "Can't burn" with the program's reason. Kept per wallet for the page session. An account-level error (e.g. the wallet
  // has no SOL for the fee) stops the check without marking anything — that says nothing about the NFTs.
  // mpl-core error codes (programs/mpl-core/src/error.rs, main, 2026-10-27)
  var CORE_ERRORS = ['InvalidSystemProgram', 'DeserializationError', 'SerializationError', 'PluginsNotInitialized', 'PluginNotFound', 'NumericalOverflow',
    'IncorrectAccount', 'IncorrectAssetHash', 'InvalidPlugin', 'InvalidAuthority', 'AssetIsFrozen', 'MissingCompressionProof', 'CannotMigrateMasterWithSupply',
    'CannotMigratePrints', 'CannotBurnCollection', 'PluginAlreadyExists', 'NumericalOverflowError', 'AlreadyCompressed', 'AlreadyDecompressed',
    'InvalidCollection', 'MissingUpdateAuthority', 'MissingNewOwner', 'MissingSystemProgram', 'NotAvailable', 'InvalidAsset', 'MissingCollection',
    'NoApprovals', 'CannotRedelegate', 'InvalidPluginSetting', 'ConflictingAuthority', 'InvalidLogWrapperProgram', 'ExternalPluginAdapterNotFound',
    'ExternalPluginAdapterAlreadyExists', 'MissingAsset', 'MissingExternalPluginAdapterAccount', 'OracleCanRejectOnly', 'RequiresLifecycleCheck',
    'DuplicateLifecycleChecks', 'InvalidOracleAccountData', 'UninitializedOracleAccount', 'MissingSigner', 'InvalidPluginOperation',
    'CollectionMustBeEmpty', 'TwoDataSources', 'UnsupportedOperation', 'NoDataSources', 'InvalidPluginAdapterTarget', 'CannotAddDataSection',
    'PermanentDelegatesPreventMove', 'InvalidExecutePda', 'AgentIdentityMustSign', 'GroupMustBeEmpty', 'DuplicateEntry', 'GroupVectorFull',
    'GroupNestingDepthExceeded', 'InconsistentGroupRelationship'];
  var burnChecks = {};   // owner → { mint: '' (burns) | reason (can't) } for this page session
  function cantReason(sim) {
    var m = (sim.logs || []).join('\n').match(new RegExp('Program ' + CORE + ' failed: custom program error: (0x[0-9a-f]+)'));
    if (m) { var n = CORE_ERRORS[parseInt(m[1], 16)]; return 'Can’t burn — the project blocks it (' + (n || m[1]) + ')'; }
    return 'Can’t burn — the project blocks it (' + reasonOf(sim) + ')';
  }
  function markCant(c, why) { c.burnable = false; c.cantBurn = true; c.reason = why; }
  async function checkBurns(rpc, owner, out, onUpdate) {
    var memo = burnChecks[owner] || (burnChecks[owner] = {}), t0 = Date.now(), sims = 0, failed = 0, stopped = null;
    var all = out.nfts.filter(function (c) { return c.burnable; }), todo = [];
    all.forEach(function (c) { if (c.mint in memo) { if (memo[c.mint]) { markCant(c, memo[c.mint]); failed++; } } else todo.push(c); });
    var mk = function (items) { return budget(burnUnits(items)).concat(items.map(function (c) { return burnIxOf(owner, c); })); };
    var roomFor = function (items, next) { return items.length < 12 && items.concat([next]).filter(function (x) { return !x.core; }).length <= 3; };
    var sim1 = async function (items) {
      sims++;
      var r = await simulate(rpc, owner, mk(items));
      if (r.err && (typeof r.err === 'string' || !r.err.InstructionError)) stopped = stopped || (typeof r.err === 'string' ? r.err : JSON.stringify(r.err).slice(0, 80));
      return r;
    };
    var bad = function (c, sim) { var why = cantReason(sim); markCant(c, why); memo[c.mint] = why; failed++; };
    var run = async function (items) {
      if (!items.length || stopped) return;
      var r = await sim1(items);
      if (stopped) return;
      if (!r.err) { items.forEach(function (c) { memo[c.mint] = ''; }); return; }
      var at = failedIndex(r.err) - (mk(items).length - items.length);   // the burn instruction that failed (after the budget ixs)
      if (items.length === 1) {
        var c = items[0];
        // a Token Metadata NFT whose verified collection NFT is gone burns without it (planBurns does the same)
        if (c.collection && !c.core && c._coll !== false) { var c2 = Object.assign({}, c, { _coll: false }), r2 = await sim1([c2]); if (stopped) return; if (!r2.err) { memo[c.mint] = ''; return; } }
        bad(c, r); return;
      }
      if (at >= 0 && at < items.length) {   // the ones before it burned fine in this run; the culprit alone; the rest again
        items.slice(0, at).forEach(function (x) { memo[x.mint] = ''; });
        if (items[at].collection && !items[at].core) await run([items[at]]); else bad(items[at], r);
        await run(items.slice(at + 1));
        return;
      }
      var h = items.length >> 1;
      await run(items.slice(0, h)); await run(items.slice(h));
    };
    var queue = todo.slice();
    try {
      while (queue.length && !stopped) {
        var items = [];
        while (queue.length && roomFor(items, queue[0]) && sizeOf(owner, mk(items.concat([queue[0]]))) <= TX_MAX) items.push(queue.shift());
        if (!items.length) { queue.shift(); continue; }   // too big to burn alone: planBurns says so at review time
        await run(items);
        if (onUpdate) onUpdate({ sims: sims, failed: failed, left: queue.length, total: todo.length });
      }
    } catch (e) { stopped = stopped || ('check interrupted: ' + ((e && e.message) || e)); }
    out.nftLamports = out.nfts.filter(function (c) { return c.burnable; }).reduce(function (t, c) { return t + c.lamports; }, 0);
    var res = { sims: sims, failed: failed, checked: all.length, ms: Date.now() - t0, stopped: stopped };
    out.burnCheck = res;
    if (onUpdate) onUpdate(res);
    return res;
  }

  /** Plan the close transactions: as many closes per tx as fit, each simulated; an account whose close fails is dropped
   *  (with the reason) and its batch rebuilt. → { batches: [{ items, ixs, lamports, units }], dropped: [{ item, reason }] } */
  async function planCloses(rpc, owner, empties, onStep, opts) {
    var step = onStep || function () {}, queue = empties.slice(), batches = [], dropped = [], charge = !(opts && opts.fee === false);
    var got = function (items) { return items.reduce(function (s, e) { return s + e.lamports; }, 0); };
    var fee = function (items) { return charge ? feeOf(got(items)) : 0; };   // 1% of the rent this transaction reclaims
    var mk = function (items) { return budget(Math.min(1400000, 8000 * items.length + 30000)).concat(items.map(function (e) { return closeIx(e, owner); }), solFeeIxs(owner, fee(items))); };
    while (queue.length) {
      var items = [];
      while (queue.length && sizeOf(owner, mk(items.concat([queue[0]]))) <= TX_MAX) items.push(queue.shift());
      if (!items.length) { dropped.push({ item: queue.shift(), reason: 'does not fit in a transaction' }); continue; }
      step('Checking batch ' + (batches.length + 1) + ' (' + items.length + ' accounts)…');
      for (var tries = 0; tries < 6 && items.length; tries++) {
        var sim = await simulate(rpc, owner, mk(items));
        if (!sim.err) { batches.push({ items: items, ixs: mk(items), lamports: got(items) - fee(items), fee: fee(items), units: sim.units }); items = []; break; }
        var at = failedIndex(sim.err) - 2;   // two compute-budget instructions come first
        if (at >= 0 && at < items.length) { dropped.push({ item: items[at], reason: reasonOf(sim) }); items.splice(at, 1); }
        else { items.forEach(function (e) { dropped.push({ item: e, reason: reasonOf(sim) }); }); items = []; }
      }
      items.forEach(function (e) { dropped.push({ item: e, reason: 'kept failing in simulation' }); });
    }
    return { batches: batches, dropped: dropped };
  }

  /** Plan the burn transactions for the ticked NFTs: up to 3 Token Metadata burns per tx (Core burns are tiny: up to 12
   *  NFTs a tx, as fit), each simulated; the owner's real gain is measured from the simulation. A burn that fails
   *  (staked, locked, odd collection, a Core plugin that says no) is dropped with the reason. */
  async function planBurns(rpc, owner, nfts, onStep, opts) {
    var step = onStep || function () {}, batches = [], dropped = [], charge = !(opts && opts.fee === false);
    var mk = function (items) { return budget(burnUnits(items)).concat(items.map(function (c) { return burnIxOf(owner, c); })); };
    var roomFor = function (items, next) { return items.length < 12 && items.concat([next]).filter(function (x) { return !x.core; }).length <= 3; };
    var pre = (await rpc('getBalance', [owner])).value;
    var measure = async function (items) {
      var sim = await simulate(rpc, owner, mk(items), [owner]);
      if (sim.err) return { sim: sim };
      var post = sim.accounts && sim.accounts[0] ? sim.accounts[0].lamports : null;
      return { sim: sim, gain: post == null ? null : post - pre };
    };
    // one by one first: tells exactly which NFTs can be burned (a verified collection whose collection NFT is gone is
    // retried without it), then pack the good ones
    var good = [];
    for (var i = 0; i < nfts.length; i++) {
      var c = Object.assign({}, nfts[i]);
      step('Checking ' + (i + 1) + ' of ' + nfts.length + '…');
      var r = await measure([c]);
      if (r.sim.err && c.collection && !c.core) { c._coll = false; var r2 = await measure([c]); if (!r2.sim.err) r = r2; else c._coll = true; }   // Core always needs its collection
      if (r.sim.err) dropped.push({ item: nfts[i], reason: reasonOf(r.sim) }); else { c.gain = r.gain; good.push(c); }
    }
    var queue = good.slice();
    while (queue.length) {
      var items = [];
      // sized WITH room for the fee transfer + memo, which is added once the gain is measured
      while (queue.length && roomFor(items, queue[0]) && sizeOf(owner, mk(items.concat([queue[0]])).concat(charge ? solFeeIxs(owner, FEE_MIN) : [])) <= TX_MAX) items.push(queue.shift());
      if (!items.length) { dropped.push({ item: queue.shift(), reason: 'does not fit in a transaction' }); continue; }
      var mm = await measure(items);
      if (mm.sim.err && items.length > 1) { queue = items.slice(1).concat(queue); items = [items[0]]; mm = await measure(items); }
      if (mm.sim.err) { dropped.push({ item: items[0], reason: reasonOf(mm.sim) }); continue; }
      var got = mm.gain != null ? mm.gain : items.reduce(function (s, x) { return s + (x.gain || x.lamports); }, 0), ixs = mk(items), fee = 0;
      if (charge && feeOf(got) > 0) {   // 1% of the owner's measured gain
        fee = feeOf(got);
        var withFee = ixs.concat(solFeeIxs(owner, fee));
        if ((await simulate(rpc, owner, withFee)).err) { dropped.push.apply(dropped, items.map(function (x) { return { item: x, reason: 'could not add the fee' }; })); continue; }
        ixs = withFee;
      }
      batches.push({ items: items, ixs: ixs, lamports: got - fee, fee: fee, units: mm.sim.units });
    }
    return { batches: batches, dropped: dropped };
  }

  // ── the Dojo fee (owner 2026-10-27, replaces the optional tips) ─────────────────────────────────────────────────
  // To the Treasury (shamanchef.sol), INSIDE the same transaction as what it pays for — so it is paid only when that
  // lands — and tagged "ddsweep:fee" so the store's ledgers file it as a Sweep fee (never a coin buy, Pot tip or card
  // repair). SOL: 1% of what the owner gets back (closes: the rent reclaimed · burns: the simulated gain), no transfer under
  // FEE_MIN. SPL (the GemFarm rescue's flat ORE fee): the Treasury's token account is created idempotently first.
  var FEE_BPS = 100, FEE_MIN = 5000, FEE_WALLET = '5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp', FEE_MEMO = 'ddsweep:fee';
  var MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  var ataOf = function (owner, mint, prog) { return pda([PK(owner).toBuffer(), PK(prog || TOKEN).toBuffer(), PK(mint).toBuffer()], ATA); };
  var feeOf = function (lamports) { var f = Math.floor(lamports * FEE_BPS / 10000); return f >= FEE_MIN ? f : 0; };
  var feeMemo = function (owner) { return ix(MEMO, [acct(owner, true, false)], utf8(FEE_MEMO)); };
  function solFeeIxs(owner, lamports) {
    return lamports > 0 ? [W3().SystemProgram.transfer({ fromPubkey: PK(owner), toPubkey: PK(FEE_WALLET), lamports: lamports }), feeMemo(owner)] : [];
  }
  function splFeeIxs(owner, mint, decimals, raw) {
    var data = new Uint8Array(10); data[0] = 12; data.set(u64le(raw), 1); data[9] = decimals;   // TransferChecked
    return [
      ix(ATA, [acct(owner, true, true), acct(ataOf(FEE_WALLET, mint), false, true), acct(FEE_WALLET, false, false), acct(mint, false, false), acct(SYS, false, false), acct(TOKEN, false, false)], new Uint8Array([1])),   // CreateIdempotent
      ix(TOKEN, [acct(ataOf(owner, mint), false, true), acct(mint, false, false), acct(ataOf(FEE_WALLET, mint), false, true), acct(owner, true, false)], data),
      feeMemo(owner),
    ];
  }

  /** Compile planned batches with a fresh blockhash, ready to sign. */
  async function finalize(rpc, owner, batches) {
    var bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
    return batches.map(function (b) { return compile(owner, b.ixs, bh); });
  }

  global.DojoBurn = { makeRpc: makeRpc, scan: scan, planCloses: planCloses, planBurns: planBurns, finalize: finalize, simulate: simulate, closeIx: closeIx, burnIx: burnIx, coreBurnIx: coreBurnIx, coreHold: coreHold, CORE: CORE,
    FEE_BPS: FEE_BPS, FEE_MIN: FEE_MIN, FEE_WALLET: FEE_WALLET, FEE_MEMO: FEE_MEMO, feeOf: feeOf, solFeeIxs: solFeeIxs, splFeeIxs: splFeeIxs, ataOf: ataOf,
    metaOf: metaOf, editionOf: editionOf, tokenRecordOf: tokenRecordOf, KEEP: KEEP, TX_MAX: TX_MAX,
    FLOOR_MAX: FLOOR_MAX, floorHigh: floorHigh, floorUnknownVerified: floorUnknownVerified, visibleNfts: visibleNfts, junkPicks: junkPicks, attachFloors: attachFloors,
    rawImageOk: rawImageOk, coreDelegated: coreDelegated, KEEP_AUTH: KEEP_AUTH, KEEP_CREATOR: KEEP_CREATOR,
    checkBurns: checkBurns, pluginFrozen: pluginFrozen, CORE_ERRORS: CORE_ERRORS, _resetBurnChecks: function () { burnChecks = {}; },
    useFloors: function (fn) { floorsFetch = fn || null; }, setFloorsUrl: function (u) { FLOORS_URL = u || '/api/floors'; },
    // the small helpers Dojo Sweep's staking code builds on
    _: { PK: PK, pda: pda, utf8: utf8, Buf: Buf, b64: b64, rdU64: rdU64, keyAt: keyAt, u64le: u64le, acct: acct, ix: ix, budget: budget, compile: compile,
      sizeOf: sizeOf, reasonOf: reasonOf, failedIndex: failedIndex, TOKEN: TOKEN, SYS: SYS } };
})(typeof window !== 'undefined' ? window : globalThis);
