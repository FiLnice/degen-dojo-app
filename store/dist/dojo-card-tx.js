// Card actions built in the browser and signed by the holder's own wallet (the /repair and /burn pages).
//   repair — ONE ORE transferChecked to the Treasury for a batch of cards + one memo "ddfix:<mint>" per card
//            (the backend credits 0.01 ORE × number of memos; the Treasury ORE account is opened if missing)
//   burn   — Token Metadata BurnV1 of a 1/1 programmable NFT by its holder (collection size updated)
// Plain JS on window.solanaWeb3 (the store's self-hosted /web3.js), same pattern as dojo-ah.js.
(function (global) {
  var W3 = function () { return global.solanaWeb3 || global.SolanaWeb3 || global.web3; };
  var PK = function (x) { return typeof x === 'string' ? new (W3().PublicKey)(x) : x; };
  var pda = function (seeds, prog) { return W3().PublicKey.findProgramAddressSync(seeds, PK(prog))[0]; };
  var utf8 = function (s) { return new TextEncoder().encode(s); };
  var Buf = function (u8) { var B = (W3() && W3().Buffer) || global.Buffer; return B ? B.from(u8) : u8; };

  var TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  var META = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  var SYS = '11111111111111111111111111111111', SYSVAR_IX = 'Sysvar1nstructions1111111111111111111111111';
  var ORE = 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp', ORE_DEC = 11;
  var TREASURY = '5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp';
  var REPAIR_BATCH = 8;   // cards per transaction (one transfer + one memo each stays well under the 1232-byte limit)

  var ataOf = function (owner, mint) { return pda([PK(owner).toBuffer(), PK(TOKEN).toBuffer(), PK(mint).toBuffer()], ATA); };
  var metaOf = function (mint) { return pda([utf8('metadata'), PK(META).toBuffer(), PK(mint).toBuffer()], META); };
  var editionOf = function (mint) { return pda([utf8('metadata'), PK(META).toBuffer(), PK(mint).toBuffer(), utf8('edition')], META); };
  var tokenRecordOf = function (mint, ta) { return pda([utf8('metadata'), PK(META).toBuffer(), PK(mint).toBuffer(), utf8('token_record'), PK(ta).toBuffer()], META); };
  var acct = function (pk, s, w) { return { pubkey: PK(pk), isSigner: s, isWritable: w }; };
  var ix = function (programId, keys, data) { return new (W3().TransactionInstruction)({ programId: PK(programId), keys: keys, data: Buf(data) }); };

  // "0.01" × n → raw ORE units (11 decimals), exact (no floating point)
  function oreRaw(decimal, times) {
    var p = String(decimal).split('.'), frac = (p[1] || '').padEnd(ORE_DEC, '0').slice(0, ORE_DEC);
    return BigInt(p[0] || '0') * 10n ** BigInt(ORE_DEC) * BigInt(times) + BigInt(frac || '0') * BigInt(times);
  }
  function u64le(v) { var b = new Uint8Array(8), n = BigInt(v); for (var i = 0; i < 8; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; }

  /** Instructions for ONE repair transaction: open the Treasury ORE account if needed, pay perCard × mints, memo each card. */
  function repairIxs(holder, mints, perCard) {
    var src = ataOf(holder, ORE), dst = ataOf(TREASURY, ORE), amt = oreRaw(perCard || '0.01', mints.length);
    var data = new Uint8Array(10); data[0] = 12; data.set(u64le(amt), 1); data[9] = ORE_DEC;   // TransferChecked
    // compute limit fitted to the batch (measured: 5 cards ≈ 169k units, 8 ≈ 268k — each memo ≈ 33k) + a small priority
    // fee (≈0.00005–0.00008 SOL) so a busy network doesn't drop the payment after the holder approved it
    var CB = W3().ComputeBudgetProgram;
    var out = [
      CB.setComputeUnitLimit({ units: Math.ceil((40000 + 36000 * mints.length) * 1.15) }),
      CB.setComputeUnitPrice({ microLamports: 200000 }),
      ix(ATA, [acct(holder, true, true), acct(dst, false, true), acct(TREASURY, false, false), acct(ORE, false, false), acct(SYS, false, false), acct(TOKEN, false, false)], new Uint8Array([1])),   // CreateIdempotent
      ix(TOKEN, [acct(src, false, true), acct(ORE, false, false), acct(dst, false, true), acct(holder, true, false)], data),
    ];
    mints.forEach(function (m) { out.push(ix(MEMO, [acct(holder, true, false)], utf8('ddfix:' + m))); });
    return { ixs: out, amountRaw: amt.toString() };
  }
  function batches(list, n) { var out = []; for (var i = 0; i < list.length; i += (n || REPAIR_BATCH)) out.push(list.slice(i, i + (n || REPAIR_BATCH))); return out; }

  /** BurnV1 of a 1/1 pNFT by its holder. `rpc(method, params)` reads the token account + verified collection. */
  async function burnIx(rpc, holder, mint) {
    var tas = await rpc('getTokenAccountsByOwner', [holder, { mint: mint }, { encoding: 'jsonParsed' }]);
    var held = ((tas && tas.value) || []).find(function (t) { var a = t.account.data.parsed.info.tokenAmount; return a.amount === '1'; });
    if (!held) throw new Error('This wallet doesn’t hold that card.');
    var asset = await rpc('getAsset', { id: mint });
    var g = ((asset && asset.grouping) || []).find(function (x) { return x.group_key === 'collection'; });   // DAS lists only VERIFIED collections
    var ta = held.pubkey, P = META;
    var data = new Uint8Array(10); data[0] = 41; data[1] = 0; data.set(u64le(1), 2);   // Burn → BurnArgs::V1 { amount: 1 }
    return ix(META, [
      acct(holder, true, true),                                   // authority (the holder)
      g ? acct(metaOf(g.group_value), false, true) : acct(P, false, false),   // collection metadata (size goes down)
      acct(metaOf(mint), false, true),                            // metadata
      acct(editionOf(mint), false, true),                         // edition (the master edition of a 1/1)
      acct(mint, false, true),                                    // mint
      acct(ta, false, true),                                      // token
      acct(P, false, false), acct(P, false, false), acct(P, false, false), acct(P, false, false),   // print-edition accounts: none
      acct(tokenRecordOf(mint, ta), false, true),                 // token record (programmable NFT)
      acct(SYS, false, false), acct(SYSVAR_IX, false, false), acct(TOKEN, false, false),
    ], data);
  }

  /** Build a v0 transaction, simulate it, return { tx, err, logs }. */
  async function prepare(rpc, payer, ixs) {
    var W = W3();
    var bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
    var tx = new W.VersionedTransaction(new W.TransactionMessage({ payerKey: PK(payer), recentBlockhash: bh, instructions: ixs }).compileToV0Message());
    var b64 = Buf(tx.serialize()).toString('base64');
    var sim = await rpc('simulateTransaction', [b64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }]);
    var v = (sim && sim.value) || {};
    return { tx: tx, err: v.err || null, logs: v.logs || [] };
  }

  global.DojoCardTx = { TREASURY: TREASURY, ORE: ORE, REPAIR_BATCH: REPAIR_BATCH, repairIxs: repairIxs, batches: batches, burnIx: burnIx, prepare: prepare, ataOf: ataOf, oreRaw: oreRaw };
})(typeof window !== 'undefined' ? window : globalThis);
