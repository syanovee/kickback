import { cached, json } from '../../../_lib/cache.js';
// Robinhood Chain token info. The public explorer now answers server requests with a browser check (403),
// so this goes through the Blockscout PRO API with our key, and the public explorer only if no key is set.
export async function onRequestGet(ctx) {
  const a = String(ctx.params.addr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return json({}, 400);
  const key = ctx.env.BLOCKSCOUT_KEY;
  const url = key ? 'https://api.blockscout.com/4663/api/v2/tokens/' + a + '?apikey=' + encodeURIComponent(key)
                  : 'https://robinhoodchain.blockscout.com/api/v2/tokens/' + a;
  return cached(ctx, 'bs-token', a, 600, async () => {
    const r = await fetch(url);
    return { status: r.status, text: await r.text() };
  }, t => t.trim().startsWith('{'));
}
