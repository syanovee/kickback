// GET /api/yield/<mint>: one coin, measured. An unknown mint is queued for the next measuring run.
import { json } from '../../_lib/cache.js';
import { yInit, yView } from '../../_lib/yield.js';
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, EVM = /^0x[0-9a-fA-F]{40}$/;
export async function onRequestGet({ params, env }) {
  if (!env.DB) return json({ error: 'no db' }, 503);
  const m = String(params.mint || '').trim();
  if (!SOL.test(m) && !EVM.test(m)) return json({ error: 'not a token address' }, 400);
  await yInit(env.DB);
  const mint = EVM.test(m) ? m.toLowerCase() : m, nowH = Math.floor(Date.now() / 3600000);
  let c = await env.DB.prepare('SELECT * FROM y_coin WHERE mint = ?1').bind(mint).first();
  if (!c) {
    await env.DB.prepare(`INSERT OR IGNORE INTO y_coin (mint, chain, status, added, searches) VALUES (?1, ?2, 'pending', ?3, 1)`).bind(mint, EVM.test(m) ? 'evm' : 'solana', Math.floor(Date.now() / 1000)).run();
    return json({ mint, status: 'pending' }, 200);
  }
  await env.DB.prepare('UPDATE y_coin SET searches = COALESCE(searches,0) + 1 WHERE mint = ?1').bind(mint).run();
  const s = await env.DB.prepare('SELECT * FROM y_stat WHERE mint = ?1').bind(mint).first();
  const hours = (await env.DB.prepare('SELECT h, raw FROM y_hour WHERE mint = ?1 AND h > ?2').bind(mint, nowH - 168).all()).results || [];
  const px = (await env.DB.prepare('SELECT h, price, qprice FROM y_price WHERE mint = ?1 AND (h > ?2 OR h BETWEEN ?3 AND ?4)').bind(mint, nowH - 3, nowH - 170, nowH - 166).all()).results || [];
  return new Response(JSON.stringify(yView(c, s, hours, nowH, px)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
}
