import { charge } from '../../_lib/budget.js';
export async function onRequestGet(ctx) {
  const { params, env, request, waitUntil } = ctx;
  const w = String(params.wallet || '');
  if (!/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(w)) return new Response('{}', { status: 400 });
  // EVM addresses are case-insensitive, Solana ones are not: only 0x addresses share a cache entry across letter case
  const k = w.startsWith('0x') ? w.toLowerCase() : w;
  const cache = caches.default, key = new Request(new URL('/api/fomo/' + k, request.url));
  const hit = await cache.match(key);
  if (hit) return hit;
  const over = await charge(ctx, 1); if (over) return over;
  const r = await fetch('https://api.fomoscan.sh/v2/user/wallet/' + w, { headers: { Authorization: 'Bearer ' + env.FOMOSCAN_KEY } });
  const res = new Response(await r.text(), { status: r.ok ? 200 : r.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } });
  if (r.ok || r.status === 404) waitUntil(cache.put(key, res.clone()));
  return res;
}
