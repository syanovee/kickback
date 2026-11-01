// GET /api/price?ids=binancecoin,ethereum : CoinGecko USD prices, kept 5 minutes so scans don't each ask CoinGecko (it rate limits us)
import { cached, json } from '../_lib/cache.js';
export async function onRequestGet(ctx) {
  const ids = (new URL(ctx.request.url).searchParams.get('ids') || '').split(',').map(s => s.trim().toLowerCase()).filter(s => /^[a-z0-9-]{2,40}$/.test(s)).slice(0, 10).sort().join(',');
  if (!ids) return json({}, 400);
  return cached(ctx, 'cg-price', ids, 300, async () => {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; Kickback/1.0; +https://getkickback.fun)' } });
    return { status: r.status, text: await r.text() };
  }, t => { try { return Object.keys(JSON.parse(t)).length > 0; } catch { return false; } });
}
