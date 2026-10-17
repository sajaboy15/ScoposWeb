/*
 * Scopos loader: the only file a vendor's page loads up front (dist/scopos.js, ~3 KB gzipped).
 *
 *   <script src="https://cdn.example.com/scopos.js" data-endpoint="/api/scopos" data-product="..." async></script>
 *
 * It reads the tag's data-* config, draws the launcher button (the same look as the full widget) in a closed shadow
 * root and loads the core (scopos-core.<hash>.js, next to this file):
 *   - right away when a guide is running (sessionStorage 'scopos:run'), a learn walk is in progress or the URL has
 *     ?scopos-learn=1, so a walkthrough continues after a page load without a gap;
 *   - on the first touch of the launcher (hover, focus, tap), or when the page calls Scopos.widget.*;
 *   - otherwise when the browser is idle after the page's load event.
 * data-load="click" never loads it on idle (only on interaction), data-load="eager" loads it at once.
 * The learn-mode code (scopos-learn.<hash>.js) is loaded by the core only when learn mode is used.
 * The core swaps this button for its own in the same task, so nothing flickers.
 * __SCOPOS_CORE__ and __SCOPOS_LEARN__ are replaced by sdk/build.mjs with the hashed file names.
 */
(function () {
  var W = window, D = document;
  var S = (W.Scopos = W.Scopos || {});
  if (S._boot || S.widget) return; // loaded twice, or the full bundle is already here
  var me = D.currentScript || D.querySelector('script[data-endpoint][src*="scopos"]');
  var data = {}, k;
  if (me) for (k in me.dataset) data[k] = me.dataset[k];
  var base = (me && me.src) || location.href;
  var CORE = '__SCOPOS_CORE__', LEARN = '__SCOPOS_LEARN__';
  var files = {};

  /** Loads a file next to this one once; scripts run in the order they were asked for. */
  function load(name) {
    return files[name] || (files[name] = new Promise(function (ok, fail) {
      var s = D.createElement('script');
      s.src = new URL(name, base).href;
      s.async = false;
      if (me && me.nonce) s.nonce = me.nonce; // a strict CSP with a nonce: the core gets the same one
      s.onload = ok;
      s.onerror = function () { delete files[name]; s.remove(); fail(new Error('Scopos: не загрузился ' + name)); };
      (D.head || D.documentElement).appendChild(s);
    }));
  }
  function core() {
    if (btn) btn.setAttribute('aria-busy', 'true');
    return load(CORE).catch(function (e) { if (btn) btn.removeAttribute('aria-busy'); console.warn(e.message); throw e; });
  }

  // Calls made before the core is here wait in a queue; the core runs them once it is up.
  var queue = [];
  var call = function (m) {
    return function () {
      var a = arguments;
      return new Promise(function (ok, fail) {
        var item = [m, a, ok, fail];
        queue.push(item);
        core().catch(function (e) { var i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); fail(e); });
      });
    };
  };
  var localHost = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/i.test(location.hostname);
  S.widget = {
    _stub: true,
    open: call('open'),
    ask: call('ask'),
    startGuide: call('startGuide'),
    cfg: {
      endpoint: data.endpoint || '/api/scopos',
      product: data.product || '',
      learn: data.learn != null && !/^(false|off|0|no)$/i.test(data.learn) && (localHost || !!data.learnToken),
    },
  };

  // What is going on in this tab: a running guide or learn walk loads the core at once.
  var run = null, exploring = false;
  try { run = JSON.parse(sessionStorage.getItem('scopos:run') || 'null'); } catch (e) { run = null; }
  try { exploring = !!sessionStorage.getItem('scopos:explore'); } catch (e) { exploring = false; }
  var running = !!(run && run.status === 'running' && run.steps && run.steps.length && ((run.index || 0) < run.steps.length || run.live));
  var learnUrl = /[?&]scopos-learn(=|&|$)/.test(location.search);

  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
  var label = running ? 'Шаг ' + Math.min((run.index || 0) + 1, run.steps.length) + ' из ' + run.steps.length : data.label || 'Спросить';
  var CSS = ':host{all:initial}*{box-sizing:border-box}'
    + '.w{position:fixed;right:max(18px,env(safe-area-inset-right,0px));bottom:max(18px,env(safe-area-inset-bottom,0px));z-index:2147483645;'
    + '--paper:#fbfaf7;--ink:#2b2825;--rule:#ebe6de;--accent:#c47f56;--shadow:0 18px 48px rgba(60,45,30,.16),0 2px 6px rgba(60,45,30,.06);'
    + 'font:14px/1.5 "Onest",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}'
    + '@media (prefers-color-scheme:dark){.w{--paper:#23201d;--ink:#efe9e1;--rule:#38332d;--accent:#e0a07a;--shadow:0 18px 48px rgba(0,0,0,.45)}}'
    + '.launch{display:flex;align-items:center;gap:9px;height:44px;padding:0 18px 0 14px;border-radius:999px;border:1px solid var(--rule);background:var(--paper);color:var(--ink);'
    + 'box-shadow:var(--shadow);cursor:pointer;font:inherit;font-weight:500;transition:transform .25s cubic-bezier(.22,.9,.24,1)}'
    + '.launch:hover{transform:translateY(-2px)}.launch[aria-busy] .ring::after{opacity:.4}'
    + '.ring{width:18px;height:18px;border-radius:50%;border:2px solid var(--accent);position:relative;flex:none}'
    + '.ring::after{content:"";position:absolute;inset:0;margin:auto;width:5px;height:5px;border-radius:50%;background:var(--accent)}'
    + 'button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'
    + '@media (prefers-reduced-motion:reduce){.launch{transition:opacity .15s linear}}';

  var host = null, root = null, btn = null;
  function mount() {
    if (host || !S.widget._stub) return; // the core got here first
    host = D.createElement('scopos-widget');
    host.setAttribute('data-scopos-ui', '');
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' + CSS + '</style><div class="w"><button class="launch" type="button"><span class="ring"></span>' + esc(label) + '</button></div>';
    btn = root.querySelector('button');
    btn.addEventListener('click', function () { var p = S.widget.open(); if (p && p.catch) p.catch(function () {}); });
    var warm = function () { core().catch(function () {}); };
    btn.addEventListener('pointerenter', warm, { once: true });
    btn.addEventListener('focus', warm, { once: true });
    btn.addEventListener('touchstart', warm, { once: true, passive: true });
    (D.body || D.documentElement).appendChild(host);
  }

  S._boot = {
    data: data, base: base, core: CORE, learn: LEARN, load: load, queue: queue, localHost: localHost,
    urgent: running || exploring || learnUrl, // a walkthrough is waiting: the core boots in the task it arrives in
    /** Called by the core once its own launcher is on the page: removes ours; true if ours had the focus. */
    handoff: function () {
      if (!host) return false;
      var focused = !!(root && root.activeElement === btn);
      host.remove();
      host = root = btn = null;
      return focused;
    },
  };

  if (D.body) mount(); else D.addEventListener('DOMContentLoaded', mount, { once: true });

  var mode = String(data.load || 'idle').toLowerCase();
  if (running || exploring || learnUrl || mode === 'eager') core().catch(function () {});
  else if (mode !== 'click') {
    var idle = function () {
      if (W.requestIdleCallback) W.requestIdleCallback(function () { core().catch(function () {}); }, { timeout: 8000 });
      else setTimeout(function () { core().catch(function () {}); }, 2000);
    };
    if (D.readyState === 'complete') idle(); else W.addEventListener('load', idle, { once: true });
  }
})();
