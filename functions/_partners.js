// Partner keys live in the PARTNER_KEYS secret, e.g.
// {"kb_ocula_xxx":{"name":"Ocula","origins":["https://ocula.fun","https://*.ocula.fun"],"hour":400,"dev":true}}
export const partners = env => { try { return JSON.parse(env.PARTNER_KEYS || '{}'); } catch { return {}; } };
export const originOk = (p, origin) => (p.origins || []).some(o => o === origin || (o.includes('*.') && origin.startsWith(o.split('*.')[0]) && origin.endsWith('.' + o.split('*.')[1])))
  || (!!p.dev && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
export const frameAncestors = env => {
  const set = new Set();
  for (const p of Object.values(partners(env))) { for (const o of p.origins || []) set.add(o); if (p.dev) { set.add('http://localhost:*'); set.add('http://127.0.0.1:*'); } }
  return [...set].join(' ');
};
