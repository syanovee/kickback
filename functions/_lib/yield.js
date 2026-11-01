// Bag calculator storage. The numbers are measured by tools/yield-job.mjs (GitHub Actions) and pushed through /api/yield/ingest.
let ready = false;
export async function yInit(DB) {
  if (ready) return;
  await DB.batch([
    // one row per coin that pays its holders
    DB.prepare(`CREATE TABLE IF NOT EXISTS y_coin (mint TEXT PRIMARY KEY, chain TEXT, platform TEXT, symbol TEXT, name TEXT, icon TEXT,
      quote_mint TEXT, quote_symbol TEXT, quote_dec INTEGER, quote_icon TEXT, fee_bps INTEGER, pool TEXT, mcap REAL,
      cum TEXT, cum_ts INTEGER, since_h INTEGER, last_payout INTEGER, holders INTEGER, status TEXT, added INTEGER, searches INTEGER DEFAULT 0)`),
    // what the coin paid out (in its reward token, raw units) in each hour, from the payout ledger
    DB.prepare(`CREATE TABLE IF NOT EXISTS y_hour (mint TEXT, h INTEGER, raw TEXT, PRIMARY KEY (mint, h))`),
    // the latest measurement: reward per held token, from real holders, with proofs
    DB.prepare(`CREATE TABLE IF NOT EXISTS y_stat (mint TEXT PRIMARY KEY, ts INTEGER, rate REAL, win_h REAL, win_raw TEXT, elig REAL,
      n INTEGER, lo REAL, hi REAL, proofs TEXT, price REAL, qprice REAL, price7d REAL, note TEXT)`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS y_coin_sym ON y_coin (symbol)`),
    // hourly prices (token and its reward token), for "now" and for the 7-day change
    DB.prepare(`CREATE TABLE IF NOT EXISTS y_price (mint TEXT, h INTEGER, price REAL, qprice REAL, PRIMARY KEY (mint, h))`),
  ]);
  ready = true;
}
const big = s => { try { return BigInt(s || '0'); } catch { return 0n; } };
// everything the page needs for one coin, computed from the stored rows
export function yView(c, s, hours, nowH, px = []) {
  if (!c) return null;
  s = s && { ...s };
  const dec = c.quote_dec ?? 0, div = 10 ** dec;
  let r7 = 0n, r24 = 0n; const days = Array(7).fill(0n);
  for (const x of hours) { const age = nowH - x.h; if (age < 0 || age >= 168) continue; const v = big(x.raw); r7 += v; if (age < 24) r24 += v; days[6 - Math.floor(age / 24)] += v; }
  const cov = c.since_h ? Math.max(0, Math.min(168, nowH - c.since_h + 1)) : 0;
  const paid7d = Number(r7) / div, paid24h = Number(r24) / div;
  const out = { mint: c.mint, chain: c.chain, platform: c.platform, symbol: c.symbol, name: c.name, icon: c.icon, fee: (c.fee_bps || 0) / 100,
    quote: { mint: c.quote_mint, symbol: c.quote_symbol, icon: c.quote_icon, dec }, mcap: c.mcap, holders: c.holders,
    lastPayout: c.last_payout, status: c.status, paid7d, paid24h, coverH: cov, days: days.map(v => Number(v) / div), note: s && !(s.elig > 0) ? (s.note || '') : '' };
  if (s && s.elig > 0 && s.win_h > 0) {
    // reward tokens a held token got in 7 days. With a day or more of our own hourly totals we use those (scaled while under a week);
    // before that, the measuring window itself (the last day of the payout ledger), scaled to a week. The page says which.
    if (cov >= 24) { out.per7d = paid7d * (168 / cov) / s.elig; out.per24h = paid24h * 7 / s.elig; out.basisH = cov; }
    else { out.per7d = Number(big(s.win_raw)) / div / s.elig * 168 / s.win_h; out.basisH = s.win_h; }
    // newest price we have, and the one closest to a week ago (our own history first, the measuring run's lookup if it is younger than a week)
    const now = px.filter(p => p.h > nowH - 6).reduce((a, b) => (!a || b.h > a.h ? b : a), null), old = px.filter(p => Math.abs(nowH - 168 - p.h) <= 2).sort((a, b) => Math.abs(nowH - 168 - a.h) - Math.abs(nowH - 168 - b.h))[0];
    s = { ...s, price: now?.price || s.price, qprice: now?.qprice || s.qprice, price7d: old?.price || s.price7d };
    out.price = s.price; out.qprice = s.qprice; out.price7d = s.price7d; out.pricedAt = now ? now.h * 3600 : s.ts;
    out.measured = { ts: s.ts, holders: s.n, windowH: s.win_h, lo: s.lo, hi: s.hi, proofs: JSON.parse(s.proofs || '[]'), note: s.note || '' };
    if (s.price > 0 && s.qprice > 0) {
      out.usdPer1kWeek = 1000 / s.price * (1 - out.fee / 100) * out.per7d * s.qprice;
      out.rewardsPct7d = out.per7d * s.qprice / s.price * 100;
      if (s.price7d > 0 && s.price / s.price7d > 0.02 && s.price / s.price7d < 50) out.pricePct7d = (s.price / s.price7d - 1) * 100;  // anything wilder is a bad lookup, not a price move
    }
  }
  return out;
}
