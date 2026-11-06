// The link preview picture for getkickback.fun/w/<wallet>: the wallet's own Kickback card, drawn by the browser that finished its check.
// GET /api/wcard?w=<wallet>  -> jpeg     POST {w, run, tok, total, img}
// Kept only with the run token /api/run signed for this one wallet, when the run's log entry has the same total,
// and a wallet's preview changes at most once every 30 minutes.
import { json } from '../_lib/cache.js';
import { readRun } from '../_lib/sec.js';
import { bump, ipKey } from '../_lib/ratelimit.js';
const ok = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s);
const norm = w => w.startsWith('0x') ? w.toLowerCase() : w;
const tables = request => { const prod = /(^|\.)getkickback\.fun$/.test(new URL(request.url).hostname); return { T: prod ? 'wcard' : 'wcard_test', L: prod ? 'scan_log' : 'scan_log_test' }; };
const ready = {};
async function init(DB, T) {
  if (ready[T]) return;
  await DB.exec(`CREATE TABLE IF NOT EXISTS ${T} (w TEXT PRIMARY KEY, ts INTEGER, total REAL, img BLOB)`);
  try { await DB.exec(`ALTER TABLE ${T} ADD COLUMN sid TEXT`); } catch {}
  ready[T] = true;
}
export async function onRequestGet({ request, env }) {
  const w = new URL(request.url).searchParams.get('w') || '';
  if (!ok(w) || !env.DB) return new Response('not found', { status: 404 });
  const { T } = tables(request);
  const row = await env.DB.prepare(`SELECT img FROM ${T} WHERE w = ?1`).bind(norm(w)).first().catch(() => null);
  if (!row?.img) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(row.img), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
}
export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  if (!env.DB) return json({ error: 'no db' }, 503);
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(b?.img || ''), total = Number(b?.total);
  if (!ok(b?.w) || typeof b.run !== 'string' || !m || m[1].length > 500000 || !Number.isFinite(total) || total < 1) return json({ error: 'bad request' }, 400);
  const tok = await readRun(env, b.tok, [b.w]);
  if (!tok || tok.run !== b.run) return json({ error: 'bad run token' }, 403);
  const { wait } = await bump(ctx, 'wcard|' + ipKey(request), [[3600, 30]]);
  if (wait) return json({ error: 'too many requests' }, 429);
  const w = norm(b.w), { T, L } = tables(request);
  const r = await env.DB.prepare(`SELECT wallets, COALESCE(total_final,total) AS t FROM ${L} WHERE run = ?1`).bind(b.run).first().catch(() => null);
  const ws = r ? [...new Set(String(r.wallets || '').split(' ').filter(Boolean).map(norm))] : [];
  if (ws.length !== 1 || ws[0] !== w || Math.abs((r.t || 0) - total) > Math.max(1, total * 0.01)) return json({ ok: false, skipped: 'no matching check' });
  const bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) return json({ error: 'bad image' }, 400);
  await init(env.DB, T);
  const now = Math.floor(Date.now() / 1000);
  const cur = await env.DB.prepare(`SELECT ts, sid FROM ${T} WHERE w = ?1`).bind(w).first().catch(() => null);
  if (cur && cur.sid !== tok.sid && now - (cur.ts || 0) < 1800) return json({ ok: false, skipped: 'preview changed in the last 30 minutes' });
  await env.DB.prepare(`INSERT INTO ${T} (w, ts, total, img, sid) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(w) DO UPDATE SET ts = excluded.ts, total = excluded.total, img = excluded.img, sid = excluded.sid`)
    .bind(w, now, Math.round(total * 100) / 100, bytes, tok.sid).run();
  return json({ ok: true });
}
