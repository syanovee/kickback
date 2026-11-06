// Signed tokens and the security headers every response gets.
// Session token: issued once per page visit (POST /api/session), sent back in the x-kb-s header on every paid call,
// so all provider use is tied to a session with its own hard cap.
// Run token: issued when a check starts (POST /api/run) for exactly those wallets; every write about a result
// (log, saved result, link preview, card, rank) must carry it, so a client-made run id authorises nothing.
const enc = new TextEncoder();
const keys = new Map();
async function key(env) {
  // KB_SECRET only: no fallback to a provider key, so one secret never does two jobs
  if (!env.KB_SECRET || String(env.KB_SECRET).length < 32) throw new Error('KB_SECRET is not set');
  const raw = env.KB_SECRET;
  let k = keys.get(raw);
  if (!k) { k = await crypto.subtle.importKey('raw', enc.encode(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); keys.set(raw, k); }
  return k;
}
const b64u = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
async function mac(env, s) { return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), enc.encode(s)))).slice(0, 32); }
// constant-time compare of two short strings
function same(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
export const rid = (n = 12) => b64u(crypto.getRandomValues(new Uint8Array(n)));

// "s1.<id>.<exp>.<mac>"
export async function makeSession(env, ttl, tier = 'f') { const id = tier + rid(), exp = Math.floor(Date.now() / 1000) + ttl; return { t: `s1.${id}.${exp}.${await mac(env, `s1|${id}|${exp}`)}`, id, exp }; }
export async function readSession(env, t) {
  const m = /^s1\.([A-Za-z0-9_-]{8,24})\.(\d{10})\.([A-Za-z0-9_-]{32})$/.exec(String(t || '')); if (!m) return null;
  if (+m[2] < Date.now() / 1000) return null;
  return same(m[3], await mac(env, `s1|${m[1]}|${m[2]}`)) ? { id: m[1], exp: +m[2] } : null;
}
// wallet set as one canonical string (sorted, EVM lower-cased), the same key the saved results use
export const walletKey = ws => [...new Set((ws || []).map(w => String(w).startsWith('0x') ? String(w).toLowerCase() : String(w)))].sort().join(' ');
// "r1.<run>.<sid>.<iat>.<mac>": mac covers the wallets too, so the token is only good for that wallet set
export async function makeRun(env, sid, wallets) { const run = rid(), iat = Math.floor(Date.now() / 1000); return { t: `r1.${run}.${sid}.${iat}.${await mac(env, `r1|${run}|${sid}|${iat}|${walletKey(wallets)}`)}`, run }; }
export async function readRun(env, t, wallets, maxAge = 2 * 86400) {
  const m = /^r1\.([A-Za-z0-9_-]{8,24})\.([A-Za-z0-9_-]{8,24})\.(\d{10})\.([A-Za-z0-9_-]{32})$/.exec(String(t || '')); if (!m) return null;
  if (+m[3] < Date.now() / 1000 - maxAge) return null;
  return same(m[4], await mac(env, `r1|${m[1]}|${m[2]}|${m[3]}|${walletKey(wallets)}`)) ? { run: m[1], sid: m[2], iat: +m[3] } : null;
}

// headers for everything a Function sends (static files get theirs from public/_headers)
export const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
export const PAGE_CSP = "script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'";
