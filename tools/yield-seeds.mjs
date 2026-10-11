// Bag calculator, every platform that is not StonkFun. One method for all of them:
//   take the wallets a coin's distributor paid in the last 7 days, keep the ones whose coin balance did not change
//   in that time (they held all week), and divide what each got by what it holds. The median is the reward per held
//   token per week; those wallets and their payout txs are the proof.
// Seeds (coin -> distributor -> one payout tx) come from scans, see functions/api/log.js.
// pump.fun is left out on purpose: its payouts go to wallets the creator picked to share fees with, not to holders.
const NET = { bsc: 'bnb-mainnet', base: 'base-mainnet', eth: 'eth-mainnet', robinhood: 'robinhood-mainnet' };
const DEX = { bsc: 'bsc', base: 'base', eth: 'ethereum', robinhood: 'robinhood', solana: 'solana' };
const WEEK = 7 * 86400;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : 0; };
const pad = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const big = h => { try { return BigInt(!h || h === '0x' ? '0x0' : h); } catch { return 0n; } };
const str = h => { try { const n = parseInt(h.slice(66, 130), 16); return Buffer.from(h.slice(130, 130 + n * 2), 'hex').toString('utf8').replace(/\0/g, '') || null; } catch { return null; } };

const CU = { eth_getLogs: 75, alchemy_getAssetTransfers: 120, eth_call: 26, eth_getTransactionReceipt: 20, eth_getBlockByNumber: 16, eth_blockNumber: 10, eth_getCode: 26, eth_getTransactionByHash: 17 };
const BUDGET = +process.env.ALCHEMY_CU_PER_S || 150;     // the plan allows 300/s; the rest stays free for people scanning on the site
let cuFree = 0, cuAt = Date.now();
async function cuWait(c) {
  for (;;) { const now = Date.now(); cuFree = Math.min(BUDGET, cuFree + (now - cuAt) / 1000 * BUDGET); cuAt = now; if (cuFree >= c) { cuFree -= c; return; } await sleep(Math.ceil((c - cuFree) / BUDGET * 1000)); }
}
export function seedEngine({ HELIUS, ALCHEMY, log }) {
  async function call(url, method, params) {
    if (url.includes('alchemy.com')) await cuWait(CU[method] || 30);
    for (let i = 0; i < 6; i++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (r.status === 429 || r.status >= 500) { await sleep(800 * 2 ** i); continue; }
        const j = await r.json();
        if (j.error) { if (/rate|limit|busy|timeout/i.test(j.error.message || '')) { await sleep(800 * 2 ** i); continue; } throw new Error(method + ': ' + j.error.message); }
        return j.result;
      } catch (e) { if (i === 5) throw e; await sleep(800 * 2 ** i); }
    }
  }
  const sol = (m, p) => call('https://mainnet.helius-rpc.com/?api-key=' + HELIUS, m, p);
  const evm = (chain, m, p) => call(`https://${NET[chain]}.g.alchemy.com/v2/${ALCHEMY}`, m, p);
  async function getJson(u) { for (let i = 0; i < 4; i++) { try { const r = await fetch(u); if (r.ok) return r.json(); if (r.status === 404) return null; } catch {} await sleep(1000 * (i + 1)); } return null; }

  // ---- prices and names: DexScreener works on every chain we scan
  async function dex(chain, addr) {
    const j = await getJson(`https://api.dexscreener.com/tokens/v1/${DEX[chain]}/${addr}`);
    const pairs = (Array.isArray(j) ? j : []).filter(p => p.baseToken?.address?.toLowerCase() === addr.toLowerCase());
    const p = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return p ? { price: +p.priceUsd || null, mcap: p.marketCap || p.fdv || null, symbol: p.baseToken.symbol, name: p.baseToken.name, icon: p.info?.imageUrl || null, pool: p.pairAddress } : null;
  }
  async function quotePrice(chain, addr) {
    if (/^native:/.test(addr) || addr === 'So11111111111111111111111111111111111111112') {
      const ids = { bsc: 'binancecoin', solana: 'solana' }[chain] || 'ethereum';
      const j = await getJson('https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' + ids); return j?.[ids]?.usd || null;
    }
    const d = await dex(chain, addr); if (d?.price) return d.price;
    // the reward token may only trade as the quote side of a pair
    const j = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
    for (const p of j?.pairs || []) if (p.quoteToken?.address?.toLowerCase() === addr.toLowerCase() && +p.priceNative > 0 && +p.priceUsd > 0) return +p.priceUsd / +p.priceNative;
    return null;
  }

  // ---- EVM
  const blockAt = {};
  async function evmBlockAt(chain, ts) {
    const k = chain + ':' + Math.floor(ts / 600); if (blockAt[k]) return blockAt[k];
    let hi = parseInt(await evm(chain, 'eth_blockNumber', []), 16), lo = Math.max(0, hi - 50_000_000);
    const tOf = async n => parseInt((await evm(chain, 'eth_getBlockByNumber', ['0x' + n.toString(16), false]))?.timestamp || '0x0', 16);
    if (await tOf(lo) > ts) lo = 0;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (await tOf(mid) <= ts) lo = mid; else hi = mid; }
    return blockAt[k] = lo;
  }
  const bal = (chain, coin, w, block) => evm(chain, 'eth_call', [{ to: coin, data: '0x70a08231' + pad(w) }, block == null ? 'latest' : '0x' + block.toString(16)]).then(big).catch(() => null);

  async function measureEvm(s) {
    const chain = s.chain, coin = s.coin.toLowerCase(), now = Math.floor(Date.now() / 1000);
    if (!NET[chain]) return { note: 'chain not supported yet' };
    let dist = s.distributor?.toLowerCase(), asset = s.asset?.toLowerCase();
    if (!dist && s.sig) {            // the sender of the biggest batch of the reward token in the scanned payout
      const rc = await evm(chain, 'eth_getTransactionReceipt', [s.sig]);
      const g = {}; for (const l of rc?.logs || []) if (l.topics?.[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && l.topics.length === 3 && l.address.toLowerCase() === asset) { const f = '0x' + l.topics[1].slice(26); g[f] = (g[f] || 0) + 1; }
      dist = Object.entries(g).sort((a, b) => b[1] - a[1])[0]?.[0];
    }
    if (!dist) return { note: 'no distributor found' };
    const native = /^native:/.test(asset || '');
    const fromBlock = await evmBlockAt(chain, now - WEEK);
    const rows = []; let pk, pages = 0;
    do {
      const p = { fromBlock: '0x' + fromBlock.toString(16), toBlock: 'latest', fromAddress: dist, withMetadata: true, excludeZeroValue: true, maxCount: '0x3e8',
        category: native ? ['external', ...(chain === 'bsc' || chain === 'robinhood' ? [] : ['internal'])] : ['erc20'], ...(native ? {} : { contractAddresses: [asset] }) };
      if (pk) p.pageKey = pk;
      const r = await evm(chain, 'alchemy_getAssetTransfers', [p]); pages++;
      for (const t of r?.transfers || []) rows.push({ to: t.to?.toLowerCase(), raw: big(t.rawContract?.value), dec: native ? 18 : parseInt(t.rawContract?.decimal || '0x12', 16), sym: native ? (chain === 'bsc' ? 'BNB' : 'ETH') : t.asset, hash: t.hash, t: Math.floor(Date.parse(t.metadata?.blockTimestamp) / 1000), block: parseInt(t.blockNum, 16) });
      pk = r?.pageKey;
    } while (pk && pages < 40);
    if (rows.length < 3) return { note: 'no payouts in the last 7 days' };
    const amts = new Set(rows.map(r => r.raw.toString()));
    if (amts.size <= 2 && rows.length >= 10) return { note: 'same amount to every wallet: an airdrop, not holder rewards' };
    const winStart = Math.min(...rows.map(r => r.t)), winBlock = Math.min(...rows.map(r => r.block)) - 1, winH = (now - winStart) / 3600;
    const per = new Map();
    for (const r of rows) { if (!r.to || r.to === coin || r.to === dist) continue; const p = per.get(r.to) || { raw: 0n, n: 0, last: r }; p.raw += r.raw; p.n++; if (r.t > p.last.t) p.last = r; per.set(r.to, p); }
    const maxN = Math.max(...[...per.values()].map(p => p.n));
    const cand = [...per].filter(([, p]) => p.n >= Math.max(1, Math.ceil(maxN * 0.8))).sort((a, b) => (b[1].raw > a[1].raw ? 1 : -1)).slice(0, 30);
    const decC = Number(big(await evm(chain, 'eth_call', [{ to: coin, data: '0x313ce567' }, 'latest']).catch(() => '0x12'))) || 18;
    const dec = rows[0].dec, samples = [];
    const D = process.env.YDEBUG ? (...a) => console.log('   [dbg]', ...a) : () => {};
    D(chain, 'dist', dist, 'asset', asset, 'payouts', rows.length, 'wallets', per.size, 'maxN', maxN, 'candidates', cand.length, 'window h', winH.toFixed(1));
    for (const [w, p] of cand) {
      const [b0, b1] = await Promise.all([bal(chain, coin, w, winBlock), bal(chain, coin, w, null)]);
      D(w, 'n', p.n, 'got', p.raw.toString(), 'bal start', b0?.toString(), 'now', b1?.toString());
      if (!b1 || b0 == null) continue;
      const diff = b1 > b0 ? b1 - b0 : b0 - b1;
      if (diff * 1000n > b1) continue;                      // bought or sold during the week: not a clean sample
      samples.push({ w, bal: Number(b1) / 10 ** decC, got: Number(p.raw) / 10 ** dec, n: p.n, sig: p.last.hash, t: p.last.t });
      if (samples.length >= 15) break;
    }
    return finish(s, samples, winH, rows[0].sym, dec, rows.reduce((a, r) => a + r.raw, 0n), { coin, asset: native ? asset : asset });
  }

  // ---- Solana (Creator rewards, Scribe, Ember and the like)
  async function measureSol(s) {
    const now = Math.floor(Date.now() / 1000), coin = s.coin, asset = s.asset || 'So11111111111111111111111111111111111111112';
    const isSol = asset === 'So11111111111111111111111111111111111111112';
    let dist = s.distributor;
    if (!dist && s.sig) {            // whoever's SOL or reward token went down in the scanned payout
      const tx = await sol('getTransaction', [s.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
      const keys = tx?.transaction?.message?.accountKeys?.map(k => k.pubkey) || [];
      if (isSol) { let best = -1, bi = -1; keys.forEach((k, i) => { const d = tx.meta.preBalances[i] - tx.meta.postBalances[i] - (i === 0 ? tx.meta.fee : 0); if (d > best) { best = d; bi = i; } }); dist = keys[bi]; }
      else { for (const b of tx?.meta?.preTokenBalances || []) { const p = (tx.meta.postTokenBalances || []).find(x => x.accountIndex === b.accountIndex); if (b.mint === asset && BigInt(b.uiTokenAmount.amount) > BigInt(p?.uiTokenAmount.amount || '0')) dist = b.owner; } }
    }
    if (!dist) return { note: 'no distributor found' };
    const rows = []; let tk, pages = 0;
    do {
      const o = { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, limit: 100, sortOrder: 'desc', filters: { status: 'succeeded', blockTime: { gte: now - WEEK } } };
      if (tk) o.paginationToken = tk;
      const r = await sol('getTransactionsForAddress', [dist, o]); pages++;
      for (const tx of r?.data || []) {
        const keys = tx.transaction.message.accountKeys.map(k => k.pubkey), sig = tx.transaction.signatures[0];
        if (isSol) {
          const di = keys.indexOf(dist); if (di < 0 || tx.meta.postBalances[di] >= tx.meta.preBalances[di]) continue;
          keys.forEach((k, i) => { const d = tx.meta.postBalances[i] - tx.meta.preBalances[i]; if (d > 0 && k !== dist) rows.push({ to: k, raw: BigInt(d), t: tx.blockTime, sig }); });
        } else {
          const pre = tx.meta.preTokenBalances || [], post = tx.meta.postTokenBalances || [];
          const out = pre.some(b => b.owner === dist && b.mint === asset && BigInt(b.uiTokenAmount.amount) > BigInt(post.find(x => x.accountIndex === b.accountIndex)?.uiTokenAmount.amount || '0'));
          if (!out) continue;
          for (const b of post) { if (b.mint !== asset || b.owner === dist) continue; const p = pre.find(x => x.accountIndex === b.accountIndex); const d = BigInt(b.uiTokenAmount.amount) - BigInt(p?.uiTokenAmount.amount || '0'); if (d > 0n) rows.push({ to: b.owner, raw: d, t: tx.blockTime, sig, dec: b.uiTokenAmount.decimals }); }
        }
      }
      tk = r?.paginationToken;
    } while (tk && pages < 40);
    if (rows.length < 3) return { note: 'no payouts in the last 7 days' };
    if (new Set(rows.map(r => r.raw.toString())).size <= 2 && rows.length >= 10) return { note: 'same amount to every wallet: an airdrop, not holder rewards' };
    const dec = isSol ? 9 : (rows[0].dec ?? 6);
    const winStart = Math.min(...rows.map(r => r.t)), winH = (now - winStart) / 3600;
    const per = new Map();
    for (const r of rows) { const p = per.get(r.to) || { raw: 0n, n: 0, last: r }; p.raw += r.raw; p.n++; if (r.t > p.last.t) p.last = r; per.set(r.to, p); }
    const maxN = Math.max(...[...per.values()].map(p => p.n));
    const cand = [...per].filter(([, p]) => p.n >= Math.max(1, Math.ceil(maxN * 0.8))).sort((a, b) => (b[1].raw > a[1].raw ? 1 : -1)).slice(0, 25);
    const samples = [];
    for (const [w, p] of cand) {
      const accs = (await sol('getTokenAccountsByOwner', [w, { mint: coin }, { encoding: 'jsonParsed' }]).catch(() => null))?.value || [];
      const b = accs.reduce((a, x) => a + (+x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
      if (!(b > 0)) continue;
      // balance untouched since the window opened: the coin account has no activity after it
      let still = true;
      for (const x of accs) { const sg = await sol('getSignaturesForAddress', [x.pubkey, { limit: 1 }]).catch(() => null); if (sg?.[0]?.blockTime && sg[0].blockTime >= winStart) still = false; }
      if (!still) continue;
      samples.push({ w, bal: b, got: Number(p.raw) / 10 ** dec, n: p.n, sig: p.last.sig, t: p.last.t });
      if (samples.length >= 12) break;
    }
    return finish(s, samples, winH, isSol ? 'SOL' : null, dec, rows.reduce((a, r) => a + r.raw, 0n), { coin, asset });
  }

  async function finish(s, samples, winH, qsym, qdec, totalRaw, ids) {
    if (samples.length < 3) return { note: 'not enough wallets that held all week to measure' };
    for (const x of samples) x.rate = x.got / x.bal;
    const rate = median(samples.map(x => x.rate)), scale = 168 / Math.max(winH, 1);
    const meta = await dex(s.chain, ids.coin), qp = await quotePrice(s.chain, ids.asset);
    let qsymbol = qsym, qicon = null;
    if (!qsymbol) { const d = await dex(s.chain, ids.asset); qsymbol = d?.symbol || null; qicon = d?.icon || null; }
    return {
      coin: { chain: s.chain, platform: s.platform, symbol: meta?.symbol ?? null, name: meta?.name ?? null, icon: meta?.icon ?? null, quote_mint: ids.asset, quote_symbol: qsymbol, quote_dec: qdec, quote_icon: qicon, pool: meta?.pool ?? null, mcap: meta?.mcap ?? null, status: 'ok' },
      stat: { ts: Math.floor(Date.now() / 1000), per7d: rate * scale, rate, win_h: +winH.toFixed(2), win_raw: totalRaw.toString(), n: samples.length,
        lo: q(samples.map(x => x.rate), 0.25) * scale, hi: q(samples.map(x => x.rate), 0.75) * scale,
        proofs: samples.sort((a, b) => b.bal - a.bal).slice(0, 5).map(x => ({ w: x.w, bal: x.bal, got: x.got, n: x.n, sig: x.sig, t: x.t })), price: meta?.price ?? null, qprice: qp, note: '' },
    };
  }

  // ---- a CA somebody searched that no scan has seen: find where its holders get paid from
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const SWAPS = new Set(['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83', '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f']);
  // a real holder payout goes to people who hold the coin: check a few of the receivers (routers and bots spray ETH too)
  async function holders(chain, coin, tos, blockHex) {
    const sample = tos.slice(0, 6); let yes = 0;
    for (const w of sample) { const b = await bal(chain, coin, w, parseInt(blockHex, 16)); if (b && b > 0n) yes++; }
    return yes >= Math.ceil(sample.length * 0.6);
  }
  async function discoverEvm(coin) {
    coin = coin.toLowerCase();
    const chains = [];
    for (const c of Object.keys(NET)) { const code = await evm(c, 'eth_getCode', [coin, 'latest']).catch(() => '0x'); if (code && code !== '0x') chains.push(c); }
    for (const chain of chains) {
      const r = await evm(chain, 'alchemy_getAssetTransfers', [{ fromBlock: '0x0', toBlock: 'latest', contractAddresses: [coin], category: ['erc20'], order: 'desc', maxCount: '0x64', excludeZeroValue: true }]).catch(() => null);
      const hashes = [...new Set((r?.transfers || []).map(t => t.hash))].slice(0, 25);
      for (const h of hashes) {
        const rc = await evm(chain, 'eth_getTransactionReceipt', [h]).catch(() => null); if (!rc) continue;
        const pools = new Set(rc.logs.filter(l => SWAPS.has(l.topics?.[0])).map(l => l.address.toLowerCase()));
        const g = {};
        for (const l of rc.logs) if (l.topics?.[0] === TRANSFER && l.topics.length === 3) { const k = l.address.toLowerCase() + '|0x' + l.topics[1].slice(26); (g[k] = g[k] || new Set()).add(l.topics[2]); }
        const hit = Object.entries(g).find(([k, to]) => { const [tk, from] = k.split('|'); return to.size >= 5 && !pools.has(from) && from !== coin && tk !== coin; });
        if (hit) { const [asset, distributor] = hit[0].split('|'); if (await holders(chain, coin, [...hit[1]].map(t => '0x' + t.slice(26)), rc.blockNumber)) return { chain, coin, platform: 'Coin rewards', distributor, asset, sig: h }; }
        // plain ETH/BNB rewards don't show in logs: look at the internal transfers of that block
        const blk = rc.blockNumber, it = await evm(chain, 'alchemy_getAssetTransfers', [{ fromBlock: blk, toBlock: blk, category: chain === 'bsc' || chain === 'robinhood' ? ['external'] : ['internal'], maxCount: '0x3e8', excludeZeroValue: true }]).catch(() => null);
        const ng = {}; for (const t of it?.transfers || []) if (t.hash === h) { const f = t.from.toLowerCase(); (ng[f] = ng[f] || new Set()).add(t.to); }
        let nh = null; for (const e of Object.entries(ng)) if (e[1].size >= 5 && !pools.has(e[0]) && await holders(chain, coin, [...e[1]], blk)) { nh = e; break; }
        if (nh) return { chain, coin, platform: 'Coin rewards', distributor: nh[0], asset: 'native:' + chain, sig: h };
      }
    }
    return null;
  }
  async function discoverSol(coin) {
    // creator-run rewards: the wallet that made the coin sends batches to many holders
    const first = await sol('getTransactionsForAddress', [coin, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, limit: 1, sortOrder: 'asc' }]).catch(() => null);
    const creator = first?.data?.[0]?.transaction?.message?.accountKeys?.find(k => k.signer)?.pubkey;
    if (!creator) return null;
    const r = await sol('getTransactionsForAddress', [creator, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, limit: 100, sortOrder: 'desc', filters: { status: 'succeeded', blockTime: { gte: Math.floor(Date.now() / 1000) - WEEK } } }]).catch(() => null);
    for (const tx of r?.data || []) {
      const keys = tx.transaction.message.accountKeys.map(k => k.pubkey), ci = keys.indexOf(creator);
      const solTo = keys.filter((k, i) => i !== ci && tx.meta.postBalances[i] > tx.meta.preBalances[i]).length;
      if (solTo >= 5 && tx.meta.postBalances[ci] < tx.meta.preBalances[ci]) return { chain: 'solana', coin, platform: 'Creator rewards', distributor: creator, asset: 'So11111111111111111111111111111111111111112', sig: tx.transaction.signatures[0] };
      const post = tx.meta.postTokenBalances || [], pre = tx.meta.preTokenBalances || [];
      const by = {}; for (const b of post) { const p = pre.find(x => x.accountIndex === b.accountIndex); if (b.owner !== creator && BigInt(b.uiTokenAmount.amount) > BigInt(p?.uiTokenAmount.amount || '0')) (by[b.mint] = by[b.mint] || new Set()).add(b.owner); }
      const m = Object.entries(by).find(([mint, o]) => o.size >= 5 && mint !== coin);
      if (m) return { chain: 'solana', coin, platform: 'Creator rewards', distributor: creator, asset: m[0], sig: tx.transaction.signatures[0] };
    }
    return null;
  }
  const measureSeed = async function measureSeed(s) {
    if (s.platform === 'pump.fun') return { note: 'pump.fun pays wallets the creator picked, not holders' };
    return s.chain === 'solana' ? measureSol(s) : measureEvm(s);
  };
  measureSeed.discover = (chain, coin) => chain === 'solana' ? discoverSol(coin) : discoverEvm(coin);
  return measureSeed;
}
