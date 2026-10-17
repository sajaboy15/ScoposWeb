/*
 * Self-update for an unpacked (developer) install, run in the service worker:
 *   try { importScripts('core/update.js'); } catch (e) {}
 *
 * Every minute (alarm 'scopos-dev-update') and on worker start it asks the local Scopos server what is on disk
 * (GET <devServer>/api/ext/version -> { version, sig, files, changedAt }), tells it what Chrome has loaded
 * (POST /api/ext/hello { version, sig, id }, shown on /setup; a reply with keyOffer: true means the user approved
 * the one-time key handoff on /setup, and the background then collects the key), and when the two differ it calls
 * chrome.runtime.reload(), but only while self.scoposBusy() is false (a guide, an answer or an exploration in
 * flight); otherwise it tries again a minute later. After any install or reload it injects the manifest's content
 * scripts into the open http(s) tabs, so pages need no refresh.
 *
 * The loaded sig is computed once per load, from the extension's own files (chrome.runtime.getURL) with the
 * server's algorithm (see extSig in server/server.mjs), and kept in chrome.storage.session, which Chrome clears on
 * every reload. An unpacked extension's files are read from disk, so this is only the loaded version while nothing
 * changed since the load: if the server says a file changed after this load started, the loaded sig is 'stale'.
 *
 * Silent: any failure (no server, not unpacked, no network) just waits for the next minute.
 * chrome.storage.local 'devServer' overrides the server (default http://localhost:4173).
 * Headless Chrome (the test harness, dev/ext-harness.mjs) is left alone, so a test never reloads under its own feet
 * while other files change; a test opts in with chrome.storage.local 'devAutoUpdate' = true.
 * Exposes self.scoposDevUpdate = { check, injectAll, ownSig, state } for tests and the background script.
 */
(function () {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  if (self.scoposDevUpdate) return; // loaded twice
  const ALARM = 'scopos-dev-update';
  const DEFAULT_SERVER = 'http://localhost:4173';
  const LOADED_KEY = 'scoposDevLoaded', STARTED_KEY = 'scoposDevStartedAt', RELOADS_KEY = 'scoposDevReloads';
  const state = { dev: null, server: null, disk: null, loaded: null, lastCheck: 0, waitingForIdle: false, gaveUp: false, error: null };
  const session = chrome.storage && chrome.storage.session;
  const local = chrome.storage && chrome.storage.local;

  // When this load began: the first time this worker ran since Chrome loaded the extension.
  const started = (async () => {
    const now = Date.now();
    if (!session) return now;
    try {
      const s = await session.get(STARTED_KEY);
      if (s[STARTED_KEY]) return s[STARTED_KEY];
      await session.set({ [STARTED_KEY]: now });
    } catch (e) { /* storage unavailable: fall back to now */ }
    return now;
  })();

  let devP = null;
  function isDev() {
    if (!devP) devP = new Promise(resolve => {
      try {
        chrome.management.getSelf(info => resolve(!chrome.runtime.lastError && !!info && info.installType === 'development'));
      } catch (e) { resolve(false); }
    }).then(v => (state.dev = v));
    return devP;
  }

  async function serverBase() {
    let base = DEFAULT_SERVER;
    try {
      const v = local && (await local.get('devServer')).devServer;
      if (typeof v === 'string' && /^https?:\/\/[^/?#\s]+\/?$/i.test(v.trim())) base = v.trim().replace(/\/$/, '');
    } catch (e) { /* default */ }
    return (state.server = base);
  }

  const timeout = ms => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  async function getJson(url) {
    const r = await fetch(url, { cache: 'no-store', signal: timeout(1500) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ---- the sig, exactly as the server computes it ----
  const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
  function lfBytes(u8) { // drop every CR that precedes an LF (same as lfBytes on the server)
    const out = new Uint8Array(u8.length);
    let n = 0;
    for (let i = 0; i < u8.length; i++) { if (u8[i] === 13 && u8[i + 1] === 10) continue; out[n++] = u8[i]; }
    return out.subarray(0, n);
  }
  /** SHA-256 over "<path>\n<sha256 of file>\n" for `files` in the given order; first 16 hex. A missing file hashes as 'missing'. */
  async function ownSig(files) {
    let lines = '';
    for (const path of files) {
      let h = 'missing';
      try {
        const r = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
        if (r.ok) h = await sha256(lfBytes(new Uint8Array(await r.arrayBuffer())));
      } catch (e) { /* not in this build */ }
      lines += `${path}\n${h}\n`;
    }
    return (await sha256(new TextEncoder().encode(lines))).slice(0, 16);
  }

  /** What this load is: stored for the load, or computed now from our own files (or 'stale' if disk moved on). */
  async function loadedInfo(disk) {
    if (state.loaded) return state.loaded;
    try { const s = session && (await session.get(LOADED_KEY)); if (s && s[LOADED_KEY]) return (state.loaded = s[LOADED_KEY]); } catch (e) { /* compute */ }
    const at = await started;
    const version = chrome.runtime.getManifest().version;
    let sig;
    if (disk.changedAt && disk.changedAt > at + 2000) sig = 'stale'; // a file changed after this load began
    else if (Array.isArray(disk.files) && disk.files.length) sig = await ownSig(disk.files);
    else return null;
    const loaded = { version, sig, at };
    try { if (session) await session.set({ [LOADED_KEY]: loaded }); } catch (e) { /* in memory only */ }
    return (state.loaded = loaded);
  }

  const headless = () => /HeadlessChrome/.test((self.navigator && navigator.userAgent) || '');
  async function optedIn() { try { return !!local && (await local.get('devAutoUpdate')).devAutoUpdate === true; } catch (e) { return false; } }

  /** Tells the server what is loaded. Its reply says keyOffer: true when the user approved, on /setup, handing its
   *  Claude key to this very extension: then the background collects it (self.scoposKeyHandoff, background.js). */
  async function hello(base, loaded) {
    let reply = null;
    try {
      const r = await fetch(base + '/api/ext/hello', {
        method: 'POST', cache: 'no-store', signal: timeout(1500),
        headers: { 'content-type': 'application/json', 'x-scopos-ext': chrome.runtime.id },
        body: JSON.stringify({ version: loaded.version, sig: loaded.sig, id: chrome.runtime.id, headless: headless() }),
      });
      if (r.ok) reply = await r.json().catch(() => null);
    } catch (e) { /* the server is gone; next minute */ }
    if (reply && reply.keyOffer === true && typeof self.scoposKeyHandoff === 'function') {
      try { state.handoff = await self.scoposKeyHandoff({ force: true }); } catch (e) { state.handoff = { error: true }; }
    }
  }

  function busy() {
    try { return typeof self.scoposBusy === 'function' && !!self.scoposBusy(); } catch (e) { return true; } // unsure = busy
  }

  /** Reload, at most 3 times in 10 minutes (a sig that never matches must not reload forever). */
  async function reload() {
    const now = Date.now();
    let list = [];
    try { list = ((local && (await local.get(RELOADS_KEY))[RELOADS_KEY]) || []).filter(t => now - t < 10 * 60 * 1000); } catch (e) { /* none */ }
    if (list.length >= 3) { state.gaveUp = true; return false; }
    list.push(now);
    try { if (local) await local.set({ [RELOADS_KEY]: list }); } catch (e) { /* still reload */ }
    chrome.runtime.reload();
    return true;
  }

  let running = null;
  function check(reason) {
    if (!running) running = run(reason).catch(e => { state.error = String((e && e.message) || e); return { error: state.error }; }).finally(() => { running = null; });
    return running;
  }
  async function run(reason) {
    if (!(await isDev())) return { skipped: 'not-development' };
    if (headless() && !(await optedIn())) return { skipped: 'headless' };
    if (chrome.alarms) { try { if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 }); } catch (e) { /* no alarms */ } }
    const base = await serverBase();
    let disk;
    try { disk = await getJson(base + '/api/ext/version'); } catch (e) { state.error = 'offline'; return { offline: true }; }
    if (!disk || typeof disk.sig !== 'string') return { offline: true };
    state.disk = disk; state.lastCheck = Date.now(); state.error = null;
    const loaded = await loadedInfo(disk);
    if (!loaded) return { disk };
    await hello(base, loaded);
    if (loaded.sig === disk.sig) { state.waitingForIdle = false; return { reason, upToDate: true, sig: disk.sig }; }
    if (busy()) { state.waitingForIdle = true; return { reason, upToDate: false, busy: true }; }
    return { reason, upToDate: false, reloading: await reload() };
  }

  // ---- after an install or a reload: bring the open tabs up to date without a refresh ----
  function glob(pattern, s) { return new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(s); }
  function matches(pattern, url) {
    if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url.protocol);
    const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!m) return false;
    const [, scheme, host, path] = m;
    const proto = url.protocol.slice(0, -1);
    if (scheme === '*' ? !/^https?$/.test(proto) : scheme !== proto) return false;
    if (proto !== 'file') {
      if (host !== '*' && !(host.startsWith('*.') ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.hostname === host)) return false;
    }
    return glob(path, url.pathname + url.search);
  }
  const BLOCKED_HOSTS = /^(chromewebstore\.google\.com|chrome\.google\.com)$/i;
  async function injectAll() {
    const groups = (chrome.runtime.getManifest().content_scripts || []).filter(g => (g.js && g.js.length) || (g.css && g.css.length));
    if (!groups.length || !chrome.scripting || !chrome.tabs) return 0;
    let fileOk = false;
    try { fileOk = await new Promise(r => chrome.extension.isAllowedFileSchemeAccess(r)); } catch (e) { /* no */ }
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { return 0; }
    let done = 0;
    await Promise.all(tabs.map(async tab => {
      let url;
      try { url = new URL(tab.url || ''); } catch (e) { return; }
      if (tab.discarded || !/^(https?|file):$/.test(url.protocol)) return;
      if (url.protocol === 'file:' && !fileOk) return;
      if (BLOCKED_HOSTS.test(url.hostname) || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) return;
      for (const g of groups) {
        if (!(g.matches || []).some(p => matches(p, url))) continue;
        if ((g.exclude_matches || []).some(p => matches(p, url))) continue;
        const target = { tabId: tab.id, allFrames: !!g.all_frames };
        try {
          if (g.css && g.css.length) await chrome.scripting.insertCSS({ target, files: g.css });
          if (g.js && g.js.length) await chrome.scripting.executeScript({ target, files: g.js, world: g.world === 'MAIN' ? 'MAIN' : 'ISOLATED' });
          done++;
        } catch (e) { /* error page, a policy-blocked site, or a tab mid-navigation */ }
      }
    }));
    return done;
  }

  chrome.runtime.onInstalled.addListener(d => { if (d.reason === 'install' || d.reason === 'update') injectAll().catch(() => {}); });
  if (chrome.alarms) chrome.alarms.onAlarm.addListener(a => { if (a && a.name === ALARM) check('alarm'); });

  self.scoposDevUpdate = { check, injectAll, ownSig, state };
  check('start');
})();
