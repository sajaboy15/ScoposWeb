/*
 * Scopos guard: the safety net under the explorer.
 *
 * The explorer only presses controls that look like they open something, but
 * labels lie: a «Создать» button can POST at once, a menu item can call
 * confirm() and then delete. While the guard is on, nothing the page does can
 * write: forms don't submit, confirm() answers "no", alert/prompt/print do
 * nothing, window.open is refused, non-GET fetch/XHR answer 403, sendBeacon and
 * WebSocket/WebTransport/RTCDataChannel sends are refused, and "leave site?"
 * prompts never show (they would hang the walk).
 *
 * Three layers:
 *  - in the extension, the service worker also blocks non-GET requests and
 *    every WebSocket/WebTransport for the tab at the network level
 *    (declarativeNetRequest session rules). That is the primary net: it also
 *    covers captured fetch references, workers, iframes and native form posts;
 *  - DOM guards installed from here (submit and risky link clicks are stopped
 *    in the capture phase; DOM events are shared between worlds);
 *  - pageMain(), the patch for the page's own world. The extension asks the
 *    service worker to run it with world:'MAIN' (inline <script> is blocked by
 *    CSP on many sites); the SDK already runs in the page's world and calls it
 *    directly.
 *
 * On/off in the page world: the patch keeps its state in a closure. It is
 * switched only by pageMain(nonce, 'on'|'off') with a random per-document nonce
 * that never appears in the DOM or in an event (in the extension it travels
 * content script -> worker -> chrome.scripting args). The <html> attribute
 * data-scopos-guard="on" is kept for the isolated world and can only turn the
 * page patch ON (so the patch is active the moment on() runs); a page that
 * removes the attribute cannot turn it off. data-scopos-guard-main="1" is set
 * only after every critical patch is verifiably in place; it is informational.
 *
 * This file must also load in the service worker (importScripts) so the
 * background can pass S.guard.pageMain to chrome.scripting: nothing here
 * touches the DOM until on() is called.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});
  if (S.guard) return;

  const FLAG = 'data-scopos-guard';
  let active = false, count = 0, last = '', nonce = '', observer = null;

  /**
   * The page-world patch. Self-contained on purpose: chrome.scripting serialises
   * the function, so it may not use anything from the surrounding scope.
   * @param {string} key  per-document secret; only a caller that knows it can switch the patch.
   * @param {string} cmd  'on' | 'off' | 'install'
   * @returns {'ok'|'partial'|'refused'|'none'} 'ok' when every critical patch is in place.
   */
  function pageMain(key, cmd) {
    key = String(key || '');
    if (key.length < 16) return 'refused';
    // The control slot is named after a hash of the key: the page can see the name, never the key.
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    const slot = '__scoposGuard_' + h.toString(36);
    const markMain = ok => { try { const d = document.documentElement; if (!d) return; if (ok) d.setAttribute('data-scopos-guard-main', '1'); else d.removeAttribute('data-scopos-guard-main'); } catch (e) { /* no document yet */ } };

    let existing = null;
    try { existing = Object.getOwnPropertyDescriptor(window, slot); } catch (e) { existing = null; }
    if (existing) {
      // Installed earlier in this document: just switch it.
      const res = typeof existing.value === 'function' ? existing.value(key, cmd) : 'refused';
      markMain(res === 'ok');
      return res;
    }
    if (cmd === 'off') return 'none'; // nothing installed in this document: nothing to switch off

    let state = cmd === 'on';
    const on = () => {
      if (state) return true;
      // The attribute can only add protection (it is set synchronously by the content world); removing it changes nothing.
      try { const d = document.documentElement; return !!d && d.getAttribute('data-scopos-guard') === 'on'; } catch (e) { return false; }
    };
    const report = what => { try { window.dispatchEvent(new CustomEvent('scopos:blocked', { detail: String(what).slice(0, 200) })); } catch (e) { /* ignore */ } };
    const SAFE = /^(GET|HEAD|OPTIONS)$/i;
    // Natives captured once, before any page code can trick the checks below.
    const OrigRequest = window.Request, OrigResponse = window.Response;
    const reqMethodGet = (() => { try { return Object.getOwnPropertyDescriptor(Request.prototype, 'method').get; } catch (e) { return null; } })();
    const reqUrlGet = (() => { try { return Object.getOwnPropertyDescriptor(Request.prototype, 'url').get; } catch (e) { return null; } })();
    const GQL_KEYS = new Set(['query', 'variables', 'operationName', 'extensions']);
    /**
     * GraphQL reads go out as POST. Only a plain JSON {query} (or a batch of them) whose every query
     * starts as a read and never mentions a mutation or subscription is let through; anything else is a write.
     */
    const readQuery = (body, url) => {
      if (typeof body !== 'string' || !/graph|gql/i.test(String(url || ''))) return false;
      if (/mutation|subscription/i.test(body)) return false;
      let ops;
      try { ops = [].concat(JSON.parse(body)); } catch (e) { return false; }
      return ops.length > 0 && ops.every(o => o && typeof o === 'object' && !Array.isArray(o)
        && Object.keys(o).every(k => GQL_KEYS.has(k))
        && typeof o.query === 'string'
        && /^\s*(query\b|\{)/.test(o.query)
        && !/mutation|subscription/i.test(o.query));
    };
    const urlOf = x => { try { return String(x && typeof x === 'object' && 'url' in x ? x.url : x); } catch (e) { return ''; } };
    /** Replaces obj[name]; true only when the replacement really took. */
    const wrap = (obj, name, make) => {
      try {
        const orig = obj[name];
        if (typeof orig !== 'function') return false;
        const next = make(orig);
        obj[name] = next;
        return obj[name] === next;
      } catch (e) { return false; /* read-only on this page */ }
    };
    const critical = [];
    const BLOCKED_BODY = '{"error":"blocked by Scopos while it explores the product"}';

    // ---- fetch: a definitive 403, never a network error (retry/offline layers would replay a network error later) ----
    if (typeof window.fetch === 'function' && OrigRequest && OrigResponse && reqMethodGet) {
      const denied = what => { report(what); return Promise.resolve(new OrigResponse(BLOCKED_BODY, { status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json' } })); };
      critical.push(wrap(window, 'fetch', orig => function fetch(input, init) {
        if (!on()) return orig.apply(this, arguments);
        // Normalise once with the native Request, read the method through the captured getter and send exactly
        // that Request: a method getter or toString that answers differently on each read can't slip through.
        let r;
        try { r = new OrigRequest(input, init); } catch (e) { return Promise.reject(e); }
        let m = '', url = '';
        try { m = String(reqMethodGet.call(r)); url = reqUrlGet ? String(reqUrlGet.call(r)) : urlOf(input); } catch (e) { m = ''; }
        if (SAFE.test(m)) return orig.call(this, r);
        const self = this;
        if (/graph|gql/i.test(url)) {
          // Possibly a GraphQL read: look at the body (a clone, so the real one is still sendable).
          let copy;
          try { copy = r.clone(); } catch (e) { return denied(`fetch ${m} ${url}`); }
          return copy.text().then(t => (on() && !readQuery(t, url) ? denied(`fetch ${m} ${url}`) : orig.call(self, r)), () => denied(`fetch ${m} ${url}`));
        }
        return denied(`fetch ${m || '?'} ${url}`);
      }));
    }

    // ---- XMLHttpRequest ----
    if (window.XMLHttpRequest) {
      const opened = new WeakMap(); // xhr -> { m, url } as passed to the native open
      const faked = new WeakSet(); // xhrs answered with a synthetic 403 (own props shadow the native getters)
      const FAKE_PROPS = ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL', 'getResponseHeader', 'getAllResponseHeaders'];
      const P = XMLHttpRequest.prototype;
      critical.push(wrap(P, 'open', orig => function open(method, url) {
        if (faked.has(this)) { faked.delete(this); FAKE_PROPS.forEach(k => { try { delete this[k]; } catch (e) { /* ignore */ } }); }
        // Stringify once and hand the native open exactly what was recorded.
        const args = Array.prototype.slice.call(arguments);
        const m = String(method);
        args[0] = m;
        if (args.length > 1) { try { args[1] = typeof url === 'string' ? url : String(url); } catch (e) { /* the native open will throw */ } }
        const res = orig.apply(this, args);
        opened.set(this, { m: m.toUpperCase(), url: args.length > 1 ? String(args[1]) : '' });
        return res;
      }));
      const fake403 = xhr => {
        let rt = '';
        try { rt = xhr.responseType || ''; } catch (e) { rt = ''; }
        let response = null;
        if (rt === '' || rt === 'text') response = BLOCKED_BODY;
        else if (rt === 'json') { try { response = JSON.parse(BLOCKED_BODY); } catch (e) { response = null; } }
        faked.add(xhr);
        const def = (k, v) => { try { Object.defineProperty(xhr, k, { configurable: true, get: () => v }); } catch (e) { /* ignore */ } };
        def('readyState', 4); def('status', 403); def('statusText', 'Forbidden');
        def('response', response); def('responseText', rt === '' || rt === 'text' ? BLOCKED_BODY : '');
        def('responseURL', (opened.get(xhr) || {}).url || '');
        try {
          Object.defineProperty(xhr, 'getResponseHeader', { configurable: true, value: n => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) });
          Object.defineProperty(xhr, 'getAllResponseHeaders', { configurable: true, value: () => 'content-type: application/json\r\n' });
        } catch (e) { /* ignore */ }
        const fire = (type, Ctor) => { try { xhr.dispatchEvent(new Ctor(type)); } catch (e) { /* ignore */ } };
        fire('readystatechange', Event);
        fire('load', ProgressEvent);
        fire('loadend', ProgressEvent);
      };
      critical.push(wrap(P, 'send', orig => function send(body) {
        if (!on()) return orig.apply(this, arguments);
        const rec = opened.get(this);
        let m;
        if (rec) m = rec.m;
        else {
          // open() ran without our wrapper (a natively captured open): the method is unknown, so it counts as a write.
          // Only an XHR that was never opened (readyState 0) is left to the native send, which throws.
          let rs = 0;
          try { rs = this.readyState; } catch (e) { rs = 1; }
          if (rs === 0) return orig.apply(this, arguments);
          m = '?';
        }
        if (SAFE.test(m) || readQuery(body, rec && rec.url)) return orig.apply(this, arguments);
        report(`xhr ${m} ${(rec && rec.url) || ''}`);
        const xhr = this;
        setTimeout(() => fake403(xhr), 0);
        return undefined;
      }));
    }

    // ---- WebSocket / WebTransport / RTCDataChannel: no new sockets and no sends while on ----
    if (typeof window.WebSocket === 'function') {
      critical.push(wrap(WebSocket.prototype, 'send', orig => function send() { if (on()) { report('websocket send'); return undefined; } return orig.apply(this, arguments); }));
      try {
        const WS = window.WebSocket;
        const guarded = new Proxy(WS, {
          construct(t, args, nt) {
            if (on()) { report('websocket ' + urlOf(args[0])); throw new DOMException('Blocked by Scopos while it explores the product', 'SecurityError'); }
            return Reflect.construct(t, args, nt);
          },
        });
        window.WebSocket = guarded;
        critical.push(window.WebSocket === guarded);
      } catch (e) { critical.push(false); }
    }
    if (typeof window.WebTransport === 'function') {
      try {
        const WT = window.WebTransport;
        window.WebTransport = new Proxy(WT, {
          construct(t, args, nt) {
            if (on()) { report('webtransport'); throw new DOMException('Blocked by Scopos while it explores the product', 'SecurityError'); }
            return Reflect.construct(t, args, nt);
          },
        });
      } catch (e) { /* ignore: the network rule blocks it in the extension */ }
    }
    if (window.RTCDataChannel) wrap(RTCDataChannel.prototype, 'send', orig => function send() { if (on()) { report('datachannel send'); return undefined; } return orig.apply(this, arguments); });

    if (navigator.sendBeacon) critical.push(wrap(navigator, 'sendBeacon', orig => function sendBeacon() { if (on()) { report('beacon'); return false; } return orig.apply(this, arguments); }));
    wrap(window, 'confirm', orig => function confirm() { if (on()) { report('confirm'); return false; } return orig.apply(this, arguments); });
    wrap(window, 'alert', orig => function alert() { if (on()) return undefined; return orig.apply(this, arguments); });
    wrap(window, 'prompt', orig => function prompt() { if (on()) { report('prompt'); return null; } return orig.apply(this, arguments); });
    wrap(window, 'print', orig => function print() { if (on()) { report('print'); return undefined; } return orig.apply(this, arguments); });
    wrap(window, 'open', orig => function open() { if (on()) { report('window.open'); return null; } return orig.apply(this, arguments); });
    if (window.HTMLFormElement) {
      critical.push(wrap(HTMLFormElement.prototype, 'submit', orig => function submit() { if (on()) { report('form.submit'); return undefined; } return orig.apply(this, arguments); }));
      if (typeof HTMLFormElement.prototype.requestSubmit === 'function') critical.push(wrap(HTMLFormElement.prototype, 'requestSubmit', orig => function requestSubmit() { if (on()) { report('form.requestSubmit'); return undefined; } return orig.apply(this, arguments); }));
    }

    // "Leave site?" prompts: defuse every way a page can ask for one, whatever order its listeners were added in.
    wrap(Event.prototype, 'preventDefault', orig => function preventDefault() { if (this.type === 'beforeunload' && on()) return undefined; return orig.apply(this, arguments); });
    try {
      const BE = window.BeforeUnloadEvent && BeforeUnloadEvent.prototype;
      const d = BE && Object.getOwnPropertyDescriptor(BE, 'returnValue');
      if (d && d.set && d.configurable) Object.defineProperty(BE, 'returnValue', { configurable: true, enumerable: d.enumerable, get: d.get, set(v) { if (on()) return; d.set.call(this, v); } });
    } catch (e) { /* ignore */ }
    try {
      let user = window.onbeforeunload;
      const guarded = function (e) { if (on()) return undefined; return typeof user === 'function' ? user.call(this, e) : undefined; };
      window.onbeforeunload = guarded;
      Object.defineProperty(window, 'onbeforeunload', { configurable: true, enumerable: true, get() { return user; }, set(fn) { user = fn; } });
    } catch (e) { /* ignore */ }

    const ok = critical.length > 0 && critical.every(Boolean);
    const status = ok ? 'ok' : 'partial';
    // The switch: only a caller holding the key can turn the patch on or off. Non-writable and
    // non-configurable, so the page can't swap it for a function that would record the key.
    const control = (k, c) => {
      if (k !== key) return 'refused';
      if (c === 'on') state = true;
      else if (c === 'off') state = false;
      return status;
    };
    try {
      Object.defineProperty(window, slot, { value: control, writable: false, configurable: false, enumerable: false });
    } catch (e) {
      // Without a switch the patch could never be turned off; fall back to the attribute alone.
      state = false;
      markMain(false);
      return 'partial';
    }
    // Last: the attribute appears only when the patch is really in place.
    markMain(ok);
    return status;
  }

  const inExtension = () => { try { return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  /** The per-document secret that switches the page-world patch. Lives only in this (content or SDK) closure. */
  function secret() {
    if (nonce) return nonce;
    try {
      const a = new Uint32Array(4);
      crypto.getRandomValues(a);
      nonce = Array.from(a, x => x.toString(36).padStart(7, '0')).join('');
    } catch (e) {
      nonce = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 9).padEnd(7, '0')).join('');
    }
    return nonce;
  }

  /**
   * Installs/switches pageMain in the page's own world. Resolves to true when the page patch confirmed
   * that every critical write path is covered.
   */
  function inject(cmd = 'on') {
    const key = secret();
    if (inExtension()) {
      try {
        const p = chrome.runtime.sendMessage({ type: cmd === 'off' ? 'guard:off' : 'guard:inject', nonce: key });
        return Promise.resolve(p).then(r => !!(r && r.main === 'ok'), () => false);
      } catch (e) { return Promise.resolve(false); /* extension reloaded */ }
    }
    try { return Promise.resolve(pageMain(key, cmd) === 'ok'); } catch (e) { return Promise.resolve(false); }
  }

  const NON_HTML = /\.(pdf|csv|tsv|xlsx?|ods|zip|gz|tgz|rar|7z|json|xml|txt|docx?|odt|pptx?|png|jpe?g|gif|webp|svg|mp[34]|mov|avi|wav|exe|msi|dmg|pkg|apk|ics|vcf)$/i;
  const ours = n => !!(n && n.closest && n.closest('[data-scopos-ui],scopos-layer')) || !!(S.pointer && S.pointer.isOurs && n && n.nodeType === 1 && S.pointer.isOurs(n));

  function riskyLink(a) {
    if (!a.hasAttribute('href')) return false;
    if (a.hasAttribute('download')) return true;
    const t = (a.getAttribute('target') || '').toLowerCase();
    if (t && t !== '_self' && t !== '_top' && t !== '_parent') return true;
    if (['data-method', 'data-turbo-method', 'data-confirm', 'data-turbo-confirm'].some(x => a.hasAttribute(x))) return true;
    let u;
    try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return true; }
    if (u.protocol === 'javascript:') return false; // the page's own handler; the page-world patch covers what it does
    if (!/^https?:$/.test(u.protocol) || u.origin !== location.origin) return true; // mailto:, tel:, other sites
    return NON_HTML.test(u.pathname);
  }

  function note(what) { count++; last = String(what || '').slice(0, 200); }
  const onSubmit = e => {
    if (!active || ours(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    note('submit');
  };
  const onClick = e => {
    if (!active) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    const a = path.find(n => n && n.tagName === 'A');
    if (!a || ours(a) || !riskyLink(a)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    note('link ' + a.getAttribute('href'));
  };
  const onBlocked = e => note(typeof e.detail === 'string' ? e.detail : 'write');
  // Morphing (Turbo/idiomorph), document.open() or a hostile page can drop the flag: put it back while active.
  const keepFlag = () => {
    const d = document.documentElement;
    if (active && d && d.getAttribute(FLAG) !== 'on') d.setAttribute(FLAG, 'on');
  };

  /** Turns the guard on. Resolves to true once the page-world patch confirmed it is fully in place. */
  function on() {
    if (typeof document === 'undefined' || !document.documentElement) return Promise.resolve(false);
    document.documentElement.setAttribute(FLAG, 'on');
    if (!active) {
      active = true;
      addEventListener('submit', onSubmit, true);
      addEventListener('click', onClick, true);
      addEventListener('scopos:blocked', onBlocked, true);
      try {
        observer = new MutationObserver(keepFlag);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: [FLAG] });
      } catch (e) { observer = null; }
    }
    return inject('on');
  }

  function off() {
    if (typeof document === 'undefined') return Promise.resolve(false);
    const wasActive = active;
    active = false;
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } observer = null; }
    if (document.documentElement) document.documentElement.removeAttribute(FLAG);
    if (wasActive) {
      removeEventListener('submit', onSubmit, true);
      removeEventListener('click', onClick, true);
      removeEventListener('scopos:blocked', onBlocked, true);
    }
    // The explicit off: the only thing that switches the page patch (and, in the extension, the network block) off.
    return wasActive || nonce ? inject('off') : Promise.resolve(false);
  }

  S.guard = {
    on, off, pageMain,
    inject: () => inject('on'),
    active: () => active,
    blocked: () => count, // how many writes/prompts were stopped so far (the explorer diffs it per press)
    last: () => last,
  };
})(typeof window !== 'undefined' ? window : globalThis);
