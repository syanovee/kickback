/*! Kickback partner SDK, docs: getkickback.fun/docs
 *  const data = await Kickback.scan(wallet, { key, helius, onUpdate, onProgress })
 *  Runs the Kickback scanner in a hidden frame and resolves with JSON. */
(function () {
  var ORIGIN = null, frame = null, ready = null, seq = 0, waiting = {};
  function boot() {
    if (ready) return ready;
    ORIGIN = (window.KICKBACK_ORIGIN || 'https://getkickback.fun').replace(/\/+$/, '');
    ready = new Promise(function (res, rej) {
      window.addEventListener('message', function (e) {
        if (e.origin !== ORIGIN || !e.data) return;
        var d = e.data, w = waiting[d.id];
        if (d.type === 'kickback:ready') return res();
        if (!w) return;
        if (d.type === 'kickback:progress' && w.onProgress) w.onProgress(d.text);
        if (d.type === 'kickback:result') { if (w.onUpdate) w.onUpdate(d.data, !!d.final); if (d.final) { delete waiting[d.id]; clearTimeout(w.t); w.resolve(d.data); } }
        if (d.type === 'kickback:error') { delete waiting[d.id]; clearTimeout(w.t); w.reject(new Error(d.error)); }
      });
      frame = document.createElement('iframe');
      frame.src = ORIGIN + '/embed';
      frame.title = 'Kickback scanner'; frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
      // kept inside the viewport (1px, invisible) so browsers don't throttle it
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none;z-index:-1';
      (document.body || document.documentElement).appendChild(frame);
      setTimeout(function () { rej(new Error('Kickback frame did not load')); }, 20000);
    });
    ready.catch(function () { ready = null; });
    return ready;
  }
  window.Kickback = {
    scan: function (wallet, opts) {
      opts = opts || {};
      return boot().then(function () {
        return new Promise(function (resolve, reject) {
          var id = ++seq;
          waiting[id] = { resolve: resolve, reject: reject, onUpdate: opts.onUpdate, onProgress: opts.onProgress,
            t: setTimeout(function () { if (waiting[id]) { delete waiting[id]; reject(new Error('timeout')); } }, opts.timeout || 240000) };
          frame.contentWindow.postMessage({ type: 'kickback:scan', id: id, wallet: wallet, key: opts.key, helius: opts.helius }, ORIGIN);
        });
      });
    }
  };
})();
