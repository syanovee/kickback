import { cached, okRpc, json, putCached, getCached } from '../_lib/cache.js';
import { TX_OPTS, txKey } from '../_lib/soltx.js';
import { solRpc } from '../_lib/rpc.js';
import { SOL_PARAMS } from '../_lib/params.js';
import { charge } from '../_lib/budget.js';
// the methods the page uses, each with its params rebuilt from the shapes the page sends (_lib/params.js)
const ALLOWED = new Set(['getTokenAccountsByOwner','getTransactionsForAddress','getAssetBatch','getTransaction',
  'getSignaturesForAddress','getAccountInfo','getMultipleAccounts','getBalance']);
const DAY = 86400;

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: 'bad json' } }, 400); }
  if (Array.isArray(body) || !ALLOWED.has(body?.method)) return json({ error: { message: 'method not allowed' } }, 403);
  const m = body.method, p = SOL_PARAMS[m](body.params);
  if (!p) return json({ error: { code: -32602, message: 'params not allowed' } }, 400);
  let ttl = 0;
  if (m === 'getTransactionsForAddress' && p[1].sortOrder === 'asc' && p[1].limit === 1) ttl = 30 * DAY;
  else if (m === 'getTransaction') ttl = 30 * DAY;
  else if (m === 'getAssetBatch') ttl = DAY;
  else if (m === 'getTransactionsForAddress' && p[1].transactionDetails === 'signatures' && p[1].filters?.blockTime?.lt
           && p[1].filters.blockTime.lt < Date.now() / 1000 - 3600) ttl = 7 * DAY;
  // every call goes through the router: the right providers for the method, spread by weight, the next one answers if one refuses.
  // each upstream call is charged to the session that asked for it
  const upstream = async () => {
    const over = await charge(ctx, 1);
    if (over) return { status: 429, text: '{"error":"budget"}' };
    return solRpc(env, m, p);
  };
  // a page that points to a next page is tied to the provider that made it: not kept, so a cached page never sends a read to a provider that has since gone
  const res = await cached(ctx, 'helius', JSON.stringify([m, p]), ttl, upstream, t => okRpc(t) && !/"paginationToken"\s*:\s*"/.test(t));
  if (m === 'getTransactionsForAddress' && p[1].transactionDetails === 'full' && res.status === 200) {
    try {
      const j = await res.clone().json(), now = Date.now() / 1000;
      for (const tx of j?.result?.data || []) {
        const sig = tx?.transaction?.signatures?.[0];
        if (sig && tx.blockTime && now - tx.blockTime > 120) await putCached(ctx, 'alchemy:solana-mainnet', txKey(sig), 30 * DAY, JSON.stringify({ jsonrpc: '2.0', id: 1, result: tx }));
      }
    } catch {}
  }
  return res;
}
