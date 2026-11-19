// GET /api/price?ids=binancecoin,ethereum : USD prices of the chains' native coins, kept 5 minutes so scans don't each ask CoinGecko.
// CoinGecko's free API rate limits us under load: then the last good answer (kept a day) is used, and failing that Coinbase's spot price.
import { cached, getCached, putCached, json } from '../_lib/cache.js';
import { charge } from '../_lib/budget.js';
const CB = { ethereum: 'ETH', binancecoin: 'BNB', solana: 'SOL', bitcoin: 'BTC' };
async function coinbase(ids) {
  const out = {};
  await Promise.all(ids.split(',').map(async id => {
    if (!CB[id]) return;
    try { const r = await fetch(`https://api.coinbase.com/v2/prices/${CB[id]}-USD/spot`, { signal: AbortSignal.timeout(6000) }); const j = await r.json(); const v = +j?.data?.amount; if (v > 0) out[id] = { usd: v }; } catch {}
  }));
  return out;
}
export async function onRequestGet(ctx) {
  const ids = (new URL(ctx.request.url).searchParams.get('ids') || '').split(',').map(s => s.trim().toLowerCase()).filter(s => /^[a-z0-9-]{2,40}$/.test(s)).slice(0, 10).sort().join(',');
  if (!ids) return json({}, 400);
  const good = t => { try { return Object.keys(JSON.parse(t)).length > 0; } catch { return false; } };
  return cached(ctx, 'cg-price', ids, 300, async () => {
    if (await charge(ctx, 1)) return { status: 429, text: '{"error":"budget"}' };
    let status = 0, text = '';
    try { const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; Kickback/1.0; +https://getkickback.fun)' }, signal: AbortSignal.timeout(8000) });
      status = r.status; text = await r.text(); } catch {}
    if (status === 200 && good(text)) { await putCached(ctx, 'cg-price-last', ids, 86400, text); return { status, text }; }
    const last = await getCached(ctx, 'cg-price-last', ids);
    if (last) return { status: 200, text: last };
    const cb = await coinbase(ids);
    if (Object.keys(cb).length) return { status: 200, text: JSON.stringify(cb) };
    return { status: status || 503, text: text || '{"error":"no price"}' };
  }, good);
}
