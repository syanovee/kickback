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
      if (r.status !== 429 && r.status < 500) throw new Error(r.status + ' ' + url);
    } catch (e) { if (i === tries - 1) throw e; }
    await sleep(Math.min(20e3, 1000 * 2 ** i));
  }
}
async function rpc(method, params) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch('https://mainnet.helius-rpc.com/?api-key=' + HELIUS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
      if (r.status === 429 || r.status >= 500) { await sleep(800 * 2 ** i); continue; }
      const j = await r.json(); if (j.error) throw new Error(method + ': ' + j.error.message); return j.result;
    } catch (e) { if (i === 5) throw e; await sleep(800 * 2 ** i); }
  }
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

async function site(method, body) {
  let last = '';
  for (let i = 0; i < 20; i++) {   // a Mac on wifi can drop out for a few minutes: keep trying for ~8 min
    const r = await fetch(SITE + '/api/coins/ingest', { method, headers: { authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) }).catch(e => (last = e.message + (e.cause ? ' [' + (e.cause.code || '') + ' ' + (e.cause.message || '') + ']' : ''), null));
    if (r?.ok) return r.json();
    if (r) { last = r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200); if (r.status < 500) throw new Error('site ' + last); }
    log('  site busy (' + last + '), retrying'); await sleep(Math.min(30000, 3000 * (i + 1)));
  }
  throw new Error('site unreachable: ' + last);
}
// a coin's new days and its moved cursor always go out in the same request
async function post(coins, days = [], reset = [], expect, rounds = []) {
  const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  for (let i = 0; i < Math.max(coins.length, 1); i += 300) {
    const cs = coins.slice(i, i + 300).map(clean);
    await site('POST', { coins: cs, days: i ? [] : days, reset: i ? [] : reset, ...(rounds.length && !i ? { rounds } : {}), ...(expect && !i ? { expect } : {}) });
  }
}
const toNum = (raw, dec) => { const b = BigInt(raw), d = 10n ** BigInt(dec); return Number(b / d) + Number(b % d) / Number(d); };

// ---- market data (DexScreener): price, market cap, 24h volume, icon, name
async function market(chain, mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const j = await get(`https://api.dexscreener.com/tokens/v1/${chain}/${mints.slice(i, i + 30).join(',')}`).catch(() => null);
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
  const found = {}; let tk;
  for (let p = 0; p < 10; p++) {
    const o = { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, limit: 100, sortOrder: 'desc' }; if (tk) o.paginationToken = tk;
    const r = await rpc('getTransactionsForAddress', [PUMP_SIGNER, o]).catch(e => (log('  pump discover page failed', e.message), null));
    for (const t of r?.data || []) { if (!isDist(t)) continue; const v = vaultOf(t); if (v?.coin && v.vault) (found[v.coin] = found[v.coin] || { vault: v.vault, n: 0 }).n++; }
    tk = r?.paginationToken; if (!tk) break;
  }
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
      if (t.blockTime > Date.now() / 1000 - 14 * DAY) { recent.push([t.blockTime, toNum(out, dec), n]); if (recent.length > 6) recent.shift(); }
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
    paid_raw: r.distributedRaw, payouts: r.payoutCount ?? null, wallets: r.walletsPaid ?? null, last_ts: r.lastPayoutAt ? Math.floor(Date.parse(r.lastPayoutAt) / 1000) : null, src: 'stonk' });
  log(`StonkFun: ${sf.length} coins`);

  // 2. pump.fun: coins paying right now, pinned ones, and the ones we already count
  // NO_PUMP=1: skip pump.fun, it is the only part that spends Helius credits (StonkFun is free)
  const NO_PUMP = !!process.env.NO_PUMP;
  const pf = NO_PUMP ? {} : await pumpDiscover().catch(e => (log('pump discover failed', e.message), {}));
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
  const meta = (r, m) => Object.assign(r, { symbol: m?.symbol ?? r.symbol, name: m?.name ?? r.name, icon: m?.icon ?? r.icon, price: m?.price ?? null, mcap: m?.mcap ?? null, vol24: m?.vol24 ?? null, created: m?.created ?? null });
  const payMeta = r => { const p = pk[key(r.pay_mint)] || {}; Object.assign(r, { pay_price: p.price ?? null, pay_icon: MAJOR[r.pay_mint]?.icon || p.icon || null }); if (MAJOR[r.pay_mint]) r.pay_symbol = MAJOR[r.pay_mint].symbol; };

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
      const paid = toNum(r.paid_raw, r.pay_dec); r.paid_usd = r.pay_price ? paid * r.pay_price : null;
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

  // 5. pump.fun: count rounds from the vault, biggest coins first
  for (const r of NO_PUMP ? [] : pumpRows.sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0))) {
    if (left() < 90e3) break;
    try { await pumpOne(r); } catch (e) { log('  pump', r.symbol, 'failed, next run continues from its last saved point:', e.message); }
  }
  async function pumpOne(r) {
    if (r.status === 'hidden' || r.status === 'feeshare') return;
    const k = known.get(r.mint) || {};
    if (!r.vault) r.vault = await pumpVault(r.mint).catch(() => null);
    if (!r.vault) { await post([{ mint: r.mint, status: 'novault' }]); log('  pump', r.symbol, 'no rewards vault found'); return; }
    const fresh = !k.cursor || k.vault !== r.vault;
    let c = { ...k, mint: r.mint, vault: r.vault, days_from: fresh ? null : k.days_from, cursor: fresh ? null : k.cursor, paid_raw: fresh ? '0' : k.paid_raw, rounds: fresh ? 0 : k.rounds, payouts: fresh ? 0 : k.payouts, first_ts: fresh ? null : k.first_ts, last_ts: fresh ? null : k.last_ts };
    let resetDone = !fresh;
    for (let step = 0; step < 40 && left() > 90e3; step++) {
      const x = await pumpCount(c, 25);
      const days = [...x.days].map(([d, v]) => [r.mint, d, v.v, v.n, 'add']);
      const paidN = toNum(x.paid, x.cursor.dec ?? 9);
      const upd = { mint: r.mint, vault: r.vault, cursor: JSON.stringify(x.cursor), paid_raw: x.paid.toString(), rounds: x.rounds, payouts: x.payouts, first_ts: x.first, last_ts: x.last,
        proofs: x.proofs.length ? x.proofs.map(s => ({ s })) : undefined, paid_usd: paidN * (r.pay_price || 0), status: x.feeShare ? 'feeshare' : (r.status === 'hidden' ? 'hidden' : 'ok') };
      const a = x.cursor.asset || WSOL;
      if (a !== WSOL && a !== r.mint && !pk[a]) Object.assign(pk, await market('solana', [a]));
      const am = a === WSOL ? { symbol: 'SOL', icon: MAJOR[WSOL].icon, price: pk[WSOL]?.price } : a === r.mint ? { symbol: r.symbol, icon: r.icon, price: r.price } : pk[a] || {};
      Object.assign(upd, { pay_mint: a, pay_dec: x.cursor.dec ?? 9, pay_symbol: am.symbol || null, pay_icon: am.icon || null, pay_price: am.price || null, paid_usd: paidN * (am.price || 0) });
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
  log('done in', Math.round((Date.now() - T0) / 1000), 's');
}
main().catch(e => { console.error(e); process.exit(1); });
