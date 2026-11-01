// A wallet's last full result, saved by the browser that finished the check, so the next check of it opens instantly.
// GET /api/snap?k=<wallets>   POST {k, run, total, data}  (data: gzip+base64 of the result, at most 7.5 MB)
// Only kept when it matches that run's own log entry (same wallets, same total), so nobody can save a made-up result.
import { json } from '../_lib/cache.js';
const ok = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s);
const PART = 900000;
let ready = {};
async function init(DB, T) {
  if (ready[T]) return;
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS ${T} (k TEXT PRIMARY KEY, ts INTEGER, total REAL, parts INTEGER)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS ${T}_part (k TEXT, i INTEGER, d TEXT, PRIMARY KEY (k, i))`),
  ]);
  ready[T] = true;
}
const tables = request => { const prod = /(^|\.)getkickback\.fun$/.test(new URL(request.url).hostname); return { T: prod ? 'scan_snap' : 'scan_snap_test', L: prod ? 'scan_log' : 'scan_log_test' }; };
const keyOk = k => { const ws = String(k || '').split(' '); return ws.length >= 1 && ws.length <= 10 && ws.every(ok) ? ws : null; };
export async function onRequestGet({ request, env }) {
  const k = new URL(request.url).searchParams.get('k') || '';
  if (!keyOk(k) || !env.DB) return json({});
  const { T } = tables(request);
  try {
    await init(env.DB, T);
    const m = await env.DB.prepare(`SELECT ts, total, parts FROM ${T} WHERE k = ?1`).bind(k).first();
    if (!m) return json({});
    const ps = (await env.DB.prepare(`SELECT d FROM ${T}_part WHERE k = ?1 ORDER BY i`).bind(k).all()).results || [];
    if (ps.length !== m.parts) return json({});
    return new Response(JSON.stringify({ ts: m.ts, total: m.total, data: ps.map(p => p.d).join('') }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch { return json({}); }
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no db' }, 503);
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const ws = keyOk(b?.k), total = Number(b?.total), data = b?.data;
  if (!ws || typeof b.run !== 'string' || !Number.isFinite(total) || typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 7.5e6) return json({ error: 'bad request' }, 400);
  const { T, L } = tables(request);
  // the run must be a real finished check of exactly these wallets, with this total
  const r = await env.DB.prepare(`SELECT wallets, COALESCE(total_final,total) AS t FROM ${L} WHERE run = ?1`).bind(b.run).first().catch(() => null);
  const same = r && [...new Set(String(r.wallets || '').split(' ').filter(Boolean).map(w => w.startsWith('0x') ? w.toLowerCase() : w))].sort().join(' ') === b.k;
  if (!same || Math.abs((r.t || 0) - total) > Math.max(1, total * 0.01)) return json({ ok: false, skipped: 'no matching check' });
  await init(env.DB, T);
  const parts = []; for (let i = 0; i < data.length; i += PART) parts.push(data.slice(i, i + PART));
  const st = [env.DB.prepare(`DELETE FROM ${T}_part WHERE k = ?1`).bind(b.k)];
  parts.forEach((d, i) => st.push(env.DB.prepare(`INSERT INTO ${T}_part (k, i, d) VALUES (?1, ?2, ?3)`).bind(b.k, i, d)));
  st.push(env.DB.prepare(`INSERT INTO ${T} (k, ts, total, parts) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(k) DO UPDATE SET ts = excluded.ts, total = excluded.total, parts = excluded.parts`).bind(b.k, Math.floor(Date.now() / 1000), total, parts.length));
  await env.DB.batch(st);
  return json({ ok: true, parts: parts.length });
}
