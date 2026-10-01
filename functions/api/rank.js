import { json } from '../_lib/cache.js';
const isAddr = s => typeof s === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s));
let ready = false;
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no db' }, 503);
  if (!/(^|\.)getkickback\.fun$/.test(new URL(request.url).hostname)) return json({ ok: true, skipped: 'not prod' });
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const w = b?.w, total = Number(b?.total);
  if (!isAddr(w) || !Number.isFinite(total) || total < 0 || total > 5e6) return json({ error: 'bad request' }, 400);
  if (!ready) { await env.DB.exec('CREATE TABLE IF NOT EXISTS scans (w TEXT PRIMARY KEY, total REAL NOT NULL, t INTEGER NOT NULL)'); ready = true; }
  const key = w.startsWith('0x') ? w.toLowerCase() : w, t = Math.round(total * 100) / 100;
  await env.DB.prepare('INSERT INTO scans (w, total, t) VALUES (?1, ?2, ?3) ON CONFLICT(w) DO UPDATE SET total = excluded.total, t = excluded.t')
    .bind(key, t, Math.floor(Date.now() / 1000)).run();
  const r = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM scans WHERE total > ?1 AND w != ?2) AS above, (SELECT COUNT(*) FROM scans) AS n').bind(t, key).first();
  const rank = (r?.above || 0) + 1, n = r?.n || 1;
  return json({ rank, n, top: Math.max(1, Math.ceil(rank / n * 100)) });
}
