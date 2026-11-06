// Per-session budget: each paid upstream call is charged to the session that asked for it, with a hard cap.
// A session is one page visit (POST /api/session); an address can only open so many per hour (api/session.js).
import { bump, overLimit } from './ratelimit.js';
export const SESSION_TTL = 6 * 3600;
export const SESSION_WINDOWS = [[SESSION_TTL, 30000]];
export const LIGHT_WINDOWS = [[SESSION_TTL, 15000]];   // sessions without a passed Turnstile check
// charge n upstream calls (and ipUnits more to the address budget); returns a 429 Response when out of budget, else null
export async function charge(ctx, n = 1, ipUnits = 0) {
  const sid = ctx.data?.sid; if (!sid || n <= 0) return null;
  const [a, b] = await Promise.all([bump(ctx, 's|' + sid, sid[0] === 'l' ? LIGHT_WINDOWS : SESSION_WINDOWS, n), ipUnits > 0 ? overLimit(ctx, ipUnits) : { wait: 0 }]);
  const wait = Math.max(a.wait, b.wait);
  return wait ? new Response('{"error":"budget"}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.min(wait, 600)) } }) : null;
}
