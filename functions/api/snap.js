// A wallet's last full result, saved by the browser that finished the check, so the next check of it opens instantly.
// GET /api/snap?k=<wallets>   POST {k, run, tok, total, data}  (data: gzip+base64 of the result, at most 1 MB)
// Data only, never HTML: the page draws a saved result with the same escaping code as a fresh one.
// Kept only when the run token /api/run signed for exactly these wallets comes with it, the run's own log entry
// has the same total, and the content passes the schema check below.
import { json } from '../_lib/cache.js';
import { readRun } from '../_lib/sec.js';
import { bump, ipKey } from '../_lib/ratelimit.js';
const ok = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s);
const PART = 900000, MAX_B64 = 1_000_000, MAX_JSON = 8_000_000, V = 2, DAY_BYTES = 150_000_000, KEEP_DAYS = 30;
let ready = {};
async function init(DB, T) {
  if (ready[T]) return;
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS ${T} (k TEXT PRIMARY KEY, ts INTEGER, total REAL, parts INTEGER)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS ${T}_part (k TEXT, i INTEGER, d TEXT, PRIMARY KEY (k, i))`),
  ]);
  try { await DB.exec(`ALTER TABLE ${T} ADD COLUMN v INTEGER`); } catch {}
  try { await DB.exec(`ALTER TABLE ${T} ADD COLUMN sid TEXT`); } catch {}
  ready[T] = true;
}
const tables = request => { const prod = /(^|\.)getkickback\.fun$/.test(new URL(request.url).hostname); return { T: prod ? 'scan_snap' : 'scan_snap_test', L: prod ? 'scan_log' : 'scan_log_test' }; };
const keyOk = k => { const ws = String(k || '').split(' '); return ws.length >= 1 && ws.length <= 10 && ws.every(ok) ? ws : null; };

// the saved result is plain data: numbers, short strings, arrays and objects with plain keys, nothing that looks like markup
function clean(o) {
  let n = 0;
  const walk = (x, d) => {
    if (++n > 400000 || d > 8) return false;
    if (x === null || typeof x === 'boolean') return true;
    if (typeof x === 'number') return Number.isFinite(x);
    if (typeof x === 'string') return x.length <= 4000 && !/[<>`]/.test(x);
    if (Array.isArray(x)) return x.length <= 20000 && x.every(v => walk(v, d + 1));
    if (typeof x === 'object') return Object.entries(x).every(([k, v]) => /^[A-Za-z0-9_$:|.-]{1,100}$/.test(k) && walk(v, d + 1));
    return false;
  };
  if (!o || typeof o !== 'object' || o.v !== V || !Array.isArray(o.rows) || !Number.isFinite(o.total) || 'stack' in o || 'plats' in o || 'wk' in o) return false;
  return walk(o, 0);
}
async function unzip(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const r = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(), dec = new TextDecoder();
  let s = '';
  for (;;) { const { done, value } = await r.read(); if (done) break; s += dec.decode(value, { stream: true }); if (s.length > MAX_JSON) { r.cancel().catch(() => {}); return null; } }
  return s + dec.decode();
}

export async function onRequestGet({ request, env }) {
  const k = new URL(request.url).searchParams.get('k') || '';
  if (!keyOk(k) || !env.DB) return json({});
  const { T } = tables(request);
  try {
    await init(env.DB, T);
    // results saved before v2 held HTML: never handed out
    const m = await env.DB.prepare(`SELECT ts, total, parts FROM ${T} WHERE k = ?1 AND v = ?2`).bind(k, V).first();
    if (!m) return json({});
    const ps = (await env.DB.prepare(`SELECT d FROM ${T}_part WHERE k = ?1 ORDER BY i`).bind(k).all()).results || [];
    if (ps.length !== m.parts) return json({});
    return new Response(JSON.stringify({ ts: m.ts, total: m.total, data: ps.map(p => p.d).join('') }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch { return json({}); }
}
export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  if (!env.DB) return json({ error: 'no db' }, 503);
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const ws = keyOk(b?.k), total = Number(b?.total), data = b?.data;
  if (!ws || typeof b.run !== 'string' || !Number.isFinite(total) || typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data) || data.length > MAX_B64) return json({ error: 'bad request' }, 400);
  const tok = await readRun(env, b.tok, ws);
  if (!tok || tok.run !== b.run) return json({ error: 'bad run token' }, 403);
  const { wait } = await bump(ctx, 'snap|' + ipKey(request), [[3600, 20]]);
  if (wait) return json({ error: 'too many requests' }, 429);
  if ((await bump(ctx, 'snapbytes', [[86400, DAY_BYTES]], data.length)).wait) return json({ ok: false, skipped: 'daily budget used' });
  const { T, L } = tables(request);
  // the run must be a logged check of exactly these wallets, with this total
  const r = await env.DB.prepare(`SELECT wallets, COALESCE(total_final,total) AS t FROM ${L} WHERE run = ?1`).bind(b.run).first().catch(() => null);
  const same = r && [...new Set(String(r.wallets || '').split(' ').filter(Boolean).map(w => w.startsWith('0x') ? w.toLowerCase() : w))].sort().join(' ') === b.k;
  if (!same || Math.abs((r.t || 0) - total) > Math.max(1, total * 0.01)) return json({ ok: false, skipped: 'no matching check' });
  let o = null; try { const s = await unzip(data); o = s && JSON.parse(s); } catch {}
  if (!clean(o) || Math.abs(o.total - total) > Math.max(1, total * 0.01)) return json({ error: 'bad result' }, 400);
  await init(env.DB, T);
  const parts = []; for (let i = 0; i < data.length; i += PART) parts.push(data.slice(i, i + PART));
  const st = [env.DB.prepare(`DELETE FROM ${T}_part WHERE k = ?1`).bind(b.k)];
  parts.forEach((d, i) => st.push(env.DB.prepare(`INSERT INTO ${T}_part (k, i, d) VALUES (?1, ?2, ?3)`).bind(b.k, i, d)));
  st.push(env.DB.prepare(`INSERT INTO ${T} (k, ts, total, parts, v, sid) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(k) DO UPDATE SET ts = excluded.ts, total = excluded.total, parts = excluded.parts, v = excluded.v, sid = excluded.sid`)
    .bind(b.k, Math.floor(Date.now() / 1000), total, parts.length, V, tok.sid));
  await env.DB.batch(st);
  if (Math.random() < 0.02) ctx.waitUntil((async () => {   // results nobody re-checked for a month
    const old = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
    await env.DB.batch([env.DB.prepare(`DELETE FROM ${T}_part WHERE k IN (SELECT k FROM ${T} WHERE ts < ?1 LIMIT 200)`).bind(old), env.DB.prepare(`DELETE FROM ${T} WHERE k IN (SELECT k FROM ${T} WHERE ts < ?1 LIMIT 200)`).bind(old)]);
  })().catch(() => {}));
  return json({ ok: true, parts: parts.length });
}
