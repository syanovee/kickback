// only our own pages may use the api
const HOSTS = /^(getkickback\.fun|www\.getkickback\.fun|([a-z0-9-]+\.)?kickback-(rewards|test)\.pages\.dev|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/;
const host = u => { try { return new URL(u).host; } catch { return ''; } };
export async function onRequest({ request, next }) {
  const path = new URL(request.url).pathname;
  if (path === '/api/admin' || request.method === 'OPTIONS') return next();
  const site = request.headers.get('sec-fetch-site');
  const from = host(request.headers.get('origin') || '') || host(request.headers.get('referer') || '');
  const ok = site === 'same-origin' || (site !== 'cross-site' && site !== 'same-site' && HOSTS.test(from));
  if (!ok) return new Response('{"error":"forbidden"}', { status: 403, headers: { 'Content-Type': 'application/json' } });
  return next();
}
