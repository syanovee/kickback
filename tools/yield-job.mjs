// Kickback bag calculator: measures what holding a coin really pays, from on-chain payouts.
// Runs every hour on GitHub Actions (.github/workflows/yield.yml). Can also run by hand:
//   SITE=https://kickback-test.pages.dev YIELD_KEY=... HELIUS_KEY=... node tools/yield-job.mjs
//
// How a coin is measured (StonkFun for now):
// 1. StonkFun keeps a running total of what each coin paid. We read it every hour and keep the difference per hour,
//    so after a week we have the exact 7 days. Until then the last day of the payout ledger stands in, scaled to a week.
// 2. Payouts are split by balance, so every holder gets the same amount per token.
//    We take wallets that were paid in every round of the last day, read their balance on-chain,
//    and divide: reward per token. The median over those wallets is the number, and they are the proof.
// 3. Reward per token x what the coin paid this week / what it paid in that window = reward per token per week.
const SITE = (process.env.SITE || 'https://getkickback.fun').replace(/\/$/, '');
const KEY = process.env.YIELD_KEY, HELIUS = process.env.HELIUS_KEY, ALCHEMY = process.env.ALCHEMY_KEY;
import { seedEngine } from './yield-seeds.mjs';
const BUDGET = (+process.env.MAX_MIN || 45) * 60e3, T0 = Date.now();
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const SF = 'https://www.stonkfun.xyz';
const H = 3600e3, NOW = Date.now(), NOW_H = Math.floor(NOW / H), WEEK_MS = 7 * 24 * H;
if (!KEY || !HELIUS) { console.error('YIELD_KEY and HELIUS_KEY are needed'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const left = () => BUDGET - (Date.now() - T0);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function get(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      if (r.status !== 429 && r.status < 500) throw new Error(r.status + ' ' + url);
    } catch (e) { if (i === tries - 1) throw e; }
    await sleep(Math.min(20e3, 1000 * 2 ** i));
  }
  throw new Error('gave up ' + url);
}
async function rpc(method, params) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch('https://mainnet.helius-rpc.com/?api-key=' + HELIUS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) { await sleep(800 * 2 ** i); continue; }
      const j = await r.json(); if (j.error) throw new Error(method + ': ' + j.error.message); return j.result;
    } catch (e) { if (i === 5) throw e; await sleep(800 * 2 ** i); }
  }
}
async function site(method, body) {
  const r = await fetch(SITE + '/api/yield/ingest', { method, headers: { authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error('site ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
const abs = u => !u ? null : u.startsWith('/') ? SF + u : u;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : 0; };

// writes go out in small pieces, so a run that times out still keeps what it did
let out = { coins: [], hours: [], stats: [], prices: [] };
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
async function flush(prune = false) {
  if (!out.coins.length && !out.hours.length && !out.stats.length && !out.prices.length && !(out.seeds || []).length && !prune) return;
  const b = out; out = { coins: [], hours: [], stats: [], prices: [] };
  for (let i = 0; i < Math.max(1, b.hours.length, b.prices.length); i += 3000)
    await site('POST', { coins: i ? [] : b.coins.map(clean), stats: i ? [] : b.stats.map(clean), seeds: i ? [] : (b.seeds || []), hours: b.hours.slice(i, i + 3000), prices: b.prices.slice(i, i + 3000), prune: prune && i === 0 });
}

// the payout ledger of one coin, newest first, until `untilMs`; rows newer than `newestMs` are skipped
async function ledger(mint, quoteMint, untilMs, newestMs, maxPages) {
  const rows = []; let cursor = '', pages = 0, oldest = newestMs, end = false;
  while (pages < maxPages) {
    const j = await get(`${SF}/api/v2/tokens/${mint}/rewards/payouts?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    pages++;
    let stop = false;
    for (const r of j?.rows || []) {
      const t = Date.parse(r.createdAt); if (t > newestMs) continue;
      if (t < untilMs) { stop = true; break; }
      oldest = t; if (r.assetMint === quoteMint) rows.push({ sig: r.signature, w: r.holder, raw: BigInt(r.amountRaw), t });
    }
    cursor = j?.page?.nextCursor;
    if (stop) break;
    if (!cursor) { end = true; break; }
  }
  return { rows, oldest, pages, complete: end || oldest <= untilMs || rows.length === 0 || pages < maxPages, end };
}

async function backfill(r, listMs) {
  const qm = r.asset.mint, l = await ledger(r.mint, qm, NOW - WEEK_MS, listMs, 1500);
  const byH = new Map();
  for (const x of l.rows) { const h = Math.floor(x.t / H); byH.set(h, (byH.get(h) || 0n) + x.raw); }
  // since_h: first hour fully covered. A capped read drops its partial oldest hour.
  let since = NOW_H - 167;
  if (l.end && l.rows.length) since = Math.max(since, Math.floor(l.rows[l.rows.length - 1].t / H));
  else if (!l.complete) since = Math.floor(l.oldest / H) + 1;
  for (const [h, v] of byH) if (h >= since) out.hours.push([r.mint, h, v.toString(), 'set']);
  return { rows: l.rows, since, pages: l.pages };
}

async function holdersOf(mint) {
  const big = (await rpc('getTokenLargestAccounts', [mint]))?.value || [];
  if (!big.length) return new Map();
  const acc = (await rpc('getMultipleAccounts', [big.map(b => b.address), { encoding: 'jsonParsed' }]))?.value || [];
  const m = new Map();
  acc.forEach((a, i) => { const o = a?.data?.parsed?.info?.owner; if (o) m.set(o, (m.get(o) || 0) + (+big[i].uiAmount || 0)); });
  return m;
}
async function balanceOf(owner, mint) {
  const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
  return (r?.value || []).reduce((s, a) => s + (+a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
}

const MIN_MCAP = +process.env.MIN_MCAP || 30000;
async function measure(r, rows0, listMs, searched) {
  const meta = (await get(`${SF}/api/public/v1/tokens/${r.mint}`))?.data?.token;
  if (!searched && (meta?.market?.marketCapUsd || 0) < MIN_MCAP) return { meta, note: 'market cap under $30K, measured when someone looks it up' };
  const qm = r.asset.mint, dec = r.asset.decimals;
  // a day of payouts; a slow coin gets up to a week, so the window has a few rounds in it
  const sigs = a => new Set(a.map(x => x.sig)).size;
  let all = rows0 || (await ledger(r.mint, qm, NOW - 24 * H, listMs, 250)).rows;
  let rows = all.filter(x => x.t >= NOW - 24 * H);
  if (sigs(rows) < 3) { if (!rows0) all = (await ledger(r.mint, qm, NOW - WEEK_MS, listMs, 400)).rows; rows = all; }
  if (!rows.length) return { note: 'no payouts in the last 7 days' };
  // drop the oldest tx: the page may have cut it in half
  const oldSig = rows[rows.length - 1].sig; rows = rows.filter(x => x.sig !== oldSig);
  if (!rows.length) return { note: 'too few payouts to measure' };
  const winStart = rows[rows.length - 1].t, winH = (listMs - winStart) / H;
  const fr = new Set(((await get(`${SF}/api/v2/tokens/${r.mint}/rewards/fee-recipients?limit=100`).catch(() => null))?.rows || []).map(x => x.holder || x.recipient || x.wallet).filter(Boolean));
  let total = 0n; const per = new Map();
  for (const x of rows) { total += x.raw; if (fr.has(x.w)) continue; const p = per.get(x.w) || { raw: 0n, sigs: new Set(), last: null }; p.raw += x.raw; p.sigs.add(x.sig); if (!p.last) p.last = { sig: x.sig, t: x.t }; per.set(x.w, p); }
  const rounds = Math.max(...[...per.values()].map(p => p.sigs.size));
  const steady = new Map([...per].filter(([, p]) => p.sigs.size >= Math.max(1, Math.ceil(rounds * 0.8))));
  // balances: the biggest holders in two calls, then one call per wallet if that is not enough
  const big = await holdersOf(r.mint);
  const samples = [];
  for (const [w, bal] of big) { const p = steady.get(w); if (p && bal > 0) samples.push({ w, bal, p }); }
  if (samples.length < 8) {
    const more = [...steady].filter(([w]) => !big.has(w)).sort((a, b) => (b[1].raw > a[1].raw ? 1 : -1)).slice(0, 20 - samples.length);
    for (const [w, p] of more) { const bal = await balanceOf(w, r.mint).catch(() => 0); if (bal > 0) samples.push({ w, bal, p }); }
  }
  if (samples.length < 3) return { note: 'not enough steady holders to measure' };
  const div = 10 ** dec;
  for (const s of samples) s.rate = Number(s.p.raw) / div / s.bal;
  const rate = median(samples.map(s => s.rate));
  const elig = Number(total) / div / rate;
  const proofs = samples.sort((a, b) => b.bal - a.bal).slice(0, 5).map(s => ({ w: s.w, bal: s.bal, got: Number(s.p.raw) / div, n: s.p.sigs.size, sig: s.p.last.sig, t: Math.floor(s.p.last.t / 1000) }));
  return { meta, stat: { mint: r.mint, ts: Math.floor(Date.now() / 1000), rate, win_h: +winH.toFixed(2), win_raw: total.toString(), elig, n: samples.length,
    lo: q(samples.map(s => s.rate), 0.25), hi: q(samples.map(s => s.rate), 0.75), proofs, note: '' } };
}

async function prices(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 50) {
    const j = await get('https://lite-api.jup.ag/price/v3?ids=' + mints.slice(i, i + 50).join(',')).catch(() => null);
    for (const [m, v] of Object.entries(j || {})) if (+v?.usdPrice > 0) out[m] = +v.usdPrice;
  }
  return out;
}
let geckoAt = 0;
async function price7dAgo(pool, mint, now) {
  if (!pool) return null;
  const wait = geckoAt + 2200 - Date.now(); if (wait > 0) await sleep(wait); geckoAt = Date.now();
  const j = await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=200&currency=usd&token=${mint}`).catch(() => null);
  const list = j?.data?.attributes?.ohlcv_list || [], target = (NOW - WEEK_MS) / 1000;
  let best = null; for (const c of list) if (!best || Math.abs(c[0] - target) < Math.abs(best[0] - target)) best = c;
  const p = best && Math.abs(best[0] - target) < 12 * 3600 ? +best[4] : null;
  // a price from the wrong side of the pool would be off by orders of magnitude: drop it
  return p > 0 && (!now || (p / now > 0.02 && p / now < 50)) ? p : null;
}

async function main() {
  const st = await site('GET');
  const known = new Map(st.coins.map(c => [c.mint, c]));
  const measureSeed = seedEngine({ HELIUS, ALCHEMY, log });
  log(`site has ${known.size} coins`);
  // 1. every StonkFun coin that paid holders in the last 8 days, with its running total
  const listMs = Date.now(), active = [];
  let cursor = '';
  for (let p = 0; p < 250; p++) {
    const j = await get(`${SF}/api/v2/rewards/launches?sort=recent&order=desc&limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    let stop = false;
    for (const r of j?.rows || []) { if (Date.parse(r.lastPayoutAt) < NOW - 8 * 24 * H) { stop = true; break; } if (r.asset?.mint && r.distributedRaw) active.push(r); }
    cursor = j?.page?.nextCursor; if (stop || !cursor) break;
  }
  log(`StonkFun: ${active.length} coins paid holders in the last 8 days`);
  const activeSet = new Set(active.map(r => r.mint));
  const MIN_WALLETS = +process.env.MIN_WALLETS || 30;   // coins paying fewer wallets are dust: tracked only if someone searches them
  // 2. top up the hourly totals of coins we already track
  const todo = [];
  for (const r of active) {
    if (ONLY.length && !ONLY.includes(r.mint)) continue;
    const k = known.get(r.mint);
    if (!k && !ONLY.length && (r.walletsPaid || 0) < MIN_WALLETS) continue;
    const base = { mint: r.mint, chain: 'solana', platform: 'StonkFun', quote_mint: r.asset.mint, quote_symbol: r.asset.symbol, quote_dec: r.asset.decimals,
      last_payout: Math.floor(Date.parse(r.lastPayoutAt) / 1000), holders: r.walletsPaid ?? null };
    if (k?.cum && k.since_h != null && k.status === 'ok') {
      const d = BigInt(r.distributedRaw) - BigInt(k.cum);
      if (d > 0n) out.hours.push([r.mint, NOW_H, d.toString(), 'add']);
      // a total that went down means StonkFun rebuilt its ledger: start counting again from here
      out.coins.push({ ...base, cum: r.distributedRaw, cum_ts: Math.floor(listMs / 1000), ...(d < 0n ? { since_h: NOW_H + 1 } : {}) });
      const age = Date.now() / 1000 - (k.stat_ts || 0);
      if (!k.stat_ts || age > 20 * 3600 || (k.searches > 0 && !(k.stat_elig > 0) && age > 3000) || process.env.FORCE) todo.push({ r, base, k });
    } else {
      // first time we see it: remember its running total now, hourly differences start next hour
      out.coins.push({ ...base, status: 'ok', cum: r.distributedRaw, cum_ts: Math.floor(listMs / 1000), since_h: NOW_H + 1 });
      todo.push({ r, base, k });
    }
  }
  // prices every hour for every coin we track, so the calculator and the 7-day price change stay current
  const tracked = active.filter(r => known.get(r.mint)?.status === 'ok');
  const px0 = await prices([...new Set(tracked.flatMap(r => [r.mint, r.asset.mint]))]);
  for (const r of tracked) if (px0[r.mint]) out.prices.push([r.mint, NOW_H, px0[r.mint], px0[r.asset.mint] || null]);
  await flush();
  // coins someone searched for that are not active StonkFun coins
  for (const k of known.values()) if (k.status === 'pending' && !activeSet.has(k.mint)) {
    const t = k.chain === 'solana' ? (await get(`${SF}/api/public/v1/tokens/${k.mint}`).catch(() => null))?.data?.token : null;
    if (t) { out.coins.push({ mint: k.mint, status: t.mode === 'reward' ? 'quiet' : 'no-rewards', symbol: t.symbol ?? null, name: t.name ?? null, platform: 'StonkFun' }); continue; }
    // not StonkFun: look for its distributor on-chain, then measure it like a scanned coin
    let seed = null; try { seed = await measureSeed.discover(k.chain, k.mint); } catch (e) { log('discover failed', k.mint, e.message); }
    if (!seed) { out.coins.push({ mint: k.mint, status: 'unsupported' }); log('  searched', k.mint, 'no holder payouts found'); continue; }
    out.seeds = (out.seeds || []).concat([seed]);
    try {
      const m = await measureSeed(seed);
      log('  searched', seed.chain, seed.platform, k.mint, m.coin ? `$${m.coin.symbol} ${m.stat.n} wallets` : m.note);
      if (m.coin) { out.coins.push({ mint: k.mint, ...m.coin }); out.stats.push({ mint: k.mint, ...m.stat }); }
      else { out.coins.push({ mint: k.mint, chain: seed.chain, platform: seed.platform, status: 'ok' }); out.stats.push({ mint: k.mint, ts: Math.floor(Date.now() / 1000), note: m.note }); }
    } catch (e) { log('  searched', k.mint, 'measure failed', e.message); }
  }
  await flush();
  // 3. every other platform: coins people scanned, measured from their distributor's payouts (tools/yield-seeds.mjs)
  if (ALCHEMY || HELIUS) {
    const byCoin = new Map();
    for (const x of st.seeds || []) { const k = x.chain === 'solana' ? x.coin : x.coin.toLowerCase(); if (!byCoin.has(k) || (x.n || 0) > (byCoin.get(k).n || 0)) byCoin.set(k, { ...x, key: k }); }
    const due = [...byCoin.values()].filter(x => { if (ONLY.length && !ONLY.includes(x.key)) return false; const k = known.get(x.key); return !k?.stat_ts || Date.now() / 1000 - k.stat_ts > 20 * 3600 || (k.searches > 0 && !(k.stat_elig > 0) && Date.now() / 1000 - k.stat_ts > 3000) || process.env.FORCE; })
      .sort((a, b) => (known.get(b.key)?.searches || 0) - (known.get(a.key)?.searches || 0) || (b.n || 0) - (a.n || 0));
    log(`other platforms: ${due.length} of ${byCoin.size} scanned coins to measure`);
    const seedEnd = Date.now() + Math.min(18 * 60e3, left() / 2);
    let si = 0, sd = 0;
    await Promise.all([0, 1, 2].map(async () => { for (let x; Date.now() < seedEnd && (x = due[si++]);) {
      try {
        const m = await measureSeed(x);
        log('  ' + x.chain, x.platform, x.key.slice(0, 8), m.coin ? `$${m.coin.symbol} ${m.stat.n} wallets, per token/wk ${m.stat.per7d.toExponential(3)} ${m.coin.quote_symbol}, $1K/wk ${m.stat.price && m.stat.qprice ? '$' + (1000 / m.stat.price * m.stat.per7d * m.stat.qprice).toFixed(2) : '?'}` : m.note);
        if (m.coin) { out.coins.push({ mint: x.key, ...m.coin }); out.stats.push({ mint: x.key, ...m.stat }); if (m.stat.price) out.prices.push([x.key, NOW_H, m.stat.price, m.stat.qprice || null]); }
        else { out.coins.push({ mint: x.key, chain: x.chain, platform: x.platform, status: known.get(x.key)?.status === 'ok' ? 'ok' : 'ok' });
          if (!(known.get(x.key)?.stat_elig > 0)) out.stats.push({ mint: x.key, ts: Math.floor(Date.now() / 1000), note: m.note }); }
        sd++; if (sd % 10 === 0) { log(`other platforms ${sd}/${due.length}`); await flush(); }
      } catch (e) { log('seed skip', x.chain, x.platform, x.key, e.message); }
    } }));
    await flush();
    log(`other platforms: ${sd} measured`);
  }
  if (process.env.SEEDS_ONLY) { await flush(true); log('done (other platforms only)'); return; }
  // 4. backfill new coins and measure: searched coins first, then the ones paying the most wallets
  todo.sort((a, b) => ((b.k?.searches || 0) - (a.k?.searches || 0)) || ((b.r.walletsPaid || 0) - (a.r.walletsPaid || 0)));
  log(`${todo.length} to measure, ${Math.round(left() / 60e3)} min budget`);
  const measured = [];
  let i = 0, done = 0;
  const worker = async () => {
    for (let x; left() > 4 * 60e3 && (x = todo[i++]);) {
      try {
        const m = await measure(x.r, null, listMs, (x.k?.searches || 0) > 0);
        const t = m.meta;
        out.coins.push({ mint: x.r.mint, status: 'ok',
          ...(t ? { symbol: t.symbol, name: t.name, icon: abs(t.imageUrl), quote_icon: abs(t.quote?.logoUrl), fee_bps: t.transferFee?.bps || 0, pool: t.pool, mcap: t.market?.marketCapUsd ?? null } : {}) });
        if (m.stat) { m.stat.price = t?.market?.priceUsd || null; measured.push({ stat: m.stat, pool: t?.pool, quote: x.r.asset.mint }); }
        else if (!(x.k?.stat_elig > 0)) out.stats.push({ mint: x.r.mint, ts: Math.floor(Date.now() / 1000), note: m.note });   // never replace a good measurement with a failed one
        done++;
        if (done % 10 === 0) { log(`${done}/${todo.length} done`); await flush(); }
      } catch (e) { log('skip', x.r.mint, e.message); }
    }
  };
  await Promise.all([...Array(+process.env.WORKERS || 6)].map(worker));
  // 4. prices: token and reward token now (Jupiter), token a week ago (GeckoTerminal)
  const px = await prices([...new Set(measured.flatMap(m => [m.stat.mint, m.quote]))]);
  for (const m of measured) {
    m.stat.price = px[m.stat.mint] || m.stat.price; m.stat.qprice = px[m.quote] || null;
    if (px[m.stat.mint]) out.prices.push([m.stat.mint, NOW_H, px[m.stat.mint], px[m.quote] || null]);
    m.stat.price7d = left() > 60e3 ? await price7dAgo(m.pool, m.stat.mint, m.stat.price) : null;
    out.stats.push(m.stat);
  }
  await flush(true);
  log(`done: ${done} coins measured or backfilled in ${Math.round((Date.now() - T0) / 60e3)} min`);
}
main().catch(async e => { console.error(e); try { await flush(); } catch {} process.exit(1); });
