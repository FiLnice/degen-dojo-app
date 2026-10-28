/* Dojo payout transaction builder — shared by /payouts (browser: window.DojoPayoutTx, needs
 * window.solanaWeb3 + window.Buffer) and the Node tests (require('./payout-tx.js') with
 * @solana/web3.js). Builds ONLY unsigned transactions; the owner's wallet signs them.
 *
 * Raw amounts are BigInt (plans carry them as decimal strings; ORE has 11 decimals, so a Number
 * stops being exact above ~90,071 ORE).
 *   transfersForPlan(plan, swapOre)  → [{id, owner, cur, mint, decimals, amount: BigInt}] — swapOre is the
 *                                      SERVER manifest (plan.manifest.swapOre), never a browser estimate
 *   swapBuckets(plan)                → {SOL:{total, parts:[{id, weight}]}, USDC:{…}} (BigInt)
 *   packTransfers({W3, payer, blockhash, transfers}) → [{tx, owners, transfers}] v0 txs ≤ 1232 bytes,
 *                                      each: compute budget + per recipient (create ATA idempotent +
 *                                      TransferChecked) — a recipient's ORE+SKR stay in one tx
 *   swapFromQuote({fetch, base, payer, quote}) → {minOut, swapTransaction(b64)} — builds the swap from the
 *                                      server's recorded quote (/api/payouts action 'quote')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DojoPayoutTx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  var ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  var SYS = '11111111111111111111111111111111';
  var CB = 'ComputeBudget111111111111111111111111111111';
  var MINTS = { ORE: 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp', SKR: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3', USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SOL: 'So11111111111111111111111111111111111111112' };
  var DEC = { ORE: 11, SKR: 6, SOL: 9, USDC: 6 };
  var MAX_TX = 1232;
  var CU_PER_RECIPIENT_MINT = 32000;   // create-ATA-idempotent (~25k when it creates) + TransferChecked (~6k)

  // raw value (BigInt | decimal string | integer Number from an old plan) → BigInt
  function B(v) { if (typeof v === 'bigint') return v; if (typeof v === 'number') return BigInt(Math.trunc(v) || 0); var t = String(v == null ? '0' : v).trim(); return /^-?\d+$/.test(t) ? BigInt(t) : 0n; }
  function bytes(arr) { var B = (typeof Buffer !== 'undefined') ? Buffer : null; return B ? B.from(arr) : Uint8Array.from(arr); }
  function u64le(v) { var b = new Uint8Array(8), dv = new DataView(b.buffer); dv.setBigUint64(0, BigInt(v), true); return b; }
  function u32le(v) { var b = new Uint8Array(4), dv = new DataView(b.buffer); dv.setUint32(0, v >>> 0, true); return b; }
  function cat() { var n = 0, i, o = 0; for (i = 0; i < arguments.length; i++) n += arguments[i].length; var out = new Uint8Array(n); for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; } return out; }

  function ataAddress(W3, owner, mint, program) {
    return W3.PublicKey.findProgramAddressSync([new W3.PublicKey(owner).toBytes(), new W3.PublicKey(program || TOKEN).toBytes(), new W3.PublicKey(mint).toBytes()], new W3.PublicKey(ATA))[0];
  }
  function meta(W3, k, s, w) { return { pubkey: new W3.PublicKey(k), isSigner: !!s, isWritable: !!w }; }
  function ix(W3, programId, keys, data) { return new W3.TransactionInstruction({ programId: new W3.PublicKey(programId), keys: keys, data: bytes(data) }); }

  // [create recipient ATA (idempotent — no-op if it exists), TransferChecked payer→recipient]
  function transferIxs(W3, payer, t) {
    var src = ataAddress(W3, payer, t.mint), dst = ataAddress(W3, t.owner, t.mint);
    return [
      ix(W3, ATA, [meta(W3, payer, true, true), meta(W3, dst, false, true), meta(W3, t.owner, false, false), meta(W3, t.mint, false, false), meta(W3, SYS, false, false), meta(W3, TOKEN, false, false)], [1]),
      ix(W3, TOKEN, [meta(W3, src, false, true), meta(W3, t.mint, false, false), meta(W3, dst, false, true), meta(W3, payer, true, false)], cat([12], u64le(t.amount), [t.decimals])),
    ];
  }
  function computeIxs(W3, units, microLamports) {
    var out = [ix(W3, CB, [], cat([2], u32le(units)))];
    if (microLamports > 0) out.push(ix(W3, CB, [], cat([3], u64le(microLamports))));
    return out;
  }
  function compile(W3, payer, blockhash, transfers, cuPrice) {
    var ixs = computeIxs(W3, Math.min(1400000, 5000 + CU_PER_RECIPIENT_MINT * transfers.length), cuPrice);
    transfers.forEach(function (t) { ixs = ixs.concat(transferIxs(W3, payer, t)); });
    var msg = new W3.TransactionMessage({ payerKey: new W3.PublicKey(payer), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    return new W3.VersionedTransaction(msg);
  }
  function sizeOf(tx) { try { return tx.serialize().length; } catch (e) { return Infinity; } }

  // Greedy pack, keeping each recipient's transfers together.
  function packTransfers(o) {
    var W3 = o.W3, payer = o.payer, bh = o.blockhash, cuPrice = o.cuPrice == null ? 20000 : o.cuPrice;
    var groups = [], byOwner = {};
    (o.transfers || []).forEach(function (t) { if (!(B(t.amount) > 0n)) return; if (!byOwner[t.owner]) { byOwner[t.owner] = []; groups.push(byOwner[t.owner]); } byOwner[t.owner].push(t); });
    var out = [], cur = [];
    function flush() { if (!cur.length) return; var tx = compile(W3, payer, bh, cur, cuPrice); out.push({ tx: tx, size: sizeOf(tx), transfers: cur, owners: cur.map(function (t) { return t.owner; }).filter(function (v, i, a) { return a.indexOf(v) === i; }) }); cur = []; }
    groups.forEach(function (g) {
      var tryList = cur.concat(g);
      if (sizeOf(compile(W3, payer, bh, tryList, cuPrice)) <= MAX_TX) { cur = tryList; return; }
      flush();
      if (sizeOf(compile(W3, payer, bh, g, cuPrice)) > MAX_TX) throw new Error('one recipient does not fit in a transaction');
      cur = g.slice();
    });
    flush();
    return out;
  }

  function payable(plan, skipIds) {
    var ex = {}; (plan.excluded || []).forEach(function (id) { ex[id] = 1; });
    var paid = (plan.payment && plan.payment.paidIds) || {};
    return (plan.payees || []).filter(function (p) { return !ex[p.id] && !paid[p.id] && !(skipIds && skipIds[p.id]); });
  }
  function swapBuckets(plan, skipIds) {
    var b = { SOL: { total: 0n, parts: [] }, USDC: { total: 0n, parts: [] } };
    payable(plan, skipIds).forEach(function (p) {
      ['SOL', 'USDC'].forEach(function (c) { var v = B(p.pay[c]); if (v > 0n) { b[c].total += v; b[c].parts.push({ id: p.id, weight: v }); } });
    });
    return b;
  }
  function transfersForPlan(plan, swapOre, skipIds) {
    var out = [];
    payable(plan, skipIds).forEach(function (p) {
      var ore = B(p.pay.ORE) + B(swapOre && swapOre[p.id]), skr = B(p.pay.SKR);
      if (ore > 0n) out.push({ id: p.id, owner: p.wallet, cur: 'ORE', mint: MINTS.ORE, decimals: DEC.ORE, amount: ore });
      if (skr > 0n) out.push({ id: p.id, owner: p.wallet, cur: 'SKR', mint: MINTS.SKR, decimals: DEC.SKR, amount: skr });
    });
    return out;
  }
  // Burn Raffle gift prizes still to send (pay.bonus of the unpaid payees) → [{ key, id, to, kind, mint, raw, decimals,
  // program, collection, title }] for dojo-gift.js; `done` = gift keys an earlier attempt already sent (key = payee id + mint)
  function giftsForPlan(plan, skipIds, done) {
    var out = [];
    payable(plan, skipIds).forEach(function (p) {
      ((p.pay && p.pay.bonus) || []).forEach(function (b) {
        var key = p.id + ':' + b.mint;
        if (done && done[key]) return;
        out.push({ key: key, id: p.id, to: p.wallet, kind: b.kind, mint: b.mint, raw: b.kind === 'token' ? String(b.raw) : '1', decimals: Number(b.decimals) || 0,
          program: b.program || (b.kind === 'core' ? null : TOKEN), collection: b.collection || null, title: b.title || b.symbol || '' });
      });
    });
    return out;
  }
  // totals still to send per token (raw)
  function need(plan, skipIds) {
    var t = { ORE: 0n, SKR: 0n, SOL: 0n, USDC: 0n };
    payable(plan, skipIds).forEach(function (p) { ['ORE', 'SKR', 'SOL', 'USDC'].forEach(function (c) { t[c] += B(p.pay[c]); }); });
    return t;
  }

  // Build the Jupiter ExactIn swap X → ORE from the SERVER's recorded quote (plan.manifest.swaps[c].quote).
  // minOut = the ORE the swap guarantees after slippage — the server already split exactly that.
  function swapFromQuote(o) {
    var f = o.fetch || fetch, base = o.base || 'https://lite-api.jup.ag', quote = o.quote;
    if (!quote || quote.outputMint !== MINTS.ORE) return Promise.reject(new Error('No server quote to swap with — press Pay again'));
    return f(base + '/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: o.payer, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })
      .then(function (r) { return r.json(); }).then(function (s) {
        if (!s || !s.swapTransaction) throw new Error('The swap to ORE could not be built' + (s && s.error ? ' (' + s.error + ')' : ''));
        return { minOut: B(quote.otherAmountThreshold != null ? quote.otherAmountThreshold : quote.outAmount), swapTransaction: s.swapTransaction };
      });
  }

  // ---------- Dojo Keeper: burn the cards holders sent to the Treasury (Token Metadata BurnV1, pNFT) ----------
  // Accounts as mpl-token-metadata's burnV1: authority, collectionMetadata, metadata, edition, mint, token,
  // masterEdition, masterEditionMint, masterEditionToken, editionMarker, tokenRecord, system, sysvar ixs, spl-token.
  // Absent optional accounts are the program id itself (read-only). data = [41 (Burn), 0 (V1), amount u64].
  var TM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', SYSVAR_IX = 'Sysvar1nstructions1111111111111111111111111';
  var enc = function (s) { return new TextEncoder().encode(s); };
  function tmPda(W3, seeds) { return W3.PublicKey.findProgramAddressSync(seeds, new W3.PublicKey(TM))[0]; }
  function burnPnftIxs(W3, owner, mint, collectionMint) {
    var tm = new W3.PublicKey(TM).toBytes(), m = new W3.PublicKey(mint).toBytes();
    var metadata = tmPda(W3, [enc('metadata'), tm, m]), edition = tmPda(W3, [enc('metadata'), tm, m, enc('edition')]);
    var token = ataAddress(W3, owner, mint), tokenRecord = tmPda(W3, [enc('metadata'), tm, m, enc('token_record'), token.toBytes()]);
    var coll = collectionMint ? tmPda(W3, [enc('metadata'), tm, new W3.PublicKey(collectionMint).toBytes()]) : null;
    var keys = [meta(W3, owner, true, true), coll ? meta(W3, coll, false, true) : meta(W3, TM, false, false), meta(W3, metadata, false, true), meta(W3, edition, false, true),
      meta(W3, mint, false, true), meta(W3, token, false, true), meta(W3, TM, false, false), meta(W3, TM, false, false), meta(W3, TM, false, false), meta(W3, TM, false, false),
      meta(W3, tokenRecord, false, true), meta(W3, SYS, false, false), meta(W3, SYSVAR_IX, false, false), meta(W3, TOKEN, false, false)];
    return [ix(W3, TM, keys, cat([41, 0], u64le(1)))];
  }
  // Pack burns of the Treasury's sent-in cards into v0 txs ≤ 1232 bytes (≈ 3 per tx).
  function packBurns(o) {
    var W3 = o.W3, out = [], cur = [], cuPrice = o.cuPrice == null ? 20000 : o.cuPrice;
    function build(list) { var ixs = computeIxs(W3, Math.min(1400000, 20000 + 150000 * list.length), cuPrice); list.forEach(function (b) { ixs = ixs.concat(burnPnftIxs(W3, o.payer, b.mint, b.collection)); });
      return new W3.VersionedTransaction(new W3.TransactionMessage({ payerKey: new W3.PublicKey(o.payer), recentBlockhash: o.blockhash, instructions: ixs }).compileToV0Message()); }
    (o.burns || []).forEach(function (b) {
      var t = cur.concat([b]);
      if (sizeOf(build(t)) <= MAX_TX && t.length <= 4) { cur = t; return; }
      if (cur.length) out.push({ tx: build(cur), burns: cur });
      cur = [b];
    });
    if (cur.length) out.push({ tx: build(cur), burns: cur });
    return out;
  }
  // Build a Jupiter swap from a SERVER quote to any output (the Keeper's conversion to stORE).
  function swapFromQuoteTo(o) {
    var f = o.fetch || fetch, base = o.base || 'https://lite-api.jup.ag', quote = o.quote;
    if (!quote || quote.outputMint !== o.outputMint) return Promise.reject(new Error('No server quote for that swap — press the button again'));
    return f(base + '/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: o.payer, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })
      .then(function (r) { return r.json(); }).then(function (s) {
        if (!s || !s.swapTransaction) throw new Error('The swap could not be built' + (s && s.error ? ' (' + s.error + ')' : ''));
        return { swapTransaction: s.swapTransaction };
      });
  }

  // ---------- DD-09: check every transaction BEFORE the Treasury signs it ----------
  // inspect({ W3, rpc(method, params) → result, tx: VersionedTransaction, signer: the Treasury, expect })
  //   expect.kind 'transfers' : expect.transfers [{owner, mint, decimals, amount}] (SPL) + expect.sol [{to, lamports}]
  //                            — the tx must be EXACTLY these payments (plus compute budget + the recipients' token
  //                              accounts); expect.afterSwap: its tokens come from a swap in the same batch, so a test
  //                              run may fail for missing funds — then the instruction-by-instruction check decides
  //               'swap'      : expect.spendMint / spendMax (raw; SOL = lamports) and getMint / getMin (raw) — the
  //                              swap program is opaque, so the TEST RUN decides: spends ≤ spendMax, gets ≥ getMin
  //               'burns'     : expect.burns [{mint}] — Token Metadata BurnV1 of exactly these cards
  //               'gifts'     : expect.gifts [{to, kind: token|nft|pnft|core, mint, raw, program}] — a Burn Raffle winner's gift
  //                              prizes (dojo-gift.js builds them): TransferChecked of exactly these tokens / NFTs (+ the
  //                              winner's token account), Token Metadata Transfer V1 of exactly these pNFTs, Core TransferV1 of
  //                              exactly these assets — and the test run shows each one arriving, Core assets owned by the winner
  // Always: the Treasury pays the fee; only known programs; no Approve / SetAuthority / closing of Treasury token
  // accounts (also checked on the simulated account state, so a hidden inner call can't do it either); no other
  // Treasury token account is written; the network fee stays under 0.01 SOL.
  // → { ok: true, simulated, text: 'Checked: … ✓' } — or throws Error('Refused: …') and nothing gets signed.
  var JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  var MEMO1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', MEMO2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  var STORE = 'storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR', CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
  var TOKEN_RECORD_ALLOW = 2000000n;   // a pNFT gift: Token Metadata opens the winner's token record (≈ 1.06–1.45M lamports) from the Treasury
  var NAME = {}; NAME[MINTS.ORE] = 'ORE'; NAME[MINTS.SKR] = 'SKR'; NAME[MINTS.USDC] = 'USDC'; NAME[MINTS.SOL] = 'SOL'; NAME[STORE] = 'stORE';
  var DECM = {}; DECM[MINTS.ORE] = 11; DECM[STORE] = 11; DECM[MINTS.SKR] = 6; DECM[MINTS.USDC] = 6; DECM[MINTS.SOL] = 9;
  var ATA_RENT = 2039280n, MAX_FEE_LAMPORTS = 10000000n;   // a token account's rent · the network-fee cap (0.01 SOL)
  function nameOf(m) { return NAME[m] || (m.slice(0, 4) + '…'); }
  function fmtRaw(raw, mint) { var d = DECM[mint] != null ? DECM[mint] : 0; return (Number(B(raw)) / Math.pow(10, d)).toLocaleString('en-US', { maximumFractionDigits: d >= 9 ? 6 : 4 }) + ' ' + nameOf(mint); }
  function u64At(b, o) { var v = 0n; for (var i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; }
  function u32At(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function b64bytes(s) { if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64')); var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function b64of(u8) { if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64'); var s = ''; for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  // an SPL token account's state: { mint, owner, amount, delegate, closeAuth } (null when it isn't one)
  function tokAcct(W3, acc) {
    if (!acc || !acc.data) return null;
    var d = b64bytes(Array.isArray(acc.data) ? acc.data[0] : acc.data);
    if (d.length < 165) return null;
    var k = function (a, b) { return new W3.PublicKey(d.subarray(a, b)).toBase58(); };
    return { mint: k(0, 32), owner: k(32, 64), amount: u64At(d, 64), delegate: u32At(d, 72) ? k(76, 108) : null, closeAuth: u32At(d, 129) ? k(133, 165) : null };
  }
  // ---- the Jupiter swap instruction's OWN limits (what the chain enforces — a test run can't see them) ----
  // Jupiter v6 (JUP6…) instructions end with fixed arguments; checked against real lite-api.jup.ag swaps built for the
  // Treasury (2026-10-24): route / sharedAccountsRoute (ExactIn) end with  in_amount u64 · quoted_out_amount u64 ·
  // slippage_bps u16 · platform_fee_bps u8;  exactOutRoute / sharedAccountsExactOutRoute end with  out_amount u64 ·
  // quoted_in_amount u64 · slippage_bps u16 · platform_fee_bps u8. On-chain, an ExactIn swap fails unless it gets
  // ≥ quoted_out × (10000 − slippage) / 10000 (rounded up, as Jupiter's otherAmountThreshold is) — so a builder that
  // strips that floor (quoted_out = 1, slippage 99.99%) leaves a swap any sandwich bot can drain while its test run
  // still looks fine. Any other Jupiter instruction (token-ledger / v2 variants) is refused, not guessed at.
  var JUP_IX = { e517cb977ae3ad2a: { name: 'route', mode: 'ExactIn' }, c1209b3341d69c81: { name: 'sharedAccountsRoute', mode: 'ExactIn' },
    d033ef977b2bed5c: { name: 'exactOutRoute', mode: 'ExactOut' }, b0d169a89a7d453e: { name: 'sharedAccountsExactOutRoute', mode: 'ExactOut' } };
  var MAX_SLIPPAGE_BPS = 100;
  function hex8(d) { var s = ''; for (var i = 0; i < 8 && i < d.length; i++) s += (d[i] < 16 ? '0' : '') + d[i].toString(16); return s; }
  // → { name, mode, amount (in_amount | out_amount), quoted (quoted_out | quoted_in), slippageBps, platformFeeBps } | null
  function jupSwapArgs(d) {
    var k = JUP_IX[hex8(d)], L = d.length;
    if (!k || L < 8 + 4 + 19) return null;
    return { name: k.name, mode: k.mode, amount: u64At(d, L - 19), quoted: u64At(d, L - 11), slippageBps: d[L - 3] | (d[L - 2] << 8), platformFeeBps: d[L - 1] };
  }
  var ceilDiv = function (a, b) { return (a + b - 1n) / b; };
  // the minimum an ExactIn swap must deliver on-chain / the most an ExactOut swap may take, from its own arguments
  function jupOnChainMinOut(a) { return ceilDiv(a.quoted * BigInt(10000 - a.slippageBps), 10000n); }
  function jupOnChainMaxIn(a) { return ceilDiv(a.quoted * BigInt(10000 + a.slippageBps), 10000n); }
  function sumBy(list, key, val) { var o = {}; list.forEach(function (x) { o[x[key]] = (o[x[key]] || 0n) + B(x[val]); }); return o; }
  function andList(parts) { return parts.length < 2 ? parts.join('') : parts.slice(0, -1).join(', ') + ' + ' + parts[parts.length - 1]; }

  async function inspect(o) {
    var W3 = o.W3, rpc = o.rpc, tx = o.tx, signer = o.signer, e = o.expect || {}, kind = e.kind;
    var refuse = function (why) { throw new Error('Refused: ' + why); };
    if (['transfers', 'swap', 'burns', 'gifts'].indexOf(kind) < 0) refuse('no check is defined for this transaction');
    var pays = kind === 'transfers' || kind === 'gifts';
    var msg = tx.message;
    if (msg.staticAccountKeys[0].toBase58() !== signer) refuse('the network fee would not be paid by the Treasury ' + signer.slice(0, 4) + '…');
    // every account the tx uses (lookup tables resolved) and which of them it writes
    var alts = [];
    if (msg.addressTableLookups && msg.addressTableLookups.length) {
      var lk = msg.addressTableLookups.map(function (l) { return l.accountKey.toBase58(); });
      var lr = await rpc('getMultipleAccounts', [lk, { encoding: 'base64' }]);
      ((lr && lr.value) || []).forEach(function (a, i) { if (!a) refuse('it uses an unknown address lookup table'); alts.push(new W3.AddressLookupTableAccount({ key: new W3.PublicKey(lk[i]), state: W3.AddressLookupTableAccount.deserialize(b64bytes(a.data[0])) })); });
      if (alts.length !== lk.length) refuse('it uses an unknown address lookup table');
    }
    var keys = msg.getAccountKeys({ addressLookupTableAccounts: alts }), K = [], writable = {};
    for (var i = 0; i < keys.length; i++) { K.push(keys.get(i).toBase58()); if (msg.isAccountWritable(i)) writable[K[i]] = true; }
    // the Treasury's own token accounts (both token programs)
    var mine = {};
    for (var p = 0; p < 2; p++) {
      var tk = await rpc('getTokenAccountsByOwner', [signer, { programId: p ? TOKEN22 : TOKEN }, { encoding: 'jsonParsed' }]);
      ((tk && tk.value) || []).forEach(function (a) { mine[a.pubkey] = a.account.data.parsed.info.mint; });
    }
    var allowed = {}; [SYS, TOKEN, TOKEN22, ATA, CB, MEMO1, MEMO2].forEach(function (x) { allowed[x] = 1; });
    if (kind === 'swap') allowed[JUP] = 1;
    if (kind === 'burns') allowed[TM] = 1;
    if (kind === 'gifts') { allowed[TM] = 1; allowed[CORE] = 1; }
    var wsol = ataAddress(W3, signer, MINTS.SOL).toBase58();
    var okMints = {}, closable = {};
    var expT = (e.transfers || []).map(function (t) { return { owner: t.owner, mint: t.mint, amount: B(t.amount), src: ataAddress(W3, signer, t.mint).toBase58(), dst: ataAddress(W3, t.owner, t.mint).toBase58(), seen: false }; });
    // gifts: tokens + Token Metadata NFTs move by TransferChecked (program-aware token accounts), pNFTs by Transfer V1, Core by TransferV1
    var gifts = kind === 'gifts' ? (e.gifts || []) : [];
    gifts.forEach(function (g) {
      if (g.kind !== 'token' && g.kind !== 'nft') return;
      expT.push({ owner: g.to, mint: g.mint, amount: g.kind === 'nft' ? 1n : B(g.raw), src: ataAddress(W3, signer, g.mint, g.program).toBase58(), dst: ataAddress(W3, g.to, g.mint, g.program).toBase58(), seen: false });
      if (g.kind === 'nft') closable[ataAddress(W3, signer, g.mint, g.program).toBase58()] = 1;
    });
    var expP = gifts.filter(function (g) { return g.kind === 'pnft'; }).map(function (g) { return { owner: g.to, mint: g.mint, amount: 1n, src: ataAddress(W3, signer, g.mint, g.program).toBase58(), dst: ataAddress(W3, g.to, g.mint, g.program).toBase58(), seen: false }; });
    var expC = gifts.filter(function (g) { return g.kind === 'core'; }).map(function (g) { return { owner: g.to, asset: g.mint, seen: false }; });
    if (gifts.length !== expT.length - (e.transfers || []).length + expP.length + expC.length) refuse('a gift of an unknown kind');
    expP.forEach(function (p) { okMints[p.mint] = 1; closable[p.src] = 1; });   // Token Metadata may close the Treasury's emptied pNFT account
    var expS = (e.sol || []).map(function (s) { return { to: s.to, lamports: B(s.lamports), seen: false }; });
    var expB = (e.burns || []).map(function (b) { return { mint: b.mint, token: ataAddress(W3, signer, b.mint).toBase58(), seen: false }; });
    expT.forEach(function (t) { okMints[t.mint] = 1; });
    if (kind === 'swap') { okMints[e.spendMint] = 1; okMints[e.getMint] = 1; okMints[MINTS.SOL] = 1; closable[wsol] = 1; }
    expB.forEach(function (b) { okMints[b.mint] = 1; closable[b.token] = 1; });

    // 1) instruction by instruction
    var cuLimit = null, cuPrice = 0n, nIx = 0, jupN = 0, jupMin = null;
    msg.compiledInstructions.forEach(function (ci, n) {
      var prog = K[ci.programIdIndex], acc = ci.accountKeyIndexes.map(function (x) { return K[x]; }), d = ci.data, where = 'step ' + (n + 1) + ': ';
      if (!allowed[prog]) refuse(where + 'it calls a program a ' + (kind === 'swap' ? 'swap' : kind === 'burns' ? 'burn' : 'payment') + ' never needs (' + prog.slice(0, 6) + '…)');
      if (prog !== CB) nIx++;
      if (prog === CB) { if (d[0] === 2) cuLimit = u32At(d, 1); else if (d[0] === 3) cuPrice = u64At(d, 1); else if (d[0] !== 1 && d[0] !== 4) refuse(where + 'an unexpected compute-budget instruction'); return; }
      if (prog === MEMO1 || prog === MEMO2) return;
      if (prog === SYS) {
        var st = u32At(d, 0);
        if (st === 2) {   // Transfer
          if (acc[0] !== signer) refuse(where + 'a SOL transfer from another wallet');
          var lam = u64At(d, 4);
          if (kind === 'swap' && acc[1] === wsol) return;   // wrapping SOL for the swap (judged by the test run)
          var s = expS.filter(function (x) { return !x.seen && x.to === acc[1] && x.lamports === lam; })[0];
          if (!s) refuse(where + 'it sends ' + fmtRaw(lam, MINTS.SOL) + ' to ' + acc[1].slice(0, 4) + '…, which this payout does not say');
          s.seen = true; return;
        }
        if ((st === 0 || st === 3) && kind === 'swap' && acc[0] === signer && acc[1] !== signer) return;   // opens a temporary account (its SOL is counted below)
        refuse(where + 'a system instruction a payment never needs (#' + st + ')');
      }
      if (prog === ATA) {
        if (d.length && d[0] !== 0 && d[0] !== 1) refuse(where + 'an unexpected token-account instruction');
        if (acc[0] !== signer) refuse(where + 'someone else pays for a new token account');
        if (ataAddress(W3, acc[2], acc[3], acc[5] === TOKEN22 ? TOKEN22 : TOKEN).toBase58() !== acc[1]) refuse(where + 'it opens a token account that is not the owner\'s standard one');
        if (pays && !expT.some(function (x) { return x.dst === acc[1]; })) refuse(where + 'it opens a token account for ' + acc[2].slice(0, 4) + '…, who is not paid here');
        if (kind === 'swap' && acc[2] !== signer) refuse(where + 'the swap opens a token account for another wallet');
        if (kind === 'burns') refuse(where + 'a burn never opens token accounts');
        return;
      }
      if (prog === TOKEN || prog === TOKEN22) {
        var op = d[0];
        if (op === 12 || op === 3) {
          if (!pays) refuse(where + 'a direct token transfer inside a ' + kind);
          var src = acc[0], mintT = op === 12 ? acc[1] : null, dst = op === 12 ? acc[2] : acc[1], auth = op === 12 ? acc[3] : acc[2], amt = u64At(d, 1);
          var x = expT.filter(function (y) { return !y.seen && y.src === src && y.dst === dst && y.amount === amt && (!mintT || y.mint === mintT); })[0];
          if (!x || auth !== signer) refuse(where + 'a token transfer that does not match the plan (amount or recipient changed)');
          x.seen = true; return;
        }
        if (op === 17 || op === 1 || op === 16 || op === 18) return;   // SyncNative / InitializeAccount (wrapped SOL)
        if (op === 9) {
          if (mine[acc[0]] && !closable[acc[0]]) refuse(where + 'it closes one of the Treasury\'s token accounts');
          if (acc[1] !== signer) refuse(where + 'a closed account\'s deposit would go to another wallet');
          return;
        }
        if (op === 4 || op === 13) refuse(where + 'it would let another wallet spend Treasury tokens (Approve)');
        if (op === 6) refuse(where + 'it would change who controls a token account (SetAuthority)');
        refuse(where + 'a token instruction a payment never needs (#' + op + ')');
      }
      if (prog === TM && kind === 'gifts') {
        // Transfer V1 { amount: 1 } of a planned pNFT: from the Treasury's own account, the Treasury the authority and payer
        if (!(d[0] === 49 && d[1] === 0) || u64At(d, 2) !== 1n) refuse(where + 'a Token Metadata instruction that is not a 1-NFT transfer');
        if (acc[1] !== signer || acc[9] !== signer || acc[10] !== signer) refuse(where + 'an NFT transfer the Treasury doesn\'t own, authorise and pay for');
        var pp = expP.filter(function (y) { return !y.seen && y.mint === acc[4] && y.src === acc[0] && y.owner === acc[3] && y.dst === acc[2]; })[0];
        if (!pp) refuse(where + 'it sends ' + acc[4].slice(0, 4) + '… to ' + acc[3].slice(0, 4) + '…, which this payout does not say');
        pp.seen = true; return;
      }
      if (prog === CORE) {
        // TransferV1 of a planned Core asset to its winner; the Treasury pays and is the authority (or none → the payer)
        if (kind !== 'gifts' || d[0] !== 14) refuse(where + 'a Core instruction that is not a transfer');
        if (acc[2] !== signer || (acc[3] !== signer && acc[3] !== CORE)) refuse(where + 'a Core transfer the Treasury doesn\'t pay for and authorise');
        var cc = expC.filter(function (y) { return !y.seen && y.asset === acc[0] && y.owner === acc[4]; })[0];
        if (!cc) refuse(where + 'it sends the Core asset ' + String(acc[0]).slice(0, 4) + '… somewhere this payout does not say');
        cc.seen = true; return;
      }
      if (prog === TM) {
        if (!(d[0] === 41 && d[1] === 0)) refuse(where + 'a Token Metadata instruction that is not a burn');
        if (acc[0] !== signer) refuse(where + 'a burn by another wallet');
        var b = expB.filter(function (y) { return !y.seen && y.mint === acc[4] && y.token === acc[5]; })[0];
        if (!b) refuse(where + 'it burns ' + acc[4].slice(0, 4) + '…, which is not on the burn list');
        b.seen = true; return;
      }
      if (prog === JUP) {
        // the swap's own on-chain limits must be at least what the server quoted (the test run alone can't see them)
        var ja = jupSwapArgs(d);
        if (!ja) refuse(where + 'an unknown Jupiter instruction (' + hex8(d) + ') — only a plain route can be checked');
        if (ja.mode !== 'ExactIn') refuse(where + 'the swap is not an exact-input swap, as the server quote is');
        if (++jupN > 1) refuse(where + 'more than one swap in one transaction');
        if (ja.platformFeeBps !== 0) refuse(where + 'the swap would pay a platform fee of ' + (ja.platformFeeBps / 100) + '%');
        if (ja.slippageBps > (e.maxSlippageBps != null ? e.maxSlippageBps : MAX_SLIPPAGE_BPS)) refuse(where + 'the swap allows ' + (ja.slippageBps / 100) + '% slippage (the quote allows ' + ((e.maxSlippageBps != null ? e.maxSlippageBps : MAX_SLIPPAGE_BPS) / 100) + '%)');
        if (ja.amount > B(e.spendMax)) refuse(where + 'the swap spends ' + fmtRaw(ja.amount, e.spendMint) + ', more than the quoted ' + fmtRaw(e.spendMax, e.spendMint));
        jupMin = jupOnChainMinOut(ja);
        if (jupMin < B(e.getMin)) refuse(where + 'the swap\'s own on-chain minimum is ' + fmtRaw(jupMin, e.getMint) + ', below the quoted ' + fmtRaw(e.getMin, e.getMint) + ' — its price protection was changed');
        return;
      }
    });
    if (kind === 'swap' && !jupN) refuse('there is no swap in this transaction');
    var missing = expT.filter(function (x) { return !x.seen; }).length + expS.filter(function (x) { return !x.seen; }).length + expB.filter(function (x) { return !x.seen; }).length +
      expP.filter(function (x) { return !x.seen; }).length + expC.filter(function (x) { return !x.seen; }).length;
    if (missing) refuse(missing + ' planned payment(s) are missing from the transaction');
    var limit = BigInt(cuLimit != null ? cuLimit : 200000 * Math.max(1, nIx));
    var fee = (cuPrice * limit + 999999n) / 1000000n + 5000n * BigInt(msg.header.numRequiredSignatures);
    if (fee > MAX_FEE_LAMPORTS) refuse('its network fee could reach ' + fmtRaw(fee, MINTS.SOL) + ' (the cap is 0.01 SOL)');
    Object.keys(writable).forEach(function (k) { if (mine[k] && !okMints[mine[k]]) refuse('it would write to the Treasury\'s ' + nameOf(mine[k]) + ' account, which this ' + kind + ' never needs'); });

    // what it says it does, in plain words
    var said;
    if (kind === 'gifts') {
      var gw = {}; gifts.forEach(function (g) { gw[g.to] = 1; });
      var nT = gifts.filter(function (g) { return g.kind === 'token'; }).length, nN = gifts.length - nT, ngw = Object.keys(gw).length;
      said = 'sends ' + andList([nT ? nT + ' gift token amount' + (nT === 1 ? '' : 's') : '', nN ? nN + ' gift NFT' + (nN === 1 ? '' : 's') : ''].filter(Boolean)) + ' to ' + ngw + ' raffle winner' + (ngw === 1 ? '' : 's');
    } else if (kind === 'transfers') {
      var byMint = sumBy(expT, 'mint', 'amount'), parts = Object.keys(byMint).map(function (m) { return fmtRaw(byMint[m], m); });
      var solOut = expS.reduce(function (a, s) { return a + s.lamports; }, 0n); if (solOut > 0n) parts.push(fmtRaw(solOut, MINTS.SOL));
      var who = {}; expT.forEach(function (t) { who[t.owner] = 1; }); expS.forEach(function (s) { who[s.to] = 1; });
      var nw = Object.keys(who).length;
      said = 'sends ' + andList(parts) + ' to ' + nw + ' wallet' + (nw === 1 ? '' : 's');
    } else if (kind === 'swap') said = 'swaps ' + fmtRaw(e.spendMax, e.spendMint) + ' for at least ' + fmtRaw(e.getMin, e.getMint) + ' into the Treasury (the swap itself enforces ≥ ' + fmtRaw(jupMin, e.getMint) + ')';
    else said = 'burns ' + expB.length + ' card' + (expB.length === 1 ? '' : 's') + ' the holders sent in';

    // 2) the test run, and the Treasury's accounts before / after
    var watch = [signer], addW = function (k) { if (watch.indexOf(k) < 0) watch.push(k); };
    Object.keys(writable).forEach(function (k) { if (mine[k]) addW(k); });
    if (kind === 'swap') { addW(ataAddress(W3, signer, e.getMint).toBase58()); if (e.spendMint !== MINTS.SOL) addW(ataAddress(W3, signer, e.spendMint).toBase58()); addW(wsol); }
    expT.forEach(function (t) { addW(t.dst); if (kind === 'gifts') addW(t.src); });
    expP.forEach(function (p) { addW(p.dst); addW(p.src); });
    expC.forEach(function (c) { addW(c.asset); });
    expS.forEach(function (s) { addW(s.to); });
    if (watch.length > 64) refuse('too many accounts to check in one test run');
    var pre = ((await rpc('getMultipleAccounts', [watch, { encoding: 'base64' }])) || {}).value || [];
    var sim = await rpc('simulateTransaction', [b64of(tx.serialize()), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: watch }, innerInstructions: true }]);
    var sv = sim && sim.value;
    if (!sv) refuse('the test run returned nothing');
    if (sv.err) {
      var logs = (sv.logs || []).join('\n');
      if (kind === 'transfers' && e.afterSwap && /insufficient (funds|lamports)/i.test(logs)) return { ok: true, simulated: false, text: 'Checked step by step (its ORE comes from the swap before it): ' + said + ', nothing else touched ✓' };
      refuse('the network rejects it in a test run' + (/insufficient/i.test(logs) ? ' (not enough in the Treasury)' : ''));
    }
    var post = sv.accounts || [];
    // SOL the Treasury really spends = its own lamports + its wrapped-SOL account's lamports, before vs after
    var delta = {}, solSpent = 0n, newAtas = 0, got = {}, coreOwner = {};
    var isCore = {}; expC.forEach(function (c) { isCore[c.asset] = 1; });
    for (var w = 0; w < watch.length; w++) {
      var addr = watch[w], a0 = pre[w], a1 = post[w];
      if (addr === signer || addr === wsol) solSpent += B(a0 ? a0.lamports : 0) - B(a1 ? a1.lamports : 0);
      if (addr === signer) continue;
      if (isCore[addr]) {   // a Core asset (AssetV1: key 1, then its owner) — not a token account
        var cd = a1 && a1.data ? b64bytes(Array.isArray(a1.data) ? a1.data[0] : a1.data) : null;
        coreOwner[addr] = cd && cd.length >= 33 && cd[0] === 1 ? new W3.PublicKey(cd.subarray(1, 33)).toBase58() : null;
        continue;
      }
      var t0 = tokAcct(W3, a0), t1 = tokAcct(W3, a1);
      var ours = !!mine[addr] || (t0 && t0.owner === signer) || (t1 && t1.owner === signer);
      if (ours) {
        var mm = (t0 || t1 || {}).mint || mine[addr];
        if (t1) {
          if (t1.owner !== signer) refuse('a Treasury token account would get a new owner');
          if (t1.delegate && (!t0 || t0.delegate !== t1.delegate)) refuse('a Treasury token account would get a spender (delegate)');
          if (t0 && t1.closeAuth !== t0.closeAuth) refuse('a Treasury token account would get a new close authority');
        } else if (t0 && !closable[addr]) refuse('it would close one of the Treasury\'s token accounts');
        if (mm) delta[mm] = (delta[mm] || 0n) + ((t1 ? t1.amount : 0n) - (t0 ? t0.amount : 0n));
        continue;
      }
      if (!a0 && t1) newAtas++;
      got[addr] = t1 ? t1.amount - (t0 ? t0.amount : 0n) : B(a1 ? a1.lamports : 0) - B(a0 ? a0.lamports : 0);
    }
    // inner calls (when the RPC reports them): no hidden Approve / SetAuthority on the Treasury's accounts
    (sv.innerInstructions || []).forEach(function (g) { (g.instructions || []).forEach(function (ii) {
      var t = ii.parsed && ii.parsed.type, info = (ii.parsed && ii.parsed.info) || {};
      if (/^(approve|approveChecked|setAuthority)$/.test(t || '') && (mine[info.source] || mine[info.account] || info.owner === signer || info.authority === signer)) refuse('a hidden ' + t + ' on a Treasury account');
    }); });
    if (pays) {
      var outs = expT.concat(expP), outBy = sumBy(outs, 'mint', 'amount');
      Object.keys(delta).forEach(function (m) { if (delta[m] !== -(outBy[m] || 0n)) refuse('the test run moves ' + fmtRaw(delta[m] < 0n ? -delta[m] : delta[m], m) + ' ' + (delta[m] < 0n ? 'out of' : 'into') + ' the Treasury, the plan says ' + fmtRaw(outBy[m] || 0n, m)); });
      Object.keys(outBy).forEach(function (m) { if ((delta[m] || 0n) !== -outBy[m]) refuse('the Treasury would not send the planned ' + fmtRaw(outBy[m], m)); });
      var toBy = sumBy(outs, 'dst', 'amount');
      Object.keys(toBy).forEach(function (a) { if ((got[a] || 0n) !== toBy[a]) refuse('a recipient would not receive exactly the planned amount'); });
      expS.forEach(function (s) { if ((got[s.to] || 0n) < s.lamports) refuse('a SOL recipient would get less than planned'); });
      expC.forEach(function (c) { if (coreOwner[c.asset] !== c.owner) refuse('the Core asset ' + c.asset.slice(0, 4) + '… would not end up with its winner'); });
      var solCap = expS.reduce(function (a, s) { return a + s.lamports; }, 0n) + BigInt(newAtas) * ATA_RENT + BigInt(expP.length) * TOKEN_RECORD_ALLOW + fee + 10000n;
      if (solSpent > solCap) refuse('the Treasury would spend ' + fmtRaw(solSpent, MINTS.SOL) + ' SOL, more than the payments + deposits + fee');
    } else if (kind === 'swap') {
      var gotOut = delta[e.getMint] || 0n;
      if (gotOut < B(e.getMin)) refuse('the test run gives ' + fmtRaw(gotOut < 0n ? 0n : gotOut, e.getMint) + ', less than the quoted minimum ' + fmtRaw(e.getMin, e.getMint));
      Object.keys(delta).forEach(function (m) {
        if (m === e.getMint || m === MINTS.SOL) return;
        if (m === e.spendMint) { if (-delta[m] > B(e.spendMax)) refuse('the swap would take ' + fmtRaw(-delta[m], m) + ', more than the quoted ' + fmtRaw(e.spendMax, m)); return; }
        if (delta[m] !== 0n) refuse('the swap would change the Treasury\'s ' + nameOf(m) + ' too');
      });
      var cap = (e.spendMint === MINTS.SOL ? B(e.spendMax) : 0n) + 2n * ATA_RENT + fee + 10000n;
      if (solSpent > cap) refuse('the swap would take ' + fmtRaw(solSpent, MINTS.SOL) + ' from the Treasury, more than the quote + deposits + fee');
    } else {
      Object.keys(delta).forEach(function (m) { if (!expB.some(function (b) { return b.mint === m; }) && delta[m] !== 0n) refuse('the burn would change the Treasury\'s ' + nameOf(m)); });
      if (solSpent > fee + 10000n) refuse('the burn would cost the Treasury more SOL than its fee');
    }
    return { ok: true, simulated: true, text: 'Checked: ' + said + ', nothing else touched ✓' };
  }

  return { MINTS: MINTS, DEC: DEC, TOKEN: TOKEN, ATA: ATA, MAX_TX: MAX_TX, ataAddress: ataAddress, transferIxs: transferIxs, packTransfers: packTransfers,
    B: B, swapBuckets: swapBuckets, transfersForPlan: transfersForPlan, giftsForPlan: giftsForPlan, need: need, payable: payable, swapFromQuote: swapFromQuote,
    burnPnftIxs: burnPnftIxs, packBurns: packBurns, swapFromQuoteTo: swapFromQuoteTo, inspect: inspect, STORE: STORE, JUP: JUP,
    jupSwapArgs: jupSwapArgs, jupOnChainMinOut: jupOnChainMinOut, jupOnChainMaxIn: jupOnChainMaxIn, JUP_IX: JUP_IX };
});
