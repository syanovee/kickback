import { cached, getCached, putCached, okRpc, json } from '../../_lib/cache.js';
import { EVM_PARAMS } from '../../_lib/params.js';
import { charge } from '../../_lib/budget.js';
const NETS = new Set(['bnb-mainnet', 'robinhood-mainnet', 'eth-mainnet', 'base-mainnet', 'solana-mainnet']);
const ALLOWED = new Set(['alchemy_getAssetTransfers','eth_call','eth_getBalance','eth_getCode','eth_getTransactionByHash',
  'eth_getTransactionReceipt','eth_blockNumber',
  'getTransaction','getSlot']);
const STATIC_SELECTORS = new Set(['0xfc0c546a','0xe7d015f2','0x6124e4e7','0x95d89b41','0x313ce567','0x6234b84f','0x999b93af']);
const DAY = 86400, MAX_BATCH = 40;   // the page sends at most 40 per batch

function ttlFor(m, p) {
  if (m === 'eth_getTransactionReceipt' || m === 'eth_getTransactionByHash' || m === 'getTransaction') return 30 * DAY;
  if (m === 'eth_getCode') return DAY;
  if (m === 'eth_call') { const data = String(p?.[0]?.data || ''); return data.length === 10 && STATIC_SELECTORS.has(data.toLowerCase()) ? 7 * DAY : 0; }
  if (m === 'eth_getBalance') { const b = p?.[1]; return typeof b === 'string' && b.startsWith('0x') ? 30 * DAY : 0; }
  if (m === 'alchemy_getAssetTransfers') {
    const q = p?.[0] || {};
    if (q.contractAddresses && q.maxCount === '0x1' && q.order === 'asc') return 30 * DAY;
    if (q.fromAddress && q.toAddress && q.maxCount === '0x1') return DAY;   // 'did X ever pay Y' checks (Pons escrow): same answer for a day
  }
  return 0;
}
const storable = m => m === 'eth_call'
  ? (t => { try { const j = JSON.parse(t); return j.result !== undefined || /revert/i.test(j.error?.message || ''); } catch { return false; } })
  : okRpc;

export async function onRequestPost(ctx) {
  const { request, env, params } = ctx;
  if (!NETS.has(params.net)) return json({ error: { message: 'unknown network' } }, 404);
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: 'bad json' } }, 400); }
  const url = `https://${params.net}.g.alchemy.com/v2/${env.ALCHEMY_KEY}`, tag = 'alchemy:' + params.net;

  if (!env.ALCHEMY_KEY) return json({ error: { message: 'not configured' } }, 503);
  // params are rebuilt from the shapes the page sends (_lib/params.js), never forwarded as given
  const clean = x => ALLOWED.has(x?.method) ? EVM_PARAMS[x.method](x.params) : null;
  if (!Array.isArray(body)) {
    const m = body?.method, p = clean(body);
    if (!p) return json({ error: { message: 'method not allowed' } }, 403);
    const upstream = async () => {
      const over = await charge(ctx, 1); if (over) return { status: 429, text: '{"error":"budget"}' };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
      return { status: r.status, text: await r.text() };
    };
    return cached(ctx, tag, JSON.stringify([m, p]), ttlFor(m, p), upstream, storable(m));
  }

  if (!body.length || body.length > MAX_BATCH) return json({ error: { message: 'batch not allowed' } }, 403);
  const ps = body.map(clean);
  body = body.map((x, i) => ({ id: x?.id, method: x?.method, params: ps[i] }));
  const out = new Array(body.length), miss = [];
  await Promise.all(body.map(async (x, i) => {
    if (!x.params) { out[i] = { jsonrpc: '2.0', id: x.id, error: { code: -32602, message: 'params not allowed' } }; return; }
    const ttl = ttlFor(x.method, x.params), ck = JSON.stringify([x.method, x.params]);
    if (ttl > 0) { const hit = await getCached(ctx, tag, ck); if (hit !== null) { out[i] = { ...JSON.parse(hit), id: x.id }; return; } }
    miss.push({ i, x, ttl, ck });
  }));
  if (miss.length) {
    let arr = null, status = 0;
    const over = await charge(ctx, miss.length);   // every call in the batch counts against the session
    if (over) return over;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(miss.map((m, k) => ({ jsonrpc: '2.0', id: k, method: m.x.method, params: m.x.params }))) });
      status = r.status; if (r.ok) arr = await r.json();
    } catch {}
    const byId = {}; if (Array.isArray(arr)) for (const a of arr) byId[a.id] = a;
    for (let k = 0; k < miss.length; k++) {
      const m = miss[k], a = byId[k];
      if (!a) { const busy = !status || status === 429 || status >= 500; out[m.i] = { jsonrpc: '2.0', id: m.x.id, error: { code: busy ? 429 : status, message: busy ? 'rate limited upstream (' + status + ')' : 'upstream refused (' + status + ')' } }; continue; }
      const text = JSON.stringify({ jsonrpc: '2.0', id: 1, ...(a.error ? { error: a.error } : { result: a.result }) });
      if (m.ttl > 0 && storable(m.x.method)(text)) await putCached(ctx, tag, m.ck, m.ttl, text);
      out[m.i] = { ...JSON.parse(text), id: m.x.id };
    }
  }
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'X-Cache': miss.length ? 'partial' : 'hit', 'X-Batch': String(body.length) } });
}
