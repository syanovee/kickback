// Coin pages (/coins): counts what each reward coin has paid its holders. Runs every 30 minutes (.github/workflows/coins.yml).
//   StonkFun   lifetime total from StonkFun's rewards API; days from walking its payout ledger, oldest first, then keeping up.
//   pump.fun   every DistributeFeeToHolders round, read on-chain from the coin's rewards vault: what left the vault went to holders.
//   Flap (BNB) the coin's dividend contract keeps its own lifetime total (totalDividendsDistributed); days from our own snapshots.
// Local run against the test site: bash tools/coins-local.sh
import fs from 'node:fs';
const SITE = (process.env.SITE || 'https://getkickback.fun').replace(/\/$/, '');
const KEY = process.env.YIELD_KEY, HELIUS = process.env.HELIUS_KEY;
if (!KEY || !HELIUS) { console.error('needs YIELD_KEY and HELIUS_KEY'); process.exit(1); }
const BUDGET = (+process.env.MAX_MIN || 25) * 60e3, T0 = Date.now(), left = () => BUDGET - (Date.now() - T0);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const LIST = JSON.parse(fs.readFileSync(new URL('./coins-list.json', import.meta.url)));
const SKIP = new Set((LIST.skip || []).map(m => m.toLowerCase()));
const SF = 'https://www.stonkfun.xyz', BSC = 'https://bsc-dataseed.bnbchain.org';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', PUMP_SIGNER = 'HckQ93Xqjjo8mwt5pNPWvyCTZXQZ858rvzmm7ZRrZg9t';
const WSOL = 'So11111111111111111111111111111111111111112', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const MIN_USD = 1000;                       // smaller payers are not listed
const DAY = 86400, today = () => Math.floor(Date.now() / 1000 / DAY);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const isEvm = m => /^0x/.test(m), key = m => isEvm(m) ? m.toLowerCase() : m;

async function get(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });   // a hung request must not freeze the whole run
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      if (r.status !== 429 && r.status < 500) throw Object.assign(new Error(r.status + ' ' + url), { final: true });   // 400/403: asking again won't help
    } catch (e) { if (e.final || i === tries - 1) throw e; }
    await sleep(Math.min(20e3, 1000 * 2 ** i));
  }
}
// Helius budget: every call is counted; once the day's cap is reached, Helius calls stop until tomorrow (UTC) and the rest of the run goes on.
//   HELIUS_DAY   calls a day (default 4000), shared by every run that day (kept in the hidden '_helius' row on the site)
//   PUMP_EVERY_H count pump.fun at most every N hours (default 3; 0 = every run, for catching up)
const HELIUS_DAY = +(process.env.HELIUS_DAY || 4000), PUMP_EVERY_H = +(process.env.PUMP_EVERY_H ?? 3);
const H = { used: 0, run: 0, by: {}, cap: HELIUS_DAY };
const QN = process.env.QUICKNODE_URL || '';
let heliusDown = false;
const QN_RUN = +(process.env.QN_RUN || 1500), QQ = { used: 0 };   // QuickNode calls a run may make once it takes over   // Helius refused this run (rate limit / credits): QuickNode takes the rest, or pump.fun waits for the next run
const REFUSED = /rate.?limit|too many|credit|exceed|upgrade|plan|quota|unauthori|forbidden|api.?key/i;
async function rpcAt(url, method, params, tries) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
      if (r.status === 429 || r.status === 401 || r.status === 403 || r.status >= 500) { last = 'status ' + r.status; await sleep(800 * 2 ** i); continue; }
      const j = await r.json();
      if (j.error) { const m = String(j.error.message || ''); if (REFUSED.test(m)) { last = m.slice(0, 80); await sleep(800 * 2 ** i); continue; } throw Object.assign(new Error(method + ': ' + m), { final: true }); }
      return j.result;
    } catch (e) { if (e.final) throw e; last = String(e.message || e).slice(0, 80); await sleep(800 * 2 ** i); }
  }
  throw Object.assign(new Error(method + ' refused (' + last + ')'), { refused: true });
}
async function rpc(method, params) {
  if (H.used >= H.cap) throw new Error(H.cap < HELIUS_DAY ? 'helius share for this run used' : 'helius daily budget reached');
  H.used++; H.run++; H.by[method] = (H.by[method] || 0) + 1;
  if (heliusDown === false) {
    try { return await rpcAt('https://mainnet.helius-rpc.com/?api-key=' + HELIUS, method, params, 3); }
    catch (e) {
      if (e.refused === undefined) throw e;
      heliusDown = true;
      log('helius refused (' + e.message + ')' + (QN ? ', QuickNode takes over for this run' : ', no QUICKNODE_URL: pump.fun waits for the next run'));
    }
  }
  if (QN === '') throw new Error('helius refused, no fallback');
  if (QQ.used >= QN_RUN) throw new Error('quicknode share for this run used');
  QQ.used++; H.used--;   // a QuickNode call is not a Helius call: it counts against its own share
  try { return await rpcAt(QN, method, params, 4); }
  catch (e) { if (e.refused) { QQ.used = QN_RUN; log('quicknode refused too (' + e.message + '): pump.fun waits for the next run'); } throw e; }
}
async function evm(method, params) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(BSC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
      const j = await r.json(); if (!j.error) return j.result;
    } catch {}
    await sleep(600 * (i + 1));
  }
  return null;
}
const call = (to, data) => evm('eth_call', [{ to, data }, 'latest']);
const word = h => (h && h.length >= 66 ? BigInt('0x' + h.slice(2, 66)) : 0n);
const addr = h => (h && h.length >= 66 && !/^0x0{64}$/.test(h.slice(0, 66)) ? '0x' + h.slice(26, 66).toLowerCase() : null);
const text = h => { try { const n = parseInt(h.slice(66, 130), 16); return Buffer.from(h.slice(130, 130 + n * 2), 'hex').toString('utf8').replace(/\0/g, '') || null; } catch { return null; } };

async function site(method, body, q = '') {
  let last = '';
  for (let i = 0; i < 20; i++) {   // a Mac on wifi can drop out for a few minutes: keep trying for ~8 min
    const r = await fetch(SITE + '/api/coins/ingest' + q, { method, headers: { authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) }).catch(e => (last = e.message + (e.cause ? ' [' + (e.cause.code || '') + ' ' + (e.cause.message || '') + ']' : ''), null));
    if (r?.ok) return r.json();
    if (r) { last = r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200); if (r.status < 500) throw new Error('site ' + last); }
    log('  site busy (' + last + '), retrying'); await sleep(Math.min(30000, 3000 * (i + 1)));
  }
  throw new Error('site unreachable: ' + last);
}
// a coin's new days and its moved cursor always go out in the same request
async function post(coins, days = [], reset = [], expect, rounds = [], prices = []) {
  const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  for (let i = 0; i < Math.max(coins.length, 1); i += 300) {
    const cs = coins.slice(i, i + 300).map(clean);
    await site('POST', { coins: cs, days: i ? [] : days, reset: i ? [] : reset, ...(rounds.length && !i ? { rounds } : {}), ...(prices.length && !i ? { prices } : {}), ...(expect && !i ? { expect } : {}) });
  }
}
const toNum = (raw, dec) => { const b = BigInt(raw), d = 10n ** BigInt(dec); return Number(b / d) + Number(b % d) / Number(d); };

// ---- market data (DexScreener): price, market cap, 24h volume, icon, name
async function market(chain, mints, tries = 6) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const j = await get(`https://api.dexscreener.com/tokens/v1/${chain}/${mints.slice(i, i + 30).join(',')}`, tries).catch(e => (log('  dexscreener:', e.message.slice(0, 120)), null));
    for (const p of Array.isArray(j) ? j : []) {
      const m = key(p.baseToken?.address || ''); if (!m) continue;
      const o = out[m] || (out[m] = { vol24: 0, liq: -1 });
      o.vol24 += p.volume?.h24 || 0;
      if ((p.liquidity?.usd || 0) > o.liq) Object.assign(o, { liq: p.liquidity?.usd || 0, price: +p.priceUsd || null, mcap: p.marketCap || p.fdv || null, symbol: p.baseToken.symbol, name: p.baseToken.name });
      if (p.info?.imageUrl && !o.icon) o.icon = p.info.imageUrl;
      if (p.pairCreatedAt && (!o.created || p.pairCreatedAt < o.created * 1000)) o.created = Math.floor(p.pairCreatedAt / 1000);
    }
    await sleep(250);
  }
  return out;
}
// logos by ticker, for payout tokens whose own listing has none (Pons pays in Robinhood Chain tokens: DOGE, wXRP, stock tokens).
// Filled from the Solana payout tokens each run (NVDAx there has a logo, NVDAX on Robinhood doesn't), plus a few majors.
const ICON_BY_SYM = { DOGE: 'https://coin-images.coingecko.com/coins/images/5/large/dogecoin.png', XRP: 'https://coin-images.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png', ETH: 'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png' };
const symKey = s => String(s || '').toUpperCase().replace(/^W(?=[A-Z]{3,}$)/, '').replace(/X$/, '');
const iconFor = s => ICON_BY_SYM[symKey(s)] || ICON_BY_SYM[String(s || '').toUpperCase()] || null;
// SOL's daily close for the last two years (CoinGecko, free), to value pump.fun payouts in SOL at the price of their day
let SOLH = null;
async function solHist() {
  if (SOLH) return SOLH;
  SOLH = new Map();
  const j = await get('https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=730&interval=daily', 3).catch(() => null);
  for (const [ms, p] of j?.prices || []) SOLH.set(Math.floor(ms / 1000 / DAY), p);
  // CoinGecko can be unreachable (from China it is): Kraken's daily candles, then Binance's, give the same closes
  if (!SOLH.size) { const k = await get('https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=1440', 2).catch(() => null); for (const r of Object.values(k?.result || {}).find(Array.isArray) || []) SOLH.set(Math.floor(r[0] / DAY), +r[4]); }
  if (!SOLH.size) { const b = await get('https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1d&limit=1000', 2).catch(() => null); for (const r of Array.isArray(b) ? b : []) SOLH.set(Math.floor(r[0] / 1000 / DAY), +r[4]); }
  log(`SOL price history: ${SOLH.size} days`);
  return SOLH;
}
// Every payout token's daily close (by ticker), so the site can show each day, week and month at that day's price.
// Kraken first (its daily candles go back 720 days), then Binance. A ticker neither has is marked and asked again in a week.
// Stablecoins are $1 any day: today's price is already right for them.
const STABLE = new Set(['USDC', 'USDT', 'USDG', 'USD1', 'PYUSD', 'USDS', 'DAI', 'USDE', 'FDUSD', 'USDH']);
const KRAKEN_AS = { BTC: 'XBT', WBTC: 'XBT', DOGE: 'XDG', WETH: 'ETH', WSOL: 'SOL', WXRP: 'XRP' };
async function closes(sym) {
  const m = new Map(), k = KRAKEN_AS[sym] || sym;
  for (const pair of [...new Set([k + 'USD', k.replace(/X$/, '') + 'xUSD'])]) {
    if (m.size) break;
    await new Promise(r => setTimeout(r, 1500));   // Kraken's public API allows about one call a second
    const j = await get(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=1440`, 1).catch(() => null);
    for (const r of Object.values(j?.result || {}).find(Array.isArray) || []) if (+r[4] > 0) m.set(Math.floor(r[0] / DAY), +r[4]);
  }
  if (!m.size && !closes.noBinance) {
    // Binance can be blocked (it is from China): one failed connection and it isn't asked again this run
    const b = await get(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent((sym === 'WBTC' ? 'BTC' : sym) + 'USDT')}&interval=1d&limit=1000`, 1).catch(e => { if (!/^4\d\d /.test(e.message)) closes.noBinance = true; return null; });
    for (const r of Array.isArray(b) ? b : []) if (+r[4] > 0) m.set(Math.floor(r[0] / 1000 / DAY), +r[4]);
  }
  return m;
}
async function priceRun(st, rows) {
  const today = Math.floor(Date.now() / 1000 / DAY), have = new Map((st.prices || []).map(p => [p.sym, p]));
  // tickers worth pricing: what coins that paid real money pay in, biggest first
  const w = new Map();
  for (const r of [...(st.coins || []), ...rows]) { const s = String(r.pay_symbol || '').replace(/^\$/, '').toUpperCase(); if (s && s !== 'NULL' && !STABLE.has(s) && /^[A-Z0-9.]{1,20}$/.test(s)) w.set(s, (w.get(s) || 0) + 1); }
  let asked = 0, got = 0, rowsN = 0, none = 0;
  for (const s of [...w.keys()].sort((a, b) => w.get(b) - w.get(a))) {
    const h = have.get(s);
    if (h?.none != null && today - h.none < 7 && !(h.last >= 0)) continue;   // no exchange had it a few days ago
    if (h && h.last >= today - 1) continue;                                   // up to date
    if (asked >= 40 || left() < 120e3) break;
    asked++;
    const m = await closes(s);
    if (!m.size) { if (!(h?.last >= 0)) { await post([], [], [], undefined, [], [[s, -1, today]]); none++; } continue; }
    const from = h?.last >= 0 ? h.last - 2 : -1;
    const add = [...m].filter(([d]) => d > from).map(([d, p]) => [s, d, p]);
    for (let i = 0; i < add.length; i += 800) await post([], [], [], undefined, [], add.slice(i, i + 800));
    got++; rowsN += add.length;
  }
  log(`prices: ${got} payout tokens got daily closes (${rowsN} days), ${none} no exchange has, ${w.size} tickers in all`);
}
const solAt = (h, d, now) => h.get(d) ?? h.get(d - 1) ?? h.get(d + 1) ?? now;
const MAJOR = { [WSOL]: { symbol: 'SOL', icon: 'https://coin-images.coingecko.com/coins/images/4128/large/solana.png' },
  [WBNB]: { symbol: 'BNB', icon: 'https://coin-images.coingecko.com/coins/images/825/large/bnb-icon2_2x.png' } };

// ---- StonkFun
async function stonkList(pins) {
  const rows = [], seen = new Set(); let cursor = '';
  for (let p = 0; p < 120; p++) {
    const j = await get(`${SF}/api/v2/rewards/launches?sort=recent&order=desc&limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    let stop = false;
    for (const r of j?.rows || []) { if (Date.parse(r.lastPayoutAt) < Date.now() - 14 * DAY * 1000) { stop = true; break; } if (r.asset?.mint && r.distributedRaw && !seen.has(r.mint)) { seen.add(r.mint); rows.push(r); } }
    cursor = j?.page?.nextCursor; if (stop || !cursor) break;
  }
  for (const m of pins) if (!seen.has(m)) {
    const j = await get(`${SF}/api/v2/tokens/${m}/rewards`).catch(() => null);
    if (j?.rewards?.distributedRaw) rows.push({ mint: m, asset: j.quote, distributedRaw: j.rewards.distributedRaw, payoutCount: j.rewards.payoutCount, walletsPaid: j.rewards.walletsPaid, lastPayoutAt: j.rewards.lastPayoutAt, pinned: 1 });
  }
  return rows.filter(r => r.pinned || pins.includes(r.mint) || (r.walletsPaid || 0) >= 50);
}
// ---- pump.fun
const isDist = t => (t?.meta?.logMessages || []).some(l => l.includes('DistributeFeeToHolders'));
// the vault is the account the round's payouts came out of
function vaultOf(t) {
  const keys = t.transaction.message.accountKeys.map(k => k.pubkey || k);
  const ix = t.transaction.message.instructions.find(i => i.programId === PUMP);
  if (!ix?.accounts) return null;
  let best = null, low = 0;
  keys.forEach((k, i) => { const d = t.meta.postBalances[i] - t.meta.preBalances[i]; if (i && k !== PUMP_SIGNER && d < low) { low = d; best = k; } });
  return { coin: ix.accounts.find(a => a.endsWith('pump')) || ix.accounts[2], vault: best || ix.accounts[3] };
}
// active coins right now: a sample of the payout signer's latest rounds
async function pumpDiscover() {
  const found = {}; let tk, seen = 0, dist = 0, novault = 0;
  for (let p = 0; p < 10; p++) {
    const o = { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, limit: 100, sortOrder: 'desc', filters: { status: 'succeeded' } }; if (tk) o.paginationToken = tk;
    const r = await rpc('getTransactionsForAddress', [PUMP_SIGNER, o]).catch(e => (log('  pump discover page failed', e.message), null));
    for (const t of r?.data || []) { seen++; if (!isDist(t)) continue; dist++; const v = vaultOf(t); if (v?.coin && v.vault) (found[v.coin] = found[v.coin] || { vault: v.vault, n: 0 }).n++; else novault++; }
    tk = r?.paginationToken; if (!tk) break;
  }
  log(`  pump discover: ${seen} signer transactions read, ${dist} payout rounds, ${novault} without a coin or vault`);   // tells why "0 coins paying" when it happens
  return found;
}
// the coin's own history often misses its payout rounds (the mint comes in through a lookup table), so look in the payout signer's history first
async function pumpVault(mint) {
  for (const [addr, pages] of [[PUMP_SIGNER, 40], [mint, 5]]) {
    let tk;
    for (let p = 0; p < pages; p++) {
      const o = { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, limit: 100, sortOrder: 'desc', filters: { status: 'succeeded' } }; if (tk) o.paginationToken = tk;
      const r = await rpc('getTransactionsForAddress', [addr, o]).catch(e => (log('  vault lookup failed', e.message), null));
      for (const t of r?.data || []) if (isDist(t)) { const v = vaultOf(t); if (v?.coin === mint && v.vault) return v.vault; }
      tk = r?.paginationToken; if (!tk) break;
    }
  }
  return null;
}
// reads the vault's history from where we stopped. Rounds paid out of the vault; everything else is fees coming in.
async function pumpCount(c, maxPages) {
  let cur = {}; try { cur = JSON.parse(c.cursor || '{}'); } catch {}
  let slot = cur.slot || 0, asset = cur.asset || null, dec = cur.dec ?? null, paid = BigInt(c.paid_raw || '0');
  let rounds = c.rounds || 0, payouts = c.payouts || 0, first = c.first_ts || null, last = c.last_ts || null, pages = 0, done = false;
  const days = new Map(), proofs = [], recent = [], who = new Set(cur.who || []), checking = !cur.chk;
  while (pages < maxPages && left() > 60e3) {
    const r = await rpc('getTransactionsForAddress', [c.vault, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, limit: 100, sortOrder: 'asc', filters: { slot: { gt: slot }, status: 'succeeded' } }]);
    pages++;
    let txs = r?.data || [];
    // a full page may end in the middle of a slot: leave that slot for the next page
    if (txs.length === 100) { const top = txs[txs.length - 1].slot, cut = txs.filter(t => t.slot < top); if (cut.length) txs = cut; }
    for (const t of txs) {
      slot = Math.max(slot, t.slot);
      if (!isDist(t)) continue;
      const keys = t.transaction.message.accountKeys.map(k => k.pubkey || k), vi = keys.indexOf(c.vault);
      const sol = vi >= 0 ? t.meta.postBalances[vi] - t.meta.preBalances[vi] : 0;
      let out = 0n, n = 0;
      if (!asset) {
        if (sol < 0) { asset = WSOL; dec = 9; }
        else { const b = (t.meta.postTokenBalances || []).find(b => b.owner === c.vault); if (b) { asset = b.mint; dec = b.uiTokenAmount.decimals; } }
      }
      if (asset === WSOL) {
        out = BigInt(-Math.min(0, sol));
        keys.forEach((k, j) => { if (j && k !== c.vault && k !== PUMP_SIGNER && t.meta.postBalances[j] > t.meta.preBalances[j]) { n++; if (checking && who.size < 50) who.add(k); } });
      } else if (asset) {
        for (const b of t.meta.postTokenBalances || []) {
          if (b.mint !== asset) continue;
          const q = (t.meta.preTokenBalances || []).find(x => x.accountIndex === b.accountIndex), d = BigInt(b.uiTokenAmount.amount) - BigInt(q?.uiTokenAmount.amount || '0');
          if (b.owner === c.vault && d < 0n) out += -d; else if (d > 0n) { n++; if (checking && who.size < 50) who.add(b.owner); }
        }
      }
      if (out <= 0n) continue;
      paid += out; rounds++; payouts += n; first = first ?? t.blockTime; last = t.blockTime;
      const d = Math.floor(t.blockTime / DAY), x = days.get(d) || { v: 0, n: 0 }; x.v += toNum(out, dec); x.n += n; days.set(d, x);
      proofs.unshift(t.transaction.signatures[0]); if (proofs.length > 3) proofs.pop();
      // one payout round is split over many transactions in the same block: they make one row, not one row each
      if (t.blockTime > Date.now() / 1000 - 14 * DAY) { const lr = recent[recent.length - 1]; if (lr && t.blockTime - lr[0] <= 2) { lr[1] += toNum(out, dec); lr[2] += n; } else { recent.push([t.blockTime, toNum(out, dec), n]); if (recent.length > 6) recent.shift(); } }
    }
    if ((r?.data || []).length < 100) { done = true; break; }
  }
  // fee sharing runs through the same instruction but pays a handful of wallets the creator picked, not holders
  const chk = !checking || rounds >= 60, feeShare = checking && rounds >= 60 && who.size < 15;
  return { paid, rounds, payouts, first, last, days, proofs, recent, pages, done, feeShare, cursor: { slot, asset, dec, done: done ? 1 : 0, ...(chk ? { chk: 1 } : { who: [...who] }) } };
}

// ---- Flap (BNB Chain): coins whose token points at a dividend contract
async function flapDiscover() {
  const found = new Set();
  for (const q of ['pools?sort=h24_volume_usd_desc&page=1', 'pools?sort=h24_volume_usd_desc&page=2', 'pools?sort=h24_volume_usd_desc&page=3', 'pools?sort=h24_volume_usd_desc&page=4', 'pools?sort=h24_volume_usd_desc&page=5',
    'trending_pools?duration=24h&page=1', 'trending_pools?duration=24h&page=2', 'trending_pools?page=1', 'trending_pools?page=2']) {
    const j = await get('https://api.geckoterminal.com/api/v2/networks/bsc/' + q, 3).catch(() => null);
    for (const d of j?.data || []) { const a = String(d.relationships?.base_token?.data?.id || '').replace('bsc_', '').toLowerCase(); if (/(7777|8888)$/.test(a)) found.add(a); }
    await sleep(2500);
  }
  return [...found];
}
async function flapRead(token) {
  const tracker = addr(await call(token, '0x6124e4e7')); if (!tracker) return null;
  const total = word(await call(tracker, '0x85a6b3ae'));
  const reward = addr(await call(tracker, '0x3fc8cef3')) || WBNB;
  const dec = reward === WBNB ? 18 : Number(word(await call(reward, '0x313ce567'))) || 18;
  const sym = reward === WBNB ? 'BNB' : text(await call(reward, '0x95d89b41')) || '?';
  return { tracker, total, reward, dec, sym };
}


// ---- Pons (Robinhood Chain): coins whose holders are paid through the Pons escrow.
// The escrow sends each coin's reward vault its money; the vault then pays the holders in batches. A vault is a contract whose token() is the coin.
// What reaches the vaults is what holders got. Creator fees go through the same escrow to other contracts (fee claimers, agent harvests) and are left out.
// Data from Blockscout's PRO API (free key, BLOCKSCOUT_KEY). Progress lives on a hidden row so each run only reads the new escrow transfers.
const PONS_ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e', BS = 'https://api.blockscout.com/4663/api/v2', BS_KEY = process.env.BLOCKSCOUT_KEY;
const PONS_STATE = '_pons_escrow', PONS_BACK_DAYS = 7;   // first run: last week (about 4k escrow transfers, a couple of minutes)
async function bs(path, q = {}) {
  for (let i = 0; i < 6; i++) {
    await sleep(230);
    const u = new URL(BS + path); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v); u.searchParams.set('apikey', BS_KEY);
    try { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (r.ok) return await r.json(); if (r.status === 404) return null; if (r.status !== 429 && r.status < 500) throw new Error('blockscout ' + r.status); }
    catch (e) { if (i === 5 || /blockscout 4/.test(e.message)) throw e; }
    await sleep(1000 * 2 ** i);
  }
}
// Pons coins older than our first escrow read had their earlier payouts missing from All time. For each holder vault, once:
// walk what it received from the escrow (newest back) up to B, the high-water mark when its walk began. When the walk ends:
//   paid = (everything up to B) + (what the live count added after B)     rounds the same way; days before startDay are written, later days are already right.
// A walk that runs out of time keeps its place (next page) and partial sums in the state row and goes on next run.
async function ponsBackfill(bf, vaults, known, wrote, hw, startDay) {
  if (!hw) return bf;
  const now = new Map(wrote.map(c => [c.mint, c])), cur = m => now.get(m) || known.get(m) || {};
  const todo = Object.entries(vaults).filter(([v, m]) => m && !bf[v]?.done && cur(m).pay_mint && cur(m).status !== 'hidden')
    .sort((a, b) => (cur(b[1]).paid_usd || 0) - (cur(a[1]).paid_usd || 0));
  let pages = 0, finished = 0;
  for (const [v, m] of todo) {
    if (pages >= 300 || left() < 150e3) break;
    const c = cur(m), pay = c.pay_mint.toLowerCase();
    const w = bf[v] || (bf[v] = { B: hw.t, r0: String(c.paid_raw || '0'), n0: c.rounds || 0, raw: '0', n: 0, d: {}, np: null });
    let raw = BigInt(w.raw), end = false;
    while (pages < 300 && left() > 120e3) {
      const j = await bs(`/addresses/${v}/token-transfers`, { type: 'ERC-20', filter: 'to', token: pay, ...(w.np || {}) }); pages++;
      for (const t of j?.items || []) {
        if ((t.from?.hash || '').toLowerCase() !== PONS_ESCROW) continue;
        if ((t.token?.address_hash || t.token?.address || '').toLowerCase() !== pay) continue;
        const ts = Date.parse(t.timestamp); if (ts > w.B) continue;
        const x = BigInt(t.total?.value || '0'); raw += x; w.n++;
        const d = Math.floor(ts / 1000 / DAY); if (d < startDay) { const o = w.d[d] || (w.d[d] = ['0', 0]); o[0] = (BigInt(o[0]) + x).toString(); o[1]++; }
        w.first = Math.floor(ts / 1000);
      }
      w.raw = raw.toString();
      if (!j?.next_page_params) { end = true; break; }
      w.np = j.next_page_params;
    }
    if (!end) break;   // keeps its place, next run goes on
    const dec = c.pay_dec ?? 18, k = known.get(m) || {};
    const total = raw + (BigInt(c.paid_raw || '0') - BigInt(w.r0)), rounds = w.n + ((c.rounds || 0) - w.n0);
    const paidN = toNum(total, dec), first = Object.keys(w.d).map(Number).sort((a, b) => a - b)[0];
    const dayRows = Object.entries(w.d).map(([d, [r, n]]) => [m, +d, toNum(BigInt(r), dec), n, 'set']);
    await post([{ mint: m, ...(c.status === 'small' && c.pay_price && paidN * c.pay_price >= MIN_USD ? { status: 'ok' } : {}), paid_raw: total.toString(), rounds, paid_usd: c.pay_price ? paidN * c.pay_price : undefined, first_ts: w.first || null, days_from: first ?? (c.days_from ?? startDay) }], dayRows);
    log(`  Pons $${c.symbol || k.symbol || m.slice(0, 8)} history: +${toNum(raw > BigInt(w.r0) ? raw - BigInt(w.r0) : 0n, dec).toFixed(2)} ${c.pay_symbol || k.pay_symbol || ''} from before we started, ${paidN.toFixed(2)} all time`);
    bf[v] = { done: 1 }; finished++;
  }
  if (todo.length) log(`Pons history: ${finished} coins completed, ${todo.length - finished} left, ${pages} pages this run`);
  return bf;
}
async function bsCall(to, data) {
  for (let i = 0; i < 4; i++) {
    await sleep(230);
    try { const u = new URL(i % 2 ? 'https://robinhoodchain.blockscout.com/api/eth-rpc' : 'https://api.blockscout.com/4663/json-rpc'); if (!(i % 2)) u.searchParams.set('apikey', BS_KEY);
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(20000) });
      if (r.ok) { const j = await r.json(); return j.result ?? null; } } catch {}
    await sleep(800 * 2 ** i);
  }
  return null;
}
async function ponsRun(known) {
  if (!BS_KEY) { log('Pons: no BLOCKSCOUT_KEY, skipped'); return; }
  const st = known.get(PONS_STATE); let S = {}; try { S = JSON.parse(st?.cursor || '{}') || {}; } catch {}
  const vaults = S.v || {};            // vault -> coin, or '' when it is not a holder vault
  const nowMs = Date.now(), floorMs = S.hw ? 0 : nowMs - PONS_BACK_DAYS * 864e5;
  // 1. new escrow transfers, newest first, down to where the last run stopped (or 30 days back the first time)
  const items = []; let q = { type: 'ERC-20', filter: 'from' }, reached = false;
  for (let p = 0; p < 4000 && left() > 120e3; p++) {
    const j = await bs(`/addresses/${PONS_ESCROW}/token-transfers`, q);
    for (const t of j?.items || []) {
      const ts = Date.parse(t.timestamp), id = t.transaction_hash + ':' + t.log_index;
      if (S.hw && (ts < S.hw.t || (ts === S.hw.t && S.hw.h.includes(id)))) { reached = true; break; }
      if (Date.parse(t.timestamp) < floorMs) { reached = true; break; }
      items.push(t);
    }
    if (reached || !j?.next_page_params) { reached = true; break; }
    q = { type: 'ERC-20', filter: 'from', ...j.next_page_params };
  }
  if (!reached) { log(`Pons: ran out of time after ${items.length} transfers, next run starts over`); return; }
  // 2. which recipients are holder vaults: a contract whose token() names the coin and that pays many wallets at once
  // only recipients worth a look (>= $10 or 3+ transfers in this batch), biggest first: thousands of dust recipients would eat the daily API allowance
  const sz = {}; for (const t of items) { if (!t.to?.is_contract) continue; const a = t.to.hash.toLowerCase(), o = sz[a] || (sz[a] = { usd: 0, n: 0 }); o.n++; o.usd += (Number(t.total?.value || 0) / 10 ** +(t.total?.decimals || 18)) * (+t.token?.exchange_rate || 0); }
  const recips = Object.entries(sz).filter(([a, o]) => !(a in vaults) && (o.usd >= 10 || o.n >= 3)).sort((x, y) => y[1].usd - x[1].usd || y[1].n - x[1].n).map(([a]) => a);
  log(`Pons: ${items.length} new escrow transfers, ${recips.length} new recipients to check`);
  // 4 at a time: Blockscout's free key allows 5 requests a second
  let checked = 0, qi = 0;
  const one = async a => {
    const tk = await bsCall(a, '0xfc0c546a'); const coin = tk && tk.length >= 66 && !/^0x0+$/.test(tk) ? ('0x' + tk.slice(-40)).toLowerCase() : null;
    if (!coin || /^0x0{40}$/.test(coin)) { vaults[a] = ''; return; }
    const out = await bs(`/addresses/${a}/token-transfers`, { type: 'ERC-20', filter: 'from' }).catch(() => null);
    const per = {}; for (const t of out?.items || []) (per[t.transaction_hash] = per[t.transaction_hash] || new Set()).add(t.to.hash.toLowerCase());
    vaults[a] = Object.values(per).some(x => x.size >= 3) ? coin : '';     // batch payouts to holders, not a fee claimer paying its owner
  };
  await Promise.all([...Array(4)].map(async () => { while (qi < recips.length && left() > 90e3) { const a = recips[qi++]; await one(a); checked++; } }));
  // out of time before every recipient was checked: keep what we learned about vaults, count nothing yet (next run reads the same transfers again)
  if (checked < recips.length) { await post([{ mint: PONS_STATE, chain: 'robinhood', platform: 'Pons', status: 'hidden', cursor: JSON.stringify({ ...S, v: vaults }) }]); log(`Pons: checked ${checked}/${recips.length} recipients, counting next run`); return; }
  // 3. add up per coin, in its main payout token
  const per = new Map();
  for (const t of items) {
    const coin = vaults[t.to?.hash?.toLowerCase()]; if (!coin) continue;
    const tok = t.token, a = (tok.address_hash || tok.address || '').toLowerCase(), raw = BigInt(t.total?.value || '0'), dec = +(t.total?.decimals || tok.decimals || 18);
    const c = per.get(coin) || { coin, tok: {}, days: new Map(), last: 0, proofs: [] };
    const k = c.tok[a] || (c.tok[a] = { a, sym: tok.symbol, dec, icon: tok.icon_url || null, price: tok.exchange_rate ? +tok.exchange_rate : null, raw: 0n, n: 0 });
    k.raw += raw; k.n++;
    const ts = Math.floor(Date.parse(t.timestamp) / 1000), d = Math.floor(ts / DAY);
    const dd = c.days.get(a + '|' + d) || { a, d, raw: 0n, n: 0 }; dd.raw += raw; dd.n++; c.days.set(a + '|' + d, dd);
    if (ts > c.last) c.last = ts; if (c.proofs.length < 3) c.proofs.push({ s: t.transaction_hash });
    per.set(coin, c);
  }
  // 4. write: one coin at a time, its days with it. The state row moves last, so a failed run is simply read again next time.
  const startDay = S.from ?? Math.floor(floorMs / 1000 / DAY) + 1;
  const coins = [], days = [];
  for (const c of per.values()) {
    const k = known.get(c.coin);
    const main = k?.pay_mint && c.tok[k.pay_mint] ? c.tok[k.pay_mint] : Object.values(c.tok).sort((x, y) => (Number(y.raw) / 10 ** y.dec) * (y.price || 0) - (Number(x.raw) / 10 ** x.dec) * (x.price || 0) || y.n - x.n)[0];
    const prevRaw = k?.pay_mint === main.a ? BigInt(k.paid_raw || '0') : 0n, total = prevRaw + main.raw;
    const info = await bs(`/tokens/${c.coin}`).catch(() => null);
    const paidN = toNum(total, main.dec), usdNow = main.price ? paidN * main.price : 0, status = k?.status === 'hidden' ? 'hidden' : usdNow >= MIN_USD ? 'ok' : 'small';   // same bar as the other platforms
    coins.push({ mint: c.coin, chain: 'robinhood', platform: 'Pons', symbol: info?.symbol || k?.symbol || null, name: info?.name || null, icon: info?.icon_url || null,
      price: info?.exchange_rate ? +info.exchange_rate : null, mcap: info?.circulating_market_cap ? +info.circulating_market_cap : null, vol24: info?.volume_24h ? +info.volume_24h : null,
      pay_mint: main.a, pay_symbol: main.sym, pay_dec: main.dec, pay_icon: main.icon || iconFor(main.sym), pay_price: main.price, paid_raw: total.toString(), paid_usd: main.price ? paidN * main.price : null,
      rounds: (k?.rounds || 0) + main.n, last_ts: Math.max(c.last, k?.last_ts || 0), days_from: k?.days_from ?? startDay, src: 'pons', proofs: c.proofs, status, updated: Math.floor(Date.now() / 1000) });
    for (const x of c.days.values()) if (x.a === main.a && x.d >= startDay) days.push([c.coin, x.d, toNum(x.raw, main.dec), x.n, 'add']);
  }
  // high-water mark: the newest transfer's time, plus every transfer at that exact second (several land in one block)
  const topT = items.length ? Date.parse(items[0].timestamp) : null;
  const hw = topT ? { t: topT, h: items.filter(t => Date.parse(t.timestamp) === topT).map(t => t.transaction_hash + ':' + t.log_index) } : S.hw;
  const next = { from: startDay, hw, v: vaults };
  for (let i = 0; i < coins.length; i += 100) { const part = coins.slice(i, i + 100), has = d => part.some(c => c.mint === d[0]); await post(part, days.filter(has)); }
  // 5. history before we started reading the escrow: each holder vault once, everything it got from the escrow up to a fixed moment B
  next.bf = await ponsBackfill(S.bf || {}, vaults, known, coins, hw, startDay).catch(e => { log('Pons history failed, next run continues:', e.message); return S.bf || {}; });
  await post([{ mint: PONS_STATE, chain: 'robinhood', platform: 'Pons', status: 'hidden', cursor: JSON.stringify(next) }]);
  log(`Pons: ${items.length} escrow transfers read, ${per.size} coins paid holders, ${Object.values(vaults).filter(Boolean).length} holder vaults known`);
}

async function main() {
  const st = await site('GET');
  const known = new Map(st.coins.map(c => [c.mint, c]));
  log(`site has ${known.size} coins`);
  const pins = (LIST.pin || []).map(p => ({ ...p, mint: key(p.mint) })), pinned = new Set(pins.map(p => p.mint));
  const want = m => !ONLY.length || ONLY.includes(m);
  const rows = new Map();      // mint -> coin row we will write

  // 1. StonkFun: every coin that paid holders lately, with StonkFun's own lifetime totals
  const sfMs = Date.now();
  const sf = await stonkList(pins.filter(p => p.platform === 'StonkFun').map(p => p.mint));
  for (const r of sf) if (want(r.mint)) rows.set(r.mint, { mint: r.mint, chain: 'solana', platform: 'StonkFun', pay_mint: r.asset.mint, pay_symbol: r.asset.symbol, pay_dec: r.asset.decimals,
    paid_raw: r.distributedRaw, payouts: r.payoutCount ?? null, wallets: r.walletsPaid ?? null, last_ts: r.lastPayoutAt ? Math.floor(Date.parse(r.lastPayoutAt) / 1000) : null, src: 'stonk', _usdAt: r.distributedUsdAtPayout ?? null, _usdPart: !!r.distributedUsdAtPayoutPartial });
  log(`StonkFun: ${sf.length} coins`);

  // 2. pump.fun: coins paying right now, pinned ones, and the ones we already count
  // NO_PUMP=1: skip pump.fun, it is the only part that spends Helius credits (StonkFun is free)
  const HS = '_helius', hst = (() => { try { return JSON.parse(known.get(HS)?.cursor || '{}') || {}; } catch { return {}; } })();
  if (hst.d === today()) H.used = hst.n || 0;
  const pumpDue = PUMP_EVERY_H <= 0 || !hst.pump || Date.now() / 1000 - hst.pump >= PUMP_EVERY_H * 3600 - 300;
  const saveH = async (pumpRan) => { await post([{ mint: HS, chain: 'solana', platform: 'pump.fun', status: 'hidden', cursor: JSON.stringify({ d: today(), n: H.used, pump: pumpRan ? Math.floor(Date.now() / 1000) : hst.pump || 0 }) }]).catch(() => {}); };
  log(`helius: ${H.used}/${HELIUS_DAY} calls used today, pump.fun ${process.env.NO_PUMP ? 'off (NO_PUMP)' : pumpDue ? 'runs this time' : `waits (every ${PUMP_EVERY_H}h)`}`);
  const NO_PUMP = !!process.env.NO_PUMP || !pumpDue || H.used >= HELIUS_DAY;
  // the day's budget is spread over the pump.fun runs still to come today (UTC), so coins stay fresh all day
  // instead of the morning runs using it all up; a coin cut off mid-way goes on from its saved point next run
  if (!NO_PUMP && PUMP_EVERY_H > 0) {
    const runsLeft = Math.max(1, Math.ceil((DAY - Math.floor(Date.now() / 1000) % DAY) / (PUMP_EVERY_H * 3600)));
    H.cap = Math.min(HELIUS_DAY, H.used + Math.max(100, Math.floor((HELIUS_DAY - H.used) / runsLeft)));
    log(`helius: this run may use up to ${H.cap - H.used} calls (${runsLeft} pump.fun runs left today)`);
  }
  const pf = NO_PUMP ? {} : await pumpDiscover().catch(e => (log('pump discover failed', e.message), {}));
  const pfAll = pf;
  const pumpMints = NO_PUMP ? new Set() : new Set([...Object.keys(pf), ...pins.filter(p => p.platform === 'pump.fun').map(p => p.mint), ...[...known.values()].filter(c => c.platform === 'pump.fun' && c.status === 'ok').map(c => c.mint)]);
  log(`pump.fun: ${Object.keys(pf).length} coins paying in the last minutes, ${pumpMints.size} to look at`);

  // 3. Flap: dividend contracts of busy BNB coins
  // Flap is off until its numbers check out: the contracts' totals did not move for hours while the coins traded
  if (!LIST.flap) { const off = [...known.values()].filter(c => c.platform === 'Flap' && c.status === 'ok').map(c => ({ mint: c.mint, status: 'hidden' })); if (off.length) await post(off); }
  const fl = LIST.flap ? await flapDiscover().catch(() => []) : [];
  const flapMints = LIST.flap ? new Set([...fl, ...pins.filter(p => p.platform === 'Flap').map(p => p.mint), ...[...known.values()].filter(c => c.platform === 'Flap' && c.status === 'ok').map(c => c.mint)]) : new Set();
  for (const m of flapMints) {
    if (!want(m)) continue;
    const f = await flapRead(m).catch(() => null); if (!f || f.total === 0n) continue;
    const k = known.get(m), day = today(), out = { mint: m, chain: 'bsc', platform: 'Flap', pay_mint: f.reward, pay_symbol: f.sym, pay_dec: f.dec, paid_raw: f.total.toString(), vault: f.tracker, src: 'flap', proofs: [{ a: f.tracker }], last_ts: null };
    // the contract only knows its total: the change since our last look is that day's payout
    if (k?.paid_raw && k.days_from != null) { const d = f.total - BigInt(k.paid_raw); if (d > 0n) out._day = [m, day, toNum(d, f.dec), 0, 'add']; if (d > 0n) out.last_ts = Math.floor(Date.now() / 1000); else out.last_ts = k.last_ts; }
    else out.days_from = day + 1;
    rows.set(m, out);
  }
  log(`Flap: ${[...rows.values()].filter(r => r.platform === 'Flap').length} coins with a dividend contract`);

  // 4. market data for everything, and the prices of what they pay in
  const sol = [...new Set([...[...rows.values()].filter(r => r.chain === 'solana').map(r => r.mint), ...pumpMints])];
  const bsc = [...rows.values()].filter(r => r.chain === 'bsc').map(r => r.mint);
  const mk = { ...(await market('solana', sol)), ...(await market('bsc', bsc)) };
  const payS = [...new Set([WSOL, ...[...rows.values()].filter(r => r.chain === 'solana').map(r => r.pay_mint)])], payB = [...new Set([WBNB, ...[...rows.values()].filter(r => r.chain === 'bsc').map(r => r.pay_mint)])];
  const pk = { ...(await market('solana', payS)), ...(await market('bsc', payB)) };
  // what they pay in, its logo and exact ticker (xStocks write NVDAx, not NVDAX): Jupiter's token list, free, one call per token we have no logo for
  // tokens we already have a logo for are not looked up again (this took minutes every run)
  const haveIcon = new Map([...known.values()].filter(c => c.pay_icon && c.pay_mint).map(c => [c.pay_mint, { icon: c.pay_icon, sym: c.pay_symbol }]));
  let jupN = 0;
  for (const m of payS) {
    if (!MAJOR[m] && !pk[m]?.icon && haveIcon.has(m)) { const h = haveIcon.get(m), o = pk[m] || (pk[m] = {}); o.icon = h.icon; if (h.sym) o.jsym = h.sym; }
    if (MAJOR[m] || pk[m]?.icon) continue;
    if (++jupN > 25) continue;   // a few new tokens a run is plenty; tokens Jupiter has no logo for would otherwise be asked again every run
    const t = (await get(`https://lite-api.jup.ag/tokens/v2/search?query=${m}`, 1).catch(() => null) || []).find(x => x.id === m);
    if (t) { const o = pk[m] || (pk[m] = {}); if (t.icon) o.icon = t.icon; if (t.symbol) o.jsym = t.symbol; if (!o.price && t.usdPrice) o.price = t.usdPrice; }
    await sleep(120);
  }
  for (const m of payS) { const o = pk[m]; const sy = o?.jsym || o?.symbol; if (o?.icon && sy) { ICON_BY_SYM[symKey(sy)] ??= o.icon; ICON_BY_SYM[String(sy).toUpperCase()] ??= o.icon; } }
  for (const [m, h] of haveIcon) if (h.sym) { ICON_BY_SYM[symKey(h.sym)] ??= h.icon; ICON_BY_SYM[String(h.sym).toUpperCase()] ??= h.icon; }
  // coins this run doesn't rewrite (quiet ones, pump.fun between its runs) still get their payout token's logo: same token elsewhere, or the same ticker
  { const byMint = new Map([...haveIcon].map(([m, h]) => [m, h.icon])); for (const m of payS) if (pk[m]?.icon) byMint.set(m, pk[m].icon);
    const fix = [...known.values()].filter(c => c.status === 'ok' && !c.pay_icon && c.pay_mint && !rows.has(c.mint)).map(c => ({ mint: c.mint, pay_icon: byMint.get(c.pay_mint) || iconFor(c.pay_symbol) })).filter(x => x.pay_icon);
    if (fix.length) { await post(fix); log(`payout token logos added to ${fix.length} coins`); } }
  // coins DexScreener doesn't list (dead or never traded there) still get a name: from the token's own on-chain metadata, 100 per call
  { const miss = [...rows.values()].filter(r => r.chain === 'solana' && !mk[r.mint]?.symbol && !known.get(r.mint)?.symbol).map(r => r.mint);
    for (let i = 0; i < miss.length; i += 100) {
      const a = await rpc('getAssetBatch', { ids: miss.slice(i, i + 100) }).catch(() => null);
      for (const x of Array.isArray(a) ? a : []) { if (!x?.id) continue; const md = x.content?.metadata || {}; const o = mk[x.id] || (mk[x.id] = {});
        if (!o.symbol && md.symbol) o.symbol = String(md.symbol).trim().slice(0, 20); if (!o.name && md.name) o.name = String(md.name).trim().slice(0, 60);
        if (!o.icon && (x.content?.links?.image || x.content?.files?.[0]?.uri)) o.icon = x.content.links?.image || x.content.files[0].uri; }
    }
    if (miss.length) log(`names from on-chain metadata: ${miss.length} coins`);
  }
  // known coins keep the name they already have when DexScreener drops them
  const meta = (r, m) => Object.assign(r, { symbol: m?.symbol ?? r.symbol ?? known.get(r.mint)?.symbol, name: m?.name ?? r.name, icon: m?.icon ?? r.icon, price: m?.price ?? null, mcap: m?.mcap ?? null, vol24: m?.vol24 ?? null, created: m?.created ?? null });
  const payMeta = r => { const p = pk[key(r.pay_mint)] || {}; Object.assign(r, { pay_price: p.price ?? null, pay_icon: MAJOR[r.pay_mint]?.icon || p.icon || iconFor(p.jsym || r.pay_symbol) || null }); if (MAJOR[r.pay_mint]) r.pay_symbol = MAJOR[r.pay_mint].symbol; else if (p.jsym) r.pay_symbol = p.jsym; };

  // pump coins worth a page: busy ones (or pinned, or already counted)
  for (const m of pumpMints) {
    if (!want(m)) continue;
    const x = mk[m], k = known.get(m);
    if (!pinned.has(m) && k?.status !== 'ok' && !((x?.vol24 || 0) >= 100e3 || (x?.mcap || 0) >= 300e3)) continue;
    rows.set(m, { mint: m, chain: 'solana', platform: 'pump.fun', vault: k?.vault || pf[m]?.vault || null, src: 'pump', pay_mint: WSOL, pay_symbol: 'SOL', pay_dec: 9 });
  }
  const now = Math.floor(Date.now() / 1000), dayRows = [], first = [];
  for (const r of rows.values()) {
    meta(r, mk[r.mint]); payMeta(r);
    r.updated = now;
    if (SKIP.has(r.mint.toLowerCase())) r.status = 'hidden';
    if (r.platform !== 'pump.fun') {
      // dollars as they were at each payout (what holders actually got), as StonkFun counts them. When StonkFun lacks a price for some payouts (partial), the larger of that and today's value
      const paid = toNum(r.paid_raw, r.pay_dec), now$ = r.pay_price ? paid * r.pay_price : null;
      r.paid_usd = r._usdAt != null ? (r._usdPart ? Math.max(r._usdAt, now$ || 0) : r._usdAt) : now$;
      delete r._usdAt; delete r._usdPart;
      if (!r.status) r.status = (r.paid_usd || 0) >= MIN_USD || pinned.has(r.mint) ? 'ok' : 'small';
    }
    if (r._day) dayRows.push(r._day); delete r._day;
  }
  // pump rows only get their totals from counting below; keep what we have until then
  const pumpRows = [...rows.values()].filter(r => r.platform === 'pump.fun');
  // pump rows: what they pay in and its value come from counting below (a coin can pay in a token, not SOL), so known coins keep theirs here
  for (const r of pumpRows) { const k = known.get(r.mint); if (!r.status) r.status = k?.status || 'ok'; if (k?.pay_mint) for (const f of ['pay_mint', 'pay_symbol', 'pay_dec', 'pay_icon', 'pay_price', 'paid_usd']) delete r[f]; }
  for (const r of rows.values()) if (!known.get(r.mint)) first.push(r.mint);
  await post([...rows.values()], dayRows);
  log(`wrote ${rows.size} coins (${first.length} new)`);

  // 4b. Pons (Robinhood Chain), cheap: only the escrow's new transfers
  // a Pons coin first seen as small whose earlier payouts (read later) put it over the bar shows up now
  { const up = [...known.values()].filter(k => k.platform === 'Pons' && k.status === 'small' && (k.paid_usd || 0) >= MIN_USD).map(k => ({ mint: k.mint, status: 'ok' }));
    if (up.length) { await post(up); log(`Pons: ${up.length} coins over the bar after their history was read`); } }
  if (!ONLY.length) await ponsRun(known).catch(e => log('Pons failed, next run tries again:', e.message));
  if (!ONLY.length) await priceRun(st, [...rows.values()]).catch(e => log('prices failed, next run tries again:', e.message));

  // 5. pump.fun: count rounds from the vault, biggest coins first
  let quietUsd = 0; const noMarket = new Set();
  for (const r of NO_PUMP ? [] : pumpRows.sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0))) {
    if (left() < 90e3 || (heliusDown ? (QN === '' || QQ.used >= QN_RUN) : H.used >= H.cap)) break;
    try { await pumpOne(r); } catch (e) { log('  pump', r.symbol, 'failed, next run continues from its last saved point:', e.message); }
  }
  if (quietUsd) log(`pump.fun: ${quietUsd} quiet coins valued at payout-day SOL price`);
  // one coin may use at most PER_COIN calls a run: a coin with tens of thousands of payouts a day catches up over a few runs
  // instead of eating the whole run while every other coin waits
  const PER_COIN = +(process.env.PER_COIN || 120);
  async function pumpOne(r) {
    const c0 = H.run;
    if (r.status === 'hidden' || r.status === 'feeshare') return;
    const k = known.get(r.mint) || {};
    // caught up and no payout for a week: its total won't move, leave it (it comes back as soon as it pays again: pumpDiscover sees it)
    { let cu = {}; try { cu = JSON.parse(k.cursor || '{}') || {}; } catch {} if (cu.done && k.last_ts && Date.now() / 1000 - k.last_ts > 7 * DAY && !(r.mint in pfAll)) {
      // a quiet SOL coin counted before dollars-at-payout existed: value it once from its saved days (no Helius calls)
      if ((cu.asset || WSOL) === WSOL && cu.usdAt == null) { const h = await solHist(); const dd = h.size ? await site('GET', undefined, `?days=${r.mint}`).catch(() => null) : null;
        if (dd?.days) { cu.usdAt = dd.days.reduce((a, x) => a + (x.v || 0) * solAt(h, x.d, pk[WSOL]?.price || 0), 0); await post([{ mint: r.mint, cursor: JSON.stringify(cu), paid_usd: cu.usdAt }]); quietUsd++; } }
      return; } }
    if (!r.vault) r.vault = await pumpVault(r.mint).catch(() => null);
    if (!r.vault) { await post([{ mint: r.mint, status: 'novault' }]); log('  pump', r.symbol, 'no rewards vault found'); return; }
    const fresh = !k.cursor || k.vault !== r.vault;
    let c = { ...k, mint: r.mint, vault: r.vault, days_from: fresh ? null : k.days_from, cursor: fresh ? null : k.cursor, paid_raw: fresh ? '0' : k.paid_raw, rounds: fresh ? 0 : k.rounds, payouts: fresh ? 0 : k.payouts, first_ts: fresh ? null : k.first_ts, last_ts: fresh ? null : k.last_ts };
    let resetDone = !fresh;
    // dollars at payout for SOL payouts: the running sum lives in the cursor; a coin counted before this existed is valued once from its saved days
    let usdAt = null;
    { let cu = {}; try { cu = JSON.parse(c.cursor || '{}') || {}; } catch {}
      if ((cu.asset || WSOL) === WSOL) { const h = await solHist(); if (h.size) {
        if (cu.usdAt != null && !fresh) usdAt = cu.usdAt;
        else if (fresh || !c.cursor) usdAt = 0;
        else { const dd = await site('GET', undefined, `?days=${r.mint}`).catch(() => null); if (dd?.days) usdAt = dd.days.reduce((a, x) => a + (x.v || 0) * solAt(h, x.d, pk[WSOL]?.price || 0), 0); }
      } } }
    for (let step = 0; step < 40 && left() > 90e3 && H.run - c0 < PER_COIN; step++) {
      const x = await pumpCount(c, 25);
      const days = [...x.days].map(([d, v]) => [r.mint, d, v.v, v.n, 'add']);
      const paidN = toNum(x.paid, x.cursor.dec ?? 9);
      const upd = { mint: r.mint, vault: r.vault, cursor: JSON.stringify(x.cursor), paid_raw: x.paid.toString(), rounds: x.rounds, payouts: x.payouts, first_ts: x.first, last_ts: x.last,
        proofs: x.proofs.length ? x.proofs.map(s => ({ s })) : undefined, paid_usd: paidN * (r.pay_price || 0), status: x.feeShare ? 'feeshare' : (r.status === 'hidden' ? 'hidden' : 'ok') };
      const a = x.cursor.asset || WSOL;
      if (a !== WSOL && a !== r.mint && !pk[a] && !noMarket.has(a)) { const m = await market('solana', [a], 2); Object.assign(pk, m); if (!m[a]) noMarket.add(a); }   // asked once a run, not once per coin
      const am = a === WSOL ? { symbol: 'SOL', icon: MAJOR[WSOL].icon, price: pk[WSOL]?.price } : a === r.mint ? { symbol: r.symbol, icon: r.icon, price: r.price } : pk[a] || {};
      Object.assign(upd, { pay_mint: a, pay_dec: x.cursor.dec ?? 9, pay_symbol: am.symbol || null, pay_icon: am.icon || null, pay_price: am.price || null, paid_usd: paidN * (am.price || 0) });
      if (a === WSOL && usdAt != null) { const h = await solHist(); for (const [d, y] of x.days) usdAt += y.v * solAt(h, d, am.price || 0); x.cursor.usdAt = usdAt; upd.cursor = JSON.stringify(x.cursor); upd.paid_usd = usdAt; }
      if (c.days_from == null && x.first) upd.days_from = c.days_from = Math.floor(x.first / DAY);
      await post([upd], days, resetDone ? [] : [r.mint], { mint: r.mint, cursor: resetDone ? c.cursor : (k.cursor ?? null) }, x.recent.map(([t, v, n]) => [r.mint, t, v, n])); resetDone = true;
      c = { ...c, cursor: upd.cursor, paid_raw: upd.paid_raw, rounds: x.rounds, payouts: x.payouts, first_ts: x.first, last_ts: x.last };
      if (x.feeShare || x.done) { log(`  pump $${r.symbol} ${paidN.toFixed(2)} ${x.cursor.asset === WSOL ? 'SOL' : 'tokens'}, ${x.rounds} rounds${x.feeShare ? ', fee sharing: hidden' : ''}`); break; }
      log(`  pump $${r.symbol} catching up: ${paidN.toFixed(2)} so far, ${x.rounds} rounds, up to ${new Date(x.last * 1000).toISOString().slice(0, 16)}`);
    }
  }

  // 6. StonkFun days. Walking whole ledgers is too slow (big coins have millions of payouts), so:
  //    first time, the last 7 days from the ledger (newest back); after that, the change in StonkFun's own lifetime total between runs.
  const sfRows = [...rows.values()].filter(r => r.platform === 'StonkFun' && r.status === 'ok').sort((a, b) => (b.paid_usd || 0) - (a.paid_usd || 0));
  const snap = [], snapDays = [], snapRounds = [], curNow = new Map();   // curNow: the cursor each coin has on the site after this run's writes
  for (const r of sfRows) {
    let cur = {}; try { cur = JSON.parse(known.get(r.mint)?.cursor || '{}') || {}; } catch {}
    if (cur.m !== 'snap') continue;
    const d = BigInt(r.paid_raw) - BigInt(cur.raw || '0'), n = Math.max(0, (r.payouts || 0) - (cur.n || 0));
    if (d > 0n) { snapDays.push([r.mint, today(), toNum(d, r.pay_dec), n, 'add']); snapRounds.push([r.mint, r.last_ts || Math.floor(Date.now() / 1000), toNum(d, r.pay_dec), n]); }
    if (d !== 0n || n) { const str = JSON.stringify({ m: 'snap', raw: r.paid_raw, n: r.payouts || 0, ...(cur.bf ? { bf: cur.bf } : {}) }); snap.push({ mint: r.mint, cursor: str }); curNow.set(r.mint, str); }
  }
  for (let i = 0; i < snap.length; i += 200) { const part = snap.slice(i, i + 200), has = x => part.some(c => c.mint === x[0]); await post(part, snapDays.filter(has), [], undefined, snapRounds.filter(has)); }
  if (snap.length) log(`StonkFun: ${snap.length} coins paid since last run`);
  for (const r of sfRows) {
    if (left() < 90e3) break;
    let cur = {}; try { cur = JSON.parse(known.get(r.mint)?.cursor || '{}') || {}; } catch {}
    if (cur.m === 'snap') continue;
    try { await stonkWeek(r); } catch (e) { log('  stonk', r.symbol, 'failed, next run tries again:', e.message); }
  }
  async function stonkWeek(r) {
    const since = (today() - 6) * DAY * 1000, days = new Map(), proofs = [];
    let cc = '', pages = 0, oldest = sfMs, end = false, capped = false;
    for (;;) {
      if (pages >= 400 || left() < 60e3) { capped = true; break; }
      const j = await get(`${SF}/api/v2/tokens/${r.mint}/rewards/payouts?limit=100${cc ? '&cursor=' + encodeURIComponent(cc) : ''}`); pages++;
      let stop = false;
      for (const x of j?.rows || []) {
        const t = Date.parse(x.createdAt); if (t > sfMs) continue;      // newer than the total we saved: the next run's change covers it
        if (t < since) { stop = true; break; }
        oldest = t;
        if (x.assetMint !== r.pay_mint) continue;
        const d = Math.floor(t / 1000 / DAY), y = days.get(d) || { v: 0, n: 0 }; y.v += toNum(x.amountRaw, r.pay_dec); y.n++; days.set(d, y);
        if (proofs.length < 3) proofs.push(x.signature);
      }
      cc = j?.page?.nextCursor; if (stop || !cc) { end = true; break; }
    }
    // a capped read leaves its oldest day half counted: drop it
    const from = capped ? Math.floor(oldest / 1000 / DAY) + 1 : Math.max(today() - 6, Math.floor(oldest / 1000 / DAY));
    const out = [...days].filter(([d]) => d >= from).map(([d, v]) => [r.mint, d, v.v, v.n, 'add']);
    await post([{ mint: r.mint, days_from: from, cursor: JSON.stringify({ m: 'snap', raw: r.paid_raw, n: r.payouts || 0 }), ...(proofs.length ? { proofs: proofs.map(s => ({ s })) } : {}) }], out, [r.mint]);
    log(`  stonk $${r.symbol} last ${today() - from + 1} days read (${pages} pages)`);
  }

  // 7. StonkFun history before days_from, oldest first, a little every run (BF_MIN minutes): small coins first so most pages fill in fast.
  //    Each request saves its days together with the moved cursor, so nothing counts twice. When it reaches days_from, days_from moves back to the coin's first day.
  const bfEnd = Date.now() + (+process.env.BF_MIN || 10) * 60e3;
  const todo = sfRows.map(r => { let cur = {}; try { cur = JSON.parse(curNow.get(r.mint) ?? known.get(r.mint)?.cursor ?? '{}') || {}; } catch {} return { r, cur, df: known.get(r.mint)?.days_from }; })
    .filter(x => x.cur.m === 'snap' && !x.cur.bf?.done && x.df != null && r0(x.r) < x.df - 1).sort((a, b) => (a.r.payouts || 0) - (b.r.payouts || 0));
  function r0(r) { return r.first_ts ? Math.floor(r.first_ts / DAY) : 0; }
  let bfPages = 0, bfDone = 0;
  for (const x of todo) {
    if (Date.now() > bfEnd || left() < 90e3) break;
    try {
    const r = x.r, until = x.df * DAY * 1000;
    let cur = x.cur, str = curNow.get(r.mint) ?? known.get(r.mint)?.cursor ?? null, bf = { ...(cur.bf || {}) }, pages = 0, done = false;
    while (!done && Date.now() < bfEnd && left() > 90e3) {
      const days = new Map();
      for (let k = 0; k < 20 && !done; k++) {
        const j = await get(`${SF}/api/v2/tokens/${r.mint}/rewards/payouts?limit=100&order=asc${bf.c ? '&cursor=' + encodeURIComponent(bf.c) : ''}`); pages++;
        const rows = j?.rows || [];
        for (const y of rows) {
          const t = Date.parse(y.createdAt); if (t >= until) { done = true; break; }
          if (y.assetMint !== r.pay_mint) continue;
          const d = Math.floor(t / 1000 / DAY), z = days.get(d) || { v: 0, n: 0 }; z.v += toNum(y.amountRaw, r.pay_dec); z.n++; days.set(d, z);
          bf.first = bf.first == null ? d : Math.min(bf.first, d);
        }
        if (!done) { bf.c = j?.page?.nextCursor; if (!bf.c || !rows.length) done = true; }
      }
      const firstDay = bf.first;
      if (done) bf = { done: 1 };
      const next = JSON.stringify({ ...cur, bf });
      const res = await site('POST', { coins: [{ mint: r.mint, cursor: next, ...(done ? { days_from: Math.min(firstDay ?? x.df, x.df) } : {}) }],
        days: [...days].map(([d, v]) => [r.mint, d, v.v, v.n, 'add']), reset: [], expect: { mint: r.mint, cursor: str } });
      if (res?.skipped) { log('  history', r.symbol, 'cursor moved, next run'); break; }
      str = next; cur = { ...cur, bf };
    }
    bfPages += pages; if (done) bfDone++;
    log(`  history $${r.symbol} ${done ? 'complete' : 'in progress'} (${pages} pages)`);
    } catch (e) { log('  history', x.r.symbol, 'stopped:', e.message, '(saved, next run continues)'); break; }
  }
  if (todo.length) log(`StonkFun history: ${bfDone} coins completed, ${todo.length - bfDone} left, ${bfPages} pages this run`);
  await saveH(!NO_PUMP);
  log(`helius: ${H.run} calls this run (${Object.entries(H.by).map(([m, n]) => m + ' ' + n).join(', ') || 'none'}), ${H.used}/${HELIUS_DAY} today${QQ.used ? ', of them ' + QQ.used + ' via QuickNode' : ''}`);
  log('done in', Math.round((Date.now() - T0) / 1000), 's');
}
main().catch(e => { console.error(e); process.exit(1); });
