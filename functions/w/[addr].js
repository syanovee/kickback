// getkickback.fun/w/<wallet> : a shareable link that opens Kickback and scans that wallet right away
const ok = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s);
export async function onRequestGet({ params, request }) {
  const a = String(params.addr || ''), origin = new URL(request.url).origin;
  return Response.redirect(origin + (ok(a) ? '/?wallet=' + encodeURIComponent(a) + '&go' : '/'), 302);
}
