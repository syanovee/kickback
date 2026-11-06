import { json } from '../_lib/cache.js';
import { readRun } from '../_lib/sec.js';
const isAddr = s => typeof s === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s));
let ready = false;
// POST {w, wallets, run, tok, total}: this wallet's place among all checked wallets. Only with the run token of the check,
// and only the total that check logged, so nobody can move another wallet's rank or the public total.
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no db' }, 503);
  if (!/(^|\.)getkickback\.fun$/.test(new URL(request.url).hostname)) return json({ ok: true, skipped: 'not prod' });
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const w = b?.w, total = Number(b?.total), ws = Array.isArray(b?.wallets) ? b.wallets.filter(isAddr).slice(0, 10) : [];
  if (!isAddr(w) || !Number.isFinite(total) || total < 0 || total > 5e6) return json({ error: 'bad request' }, 400);
  const key = w.startsWith('0x') ? w.toLowerCase() : w, t = Math.round(total * 100) / 100;
  const tok = ws.length ? await readRun(env, b.tok, ws) : null;
  if (!tok || tok.run !== b.run || !ws.map(x => x.startsWith('0x') ? x.toLowerCase() : x).includes(key)) return json({ error: 'bad run token' }, 403);
  const r0 = await env.DB.prepare('SELECT COALESCE(total_final,total) AS t FROM scan_log WHERE run = ?1').bind(b.run).first().catch(() => null);
  if (!r0 || Math.abs((r0.t || 0) - total) > Math.max(1, total * 0.01)) return json({ error: 'total does not match the check' }, 403);
  if (!ready) { await env.DB.exec('CREATE TABLE IF NOT EXISTS scans (w TEXT PRIMARY KEY, total REAL NOT NULL, t INTEGER NOT NULL)'); ready = true; }
  await env.DB.prepare('INSERT INTO scans (w, total, t) VALUES (?1, ?2, ?3) ON CONFLICT(w) DO UPDATE SET total = excluded.total, t = excluded.t')
    .bind(key, t, Math.floor(Date.now() / 1000)).run();
  const r = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM scans WHERE total > ?1 AND w != ?2) AS above, (SELECT COUNT(*) FROM scans) AS n,
    (SELECT COUNT(*) FROM scans WHERE total > 0) AS paid, (SELECT COUNT(*) FROM scans WHERE total > 0 AND total < ?1 AND w != ?2) AS below`).bind(t, key).first();
  const rank = (r?.above || 0) + 1, n = r?.n || 1;
  // paid/below: wallets that got anything, and how many of them this one beat (the many $0 wallets would make any total look "top 50%")
  return json({ rank, n, top: Math.max(1, Math.ceil(rank / n * 100)), paid: r?.paid || 0, below: r?.below || 0 });
}
