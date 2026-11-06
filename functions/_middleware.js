// Security headers on every response a Function builds. Cloudflare applies public/_headers to static files only,
// so without this /w/, /s/, /c/, /embed and every /api route went out bare.
// public/_routes.json keeps static files from running this (they get _headers instead).
import { BASE_HEADERS, PAGE_CSP } from './_lib/sec.js';
export async function onRequest({ request, next }) {
  let res;
  try { res = await next(); } catch (e) { res = new Response('{"error":"server error"}', { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  const out = new Response(res.body, res), h = out.headers, path = new URL(request.url).pathname;
  for (const [k, v] of Object.entries(BASE_HEADERS)) if (!h.has(k)) h.set(k, v);
  const html = /text\/html/i.test(h.get('Content-Type') || '');
  if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', html ? PAGE_CSP + "; frame-ancestors 'none'" : "default-src 'none'; frame-ancestors 'none'; sandbox");
  if (path !== '/embed' && !h.has('X-Frame-Options')) h.set('X-Frame-Options', 'DENY');
  return out;
}
