import { cached, json } from '../../../_lib/cache.js';
export async function onRequestGet(ctx) {
  const a = String(ctx.params.addr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return json({}, 400);
  return cached(ctx, 'bs-token', a, 600, async () => {
    const r = await fetch('https://robinhoodchain.blockscout.com/api/v2/tokens/' + a);
    return { status: r.status, text: await r.text() };
  });
}
