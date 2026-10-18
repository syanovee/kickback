// Coin icons through our own domain, cached at the edge. Third-party icon hosts and the resizer are slow or flaky
// from some networks, so the page asks us instead and gets the same picture back fast after the first time.
const MAX = 3_000_000;
export async function onRequestGet(ctx) {
  const raw = new URL(ctx.request.url).searchParams.get('u') || '';
  let u; try { u = new URL(raw); } catch { return new Response('bad url', { status: 400 }); }
  if (u.protocol !== 'https:' || /(^|\.)(localhost|getkickback\.fun|pages\.dev)$/i.test(u.hostname) || /^[\d.:[\]]+$/.test(u.hostname)) return new Response('bad url', { status: 400 });
  const key = new Request('https://kb.cache/img/' + encodeURIComponent(u.toString()));
  const hit = await caches.default.match(key); if (hit) return hit;
  let r = null;
  try { r = await fetch(u.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 kickback' }, cf: { cacheTtl: 86400, cacheEverything: true } }); } catch {}
  let ok = r && r.ok && /^image\//.test(r.headers.get('Content-Type') || '');
  if (!ok) { // some hosts refuse us: try the resizer once
    try { r = await fetch('https://wsrv.nl/?url=' + encodeURIComponent(u.toString()) + '&w=256&h=256&fit=cover&output=png'); ok = r.ok; } catch { ok = false; }
  }
  if (!ok) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=600' } });
  const buf = await r.arrayBuffer(); if (buf.byteLength > MAX) return new Response('too big', { status: 413 });
  const res = new Response(buf, { headers: {
    'Content-Type': r.headers.get('Content-Type') || 'image/png',
    'Cache-Control': 'public, max-age=604800',
    // an svg opened directly must not run anything on our origin
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff' } });
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}
