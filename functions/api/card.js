import { json } from '../_lib/cache.js';
import { readRun, walletKey } from '../_lib/sec.js';
import { bump, ipKey } from '../_lib/ratelimit.js';
const isAddr = s => typeof s === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s));
const ABC = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_B64 = 900_000;   // a 1600x900 card at the page's quality is well under this
const DAY_BYTES = 40_000_000; // all new cards together, per day: the database can't be filled through here
// POST {w, wallets, run, tok, total, handle, img}: a share card. Needs the run token /api/run signed for the check it came from,
// the card's wallet must be one of that check's wallets, and its total can't be more than the check found.
export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  if (!env.DB) return json({ error: 'no db' }, 503);
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(b?.img || '');
  const total = Number(b?.total), handle = typeof b?.handle === 'string' ? b.handle.replace(/[^A-Za-z0-9_]/g, '').slice(0, 15) : '';
  const ws = Array.isArray(b?.wallets) ? b.wallets.filter(isAddr).slice(0, 10) : [];
  if (!m || m[1].length > MAX_B64 || !isAddr(b?.w) || !Number.isFinite(total) || total < 0 || total > 5e6 || typeof b.run !== 'string') return json({ error: 'bad request' }, 400);
  const norm = w => w.startsWith('0x') ? w.toLowerCase() : w;
  const tok = ws.length ? await readRun(env, b.tok, ws) : null;
  if (!tok || tok.run !== b.run || !ws.map(norm).includes(norm(b.w))) return json({ error: 'bad run token' }, 403);
  const a = await bump(ctx, 'card|' + ipKey(request), [[3600, 20], [86400, 60]]), c = await bump(ctx, 'cardrun|' + tok.run, [[86400, 12]]);
  if (a.wait || c.wait) return json({ error: 'too many cards, try again later' }, 429);
  if ((await bump(ctx, 'cardbytes', [[86400, DAY_BYTES]], m[1].length)).wait) return json({ error: 'too many cards today, try again tomorrow' }, 429);
  const prod = /(^|\.)getkickback\.fun$/.test(new URL(request.url).hostname);
  const r = await env.DB.prepare(`SELECT MAX(COALESCE(total_final,0), COALESCE(total,0)) AS t FROM ${prod ? 'scan_log' : 'scan_log_test'} WHERE run = ?1 AND COALESCE(flags,'') != 'event-only'`).bind(b.run).first().catch(() => null);
  // still running, with the wallet's saved result on screen: the saved result (checked against an earlier logged check) sets the limit
  const s = r ? null : await env.DB.prepare(`SELECT total FROM ${prod ? 'scan_snap' : 'scan_snap_test'} WHERE k = ?1 AND v = 2`).bind(walletKey(ws)).first().catch(() => null);
  const max = r ? (r.t || 0) : s ? (s.total || 0) : -1;
  if (max < 0 || total > max * 1.01 + 1) return json({ error: 'total does not match the check' }, 403);
  const bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) return json({ error: 'bad image' }, 400);
  const rnd = crypto.getRandomValues(new Uint8Array(8)); const id = [...rnd].map(x => ABC[x % ABC.length]).join('');
  await env.DB.exec('CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, w TEXT NOT NULL, total REAL NOT NULL, handle TEXT, img BLOB NOT NULL, t INTEGER NOT NULL)');
  try { await env.DB.exec("ALTER TABLE cards ADD COLUMN kind TEXT"); } catch {}
  try { await env.DB.exec("ALTER TABLE cards ADD COLUMN test INTEGER"); } catch {}
  // cards made on the test site still work (links, previews) but stay out of the admin
  const test = prod ? 0 : 1;
  await env.DB.prepare('INSERT INTO cards (id, w, total, handle, img, t, kind, test) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(id, b.w, Math.round(total * 100) / 100, handle, bytes, Math.floor(Date.now() / 1000), b?.studio ? 'studio' : b?.kind === 'copy' ? 'copy' : b?.kind === 'knots' ? 'knots' : '', test).run();
  return json({ id });
}
