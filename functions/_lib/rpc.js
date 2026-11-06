// Solana RPC router: one call, several free providers behind it.
// - each method goes only to providers that answer it the same way (checked side by side: tools/rpc-check.mjs)
// - load is spread by weight, so no single free allowance runs out
// - a provider that refuses (key off, rate limit, outage) is skipped right away and rested for a while, the next one answers
// - a wallet's paged history stays with the provider that started it (page tokens only work there)
// Keys come from Cloudflare secrets, never from the browser.
const HIST = new Set(['getTransactionsForAddress']);                       // full wallet history incl. token accounts
const DAS = new Set(['getAssetBatch', 'getAsset']);                        // token names, icons
// weights: higher = more of the traffic. OrbitFlare's free plan allows ~1 history read a second, so it only takes a little.
const ROUTES = { hist: { helius: 5, quicknode: 4, orbitflare: 1 }, das: { helius: 1 }, std: { alchemy: 4, orbitflare: 2, quicknode: 2, helius: 1 } };
const REST_MS = { auth: 30 * 60e3, limit: 60e3, down: 3 * 60e3, soft: 15e3 };        // how long a provider sits out after each kind of refusal
const rest = new Map();                                                   // provider -> until (per worker instance)
export const stats = {};                                                  // provider -> {ok, fail, skip}

function urls(env) {
  const u = {};
  if (env.HELIUS_KEY) u.helius = 'https://mainnet.helius-rpc.com/?api-key=' + env.HELIUS_KEY;
  if (env.QUICKNODE_URL) u.quicknode = env.QUICKNODE_URL;
  if (env.ORBITFLARE_URL) u.orbitflare = env.ORBITFLARE_URL;
  if (env.ALCHEMY_KEY) u.alchemy = 'https://solana-mainnet.g.alchemy.com/v2/' + env.ALCHEMY_KEY;
  return u;
}
const kind = m => HIST.has(m) ? 'hist' : DAS.has(m) ? 'das' : 'std';
// order to try: a weighted random pick first, then the rest by weight; rested providers go last (still tried if all else fails)
function order(route, have) {
  const now = Date.now(), live = [], tired = [];
  for (const [p, w] of Object.entries(route)) if (have[p]) ((rest.get(p) || 0) > now ? tired : live).push([p, w]);
  const pick = [], pool = [...live];
  while (pool.length) { let r = Math.random() * pool.reduce((a, [, w]) => a + w, 0), i = 0; for (; i < pool.length - 1 && (r -= pool[i][1]) > 0; i++); pick.push(pool.splice(i, 1)[0][0]); }
  return [...pick, ...tired.map(([p]) => p)];
}
// what a refusal means: the request is fine, this provider just can't serve it now.
// Status codes and documented error codes decide first; an error message alone (which a caller's own params could provoke)
// only rests the provider for a few seconds ('soft'), so one crafted request can't bench a healthy provider for long.
const AUTH_CODES = new Set([-32401, -32403, -32404]), LIMIT_CODES = new Set([-32005, -32429]);
function refusal(status, text) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'limit';
  if (status >= 500 || status === 0) return 'down';
  let j; try { j = JSON.parse(text); } catch { return 'down'; }
  const e = j?.error; if (!e) return null;
  const c = e.code, msg = String(e.message || '');
  if (AUTH_CODES.has(c)) return 'auth';
  if (LIMIT_CODES.has(c)) return 'limit';
  if (c === -32602) return null;                                          // bad params: every provider would say the same, so answer as is
  if (c === -32601) return 'nomethod';
  if (c === -32603) return 'down';
  // the request itself is wrong (bad page token, tx version): answer as is
  if (/bad request|invalid|maxSupportedTransactionVersion|transaction version|wrongsize|expected/i.test(msg)) return null;
  if (/method not found|unsupported method|method .*not supported|not available on/i.test(msg)) return 'nomethod';
  if (/api.?key|unauthori[sz]ed|forbidden|suspend|whitelist|upgrade your plan|plan (limit|does not)|rate.?limit|too many requests|over capacity|exceeded|out of credits|credits? (limit|exhausted|exceeded)|request limit|daily limit|monthly limit|internal error|timeout|timed out|unavailable|try again/i.test(msg)) return 'soft';
  return null;                                                            // a real answer: every provider would say the same
}
// page tokens carry the provider that issued them: "qn~<token>"
const TAG = { helius: 'he', quicknode: 'qn', orbitflare: 'of', alchemy: 'al' }, UNTAG = Object.fromEntries(Object.entries(TAG).map(([k, v]) => [v, k]));
function stick(params) {
  const o = params?.[1]; const t = o?.paginationToken; if (typeof t !== 'string') return { params, only: null };
  const m = /^([a-z]{2})~(.*)$/s.exec(t); if (!m || !UNTAG[m[1]]) return { params, only: 'helius' };   // old untagged tokens came from Helius
  return { params: [params[0], { ...o, paginationToken: m[2] }, ...params.slice(2)], only: UNTAG[m[1]] };
}
function retag(text, p) {
  if (!text.includes('paginationToken')) return text;
  try { const j = JSON.parse(text); if (j?.result?.paginationToken) { j.result.paginationToken = TAG[p] + '~' + j.result.paginationToken; return JSON.stringify(j); } } catch {}
  return text;
}
// one JSON-RPC call through the router. Returns {status, text, via}
export async function solRpc(env, method, params, { timeout = 25000 } = {}) {
  const have = urls(env), k = kind(method), s = stick(params);
  const list = s.only ? (have[s.only] ? [s.only] : []) : order(ROUTES[k], have);
  let last = { status: 503, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'no Solana provider available right now' } }), via: null };
  for (const p of list) {
    let status = 0, text = '', why = null;
    // a paged read can't move to another provider, so a short rate limit there is waited out (a few tries) instead of failing the page
    for (let a = 0; a < (s.only ? 4 : 1); a++) {
      if (a) await new Promise(r => setTimeout(r, 600 * a + Math.random() * 400));
      status = 0; text = '';
      try { const r = await fetch(have[p], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: s.params }), signal: AbortSignal.timeout(timeout) });
        status = r.status; text = await r.text(); } catch { status = 0; }
      why = refusal(status, text);
      if (why !== 'limit' && why !== 'down') break;
    }
    const st = stats[p] || (stats[p] = { ok: 0, fail: 0 });
    if (!why) { st.ok++; return { status, text: retag(text, p), via: p }; }
    st.fail++; last = { status: status || 503, text: text || last.text, via: p };
    if (why !== 'nomethod') rest.set(p, Date.now() + REST_MS[why]);
    if (s.only) break;                                                    // a paged read can't move to another provider mid-way
  }
  return last;
}
