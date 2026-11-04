// GET /api/solmem?w=<wallet>: the wallet's Solana transactions we already read (gzip+base64 parts of compact txs).
// The scan still lists the wallet's signatures fresh from the chain and only uses remembered txs that are in that list.
import { json } from '../_lib/cache.js';
import { memGet } from '../_lib/solmem.js';
const isAddr = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export async function onRequestGet({ request, env }) {
  const w = new URL(request.url).searchParams.get('w') || '';
  if (!isAddr(w)) return json({ p: [] });
  return new Response(JSON.stringify({ p: await memGet(env, w) }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
