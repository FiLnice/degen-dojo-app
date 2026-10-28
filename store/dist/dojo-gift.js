/* Dojo Gift — "Add to the prize" for the Burn Raffle (owner 2026-10-28): the transfer instructions for every kind of
 * asset, shared by the donor's page (/raffle: donor → raffle wallet, with a signed "ddpot:<round>[:name]" memo) and the
 * payout desk (/payouts: Treasury → raffle winner). It builds and SIMULATES only — a wallet signs.
 * Browser: window.DojoGift (needs window.solanaWeb3 + window.Buffer). Node tests: require('./dojo-gift.js').
 *
 *   ataOf(W3, owner, mint, program)      the owner's associated token account (classic Token or Token-2022)
 *   itemIxs(W3, from, item)              the instructions that move ONE item from `from` to item.to (`from` pays):
 *        sol           System transfer (item.raw lamports)
 *        token · nft   create item.to's token account if missing (idempotent) + TransferChecked
 *        pnft          Token Metadata Transfer V1 — the token records + the NFT's rule set (item.ruleSet, see ruleSets)
 *        core          Metaplex Core TransferV1 (item.collection when the asset is in one)
 *   giftMemo(round, name) / memoIx       the signed "ddpot:<round>[:<name>]" tag (name: ≤ 24 of A–Z a–z 0–9 space _ -)
 *   parseMetadata(bytes)                 → { tokenStandard, collection, ruleSet } from a Token Metadata account
 *   ruleSets(rpc, mints)                 → { mint: ruleSet | null } (the metadata accounts, ≤ 100 a call)
 *   pack({ W3, payer, blockhash, items, memo, cuPrice })   → [{ tx, items }] v0 transactions ≤ 1232 bytes
 *   scan(rpc, W3, owner, onStep)         the donor's wallet: { sol, tokens: [...], nfts: [...] } — each with `reason`
 *                                        when it can't be sent (frozen, staked, listed, soulbound, a Token-2022 extension…)
 *   checkSends(rpc, W3, owner, to, nfts, onUpdate)   SIMULATES every sendable NFT's transfer; a failure → "Can't send"
 *   plan(rpc, W3, owner, items, { memo, onStep })    → { batches: [{ items, ixs }], dropped: [{ item, reason }] }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DojoGift = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  var ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', SYS = '11111111111111111111111111111111', CB = 'ComputeBudget111111111111111111111111111111';
  var TM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
  var AUTH_RULES = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg', SYSVAR_IX = 'Sysvar1nstructions1111111111111111111111111';
  var MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  var MAX_TX = 1232, CU_PRICE = 100000, PREFIX = 'ddpot:';
  var NAME_RE = /^[A-Za-z0-9 _-]{1,24}$/;
  // compute units each kind needs (generous: the limit only caps, the fee is limit × price)
  var CU = { sol: 1000, token: 45000, nft: 45000, pnft: 260000, core: 45000 };
  // Token-2022 mint extensions that don't change a plain transfer (anything else — a transfer hook, a transfer fee, a
  // permanent delegate, non-transferable, confidential transfers, pausable… — is refused here: it can't be sent and
  // paid out exactly)
  var T22_OK = { metadataPointer: 1, tokenMetadata: 1, groupPointer: 1, groupMemberPointer: 1, tokenGroup: 1, tokenGroupMember: 1, mintCloseAuthority: 1, interestBearingConfig: 1 };

  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58(bytes) { var n = 0n, i; for (i = 0; i < bytes.length; i++) n = n * 256n + BigInt(bytes[i]); var s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (i = 0; i < bytes.length && !bytes[i]; i++) s = '1' + s; return s; }
  function B(v) { if (typeof v === 'bigint') return v; if (typeof v === 'number') return BigInt(Math.trunc(v) || 0); var t = String(v == null ? '0' : v).trim(); return /^-?\d+$/.test(t) ? BigInt(t) : 0n; }
  function bytes(arr) { return typeof Buffer !== 'undefined' ? Buffer.from(arr) : Uint8Array.from(arr); }
  function utf8(s) { return new TextEncoder().encode(s); }
  function u64le(v) { var b = new Uint8Array(8), n = B(v); for (var i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; }
  function u32At(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function b64bytes(s) { if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64')); var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function b64of(u8) { if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64'); var s = ''; for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  var chunks = function (a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

  function PK(W3, x) { return typeof x === 'string' ? new W3.PublicKey(x) : x; }
  function acct(W3, k, s, w) { return { pubkey: PK(W3, k), isSigner: !!s, isWritable: !!w }; }
  function ix(W3, programId, keys, data) { return new W3.TransactionInstruction({ programId: PK(W3, programId), keys: keys, data: bytes(data) }); }
  function ataOf(W3, owner, mint, program) {
    return W3.PublicKey.findProgramAddressSync([PK(W3, owner).toBytes(), PK(W3, program || TOKEN).toBytes(), PK(W3, mint).toBytes()], PK(W3, ATA))[0];
  }
  function tmPda(W3, seeds) { return W3.PublicKey.findProgramAddressSync(seeds, PK(W3, TM))[0]; }
  function metaOf(W3, mint) { return tmPda(W3, [utf8('metadata'), PK(W3, TM).toBytes(), PK(W3, mint).toBytes()]); }
  function editionOf(W3, mint) { return tmPda(W3, [utf8('metadata'), PK(W3, TM).toBytes(), PK(W3, mint).toBytes(), utf8('edition')]); }
  function tokenRecordOf(W3, mint, ta) { return tmPda(W3, [utf8('metadata'), PK(W3, TM).toBytes(), PK(W3, mint).toBytes(), utf8('token_record'), PK(W3, ta).toBytes()]); }

  /** The signed tag every donation carries: "ddpot:<round>" or "ddpot:<round>:<name>" (a name that fails the pattern is left out). */
  function giftMemo(round, name) { var n = String(name == null ? '' : name).trim(); return PREFIX + round + (n && NAME_RE.test(n) ? ':' + n : ''); }
  function memoIx(W3, signer, text) { return ix(W3, MEMO, [acct(W3, signer, true, false)], utf8(text)); }
  function computeIxs(W3, units, microLamports) {
    var CBP = W3.ComputeBudgetProgram, out = [CBP.setComputeUnitLimit({ units: Math.min(1400000, Math.max(20000, units)) })];
    if (microLamports > 0) out.push(CBP.setComputeUnitPrice({ microLamports: microLamports }));
    return out;
  }

  /** The instructions that move ONE item from `from` (who signs and pays) to item.to. */
  function itemIxs(W3, from, it) {
    var to = it.to;
    if (it.kind === 'sol') return [W3.SystemProgram.transfer({ fromPubkey: PK(W3, from), toPubkey: PK(W3, to), lamports: Number(B(it.raw)) })];
    if (it.kind === 'token' || it.kind === 'nft') {
      var prog = it.program || TOKEN, src = it.account || ataOf(W3, from, it.mint, prog).toBase58(), dst = ataOf(W3, to, it.mint, prog);
      var data = new Uint8Array(10); data[0] = 12; data.set(u64le(it.kind === 'nft' ? 1 : it.raw), 1); data[9] = it.kind === 'nft' ? 0 : Number(it.decimals) || 0;   // TransferChecked
      return [
        ix(W3, ATA, [acct(W3, from, true, true), acct(W3, dst, false, true), acct(W3, to, false, false), acct(W3, it.mint, false, false), acct(W3, SYS, false, false), acct(W3, prog, false, false)], [1]),   // CreateIdempotent
        ix(W3, prog, [acct(W3, src, false, true), acct(W3, it.mint, false, false), acct(W3, dst, false, true), acct(W3, from, true, false)], data),
      ];
    }
    if (it.kind === 'pnft') {
      var tp = it.program || TOKEN, s = it.account || ataOf(W3, from, it.mint, tp).toBase58(), d = ataOf(W3, to, it.mint, tp);
      var pd = new Uint8Array(11); pd[0] = 49; pd[1] = 0; pd.set(u64le(1), 2); pd[10] = 0;   // Transfer → TransferArgs::V1 { amount: 1, authorization_data: None }
      return [ix(W3, TM, [
        acct(W3, s, false, true),                                     // token (the sender's)
        acct(W3, from, false, false),                                 // token owner
        acct(W3, d, false, true),                                     // destination token (created by Token Metadata when missing)
        acct(W3, to, false, false),                                   // destination owner
        acct(W3, it.mint, false, false),                              // mint
        acct(W3, metaOf(W3, it.mint), false, true),                   // metadata
        acct(W3, editionOf(W3, it.mint), false, false),               // (master) edition
        acct(W3, tokenRecordOf(W3, it.mint, s), false, true),         // owner token record
        acct(W3, tokenRecordOf(W3, it.mint, d), false, true),         // destination token record
        acct(W3, from, true, false),                                  // authority (the owner)
        acct(W3, from, true, true),                                   // payer
        acct(W3, SYS, false, false), acct(W3, SYSVAR_IX, false, false), acct(W3, tp, false, false), acct(W3, ATA, false, false),
        it.ruleSet ? acct(W3, AUTH_RULES, false, false) : acct(W3, TM, false, false),   // authorization rules program (none → the program id)
        it.ruleSet ? acct(W3, it.ruleSet, false, false) : acct(W3, TM, false, false),   // the rule set
      ], pd)];
    }
    if (it.kind === 'core') {
      return [ix(W3, CORE, [
        acct(W3, it.mint, false, true),                                                      // asset
        it.collection ? acct(W3, it.collection, false, false) : acct(W3, CORE, false, false), // its collection (none → the program id)
        acct(W3, from, true, true),                                                          // payer
        acct(W3, CORE, false, false),                                                        // authority: none → the payer (the owner)
        acct(W3, to, false, false),                                                          // new owner
        acct(W3, SYS, false, false), acct(W3, CORE, false, false),                           // system program · log wrapper: none
      ], [14, 0])];                                                                          // TransferV1 { compression_proof: None }
    }
    throw new Error('unknown item kind ' + it.kind);
  }

  // ---- Token Metadata account → token standard, collection, rule set (Borsh, read field by field) ----
  function parseMetadata(d) {
    if (!d || d.length < 70 || d[0] !== 4) return null;
    var o = 65, n = d.length;
    var str = function () { if (o + 4 > n) throw 0; o += 4 + u32At(d, o); };
    try {
      str(); str(); str(); o += 2;                                    // name · symbol · uri · seller fee
      if (d[o++] === 1) { var c = u32At(d, o); o += 4 + c * 34; }     // creators
      o += 2;                                                         // primary sale · is mutable
      if (o < n && d[o++] === 1) o += 1;                              // edition nonce
      var ts = null; if (o < n && d[o++] === 1) ts = d[o++];          // token standard
      var coll = null; if (o < n && d[o++] === 1) { coll = { verified: !!d[o], key: b58(d.subarray(o + 1, o + 33)) }; o += 33; }
      if (o < n && d[o++] === 1) o += 17;                             // uses
      if (o < n && d[o++] === 1) o += 9;                              // collection details (V1 size / V2 padding)
      var rs = null; if (o < n && d[o++] === 1) { o += 1; if (d[o++] === 1 && o + 32 <= n) rs = b58(d.subarray(o, o + 32)); }   // programmable config V1 { rule_set }
      return { tokenStandard: ts, collection: coll, ruleSet: rs };
    } catch (e) { return null; }
  }
  /** { mint: ruleSet (base58) | null } for programmable NFTs — read from their metadata accounts. */
  async function ruleSets(rpc, W3, mints) {
    var out = {};
    for (var g of chunks(mints, 100)) {
      var r = await rpc('getMultipleAccounts', [g.map(function (m) { return metaOf(W3, m).toBase58(); }), { encoding: 'base64' }]);
      ((r && r.value) || []).forEach(function (a, i) { var p = a && a.data ? parseMetadata(b64bytes(a.data[0])) : null; out[g[i]] = p ? p.ruleSet : null; });
    }
    return out;
  }

  // ---- packing + simulating ----
  function compile(W3, payer, ixs, blockhash) {
    return new W3.VersionedTransaction(new W3.TransactionMessage({ payerKey: PK(W3, payer), recentBlockhash: blockhash || SYS, instructions: ixs }).compileToV0Message());
  }
  function sizeOf(W3, payer, ixs) { try { return compile(W3, payer, ixs).serialize().length; } catch (e) { return Infinity; } }
  var unitsOf = function (items) { return items.reduce(function (s, it) { return s + (CU[it.kind] || 50000); }, 5000); };
  // the full instruction list for `items` (+ where each item's instructions start, so a failing instruction names its item)
  function build(W3, payer, items, memo, cuPrice) {
    var ixs = computeIxs(W3, unitsOf(items), cuPrice == null ? CU_PRICE : cuPrice), at = [];
    items.forEach(function (it) { at.push(ixs.length); ixs = ixs.concat(itemIxs(W3, payer, it)); });
    if (memo) ixs.push(memoIx(W3, payer, memo));
    return { ixs: ixs, at: at };
  }
  /** Greedy pack into v0 transactions ≤ 1232 bytes (each with the memo, when there is one). */
  function pack(o) {
    var W3 = o.W3, out = [], cur = [];
    var fits = function (list) { return sizeOf(W3, o.payer, build(W3, o.payer, list, o.memo, o.cuPrice).ixs) <= MAX_TX; };
    var flush = function () { if (!cur.length) return; var b = build(W3, o.payer, cur, o.memo, o.cuPrice); out.push({ items: cur, ixs: b.ixs, at: b.at, tx: compile(W3, o.payer, b.ixs, o.blockhash) }); cur = []; };
    (o.items || []).forEach(function (it) {
      if (fits(cur.concat([it]))) { cur.push(it); return; }
      flush();
      if (!fits([it])) throw new Error((it.name || it.mint || it.kind) + ' does not fit in a transaction');
      cur = [it];
    });
    flush();
    return out;
  }
  async function simulate(rpc, W3, payer, ixs, watch) {
    var tx = compile(W3, payer, ixs), ser = tx.serialize();
    if (ser.length > MAX_TX) return { err: 'too big', size: ser.length };
    var sim = await rpc('simulateTransaction', [b64of(ser), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed',
      accounts: watch ? { encoding: 'base64', addresses: watch } : undefined }]);
    var v = (sim && sim.value) || {};
    return { err: v.err || null, logs: v.logs || [], units: v.unitsConsumed || 0, accounts: v.accounts || null, size: ser.length };
  }
  var failedIndex = function (err) { var e = err && err.InstructionError; return Array.isArray(e) ? e[0] : -1; };
  var KNOWN = { '0x11': 'it is frozen (locked by its project or a staking program)', '0x1': 'not enough in this wallet (SOL for the network fee, or the amount)', '0x9b': 'it is locked or delegated (staked or listed)', '0x4': 'the owner does not match' };
  function reasonOf(sim) {
    if (sim.err === 'AccountNotFound') return 'this wallet has no SOL to pay the network fee';
    if (sim.err === 'too big') return 'too big for one transaction';
    var code = ((sim.logs || []).join(' ').match(/custom program error: (0x[0-9a-f]+)/) || [])[1];
    if (code && KNOWN[code]) return KNOWN[code] + ' (' + code + ')';
    var l = (sim.logs || []).filter(function (x) { return /Error|failed|Program log: /.test(x) && !/consumed/.test(x); }).slice(-1)[0] || '';
    return (l.replace(/^Program log: /, '').replace(/^Program \w+ /, '').slice(0, 120)) || JSON.stringify(sim.err).slice(0, 120);
  }
  /** Plan the donor's transactions: pack, simulate each; an item whose instruction fails is dropped (with the reason) and
   *  its batch rebuilt. pNFTs get their rule sets read first. → { batches: [{ items, ixs, units }], dropped } */
  async function plan(rpc, W3, owner, items, o) {
    o = o || {};
    var step = o.onStep || function () {}, dropped = [], batches = [];
    var p = items.filter(function (it) { return it.kind === 'pnft' && it.ruleSet === undefined; });
    if (p.length) { step('Reading the rule sets of ' + p.length + ' programmable NFT' + (p.length === 1 ? '' : 's') + '…'); var rs = await ruleSets(rpc, W3, p.map(function (it) { return it.mint; })); p.forEach(function (it) { it.ruleSet = rs[it.mint] || null; }); }
    var queue = pack({ W3: W3, payer: owner, items: items, memo: o.memo, cuPrice: o.cuPrice });
    for (var bi = 0; bi < queue.length; bi++) {
      var list = queue[bi].items.slice();
      step('Checking transaction ' + (bi + 1) + ' of ' + queue.length + ' (simulated — nothing is sent)…');
      for (var tries = 0; tries < 8 && list.length; tries++) {
        var b = build(W3, owner, list, o.memo, o.cuPrice), sim = await simulate(rpc, W3, owner, b.ixs);
        if (!sim.err) { batches.push({ items: list, ixs: b.ixs, units: sim.units }); list = []; break; }
        var at = failedIndex(sim.err), k = -1;
        for (var j = b.at.length - 1; j >= 0; j--) if (at >= b.at[j]) { k = j; break; }
        if (k >= 0 && at < b.ixs.length - (o.memo ? 1 : 0)) { dropped.push({ item: list[k], reason: reasonOf(sim) }); list.splice(k, 1); }
        else { list.forEach(function (it) { dropped.push({ item: it, reason: reasonOf(sim) }); }); list = []; }
      }
      list.forEach(function (it) { dropped.push({ item: it, reason: 'kept failing in simulation' }); });
    }
    return { batches: batches, dropped: dropped };
  }
  /** Compile planned batches with a fresh blockhash, ready to sign. */
  async function finalize(rpc, W3, owner, batches) {
    var bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
    return batches.map(function (b) { return compile(W3, owner, b.ixs, bh); });
  }

  // ---- the donor's wallet ----
  function pluginHit(a, names) {
    var p = (a && a.plugins) || {}, hit = null;
    Object.keys(p).forEach(function (k) { var n = k.replace(/_/g, '').toLowerCase(), x = p[k]; if (!hit && names.indexOf(n) >= 0) hit = x || {}; });
    return hit;
  }
  function coreReason(a, owner, collFrozen) {
    var fz = pluginHit(a, ['freezedelegate', 'permanentfreezedelegate']);
    if ((fz && fz.data && fz.data.frozen) || (a.ownership && a.ownership.frozen)) return 'frozen (staked or locked)';
    if (collFrozen) return 'its collection is frozen (soulbound)';
    var td = pluginHit(a, ['transferdelegate']), au = td && td.authority;
    if (au && au.address && au.address !== owner) return 'listed or delegated somewhere';
    return null;
  }
  async function scan(rpc, W3, owner, onStep) {
    var step = onStep || function () {}, out = { owner: owner, sol: 0, tokens: [], nfts: [], unread: 0 };
    step('Reading your wallet…');
    var settle = function (p) { return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; }); };
    var balP = settle(rpc('getBalance', [owner]));
    var taP = [TOKEN, TOKEN22].map(function (pr) { return settle(rpc('getTokenAccountsByOwner', [owner, { programId: pr }, { encoding: 'jsonParsed' }])); });
    var coreP = settle(rpc('searchAssets', { ownerAddress: owner, interface: 'MplCoreAsset', burnt: false, page: 1, limit: 250 }));
    var bal = await balP; if (!bal.ok) throw bal.e; out.sol = (bal.v && bal.v.value) || 0;
    var rows = [], tas = await Promise.all(taP);
    tas.forEach(function (t, p) {
      if (!t.ok) { if (p === 0) throw t.e; out.unread++; return; }
      ((t.v && t.v.value) || []).forEach(function (a) {
        var info = a.account.data.parsed.info, amt = info.tokenAmount;
        if (amt.amount === '0') return;
        rows.push({ account: a.pubkey, program: p ? TOKEN22 : TOKEN, mint: info.mint, raw: amt.amount, decimals: amt.decimals, frozen: info.state === 'frozen', delegate: info.delegate || null });
      });
    });
    var isNft = function (r) { return r.decimals === 0 && r.raw === '1'; };
    var mints = rows.map(function (r) { return r.mint; }).filter(function (m, i, a) { return a.indexOf(m) === i; }).slice(0, 400), assets = {};
    step('Reading ' + mints.length + ' tokens and NFTs…');
    var keep = function (ab) { (ab || []).forEach(function (a) { if (a && a.id) assets[a.id] = a; }); };
    await Promise.all(chunks(mints, 50).map(function (ids) {
      // collection names ride along when the DAS node supports the option; without it, the plain batch
      return rpc('getAssetBatch', { ids: ids, options: { showCollectionMetadata: true } }).then(keep, function () {
        return rpc('getAssetBatch', { ids: ids }).then(keep, function () { out.unread += ids.length; });
      });
    }));
    // Token-2022 mints: their extensions decide whether they can be sent here at all
    var t22 = rows.filter(function (r) { return r.program === TOKEN22; }).map(function (r) { return r.mint; }).filter(function (m, i, a) { return a.indexOf(m) === i; }), ext = {};
    for (var g of chunks(t22, 100)) {
      try {
        var mr = await rpc('getMultipleAccounts', [g, { encoding: 'jsonParsed' }]);
        ((mr && mr.value) || []).forEach(function (a, i) { var x = a && a.data && a.data.parsed && a.data.parsed.info; ext[g[i]] = ((x && x.extensions) || []).map(function (e) { return e.extension; }); });
      } catch (e) { g.forEach(function (m) { ext[m] = ['unreadable']; }); }
    }
    var t22bad = function (m) { var b = (ext[m] || ['unreadable']).filter(function (e) { return !T22_OK[e]; }); return b.length ? 'a Token-2022 token with ' + b.join(', ') + ' — can’t be sent here' : null; };
    var meta = function (a) { var md = (a && a.content && a.content.metadata) || {}; return { name: String(md.name || '').trim(), symbol: String(md.symbol || '').trim(), image: (a && a.content && a.content.links && a.content.links.image) || '' }; };
    var collOf = function (a) { var g2 = ((a && a.grouping) || []).filter(function (x) { return x.group_key === 'collection'; })[0]; return g2 ? { key: g2.group_value, name: (g2.collection_metadata && g2.collection_metadata.name) || '' } : null; };
    var pnfts = [];
    rows.forEach(function (r) {
      var a = assets[r.mint], m = meta(a);
      if (a && a.compression && a.compression.compressed) return;
      var nftLike = isNft(r) && a && /^(V1_NFT|LEGACY_NFT|ProgrammableNFT)$/.test(a.interface || '');
      if (!nftLike) {
        var ti = (a && a.token_info) || {};
        out.tokens.push({ kind: 'token', mint: r.mint, account: r.account, program: r.program, raw: r.raw, decimals: r.decimals, symbol: ti.symbol || m.symbol || '', name: m.name || '', image: m.image,
          usdPrice: ti.price_info && ti.price_info.price_per_token ? +ti.price_info.price_per_token : null,
          reason: r.frozen ? 'frozen' : r.program === TOKEN22 ? t22bad(r.mint) : null });
        return;
      }
      var pn = a.interface === 'ProgrammableNFT', c = collOf(a);
      var it = { kind: pn ? 'pnft' : 'nft', mint: r.mint, account: r.account, program: r.program, name: m.name || 'Unnamed NFT', image: m.image, collection: c ? c.key : null, collectionName: c ? c.name : '',
        reason: r.program === TOKEN22 ? t22bad(r.mint) : null };
      if (!it.reason && !pn && r.frozen) it.reason = 'frozen (staked or locked)';
      else if (!it.reason && !pn && r.delegate) it.reason = 'listed or delegated somewhere';
      if (pn) pnfts.push(it);
      out.nfts.push(it);
    });
    // a programmable NFT's token record says whether it is locked (staked) or listed
    for (var pg of chunks(pnfts, 100)) {
      try {
        var tr = await rpc('getMultipleAccounts', [pg.map(function (it) { return tokenRecordOf(W3, it.mint, it.account).toBase58(); }), { encoding: 'base64', dataSlice: { offset: 0, length: 3 } }]);
        ((tr && tr.value) || []).forEach(function (a, i) { var st = a && a.data ? b64bytes(a.data[0])[2] : null; if (!pg[i].reason && st === 1) pg[i].reason = 'locked (staked)'; else if (!pg[i].reason && st === 2) pg[i].reason = 'listed for sale'; });
      } catch (e) { out.unread += pg.length; }
    }
    // Metaplex Core: owned directly (no token account)
    var cr = await coreP, cores = cr.ok ? ((cr.v && cr.v.items) || []) : [];
    if (!cr.ok) out.unread++;
    var collIds = cores.map(function (a) { var c = collOf(a); return c ? c.key : null; }).filter(function (x, i, a) { return x && a.indexOf(x) === i; }), frozenColl = {};
    for (var cg of chunks(collIds, 100)) {
      try { var cb = await rpc('getAssetBatch', { ids: cg }); (cb || []).forEach(function (a) { var fz = a && pluginHit(a, ['permanentfreezedelegate', 'freezedelegate']); if (a && fz && fz.data && fz.data.frozen) frozenColl[a.id] = 1; }); } catch (e) { /* treated as not frozen; the send check simulates */ }
    }
    cores.forEach(function (a) {
      if (!a || !a.id || a.burnt || (a.ownership && a.ownership.owner && a.ownership.owner !== owner)) return;
      var m = meta(a), c = collOf(a);
      out.nfts.push({ kind: 'core', mint: a.id, name: m.name || 'Unnamed NFT', image: m.image, collection: c ? c.key : null, collectionName: c ? c.name : '',
        reason: (a.compression && a.compression.compressed) ? 'a compressed Core NFT — can’t be sent here' : coreReason(a, owner, c && frozenColl[c.key]) });
    });
    out.tokens.sort(function (x, y) { return (!!x.reason - !!y.reason) || (x.symbol || x.mint).localeCompare(y.symbol || y.mint); });
    out.nfts.sort(function (x, y) { return (!!x.reason - !!y.reason) || x.name.localeCompare(y.name); });
    return out;
  }

  /** Can each sendable NFT really be sent? Its transfer to `to` is SIMULATED (nothing signed) in small packs; a failing
   *  pack is narrowed down (the failing instruction names its NFT, halves otherwise) and the NFT gets "Can't send". */
  async function checkSends(rpc, W3, owner, to, nfts, onUpdate) {
    var todo = nfts.filter(function (c) { return !c.reason; }), sims = 0, failed = 0, stopped = null;
    var p = todo.filter(function (c) { return c.kind === 'pnft' && c.ruleSet === undefined; });
    if (p.length) { var rs = await ruleSets(rpc, W3, p.map(function (c) { return c.mint; })); p.forEach(function (c) { c.ruleSet = rs[c.mint] || null; }); }
    var asItem = function (c) { return Object.assign({}, c, { to: to }); };
    var run = async function (list) {
      if (!list.length || stopped) return;
      var b = build(W3, owner, list.map(asItem), null, 0), r;
      sims++; r = await simulate(rpc, W3, owner, b.ixs);
      if (r.err && (typeof r.err === 'string' || !r.err.InstructionError)) { stopped = typeof r.err === 'string' ? r.err : 'check stopped'; return; }
      if (!r.err) return;
      if (list.length === 1) { list[0].reason = 'Can’t send — ' + reasonOf(r); list[0].cantSend = true; failed++; return; }
      var at = failedIndex(r.err), k = -1;
      for (var j = b.at.length - 1; j >= 0; j--) if (at >= b.at[j]) { k = j; break; }
      if (k >= 0) { await run(list.slice(0, k)); await run([list[k]]); await run(list.slice(k + 1)); return; }
      var h = list.length >> 1; await run(list.slice(0, h)); await run(list.slice(h));
    };
    var queue = todo.slice();
    while (queue.length && !stopped) {
      var list = [];
      while (queue.length && list.length < 6 && sizeOf(W3, owner, build(W3, owner, list.concat([queue[0]]).map(asItem), null, 0).ixs) <= MAX_TX) list.push(queue.shift());
      if (!list.length) { queue.shift(); continue; }
      await run(list);
      if (onUpdate) onUpdate({ sims: sims, failed: failed, left: queue.length });
    }
    return { sims: sims, failed: failed, stopped: stopped };
  }

  return { TOKEN: TOKEN, TOKEN22: TOKEN22, ATA: ATA, TM: TM, CORE: CORE, AUTH_RULES: AUTH_RULES, MEMO: MEMO, MAX_TX: MAX_TX, PREFIX: PREFIX, NAME_RE: NAME_RE, T22_OK: T22_OK,
    ataOf: ataOf, metaOf: metaOf, editionOf: editionOf, tokenRecordOf: tokenRecordOf, itemIxs: itemIxs, giftMemo: giftMemo, memoIx: memoIx, computeIxs: computeIxs,
    parseMetadata: parseMetadata, ruleSets: ruleSets, pack: pack, build: build, compile: compile, simulate: simulate, plan: plan, finalize: finalize,
    scan: scan, checkSends: checkSends, reasonOf: reasonOf, b58: b58, B: B };
});
