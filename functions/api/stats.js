import { json } from '../_lib/cache.js';
export async function onRequestGet({ env }) {
  let n = 0, s = 0;
  try { const r = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS s FROM scans').first(); n = r?.n || 0; s = r?.s || 0; } catch {}
  return new Response(JSON.stringify({ n, total: Math.round(s) }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' } });
}
