// Dojo Burn — get rent back from a wallet: close its EMPTY token accounts and BURN the NFTs its owner ticks (Token
// Metadata BurnV1, standard + programmable). ONE shared module (window.DojoBurn), served at /dojo-burn.js and used by
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
  // The owner's own collections are never offered for burning (Degen Dojo · Demon Dojo · TETO).
  var KEEP = { '2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb': 1, 'WyUy9qjJekjqTAYGanANjhtviwgu1uhCkXx1uas8fWb': 1, 'dgd6We3oS4M5LSVzT6Ep39wwVpjLC336tCpyPZkLAHx': 1 };
  // NFTs that represent something (liquidity positions, device passes) — shown, never offered for burning
  var KEEP_RE = /\b(position|liquidity|whirlpool|orca|raydium|meteora|kamino|lifinity|crema|invariant|concentrated|genesis token|seeker genesis|saga genesis)\b/i;
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
  // ≤ 3 requests in flight and ≥ 150 ms between starts (≤ ~6 a second; a heavy wallet's scan is ~10–20 calls, well under
  // the proxy's 480 a minute); 429 / 502 / 503 / 504 / network errors are retried after 2, 5, 10, 20 and 30 s — or the server's
  // Retry-After (capped at 30 s). opts: { fetch, inFlight, gapMs, waits, onRetry(attempt, ms, method) }.
  // rpc.stats = { calls, retries } counts every HTTP request (the scan logs its share on localhost).
  function makeRpc(url, opts) {
    opts = opts || {};
    var doFetch = opts.fetch || function (u, o) { return global.fetch(u, o); };
    // Netlify's own limit on /api/rpc counts 60-second windows per IP and answers an empty 429 with no Retry-After, so the
    // waits reach past a full window (2+5+10+20+30 s) — and while ANY call waits, the whole client pauses: queued calls
    // firing into the same window would only keep the counter high (live 2026-10-26: the owner's own tabs + scans).
    var maxIn = opts.inFlight || 3, gap = opts.gapMs == null ? 150 : opts.gapMs, waits = opts.waits || [2000, 5000, 10000, 20000, 30000];
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
  // Every read is sequential and batched (the paced client spaces them): the NFT candidates come from the token accounts
  // already read — amount 1, decimals 0, classic Token and Token-2022 — then getAssetBatch in chunks of 100 (compressed
  // spam has no token account, so it never costs a call), then the exact rent from getMultipleAccounts (no simulation).
  // A chunk that still fails after the client's retries is skipped, not fatal: out.unread counts what couldn't be read.
  async function scan(rpc, owner, onStep) {
    var step = onStep || function () {};
    var t0 = Date.now(), c0 = rpc.stats ? rpc.stats.calls : 0;
    var out = { owner: owner, sol: 0, empties: [], skipped: [], nfts: [], soft: [], locked: [], unread: 0 };
    var miss = function (n) { out.unread += n; };
    step('Reading wallet…');
    var bal = await rpc('getBalance', [owner]); out.sol = (bal && bal.value) || 0;
    var nftAccts = {}, progs = [TOKEN, TOKEN22];
    for (var p = 0; p < progs.length; p++) {
      var r;
      try { r = await rpc('getTokenAccountsByOwner', [owner, { programId: progs[p] }, { encoding: 'jsonParsed' }]); }
      catch (e) { if (p === 0) throw e; miss(1); continue; }   // classic Token is the scan; a Token-2022 failure is partial
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
    for (var ci = 0; ci < mc.length; ci++) {
      step('Reading NFTs… ' + Math.min((ci + 1) * 100, mints.length) + ' of ' + mints.length);
      try { var ab = await rpc('getAssetBatch', { ids: mc[ci] }); (ab || []).forEach(function (a) { if (a && a.id) assets[a.id] = a; }); }
      catch (e) { miss(mc[ci].length); mc[ci].forEach(function (m) { nftAccts[m].unread = true; }); }
    }
    var cands = [], collOf = {};
    mints.forEach(function (mint) {
      var t = nftAccts[mint], a = assets[mint];
      if (t.unread || !a || (a.compression && a.compression.compressed) || a.burnt) return;
      if (a.interface !== 'V1_NFT' && a.interface !== 'ProgrammableNFT' && a.interface !== 'LEGACY_NFT') return;
      var g = ((a.grouping || []).filter(function (x) { return x.group_key === 'collection'; })[0]) || null;
      if (g && KEEP[g.group_value]) return;   // the owner's own collections: never offered
      var md = (a.content && a.content.metadata) || {}, name = String(md.name || 'Unnamed NFT');
      var pnft = a.interface === 'ProgrammableNFT';
      // spam = a lure in the name / symbol, or a description that pairs a lure word with a link ("claim at https://…")
      var desc = String(md.description || ''), lure = SPAM.test([name, md.symbol].join(' ')) || (/(claim|airdrop|reward|visit|voucher|redeem|giveaway|winner)/i.test(desc) && /(https?:|www\.|\.com\b|\.io\b|\.xyz\b|t\.me)/i.test(desc));
      var junk = (g ? 0 : 2) + (lure ? 3 : 0) + ((a.content && a.content.links && a.content.links.image) ? 0 : 1);
      var why = null;
      // Never burn an NFT that IS something: a DeFi liquidity position (burning it strands the liquidity for good) or a
      // device / genesis pass (Seeker, Saga). Most have no master edition and fail the checks below anyway — this makes it explicit.
      if (KEEP_RE.test([name, md.symbol].join(' ')) || /^(OWP|RCL|DLMM|DAMM|LP)$/i.test(String(md.symbol || ''))) why = 'a DeFi position or pass — never burned here';
      else if (!pnft && t.frozen) why = 'locked (staked or frozen)';
      else if (!pnft && t.delegate) why = 'listed or delegated somewhere';
      if (g) collOf[g.group_value] = '';
      cands.push({ mint: mint, name: name, image: (a.content && a.content.links && a.content.links.image) || '', collection: g ? g.group_value : null, collectionName: '',
        pnft: pnft, tokenAccount: t.tokenAccount, tokenLamports: t.tokenLamports, tokenProgram: t.tokenProgram, junk: junk, reason: why, frozen: t.frozen, delegate: t.delegate || (a.ownership && a.ownership.delegate) || null });
    });
    // collection names: one batch per 100 distinct collections (usually a single call); cosmetic, so a failure is ignored
    var colls = chunks(Object.keys(collOf), 100);
    for (var cc = 0; cc < colls.length; cc++) {
      try { var cb = await rpc('getAssetBatch', { ids: colls[cc] }); (cb || []).forEach(function (a) { if (a && a.id) collOf[a.id] = String((a.content && a.content.metadata && a.content.metadata.name) || ''); }); } catch (e) { /* names stay blank */ }
    }
    cands.forEach(function (c) { if (c.collection) c.collectionName = collOf[c.collection] || ''; });
    // exact rent per NFT: token account + metadata + edition (+ token record) — only master editions are offered (a print
    // edition needs its master's accounts to burn); a pNFT's token record also says whether it is locked (staked) or listed
    step('Pricing ' + cands.length + ' NFTs…');
    var keys = [];
    cands.forEach(function (c) { c._k = keys.length; keys.push(metaOf(c.mint).toBase58(), editionOf(c.mint).toBase58(), c.pnft ? tokenRecordOf(c.mint, c.tokenAccount).toBase58() : null); });
    var flat = keys.filter(Boolean), info = {}, failed = {}, groups = chunks(flat, 100);
    for (var gi = 0; gi < groups.length; gi++) {
      try {
        var m = await rpc('getMultipleAccounts', [groups[gi], { encoding: 'base64', dataSlice: { offset: 0, length: 3 } }]);
        ((m && m.value) || []).forEach(function (v, j) { info[groups[gi][j]] = v; });
      } catch (e) { groups[gi].forEach(function (k) { failed[k] = 1; }); }
    }
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
    cands.sort(function (a, b) { return (b.burnable - a.burnable) || (b.junk - a.junk) || a.name.localeCompare(b.name); });
    // staked NFTs leave the burn list: a delegate on an unfrozen NFT = soft stake (a Revoke frees it); frozen with a
    // delegate, or a locked pNFT = held by a staking program
    var held = cands.filter(function (c) { return (!c.pnft && (c.frozen || c.delegate)) || c.lockedPnft; });
    out.nfts = cands.filter(function (c) { return held.indexOf(c) < 0; });
    held.forEach(function (c) { if (!c.pnft && c.delegate && !c.frozen) out.soft.push(c); else out.locked.push(c); });
    var dels = out.locked.map(function (c) { return c.delegate; }).filter(function (x, i, a) { return x && a.indexOf(x) === i; }), progOf = {};
    for (var di = 0; di < dels.length; di += 100) {
      try {
        var dm = await rpc('getMultipleAccounts', [dels.slice(di, di + 100), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
        ((dm && dm.value) || []).forEach(function (v, j) { progOf[dels[di + j]] = v ? v.owner : null; });
      } catch (e) { miss(1); }
    }
    out.locked.forEach(function (c) { var pr = c.delegate ? progOf[c.delegate] : null; c.program = pr && pr !== SYS ? pr : null; c.byWallet = pr === SYS; });
    out.emptyLamports = out.empties.reduce(function (s, e) { return s + e.lamports; }, 0);
    out.nftLamports = out.nfts.filter(function (c) { return c.burnable; }).reduce(function (s, c) { return s + c.lamports; }, 0);
    out.calls = rpc.stats ? rpc.stats.calls - c0 : null;
    out.ms = Date.now() - t0;
    devLog('scan ' + owner.slice(0, 4) + '…: ' + (out.calls == null ? '?' : out.calls) + ' RPC calls, ' + (out.ms / 1000).toFixed(1) + ' s, ' + mints.length + ' NFT accounts, ' + out.unread + ' unread');
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

  /** Plan the burn transactions for the ticked NFTs: up to 3 per tx (as fit), each simulated; the owner's real gain is
   *  measured from the simulation. A burn that fails (staked, locked, odd collection) is dropped with the reason. */
  async function planBurns(rpc, owner, nfts, onStep, opts) {
    var step = onStep || function () {}, batches = [], dropped = [], charge = !(opts && opts.fee === false);
    var mk = function (items) { return budget(Math.min(1400000, 150000 * items.length + 10000)).concat(items.map(function (c) { return burnIx(owner, c, c._coll !== false); })); };
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
      if (r.sim.err && c.collection) { c._coll = false; var r2 = await measure([c]); if (!r2.sim.err) r = r2; else c._coll = true; }
      if (r.sim.err) dropped.push({ item: nfts[i], reason: reasonOf(r.sim) }); else { c.gain = r.gain; good.push(c); }
    }
    var queue = good.slice();
    while (queue.length) {
      var items = [];
      // sized WITH room for the fee transfer + memo, which is added once the gain is measured
      while (queue.length && items.length < 3 && sizeOf(owner, mk(items.concat([queue[0]])).concat(charge ? solFeeIxs(owner, FEE_MIN) : [])) <= TX_MAX) items.push(queue.shift());
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

  global.DojoBurn = { makeRpc: makeRpc, scan: scan, planCloses: planCloses, planBurns: planBurns, finalize: finalize, simulate: simulate, closeIx: closeIx, burnIx: burnIx,
    FEE_BPS: FEE_BPS, FEE_MIN: FEE_MIN, FEE_WALLET: FEE_WALLET, FEE_MEMO: FEE_MEMO, feeOf: feeOf, solFeeIxs: solFeeIxs, splFeeIxs: splFeeIxs, ataOf: ataOf,
    metaOf: metaOf, editionOf: editionOf, tokenRecordOf: tokenRecordOf, KEEP: KEEP, TX_MAX: TX_MAX,
    // the small helpers Dojo Sweep's staking code builds on
    _: { PK: PK, pda: pda, utf8: utf8, Buf: Buf, b64: b64, rdU64: rdU64, keyAt: keyAt, u64le: u64le, acct: acct, ix: ix, budget: budget, compile: compile,
      sizeOf: sizeOf, reasonOf: reasonOf, failedIndex: failedIndex, TOKEN: TOKEN, SYS: SYS } };
})(typeof window !== 'undefined' ? window : globalThis);
