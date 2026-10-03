import { getCached, putCached, json } from '../../_lib/cache.js';
export async function onRequestGet(ctx) {
  const m = String(ctx.params.mint || '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) return json({}, 400);
  const hit = await getCached(ctx, 'stonk3', m);
  if (hit !== null) return new Response(hit, { headers: { 'Content-Type': 'application/json', 'X-Cache': 'hit' } });
  const r = await fetch(`https://www.stonkfun.xyz/api/public/v1/tokens/${m}/rewards`);
  const text = r.ok ? await r.text() : '{}';
  if (r.ok) await putCached(ctx, 'stonk3', m, 300, text);   // fresh enough that a coin's latest round time still matches the wallet's latest payout
  else if (r.status === 404) await putCached(ctx, 'stonk3', m, 24 * 3600, text);
  return new Response(text, { headers: { 'Content-Type': 'application/json', 'X-Cache': 'miss' } });
}
