// POST /api/session: a short-lived signed session for this page visit. Paid api routes need it (x-kb-s header)
// and charge their upstream calls to it, so one page visit has a hard cap and an address can only open a few per hour.
import { json } from '../_lib/cache.js';
import { bump, ipKey } from '../_lib/ratelimit.js';
import { makeSession } from '../_lib/sec.js';
import { SESSION_TTL } from '../_lib/budget.js';
// With TURNSTILE_SECRET set, a session whose Turnstile check passed is a full one ('f'); without a passing check
// (the check's script blocked, a script calling us directly) it is a light one ('l') with a small budget and a tight count per address.
async function human(env, token, ip, host) {
  if (!env.TURNSTILE_SECRET) return true;                          // not configured: everyone gets a full session
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const f = new FormData(); f.append('secret', env.TURNSTILE_SECRET); f.append('response', token); if (ip) f.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: f });
    const j = await r.json();
    return !!j?.success && (!j.hostname || j.hostname === host);   // a token solved on another site doesn't count
  } catch { return false; }
}
const tooMany = wait => new Response('{"error":"too many sessions, try again soon"}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(wait) } });
export async function onRequestPost(ctx) {
  let b = {}; try { b = await ctx.request.json(); } catch {}
  const ip = ipKey(ctx.request), full = await human(ctx.env, b?.ts, ctx.request.headers.get('cf-connecting-ip'), new URL(ctx.request.url).hostname);
  const { wait } = await bump(ctx, (full ? 'sess|' : 'sessl|') + ip, full ? [[3600, 300], [86400, 2000]] : [[3600, 12], [86400, 60]]);
  if (wait) return tooMany(wait);
  const s = await makeSession(ctx.env, SESSION_TTL, full ? 'f' : 'l');
  return new Response(JSON.stringify({ t: s.t, exp: s.exp, full }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
