async function keyFor(request, tag, body) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tag + '|' + body));
  const h = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(new URL('/__c/' + h, request.url).toString());
}
export async function getCached(ctx, tag, body) {
  if (ctx.request.headers.get('x-kb-nc')) return null;
  const hit = await caches.default.match(await keyFor(ctx.request, tag, body));
  return hit ? hit.text() : null;
}
export async function putCached(ctx, tag, body, ttl, text) {
  const key = await keyFor(ctx.request, tag, body);
  ctx.waitUntil(caches.default.put(key, new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl } })));
}
export async function cached(ctx, tag, body, ttl, fetcher, shouldStore = () => true) {
  if (ttl > 0) { const hit = await getCached(ctx, tag, body); if (hit !== null) return new Response(hit, { headers: { 'Content-Type': 'application/json', 'X-Cache': 'hit' } }); }
  const { status, text } = await fetcher();
  if (ttl > 0 && status === 200 && shouldStore(text)) await putCached(ctx, tag, body, ttl, text);
  return new Response(text, { status, headers: { 'Content-Type': 'application/json', 'X-Cache': 'miss' } });
}
export const okRpc = t => { try { const j = JSON.parse(t); return !j.error && j.result !== null && j.result !== undefined; } catch { return false; } };
export const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
