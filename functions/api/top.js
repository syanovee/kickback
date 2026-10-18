// Public: the biggest bags found by scans, for the homepage deck. Totals, coins and the X handle if the person typed one. Never a wallet.
const MIN = 1000;
const bad = f => /event-only|studio|embed|knots/.test(f || '');
export async function onRequestGet({ env }) {
  if (!env.DB) return json({ items: [] });
  let rows = [], skip = new Set();
  try {
    rows = (await env.DB.prepare(`SELECT ts, wallets, handle, COALESCE(total_final, total) AS t, coins, plats, payouts, flags FROM scan_log
      WHERE COALESCE(total_final, total) >= ?1 AND coins IS NOT NULL AND coins != '[]' ORDER BY t DESC LIMIT 400`).bind(MIN).all()).results || [];
  } catch {}
  // wallets already on the wall (posted cards) show there with their real post, so leave them out here
  try { for (const r of (await env.DB.prepare('SELECT c.w FROM wall w JOIN cards c ON c.id = w.id').all()).results || []) for (const a of String(r.w || '').split(/[ ,]+/)) if (a) skip.add(a); } catch {}
  // wallets the owner asked to keep off the homepage
  try { await env.DB.exec('CREATE TABLE IF NOT EXISTS top_hide (wallet TEXT PRIMARY KEY)'); for (const r of (await env.DB.prepare('SELECT wallet FROM top_hide').all()).results || []) skip.add(r.wallet); } catch {}
  const by = new Map();
  for (const r of rows) {
    if (bad(r.flags)) continue;
    const ws = String(r.wallets || '').split(' ').filter(Boolean); if (!ws.length || ws.some(w => skip.has(w))) continue;
    const k = ws.slice().sort().join(' '), cur = by.get(k);
    if (!cur) by.set(k, { ...r, handle: r.handle || '' });
    else if (!cur.handle && r.handle) cur.handle = r.handle;   // rows come biggest first, so keep that total and borrow a handle from another scan of the same wallet
  }
  // old scans logged no coin icons; borrow one from any newer scan that has the same coin
  const icon = {};
  try { for (const r of (await env.DB.prepare(`SELECT coins FROM scan_log WHERE coins LIKE '%"i":%' ORDER BY ts DESC LIMIT 500`).all()).results || []) for (const c of JSON.parse(r.coins || '[]')) if (c.i && c.s && !icon[c.s]) icon[c.s] = c.i; } catch {}
  // still no icon: look the ticker up once (Jupiter, then DexScreener) and keep the answer in the db
  try {
    const want = new Set();
    for (const r of [...by.values()].slice(0, 8)) for (const c of JSON.parse(r.coins || '[]').slice(0, 7)) if (c.s && !c.i && !icon[c.s]) want.add(c.s);
    if (want.size) {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS sym_icon (sym TEXT PRIMARY KEY, icon TEXT, t INTEGER)');
      const now = Math.floor(Date.now() / 1000), have = new Set();
      for (const r of (await env.DB.prepare(`SELECT sym, icon, t FROM sym_icon WHERE sym IN (${[...want].map(() => '?').join(',')})`).bind(...want).all()).results || []) {
        if (r.icon) icon[r.sym] = r.icon;
        if (r.icon || now - r.t < 3 * 86400) have.add(r.sym);   // a miss is retried after 3 days
      }
      const look = [...want].filter(s => !have.has(s)).slice(0, 20);
      const found = await Promise.all(look.map(s => findIcon(s).catch(() => null)));
      const st = look.map((s, k) => { if (found[k]) icon[s] = found[k]; return env.DB.prepare('INSERT OR REPLACE INTO sym_icon (sym, icon, t) VALUES (?1, ?2, ?3)').bind(s, found[k] || '', now); });
      if (st.length) await env.DB.batch(st);
    }
  } catch {}
  const items = [...by.values()].slice(0, 8).map((r, i) => {
    let coins = [], plats = [];
    try { coins = JSON.parse(r.coins).slice(0, 7).map(c => ({ s: String(c.s || '?').slice(0, 16), u: +c.u || 0, ...(c.i || icon[c.s] ? { i: c.i || icon[c.s] } : {}), ...(c.f ? { f: c.f } : {}) })); } catch {}
    try { plats = Object.entries(JSON.parse(r.plats || '{}')).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k); } catch {}
    return { k: 's' + i + '-' + Math.round(r.t), total: Math.round(r.t * 100) / 100, handle: (r.handle || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15), coins, n: (() => { try { return JSON.parse(r.coins).length; } catch { return coins.length; } })(), plats, payouts: r.payouts | 0, ts: r.ts | 0 };
  });
  return json({ items });
}
const json = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } });

const norm = s => String(s || '').toUpperCase().replace(/^\$/, '');
async function findIcon(sym) {
  const q = norm(sym);
  try {
    const j = await fetch('https://lite-api.jup.ag/tokens/v2/search?query=' + encodeURIComponent(String(sym).replace(/^\$/, '')), { cf: { cacheTtl: 86400, cacheEverything: true } }).then(r => r.ok ? r.json() : null);
    const hit = (Array.isArray(j) ? j : []).filter(t => t.icon && norm(t.symbol) === q)
      .sort((a, b) => (b.isVerified ? 1 : 0) - (a.isVerified ? 1 : 0) || (b.liquidity || b.mcap || 0) - (a.liquidity || a.mcap || 0))[0];
    if (hit) return hit.icon;
  } catch {}
  try {
    const j = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q), { cf: { cacheTtl: 86400, cacheEverything: true } }).then(r => r.ok ? r.json() : null);
    const hit = (j?.pairs || []).filter(p => p.info?.imageUrl && norm(p.baseToken?.symbol) === q).sort((a, b) => (b.marketCap || b.fdv || 0) - (a.marketCap || a.fdv || 0))[0];
    if (hit) return hit.info.imageUrl;
  } catch {}
  return null;
}
