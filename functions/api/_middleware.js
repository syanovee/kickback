import { overLimit } from '../_lib/ratelimit.js';
// only our own pages may use the api
const HOSTS = /^(getkickback\.fun|www\.getkickback\.fun|([a-z0-9-]+\.)?kickback-(rewards|test)\.pages\.dev|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/;
const host = u => { try { return new URL(u).host; } catch { return ''; } };
export async function onRequest(ctx) {
  const { request, next } = ctx;
  const path = new URL(request.url).pathname;
  if (path === '/api/admin' || path === '/api/yield/ingest' || request.method === 'OPTIONS') return next();  // both check their own key
  // link preview pictures are fetched by X, Telegram and Discord bots, which send no origin
  if (path === '/api/wcard' && request.method === 'GET') return next();
  const site = request.headers.get('sec-fetch-site');
  const from = host(request.headers.get('origin') || '') || host(request.headers.get('referer') || '');
  const ok = site === 'same-origin' || (site !== 'cross-site' && site !== 'same-site' && HOSTS.test(from));
  if (!ok) return new Response('{"error":"forbidden"}', { status: 403, headers: { 'Content-Type': 'application/json' } });
  // the origin check above can be faked by a script, so every address also has a request budget
  const { wait } = await overLimit(ctx);
  if (wait) return new Response('{"error":"too many requests, try again soon"}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(wait) } });
  return next();
}
