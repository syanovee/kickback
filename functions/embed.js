// getkickback.fun/embed : the scanner with no UI, loaded in a hidden frame by /kickback.js on partner sites.
// Only partner origins may frame it (the rest of the site stays frame-ancestors 'none').
import { frameAncestors } from './_partners.js';
export async function onRequestGet({ request, env }) {
  const page = await env.ASSETS.fetch(new URL('/', request.url));
  const anc = frameAncestors(env);
  return new Response(page.body, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
    'Content-Security-Policy': `frame-ancestors ${anc || "'none'"}; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; base-uri 'self'; object-src 'none'; form-action 'self'`,
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' } });
}
