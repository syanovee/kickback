// GET /api/yield/search?q=TICKER: coins for the search box. Empty q gives the coins that paid holders the most this week.
import { json } from '../../_lib/cache.js';
import { yInit, yView } from '../../_lib/yield.js';
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ items: [] });
  await yInit(env.DB);
  const q = (new URL(request.url).searchParams.get('q') || '').trim().replace(/^\$/, '').slice(0, 44);
  const nowH = Math.floor(Date.now() / 3600000);
  let coins;
  if (!q) coins = (await env.DB.prepare(`SELECT c.* FROM y_coin c JOIN y_stat s ON s.mint = c.mint WHERE c.status = 'ok' ORDER BY COALESCE(c.searches,0) * 1e7 + COALESCE(c.mcap,0) DESC LIMIT 8`).all()).results || [];
  else coins = (await env.DB.prepare(`SELECT c.* FROM y_coin c WHERE c.status = 'ok' AND (c.mint = ?1 OR c.symbol LIKE ?2 ESCAPE '\\' OR c.name LIKE ?3 ESCAPE '\\')
      ORDER BY (UPPER(c.symbol) = UPPER(?1)) DESC, COALESCE(c.mcap,0) DESC LIMIT 8`).bind(q, q.replace(/[%_\\]/g, m => '\\' + m) + '%', '%' + q.replace(/[%_\\]/g, m => '\\' + m) + '%').all()).results || [];
  const items = [];
  for (const c of coins) {
    const s = await env.DB.prepare('SELECT * FROM y_stat WHERE mint = ?1').bind(c.mint).first();
    const hours = (await env.DB.prepare('SELECT h, raw FROM y_hour WHERE mint = ?1 AND h > ?2').bind(c.mint, nowH - 168).all()).results || [];
    const px = (await env.DB.prepare('SELECT h, price, qprice FROM y_price WHERE mint = ?1 AND h > ?2').bind(c.mint, nowH - 3).all()).results || [];
    const v = yView(c, s, hours, nowH, px); if (!v) continue;
    items.push({ mint: v.mint, symbol: v.symbol, name: v.name, icon: v.icon, platform: v.platform, chain: v.chain, quote: v.quote.symbol, mcap: v.mcap ?? null, usdPer1kWeek: v.usdPer1kWeek ?? null });
  }
  // not in our list yet: look the ticker up on StonkFun, so nobody has to know a CA. Picking one queues it for measuring.
  if (q && items.length < 4 && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) {
    try {
      const r = await fetch('https://www.stonkfun.xyz/api/public/v1/tokens?mode=reward&pageSize=20&q=' + encodeURIComponent(q), { cf: { cacheTtl: 300, cacheEverything: true } });
      const j = r.ok ? await r.json() : null, have = new Set(items.map(x => x.mint));
      // copies share tickers: biggest first, and dust copies left out
      const toks = (j?.data?.tokens || []).filter(t => (t?.market?.marketCapUsd || 0) >= 10000).sort((a, b) => (b.market?.marketCapUsd || 0) - (a.market?.marketCapUsd || 0));
      for (const t of toks) {
        if (!t?.mint || have.has(t.mint) || items.length >= 6) continue;
        const icon = t.imageUrl ? (t.imageUrl.startsWith('/') ? 'https://www.stonkfun.xyz' + t.imageUrl : t.imageUrl) : null;
        items.push({ mint: t.mint, symbol: t.symbol, name: t.name, icon, platform: 'StonkFun', chain: 'solana', quote: t.quote?.symbol || '', mcap: t.market?.marketCapUsd ?? null, usdPer1kWeek: null, fresh: true });
      }
    } catch {}
  }
  return new Response(JSON.stringify({ items }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
}
