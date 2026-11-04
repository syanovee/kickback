// Wallet memory: every Solana tx we already read for a wallet, kept as the compact form the browser uses, in D1.
// The Cloudflare cache only lives in one data center, so a wallet checked in Frankfurt was read again in Singapore.
// This is shared everywhere: a wallet is read from the chain once, after that only its new transactions are.
// Only the server writes it (from chain data it fetched itself), so nobody can plant a made-up history.
export const MEM_V = 1;                 // bump when solCompact changes, old rows are then ignored
const T = 'sol_mem', KEEP_DAYS = 45;
let ready = false;
async function init(DB) {
  if (ready) return;
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS ${T} (w TEXT NOT NULL, k TEXT NOT NULL, v INTEGER, ts INTEGER, n INTEGER, d TEXT, PRIMARY KEY (w, k))`),
    DB.prepare(`CREATE INDEX IF NOT EXISTS ${T}_ts ON ${T} (ts)`),
  ]);
  ready = true;
}
const gz = async s => { const b = new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))); const u = new Uint8Array(await b.arrayBuffer()); let o = ''; for (let i = 0; i < u.length; i += 0x8000) o += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(o); };
// one row per batch the server read: the browser gets the rows as they are and unpacks them itself
export async function memPut(env, W, list) {
  if (!env.DB || !list.length) return;
  try {
    await init(env.DB);
    const d = await gz(JSON.stringify(list)), now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT OR REPLACE INTO ${T} (w, k, v, ts, n, d) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(W, list[0].s.slice(0, 24), MEM_V, now, list.length, d).run();
    if (Math.random() < 0.005) await env.DB.prepare(`DELETE FROM ${T} WHERE ts < ?1`).bind(now - KEEP_DAYS * 86400).run();
  } catch {}
}
export async function memGet(env, W) {
  if (!env.DB) return [];
  try { await init(env.DB); return ((await env.DB.prepare(`SELECT d FROM ${T} WHERE w = ?1 AND v = ?2`).bind(W, MEM_V).all()).results || []).map(r => r.d); } catch { return []; }
}
