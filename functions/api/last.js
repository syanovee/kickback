// GET /api/last?w=<wallet>: what this wallet's last finished check found, so a re-check shows a number right away
// while the fresh scan runs. Only totals and top coins, the same things a public scan of that wallet shows anyway.
import { json } from '../_lib/cache.js';
const ok = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s);
export async function onRequestGet({ request, env }) {
  const w = new URL(request.url).searchParams.get('w') || '';
  if (!ok(w) || !env.DB) return json({});
  let r = null;
  try {
    r = await env.DB.prepare(`SELECT COALESCE(total_final,total) AS t, COALESCE(ts_final,ts) AS ts, coins FROM scan_log
      WHERE wallets = ?1 AND COALESCE(total_final,total) > 0 AND COALESCE(flags,'') NOT LIKE '%tease%' AND COALESCE(flags,'') NOT LIKE '%studio%'
      AND COALESCE(flags,'') NOT LIKE '%embed%' AND COALESCE(flags,'') NOT LIKE '%event-only%' ORDER BY ts DESC LIMIT 1`).bind(w.startsWith('0x') ? w.toLowerCase() : w).first();
  } catch {}
  if (!r) return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
  let coins = []; try { coins = JSON.parse(r.coins || '[]').filter(c => c.u > 0).sort((a, b) => b.u - a.u).slice(0, 5).map(c => ({ s: c.s, u: c.u, i: c.i || null })); } catch {}
  return new Response(JSON.stringify({ t: Math.round(r.t * 100) / 100, ts: r.ts, coins }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
}
