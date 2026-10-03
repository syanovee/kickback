import { json } from '../_lib/cache.js';
const isAddr = s => typeof s === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s));
const ABC = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no db' }, 503);
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(b?.img || '');
  const total = Number(b?.total), handle = typeof b?.handle === 'string' ? b.handle.replace(/[^A-Za-z0-9_]/g, '').slice(0, 15) : '';
  if (!m || m[1].length > 2_600_000 || !isAddr(b?.w) || !Number.isFinite(total) || total < 0 || total > 5e6) return json({ error: 'bad request' }, 400);
  const bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) return json({ error: 'bad image' }, 400);
  const rnd = crypto.getRandomValues(new Uint8Array(8)); const id = [...rnd].map(x => ABC[x % ABC.length]).join('');
  await env.DB.exec('CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, w TEXT NOT NULL, total REAL NOT NULL, handle TEXT, img BLOB NOT NULL, t INTEGER NOT NULL)');
  try { await env.DB.exec("ALTER TABLE cards ADD COLUMN kind TEXT"); } catch {}
  try { await env.DB.exec("ALTER TABLE cards ADD COLUMN test INTEGER"); } catch {}
  // cards made on the test site still work (links, previews) but stay out of the admin
  const test = /(^|\.)getkickback\.fun$/.test(new URL(request.url).hostname) ? 0 : 1;
  await env.DB.prepare('INSERT INTO cards (id, w, total, handle, img, t, kind, test) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(id, b.w, Math.round(total * 100) / 100, handle, bytes, Math.floor(Date.now() / 1000), b?.studio ? 'studio' : b?.kind === 'copy' ? 'copy' : b?.kind === 'knots' ? 'knots' : '', test).run();
  return json({ id });
}
