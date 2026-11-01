// Private: the measuring job (tools/yield-job.mjs) reads its state here and writes results. Needs the YIELD_KEY secret as a Bearer token.
import { json } from '../../_lib/cache.js';
import { yInit } from '../../_lib/yield.js';
const same = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function auth(request, env) {
  if (!env.YIELD_KEY || !env.DB) return json({ error: 'not set up' }, 503);
  if (!same((request.headers.get('authorization') || '').replace(/^Bearer /, ''), env.YIELD_KEY)) { await new Promise(r => setTimeout(r, 600)); return json({ error: 'no' }, 403); }
  await yInit(env.DB); return null;
}
const COIN = ['chain', 'platform', 'symbol', 'name', 'icon', 'quote_mint', 'quote_symbol', 'quote_dec', 'quote_icon', 'fee_bps', 'pool', 'mcap', 'cum', 'cum_ts', 'since_h', 'last_payout', 'holders', 'status'];
const STAT = ['ts', 'rate', 'win_h', 'win_raw', 'elig', 'n', 'lo', 'hi', 'proofs', 'price', 'qprice', 'price7d', 'note'];
const v = x => x === undefined ? null : (typeof x === 'object' && x !== null ? JSON.stringify(x) : x);
const RAW = /^\d{1,30}$/;
export async function onRequestGet({ request, env }) {
  const bad = await auth(request, env); if (bad) return bad;
  const coins = (await env.DB.prepare(`SELECT c.mint, c.chain, c.platform, c.status, c.cum, c.cum_ts, c.since_h, c.searches, c.added, s.ts AS stat_ts, s.elig AS stat_elig FROM y_coin c LEFT JOIN y_stat s ON s.mint = c.mint`).all()).results || [];
  return json({ now: Date.now(), coins });
}
export async function onRequestPost({ request, env }) {
  const bad = await auth(request, env); if (bad) return bad;
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const DB = env.DB, st = [];
  for (const c of b.coins || []) {
    if (typeof c?.mint !== 'string' || c.mint.length > 44) continue;
    const cols = COIN.filter(k => k in c);
    st.push(DB.prepare(`INSERT INTO y_coin (mint, added, ${cols.join(',')}) VALUES (?1, ?2${cols.map((_, i) => ', ?' + (i + 3)).join('')})
      ON CONFLICT(mint) DO UPDATE SET ${cols.map(k => `${k} = excluded.${k}`).join(', ') || 'mint = mint'}`).bind(c.mint, Math.floor(Date.now() / 1000), ...cols.map(k => v(c[k]))));
  }
  for (const h of b.hours || []) {
    const [mint, hr, raw, mode] = h || [];
    if (typeof mint !== 'string' || !Number.isInteger(hr) || !RAW.test(String(raw))) continue;
    st.push(mode === 'add'
      ? DB.prepare(`INSERT INTO y_hour (mint, h, raw) VALUES (?1, ?2, ?3) ON CONFLICT(mint, h) DO UPDATE SET raw = CAST(CAST(raw AS INTEGER) + CAST(excluded.raw AS INTEGER) AS TEXT)`).bind(mint, hr, String(raw))
      : DB.prepare(`INSERT INTO y_hour (mint, h, raw) VALUES (?1, ?2, ?3) ON CONFLICT(mint, h) DO UPDATE SET raw = excluded.raw`).bind(mint, hr, String(raw)));
  }
  for (const s of b.stats || []) {
    if (typeof s?.mint !== 'string') continue;
    st.push(DB.prepare(`INSERT OR REPLACE INTO y_stat (mint, ${STAT.join(',')}) VALUES (?1${STAT.map((_, i) => ', ?' + (i + 2)).join('')})`).bind(s.mint, ...STAT.map(k => v(s[k]))));
  }
  for (const p of b.prices || []) {
    const [mint, hr, price, qprice] = p || [];
    if (typeof mint !== 'string' || !Number.isInteger(hr) || !(price > 0)) continue;
    st.push(DB.prepare('INSERT OR REPLACE INTO y_price (mint, h, price, qprice) VALUES (?1, ?2, ?3, ?4)').bind(mint, hr, price, qprice > 0 ? qprice : null));
  }
  if (b.prune) { const old = Math.floor(Date.now() / 3600000) - 240; st.push(DB.prepare('DELETE FROM y_hour WHERE h < ?1').bind(old), DB.prepare('DELETE FROM y_price WHERE h < ?1').bind(old)); }
  for (let i = 0; i < st.length; i += 200) await DB.batch(st.slice(i, i + 200));
  return json({ ok: true, wrote: st.length });
}
