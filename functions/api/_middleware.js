import { overLimit } from '../_lib/ratelimit.js';
import { readSession } from '../_lib/sec.js';
// only our own pages may use the api
const HOSTS = /^(getkickback\.fun|www\.getkickback\.fun|([a-z0-9-]+\.)?kickback-(rewards|test)\.pages\.dev|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/;
const host = u => { try { return new URL(u).host; } catch { return ''; } };
// routes that spend a provider key: they need a session (x-kb-s header from POST /api/session), and each call is charged to it
const PAID = /^\/api\/((helius|solscan|relay|price|soltx|solmem|run|partner)$|(alchemy|fomo|bs|stonk)\/)/;
const json = (o, s, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...h } });
export async function onRequest(ctx) {
  const { request, next, env } = ctx;
  const path = new URL(request.url).pathname;
  if (path === '/api/admin' || path === '/api/yield/ingest' || path === '/api/coins/ingest' || request.method === 'OPTIONS') return next();  // these check their own key
  // link preview pictures are fetched by X, Telegram and Discord bots, which send no origin
  if (path === '/api/wcard' && request.method === 'GET') return next();
  const site = request.headers.get('sec-fetch-site');
  const from = host(request.headers.get('origin') || '') || host(request.headers.get('referer') || '');
  const ok = site === 'same-origin' || (site !== 'cross-site' && site !== 'same-site' && HOSTS.test(from));
  if (!ok) return json({ error: 'forbidden' }, 403);
  // the origin check above can be faked by a script, so every address also has a request budget.
  // a JSON batch counts by its size (one unit per 10 calls), not as one request
  let weight = 1;
  if (request.method === 'POST' && path.startsWith('/api/alchemy/')) {
    try { const b = await request.clone().json(); if (Array.isArray(b)) weight = Math.max(1, Math.ceil(b.length / 10)); } catch {}
  }
  const { wait } = await overLimit(ctx, weight);
  if (wait) return json({ error: 'too many requests, try again soon' }, 429, { 'Retry-After': String(wait) });
  if (PAID.test(path)) {
    const s = await readSession(env, request.headers.get('x-kb-s'));
    if (!s) return json({ error: 'session' }, 401);
    ctx.data.sid = s.id;
  }
  return next();
}
