import { getCached, json } from '../_lib/cache.js';
import { txKey } from '../_lib/soltx.js';
export async function onRequestPost(ctx) {
  let sigs;
  try { sigs = (await ctx.request.json())?.sigs; } catch { return json({ error: 'bad json' }, 400); }
  if (!Array.isArray(sigs) || sigs.length > 200) return json({ error: 'up to 200 signatures' }, 400);
  const out = {};
  await Promise.all(sigs.map(async s => {
    if (typeof s !== 'string' || s.length > 100) return;
    const hit = await getCached(ctx, 'alchemy:solana-mainnet', txKey(s));
    if (hit) { try { const r = JSON.parse(hit).result; if (r) out[s] = r; } catch {} }
  }));
  return json({ txs: out });
}
