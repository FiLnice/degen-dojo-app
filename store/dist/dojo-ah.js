// Degen Dojo AuctionHouse client — non-custodial list / buy / cancel of pNFTs on the DD-native
// ORE/SKR/USDC houses (Metaplex AuctionHouse hausS13…, v1.4.1). pNFT-aware: the sell path appends
// the 8 TokenMetadata SaleV1-delegate accounts (delegate_record == token_record) so a FROZEN pNFT
// lists cleanly — verified by simulation. Buyer pays the sticker price; execute_sale deducts the
// 13% creator royalty seller-side (native AuctionHouse behavior).
(function (global) {
  var W3 = function () { return global.solanaWeb3 || global.SolanaWeb3 || global.web3; };
  var PK = function (x) { return typeof x === 'string' ? new (W3().PublicKey)(x) : x; };
  var pda = function (seeds, prog) { return W3().PublicKey.findProgramAddressSync(seeds, PK(prog))[0]; };
  var pdaB = function (seeds, prog) { return W3().PublicKey.findProgramAddressSync(seeds, PK(prog)); };
  var utf8 = function (s) { return new TextEncoder().encode(s); };

  var AH = 'hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk';
  var TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  var ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  var META = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
  var AUTH_RULES = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg';
  var RULESET = 'AdH2Utn6Fus15ZhtenW4hZBQnvtLgM1YCW2MfVp7pYS5';           // Metaplex Compatibility — fallback when the NFT has none
  // Token Metadata rejects a pNFT action unless the NFT's OWN rule set is passed (store-only Degens use
  // dd-store-only), so every builder takes opts.ruleSet — read it with ruleSetOf(rpc, mint) / parseMetadata.
  var SYSVAR_IX = 'Sysvar1nstructions1111111111111111111111111';
  var SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111';
  var SYS = '11111111111111111111111111111111';

  // Houses + treasury tokens (decimals matter for price → base-unit conversion).
  var HOUSES = {
    ORE:  { house: '7jAwmzBpVLL9ntSZWRFTvNXZztJJhk84HxGznq1Q3U8Y', mint: 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp', decimals: 11 },
    SKR:  { house: 'EfeSbHoNsXxKFRjMmNpFPNnUDYE2QmkQ5ugxvtQzCE6C', mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3', decimals: 6 },
    USDC: { house: 'GnbcBGfDLe3S2QaKwSPGwiJ6SoU8qzdkYAPdzTLfn1Ft', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  };
  // The store is ORE-only (owner decision): list + buy on the ORE house only (the co-signer signs nothing else).
  // SKR / USDC stay above so an old listing there can still be CANCELLED.
  var ACTIVE = { ORE: true };
  function activeHouse(currency) { var h = HOUSES[currency]; if (!h) throw new Error('bad currency'); if (!ACTIVE[currency]) throw new Error('The marketplace is ORE-only — ' + currency + ' listings can only be cancelled.'); return h; }
  // HOUSE RENT REFUND — a co-signed sale makes the house fee account pay for every account it opens (the buyer's escrow,
  // the buyer's NFT ATA, the seller's payment ATA, creator ATAs, the buyer's pNFT token record). The buyer refunds that
  // rent in the same transaction (System transfer → fee account, before the buy); /api/dd-cosign checks the amount
  // against chain state and refuses a buy that doesn't refund it. Mirrors store-fn-dd-cosign.mjs houseRent().
  var TOKEN_ACCOUNT_LEN = 165, TOKEN_RECORD_LEN = 80;
  // The AuctionHouse authority = the dedicated cosigner (set-ah-authority.mjs). The build bakes its pubkey
  // here from scripts/dd-authority.json — every sell/cancel/buy must pass the CURRENT house authority.
  var AUTHORITY = '8KUWwAHMb7TL31JGbucCi8YE1ax7njWi46ajVbWnvDqr';
  if (AUTHORITY.indexOf('__DD_') === 0) AUTHORITY = '8KUWwAHMb7TL31JGbucCi8YE1ax7njWi46ajVbWnvDqr';
  // Address Lookup Table for the buy tx (constant accounts). Baked in at deploy time from
  // scripts/dd-alt.json by build-store-deploy. Empty '' → buy setup pending (run create-lookup-table.mjs).
  var ALT_TABLE = '6TFd49fHnsdaGbZGytC5DMdsvCCDuT9wsYdMWH5YeMLZ';
  if (ALT_TABLE.indexOf('__DD_ALT') === 0) ALT_TABLE = '';   // unreplaced placeholder in dev

  // --- PDA helpers ---
  function ataOf(owner, mint) { return pda([PK(owner).toBuffer(), PK(TOKEN).toBuffer(), PK(mint).toBuffer()], ATA); }
  function metaOf(mint) { return pda([utf8('metadata'), PK(META).toBuffer(), PK(mint).toBuffer()], META); }
  function editionOf(mint) { return pda([utf8('metadata'), PK(META).toBuffer(), PK(mint).toBuffer(), utf8('edition')], META); }
  function tokenRecordOf(mint, tokenAccount) { return pda([utf8('metadata'), PK(META).toBuffer(), PK(mint).toBuffer(), utf8('token_record'), PK(tokenAccount).toBuffer()], META); }
  function feeAccountOf(house) { return pda([utf8('auction_house'), PK(house).toBuffer(), utf8('fee_payer')], AH); }
  function treasuryOf(house) { return pda([utf8('auction_house'), PK(house).toBuffer(), utf8('treasury')], AH); }
  function escrowOf(house, wallet) { return pdaB([utf8('auction_house'), PK(house).toBuffer(), PK(wallet).toBuffer()], AH); }
  function programAsSigner() { return pdaB([utf8('auction_house'), utf8('signer')], AH); }
  function u64le(n) { var b = new Uint8Array(8); var v = BigInt(n); for (var i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; }
  function tradeStateOf(wallet, house, tokenAccount, treasuryMint, mint, priceBaseUnits, size) {
    return pdaB([utf8('auction_house'), PK(wallet).toBuffer(), PK(house).toBuffer(), PK(tokenAccount).toBuffer(), PK(treasuryMint).toBuffer(), PK(mint).toBuffer(), u64le(priceBaseUnits), u64le(size)], AH);
  }
  function disc(name) {
    // anchor global discriminator, sha256 via SubtleCrypto is async — precompute known ones.
    return DISCS[name];
  }
  // anchor global discriminators — sha256("global:<name>")[:8], verified against the deployed program.
  var DISCS = {
    sell: new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]),
    cancel: new Uint8Array([232, 219, 223, 41, 219, 236, 220, 190]),
    buy: new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]),
    publicBuy: new Uint8Array([169, 84, 218, 35, 42, 206, 16, 171]),
    executeSale: new Uint8Array([37, 74, 217, 157, 79, 49, 35, 6]),
  };

  function priceToBaseUnits(price, decimals) {
    // price is a human number (e.g. 12.5). Return a BigInt in the token's smallest unit, no float drift.
    var s = String(price);
    var neg = s[0] === '-'; if (neg) s = s.slice(1);
    var parts = s.split('.'); var whole = parts[0] || '0'; var frac = (parts[1] || '').slice(0, decimals);
    while (frac.length < decimals) frac += '0';
    return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(frac || '0');
  }

  var a = function (pk, s, w) { return { pubkey: PK(pk), isSigner: s, isWritable: w }; };

  // Build the pNFT SELL (list) instruction. currency = 'ORE'|'SKR'|'USDC'; price is a human number.
  function buildSellIx(opts) {
    var W = W3();
    var h = activeHouse(opts.currency);
    var seller = PK(opts.seller), mint = PK(opts.mint);
    var tokenAccount = ataOf(seller, mint);
    // execute_sale only settles from the seller's ATA (assert_is_ata) — a listing from any other token account could never sell
    if (opts.tokenAccount && !PK(opts.tokenAccount).equals(tokenAccount)) throw new Error('This NFT isn’t in your wallet’s main token account, so a listing could never be bought. Send it to your own wallet address first (that moves it into the main account), then list.');
    var price = priceToBaseUnits(opts.price, h.decimals);
    var size = 1n;
    var ts = tradeStateOf(seller, h.house, tokenAccount, h.mint, mint, price, size);
    var fts = tradeStateOf(seller, h.house, tokenAccount, h.mint, mint, 0, size);
    var pas = programAsSigner();
    var tokenRecord = tokenRecordOf(mint, tokenAccount);

    var data = new Uint8Array(8 + 3 + 8 + 8);
    data.set(DISCS.sell, 0);
    data[8] = ts[1]; data[9] = fts[1]; data[10] = pas[1];   // tradeStateBump, freeTradeStateBump, programAsSignerBump
    data.set(u64le(price), 11); data.set(u64le(size), 19);

    var keys = [
      a(seller, true, false), a(tokenAccount, false, true), a(metaOf(mint), false, true),
      a(AUTHORITY, false, false), a(h.house, false, false), a(feeAccountOf(h.house), false, true),
      a(ts[0], false, true), a(fts[0], false, true),
      a(TOKEN, false, false), a(SYS, false, false), a(pas[0], false, false), a(SYSVAR_RENT, false, false),
      // pNFT remaining accounts (→ TokenMetadata SaleV1 delegate; delegate_record == token_record)
      a(META, false, false), a(tokenRecord, false, true), a(tokenRecord, false, true),
      a(mint, false, false), a(editionOf(mint), false, false),
      a(AUTH_RULES, false, false), a(PK(opts.ruleSet || RULESET), false, false), a(SYSVAR_IX, false, false),
    ];
    return { programId: PK(AH), keys: keys, data: data, tradeState: ts[0].toBase58(), priceBaseUnits: price.toString() };
  }

  // Build the pNFT CANCEL (delist) instruction — revokes the SaleV1 delegate. Verified by simulation.
  function buildCancelIx(opts) {
    var h = HOUSES[opts.currency]; if (!h) throw new Error('bad currency');
    var seller = PK(opts.seller), mint = PK(opts.mint);
    var tokenAccount = opts.tokenAccount ? PK(opts.tokenAccount) : ataOf(seller, mint);
    var price = priceToBaseUnits(opts.price, h.decimals), size = 1n;
    var ts = tradeStateOf(seller, h.house, tokenAccount, h.mint, mint, price, size)[0];
    var pas = programAsSigner()[0], tr = tokenRecordOf(mint, tokenAccount);
    var data = new Uint8Array(8 + 8 + 8);
    data.set(DISCS.cancel, 0); data.set(u64le(price), 8); data.set(u64le(size), 16);
    var keys = [
      a(seller, true, true), a(tokenAccount, false, true), a(mint, false, false), a(AUTHORITY, false, false),
      a(h.house, false, false), a(feeAccountOf(h.house), false, true), a(ts, false, true), a(TOKEN, false, false),
      // pNFT remaining (revoke SaleV1); metadata must be WRITABLE
      a(META, false, false), a(tr, false, true), a(pas, false, false), a(metaOf(mint), false, true),
      a(editionOf(mint), false, false), a(tr, false, true), a(mint, false, false),
      a(AUTH_RULES, false, false), a(PK(opts.ruleSet || RULESET), false, false), a(SYSVAR_IX, false, false), a(SYS, false, false),
    ];
    return { programId: PK(AH), keys: keys, data: data, tradeState: ts.toBase58() };
  }

  // Build the BUY (buy + execute_sale) instruction pair. The buyer pays the flat sticker price;
  // execute_sale deducts the metadata royalty (13% for Degens) seller-side and pays each creator their
  // share into the treasury-mint (ORE/SKR/USDC), then transfers the pNFT to the buyer.
  //   opts.creators = the NFT's metadata creators IN ORDER: [{address, share}, …]. REQUIRED — the program
  //   asserts each creator address positionally, and for an SPL treasury each creator needs [wallet, ATA].
  //   opts.pnft (default true) appends the TokenMetadata transfer accounts; set false for a plain NFT.
  function buildBuyIxs(opts) {
    var h = activeHouse(opts.currency);
    var buyer = PK(opts.buyer), seller = PK(opts.seller), mint = PK(opts.mint);
    var sellerAta = opts.sellerTokenAccount ? PK(opts.sellerTokenAccount) : ataOf(seller, mint);
    var buyerNftAta = ataOf(buyer, mint);              // buyer_receipt_token_account (created by program if absent)
    var buyerPayAta = ataOf(buyer, h.mint);            // payment_account — buyer's ORE/SKR/USDC ATA
    var sellerPayAta = ataOf(seller, h.mint);          // seller_payment_receipt_account (created if absent)
    var priceBU = priceToBaseUnits(opts.price, h.decimals), size = 1n;
    var escrow = escrowOf(h.house, buyer);             // [pk, bump]
    var buyerTs = tradeStateOf(buyer, h.house, sellerAta, h.mint, mint, priceBU, size);   // [pk, bump]
    var sellerTs = tradeStateOf(seller, h.house, sellerAta, h.mint, mint, priceBU, size)[0];
    var freeTs = tradeStateOf(seller, h.house, sellerAta, h.mint, mint, 0, size);          // [pk, bump]
    var pas = programAsSigner();                        // [pk, bump]
    var feeAcct = feeAccountOf(h.house), treasury = treasuryOf(h.house), meta = metaOf(mint);

    // ---- ix 1: buy (private bid on this listing's token account; tops up the escrow token account) ----
    var d1 = new Uint8Array(8 + 1 + 1 + 8 + 8);
    d1.set(DISCS.buy, 0); d1[8] = buyerTs[1]; d1[9] = escrow[1];
    d1.set(u64le(priceBU), 10); d1.set(u64le(size), 18);
    var buyKeys = [
      a(buyer, true, true), a(buyerPayAta, false, true), a(buyer, true, false), a(h.mint, false, false),
      a(sellerAta, false, false), a(meta, false, false), a(escrow[0], false, true), a(AUTHORITY, false, false),
      a(h.house, false, false), a(feeAcct, false, true), a(buyerTs[0], false, true),
      a(TOKEN, false, false), a(SYS, false, false), a(SYSVAR_RENT, false, false),
    ];

    // ---- ix 2: execute_sale (matches bid+ask, pays creators + seller, transfers the pNFT) ----
    var d2 = new Uint8Array(8 + 1 + 1 + 1 + 8 + 8);
    d2.set(DISCS.executeSale, 0); d2[8] = escrow[1]; d2[9] = freeTs[1]; d2[10] = pas[1];
    d2.set(u64le(priceBU), 11); d2.set(u64le(size), 19);
    // pNFT sales require the AH authority to co-sign (Metaplex constraint: the pNFT transfer's fee-payer
    // must be a program PDA, which only happens when the authority signs). opts.cosign marks it a signer.
    var authSigner = opts.cosign === true;
    var exKeys = [
      a(buyer, false, true), a(seller, false, true), a(sellerAta, false, true), a(mint, false, false),
      a(meta, false, true), a(h.mint, false, false), a(escrow[0], false, true), a(sellerPayAta, false, true),
      a(buyerNftAta, false, true), a(AUTHORITY, authSigner, false), a(h.house, false, false), a(feeAcct, false, true),
      // NOTE: metadata (above) is WRITABLE — the pNFT transfer updates it (execute_sale's struct marks it
      // non-mut with a @TODO, but the TokenMetadata Transfer CPI needs write access; else PrivilegeEscalation).
      a(treasury, false, true), a(buyerTs[0], false, true), a(sellerTs, false, true), a(freeTs[0], false, true),
      a(TOKEN, false, false), a(SYS, false, false), a(ATA, false, false), a(pas[0], false, false), a(SYSVAR_RENT, false, false),
    ];
    // remaining #1 — creators in metadata order, each [wallet, treasury-mint ATA] (pay_creator_fees)
    var creators = opts.creators || []; if (!creators.length) throw new Error('creators required (metadata order)');
    creators.forEach(function (cr) { var w = PK(cr.address); exKeys.push(a(w, false, true)); exKeys.push(a(ataOf(w, h.mint), false, true)); });
    // remaining #2 — pNFT transfer accounts (skip for a plain NFT)
    if (opts.pnft !== false) {
      exKeys.push(a(META, false, false), a(editionOf(mint), false, false),
        a(tokenRecordOf(mint, sellerAta), false, true), a(tokenRecordOf(mint, buyerNftAta), false, true),
        a(AUTH_RULES, false, false), a(PK(opts.ruleSet || RULESET), false, false), a(SYSVAR_IX, false, false));
    }

    // Raise the compute limit — a pNFT transfer (auth-rules validation + TokenMetadata) plus the escrow
    // funding, royalty payouts and ATA creation blow past the default 400k. setComputeUnitLimit(800000).
    var cbData = new Uint8Array(5); cbData[0] = 2; var u = 800000 >>> 0;
    cbData[1] = u & 0xff; cbData[2] = (u >> 8) & 0xff; cbData[3] = (u >> 16) & 0xff; cbData[4] = (u >> 24) & 0xff;
    var cbIx = { programId: PK('ComputeBudget111111111111111111111111111111'), keys: [], data: cbData };
    var ixs = [ cbIx, { programId: PK(AH), keys: buyKeys, data: d1 }, { programId: PK(AH), keys: exKeys, data: d2 } ];
    // the house-rent refund (opts.houseRent lamports, from houseRentOwed) goes BEFORE the buy
    var rentLamports = BigInt(opts.houseRent || 0);
    if (rentLamports > 0n) {
      var td = new Uint8Array(12); td[0] = 2; td.set(u64le(rentLamports), 4);   // SystemInstruction::Transfer
      ixs.splice(1, 0, { programId: PK(SYS), keys: [a(buyer, true, true), a(feeAcct, false, true)], data: td });
    }
    return {
      ixs: ixs,
      buyerTradeState: buyerTs[0].toBase58(), escrow: escrow[0].toBase58(), priceBaseUnits: priceBU.toString(),
    };
  }

  // Lamports of rent this sale makes the house open (see HOUSE RENT REFUND). rpc = async (method, params) => result.
  async function houseRentOwed(rpc, opts) {
    var h = activeHouse(opts.currency);
    var buyer = PK(opts.buyer), seller = PK(opts.seller), mint = PK(opts.mint);
    var buyerNftAta = ataOf(buyer, mint);
    var keys = [SYSVAR_RENT, feeAccountOf(h.house).toBase58(), escrowOf(h.house, buyer)[0].toBase58(), ataOf(seller, h.mint).toBase58(),
      buyerNftAta.toBase58(), tokenRecordOf(mint, buyerNftAta).toBase58()]
      .concat((opts.creators || []).map(function (cr) { return ataOf(PK(cr.address), h.mint).toBase58(); }));
    var res = await rpc('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }]);
    var v = res && res.value;
    if (!v || v.length !== keys.length || !v[0]) throw new Error('Couldn’t read the chain to price this buy — try again.');
    var rs = b64ToBytes(v[0].data[0]), dv = new DataView(rs.buffer, rs.byteOffset, rs.byteLength);
    var perByteYear = dv.getBigUint64(0, true), threshold = dv.getFloat64(8, true);
    var rentOf = function (len) { return Math.ceil(Number((128n + BigInt(len)) * perByteYear) * threshold); };
    var empty = function (x) { return !x || !x.data || b64ToBytes(x.data[0] || '').length === 0; };
    var owed = 0;
    [[2, TOKEN_ACCOUNT_LEN], [3, TOKEN_ACCOUNT_LEN], [4, TOKEN_ACCOUNT_LEN], [5, TOKEN_RECORD_LEN]].forEach(function (p) { if (empty(v[p[0]])) owed += rentOf(p[1]); });
    for (var i = 6; i < keys.length; i++) if (empty(v[i])) owed += rentOf(TOKEN_ACCOUNT_LEN);
    return owed;
  }

  // Parse a Token Metadata account (base64) → { name, symbol, sellerFeeBasisPoints, creators:[{address,share}], ruleSet }.
  // The buy needs the creators IN ORDER (execute_sale asserts them positionally). Works for any collection.
  function parseMetadata(base64) {
    var b = b64ToBytes(base64);
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength); var o = 1 + 32 + 32;   // key + updateAuthority + mint
    var rd = function () { var n = dv.getUint32(o, true); o += 4; var s = new TextDecoder().decode(b.slice(o, o + n)).replace(/\0+$/, ''); o += n; return s; };
    var name = rd(), symbol = rd(); rd();                    // uri (skip)
    var sfbp = dv.getUint16(o, true); o += 2;
    var creators = []; var has = b[o]; o += 1;
    if (has) { var n = dv.getUint32(o, true); o += 4; for (var k = 0; k < n; k++) { var addr = new (W3().PublicKey)(b.slice(o, o + 32)).toBase58(); o += 32; var verified = b[o]; o += 1; var share = b[o]; o += 1; creators.push({ address: addr, verified: verified, share: share }); } }
    var ruleSet = null;                                        // trailing optionals → programmable config rule set
    try {
      o += 2;                                                  // primarySaleHappened, isMutable
      if (b[o++]) o += 1;                                      // editionNonce
      if (b[o++]) o += 1;                                      // tokenStandard
      if (b[o++]) o += 33;                                     // collection
      if (b[o++]) o += 17;                                     // uses
      if (b[o++]) o += 9;                                      // collectionDetails
      if (o < b.length && b[o++]) { o += 1; if (b[o++]) ruleSet = new (W3().PublicKey)(b.slice(o, o + 32)).toBase58(); }
    } catch (e) { ruleSet = null; }
    return { name: name.trim(), symbol: symbol.trim(), sellerFeeBasisPoints: sfbp, creators: creators, ruleSet: ruleSet };
  }

  // The NFT's own rule set (null = none). rpc = async (method, params) => result.
  async function ruleSetOf(rpc, mint) {
    var mi = await rpc('getAccountInfo', [metaOf(mint).toBase58(), { encoding: 'base64' }]);
    if (!mi || !mi.value) throw new Error('No metadata for this NFT.');
    return parseMetadata(mi.value.data[0]).ruleSet;
  }

  // Prefer the (lenient) Buffer polyfill the pages load; atob is picky about whitespace/padding.
  function glBuf() { return (typeof Buffer !== 'undefined' && Buffer.from) ? Buffer : (W3().Buffer || null); }
  function b64ToBytes(s) {
    if (typeof s !== 'string') throw new Error('expected a base64 string, got ' + typeof s);
    s = s.replace(/\s/g, '');
    var B = glBuf();
    if (B) { var b = B.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
    var raw = atob(s); var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
  }
  function bytesToB64(bytes) { var B = glBuf(); if (B) return B.from(bytes).toString('base64'); var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

  // PRICE LOCK for our own houses. The price is written into the buy AND execute_sale instruction data and into both
  // trade-state PDAs (buyer's + seller's), so a buy built at the price the buyer was shown can only ever pay that
  // price — a seller who re-lists higher has a different trade state, and the old one fails. Before building, check
  // the listing still stands at the shown price; if the seller re-listed this NFT, a higher price (or another
  // currency) needs the buyer's explicit OK first. Resolves with the listing to buy; rejects (e.cancelled) otherwise.
  //   opts.confirmPrice(fromText, toText, live) → bool | Promise<bool>   (default: window.confirm)
  //   opts.listings() → the live /api/dd-listings array (default: fetch it)
  function priceUp(x, live) {
    if (live.currency !== x.currency) return true;
    var d = HOUSES[x.currency].decimals;
    return priceToBaseUnits(live.price, d) > priceToBaseUnits(x.price, d);
  }
  async function lockPrice(rpc, x, opts) {
    opts = opts || {};
    var h = HOUSES[x.currency]; if (!h) throw new Error('bad currency');
    var ta = x.tokenAccount || ataOf(x.seller, x.mint).toBase58();
    var ts = tradeStateOf(x.seller, h.house, ta, h.mint, x.mint, priceToBaseUnits(x.price, h.decimals), 1n)[0].toBase58();
    var acc = await rpc('getAccountInfo', [ts, { encoding: 'base64' }]);
    if (acc && acc.value && acc.value.owner === AH) return x;                    // still listed at the shown price
    var feed = opts.listings ? await opts.listings() : (((await (await fetch('/api/dd-listings', { cache: 'no-store' })).json()) || {}).listings || []);
    var live = (feed || []).filter(function (l) { return l && l.mint === x.mint && HOUSES[l.currency]; })[0];
    if (!live) { var gone = new Error('This NFT just sold or was delisted — nothing was bought.'); gone.cancelled = true; throw gone; }
    if (priceUp(x, live)) {
      var from = x.price + ' ' + x.currency, to = live.price + ' ' + live.currency;
      var ask = opts.confirmPrice || function (a, b) { return global.confirm('The price changed from ' + a + ' to ' + b + ' — buy at ' + b + '?'); };
      if (!(await ask(from, to, live))) { var no = new Error('The price changed from ' + from + ' to ' + to + ' — nothing was bought or signed.'); no.cancelled = true; throw no; }
    }
    return live;
  }

  // Prepare a BUY: fetch the NFT's creators, build [buy, execute_sale], compile with the lookup table,
  // and SIMULATE it. Returns { tx, err, logs, breakdown }. The page must only prompt the wallet when err==null,
  // so a buyer can never spend ORE/SKR on a transaction that would fail. rpc = async (method, params) => result.
  async function prepareBuy(rpc, opts) {
    var W = W3(), h = activeHouse(opts.currency);
    if (!ALT_TABLE) throw new Error('Buy is not enabled yet — the marketplace lookup table has not been created.');
    // 1) creators, in metadata order (execute_sale asserts them positionally)
    var mi = await rpc('getAccountInfo', [metaOf(opts.mint).toBase58(), { encoding: 'base64' }]);
    if (!mi || !mi.value) throw new Error('No metadata for this NFT.');
    var md = parseMetadata(mi.value.data[0]);
    if (!md.creators.length) throw new Error('NFT has no creators — cannot pay royalty.');
    // 2) instructions
    var isPnft = opts.pnft !== false;
    // co-signed (pNFT) sales refund the rent of the accounts they make the house open — the co-signer requires it
    var houseRent = isPnft ? await houseRentOwed(rpc, { currency: opts.currency, buyer: opts.buyer, seller: opts.seller, mint: opts.mint, creators: md.creators }) : 0;
    var built = buildBuyIxs({ currency: opts.currency, buyer: opts.buyer, seller: opts.seller, mint: opts.mint, price: opts.price, sellerTokenAccount: opts.sellerTokenAccount, creators: md.creators, ruleSet: md.ruleSet, pnft: isPnft, cosign: isPnft, houseRent: houseRent });
    var ixs = built.ixs.map(function (b) { return new W.TransactionInstruction({ programId: b.programId, keys: b.keys, data: W.Buffer ? W.Buffer.from(b.data) : b.data }); });
    // 3) lookup table
    var ai = await rpc('getAccountInfo', [ALT_TABLE, { encoding: 'base64' }]);
    if (!ai || !ai.value) throw new Error('Lookup table not found on-chain.');
    var alt = new W.AddressLookupTableAccount({ key: PK(ALT_TABLE), state: W.AddressLookupTableAccount.deserialize(b64ToBytes(ai.value.data[0])) });
    // 4) compile v0 (fits under the size limit only because of the ALT) + simulate
    var bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
    var msg = new W.TransactionMessage({ payerKey: PK(opts.buyer), recentBlockhash: bh, instructions: ixs }).compileToV0Message([alt]);
    // The preacher referral rides inside the buy as a signed "ddref:<code>" memo (wallet-picker.js DojoRef) —
    // only when it still fits the 1232-byte limit; a buy never fails because of it.
    var memoIx = global.DojoRef && global.DojoRef.instruction(W);
    if (memoIx) {
      try {
        var withMemo = new W.TransactionMessage({ payerKey: PK(opts.buyer), recentBlockhash: bh, instructions: ixs.concat([memoIx]) }).compileToV0Message([alt]);
        if (new W.VersionedTransaction(withMemo).serialize().length <= 1232) msg = withMemo;
      } catch (e) {}
    }
    var tx = new W.VersionedTransaction(msg);
    var sim = await rpc('simulateTransaction', [bytesToB64(tx.serialize()), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }]);
    var v = (sim && sim.value) || {};
    var roy = md.sellerFeeBasisPoints / 10000, price = Number(opts.price);
    return { tx: tx, err: v.err || null, logs: v.logs || [], needsCosign: isPnft, breakdown: { price: price, currency: opts.currency, royalty: price * roy, sellerNet: price * (1 - roy), royaltyBps: md.sellerFeeBasisPoints, accountRentSol: houseRent / 1e9 } };
  }

  // Submit a prepared buy. pNFTs (needsCosign) route through the /api/dd-cosign authority cosigner:
  // the buyer signs first, the backend adds the authority signature + submits. Plain NFTs go direct.
  // `adapter` is the wallet adapter (signTransaction / signAndSendTransaction). Returns the tx signature.
  async function submitBuy(rpc, adapter, r) {
    if (r.needsCosign) {
      // Per Phantom's guidance: the WALLET signs FIRST (so Phantom's Lighthouse guards inject correctly
      // and the tx isn't flagged), THEN the authority cosigner signs. Phantom signs via signTransaction;
      // the backend adds the cosigner signature and submits.
      // Refresh the blockhash right before signing — the Phantom warning flow can take long enough for
      // the original to expire (→ BlockhashNotFound on submit). Starting the ~60s window here maximizes it.
      try { if (rpc) { var _bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash; if (_bh) r.tx.message.recentBlockhash = _bh; } } catch (e) {}
      var signed = await adapter.signTransaction(r.tx.serialize());
      if (!(signed instanceof Uint8Array)) { try { signed = new Uint8Array(signed); } catch (e) {} }
      var res = await fetch('/api/dd-cosign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: bytesToB64(signed) }) });
      var j = await res.json();
      if (j.error) throw new Error(j.error);
      if (!j.signature) throw new Error('cosigner did not return a signature');
      return j.signature;
    }
    var sig = await adapter.signAndSendTransaction(r.tx);
    return sig.signature || sig;
  }

  global.DojoAH = {
    HOUSES: HOUSES, ACTIVE: ACTIVE, AUTHORITY: AUTHORITY, ALT_TABLE: ALT_TABLE, prepareBuy: prepareBuy, submitBuy: submitBuy, lockPrice: lockPrice, priceUp: priceUp, houseRentOwed: houseRentOwed,
    buildSellIx: buildSellIx, buildCancelIx: buildCancelIx, buildBuyIxs: buildBuyIxs, parseMetadata: parseMetadata, ruleSetOf: ruleSetOf,
    ataOf: ataOf, metaOf: metaOf, editionOf: editionOf, tokenRecordOf: tokenRecordOf, feeAccountOf: feeAccountOf,
    escrowOf: escrowOf, treasuryOf: treasuryOf, priceToBaseUnits: priceToBaseUnits, tradeStateOf: tradeStateOf,
  };
})(window);
