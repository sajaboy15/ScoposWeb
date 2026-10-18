// Runs the real extension in its own Chrome, with no window and a throwaway profile, so tests don't depend on
// anyone's open browser. Chrome 137+ ignores --load-extension in branded builds; the supported way is the
// CDP method Extensions.loadUnpacked over --remote-debugging-pipe with --enable-unsafe-extension-debugging.
//
//   import { launch } from './ext-harness.mjs';
//   const b = await launch();                       // headless; SCOPOS_HEADED=1 shows the window
//   const page = await b.open('http://localhost:4173/');
//   await page.eval('document.title');              // page (main world)
//   await page.evalScopos('Scopos.scan().lines.length'); // the extension's content-script world
//   await b.evalWorker('MODELS');                   // the extension's service worker
//   await b.close();
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROMES = [
  process.env.SCOPOS_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

// The packaged Claude app on Windows redirects AppData\Roaming into its LocalCache; Chrome must get the real path.
export function extensionDir() {
  const p = resolve(HERE, '..', 'extension');
  const m = p.match(/^(.*?)[\\/]AppData[\\/]Roaming[\\/](Claude[\\/].*)$/i);
  if (m) {
    const real = join(m[1], 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', m[2]);
    if (existsSync(join(real, 'manifest.json'))) return real;
  }
  return p;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch({ headed = !!process.env.SCOPOS_HEADED, width = 1280, height = 800 } = {}) {
  const exe = CHROMES.find(p => existsSync(p));
  if (!exe) throw new Error('Chrome not found; set SCOPOS_CHROME');
  const profile = mkdtempSync(join(tmpdir(), 'scopos-chrome-'));
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=Translate,MediaRouter',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--window-size=${width},${height}`,
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const out = proc.stdio[3], inp = proc.stdio[4];
  let buf = '', seq = 0;
  const waiting = new Map(), listeners = new Set();
  inp.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(raw); } catch (e) { continue; }
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message + (m.error.data ? ': ' + m.error.data : ''))) : w.resolve(m.result); }
      else listeners.forEach(f => f(m));
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const on = f => { listeners.add(f); return () => listeners.delete(f); };

  await send('Target.setDiscoverTargets', { discover: true });
  const extPath = extensionDir();
  const { id: extId } = await send('Extensions.loadUnpacked', { path: extPath });

  // The worker target: evaluate there for the extension's own state.
  async function workerSession() {
    for (let i = 0; i < 50; i++) {
      const { targetInfos } = await send('Target.getTargets');
      const t = targetInfos.find(x => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${extId}/`));
      if (t) {
        const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        await send('Runtime.enable', {}, sessionId);
        // A worker that is still starting has no `chrome` yet: wait for it instead of failing the first call.
        for (let k = 0; k < 40; k++) {
          const r = await send('Runtime.evaluate', { expression: 'typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id', returnByValue: true }, sessionId).catch(() => null);
          if (r && r.result && r.result.value === true) return sessionId;
          await sleep(150);
        }
        return sessionId;
      }
      await sleep(100);
    }
    throw new Error('extension worker not found');
  }
  let wsess = null;
  async function evalWorker(expr) {
    if (!wsess) wsess = await workerSession();
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true }, wsess);
    if (r.exceptionDetails) throw new Error('worker: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }

  async function open(url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const contexts = new Map(); // id -> { name, origin, frameId, type }
    const unsub = on(m => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.executionContextCreated') { const c = m.params.context; contexts.set(c.id, { name: c.name, origin: c.origin, frameId: c.auxData && c.auxData.frameId, type: c.auxData && c.auxData.type, isDefault: c.auxData && c.auxData.isDefault }); }
      if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(m.params.executionContextId);
      if (m.method === 'Runtime.executionContextsCleared') contexts.clear();
    });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    // Headless still has focus and frames; keep it "visible" so rAF-driven code runs normally.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    const { frameTree } = await send('Page.getFrameTree', {}, sessionId);
    const mainFrame = frameTree.frame.id;
    const page = {
      targetId, sessionId, contexts,
      send: (m, p) => send(m, p, sessionId),
      async goto(u, { waitMs = 600 } = {}) {
        const loaded = new Promise(r => { const off = on(m => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { off(); r(); } }); setTimeout(r, 20000); });
        await send('Page.navigate', { url: u }, sessionId);
        await loaded; await sleep(waitMs);
      },
      async eval(expr, contextId) {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true, ...(contextId ? { contextId } : {}) }, sessionId);
        if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
        return r.result.value;
      },
      // The extension's isolated world in the top frame (named after the extension).
      scoposContext() {
        for (const [id, c] of contexts) if (c.type === 'isolated' && c.origin === `chrome-extension://${extId}` && c.frameId === mainFrame) return id;
        for (const [id, c] of contexts) if (c.type === 'isolated' && c.frameId === mainFrame && /scopos/i.test(c.name)) return id;
        return null;
      },
      async evalScopos(expr, { timeoutMs = 8000 } = {}) {
        const t0 = Date.now();
        let id = null;
        while (!(id = page.scoposContext()) && Date.now() - t0 < timeoutMs) await sleep(100);
        if (!id) throw new Error('Scopos content script not running in this page');
        return page.eval(expr, id);
      },
      async click(x, y) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
      },
      async screenshot(file) {
        const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
        if (file) (await import('node:fs')).writeFileSync(file, Buffer.from(data, 'base64'));
        return data;
      },
      async close() { unsub(); await send('Target.closeTarget', { targetId }).catch(() => {}); },
    };
    if (url) await page.goto(url);
    return page;
  }

  return {
    extId, extPath, send, on, open, evalWorker,
    async close() {
      try { await send('Browser.close'); } catch (e) { /* already gone */ }
      await sleep(300);
      try { proc.kill(); } catch (e) { /* ignore */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome may still hold a lock */ }
    },
  };
}

// Smoke test: node dev/ext-harness.mjs [url]
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const url = process.argv[2] || 'http://localhost:4173/';
  const b = await launch();
  try {
    console.log('extension', b.extId, b.extPath);
    const p = await b.open(url);
    console.log('title', await p.eval('document.title'));
    console.log('scopos lines', await p.evalScopos('Scopos.scan().lines.length'));
    console.log('worker models', JSON.stringify(await b.evalWorker('typeof Brain !== "undefined" ? Brain.MODELS : (self.ScoposBrain && self.ScoposBrain.MODELS)')));
  } finally { await b.close(); }
}
