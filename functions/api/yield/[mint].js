// GET /api/yield/<mint>: one coin, measured. Unknown mints are not stored on a GET.
// POST /api/yield/<mint>: queue an unknown mint for the next measuring run (the queue has a cap, each address a budget).
import { json } from '../../_lib/cache.js';
import { yInit, yView } from '../../_lib/yield.js';
import { bump, ipKey } from '../../_lib/ratelimit.js';
const MAX_PENDING = 300;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, EVM = /^0x[0-9a-fA-F]{40}$/;
export async function onRequestGet({ params, env }) {
  if (!env.DB) return json({ error: 'no db' }, 503);
  const m = String(params.mint || '').trim();
  if (!SOL.test(m) && !EVM.test(m)) return json({ error: 'not a token address' }, 400);
  await yInit(env.DB);
  const mint = EVM.test(m) ? m.toLowerCase() : m, nowH = Math.floor(Date.now() / 3600000);
  let c = await env.DB.prepare('SELECT * FROM y_coin WHERE mint = ?1').bind(mint).first();
  if (!c) return json({ mint, status: 'unknown' }, 200);
  await env.DB.prepare('UPDATE y_coin SET searches = COALESCE(searches,0) + 1 WHERE mint = ?1').bind(mint).run();
  const s = await env.DB.prepare('SELECT * FROM y_stat WHERE mint = ?1').bind(mint).first();
  const hours = (await env.DB.prepare('SELECT h, raw FROM y_hour WHERE mint = ?1 AND h > ?2').bind(mint, nowH - 168).all()).results || [];
  const px = (await env.DB.prepare('SELECT h, price, qprice FROM y_price WHERE mint = ?1 AND (h > ?2 OR h BETWEEN ?3 AND ?4)').bind(mint, nowH - 3, nowH - 170, nowH - 166).all()).results || [];
  return new Response(JSON.stringify(yView(c, s, hours, nowH, px)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
}

export async function onRequestPost(ctx) {
  const { params, env, request } = ctx;
  if (!env.DB) return json({ error: 'no db' }, 503);
  const m = String(params.mint || '').trim();
  if (!SOL.test(m) && !EVM.test(m)) return json({ error: 'not a token address' }, 400);
  const { wait } = await bump(ctx, 'yq|' + ipKey(request), [[3600, 20]]);
  if (wait) return json({ error: 'too many coins added, try again later' }, 429);
  await yInit(env.DB);
  const mint = EVM.test(m) ? m.toLowerCase() : m;
  const c = await env.DB.prepare('SELECT status FROM y_coin WHERE mint = ?1').bind(mint).first();
  if (c) return json({ mint, status: c.status });
  const q = await env.DB.prepare(`SELECT COUNT(*) AS n FROM y_coin WHERE status = 'pending'`).first();
  if ((q?.n || 0) >= MAX_PENDING) return json({ error: 'the queue is full right now, try again in an hour' }, 503);
  await env.DB.prepare(`INSERT OR IGNORE INTO y_coin (mint, chain, status, added, searches) VALUES (?1, ?2, 'pending', ?3, 1)`).bind(mint, EVM.test(m) ? 'evm' : 'solana', Math.floor(Date.now() / 1000)).run();
  return json({ mint, status: 'pending' });
}
