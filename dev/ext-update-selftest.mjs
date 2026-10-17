// Self-test for extension/core/update.js in real browsers, with zero real Claude calls:
//   node dev/ext-update-selftest.mjs
// Starts a fake Anthropic upstream and a second server on PORT 4199 (never touches :4173).
//
// Phase 1, Chrome via dev/ext-harness.mjs: installType, headless stays idle without opt-in, the hello carries the
//   server's sig, the worker's crypto.subtle sig = the server's node:crypto sig, Brain.call through /api/claude from
//   the worker, a dotfile doesn't change the sig and a real edit does, chrome.runtime.reload is NOT called while
//   scoposBusy() is true and IS called when idle (stubbed here: Chrome disables an extension loaded with CDP
//   Extensions.loadUnpacked when it reloads itself, whatever the profile's developer mode), injectAll().
// Phase 2, Edge with --load-extension (still honoured there; skipped when Edge is missing): the real reload end to
//   end: busy = no reload; idle = a new worker, session storage cleared, the hello has the new sig, and the tab that
//   was open before the reload answers again without a refresh (content scripts re-injected by onInstalled).
// The edited file (core/update.js itself) is restored byte-exact.
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, extensionDir } from './ext-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.TEST_PORT || 4199;
const BASE = `http://localhost:${PORT}`;
const FAKE_KEY = 'sk-ant-test-' + 'x'.repeat(30);
const TARGET = join(ROOT, 'extension', 'core', 'update.js');
const DOTFILE = join(ROOT, 'extension', '.sigtest');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/microsoft-edge'].find(p => existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'scopos-upd-'));
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  ' + extra : ''}`); if (!cond) failed++; };

// ---- fake upstream + server under test ----
const SSE = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"element_id":3}' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
let upstreamCalls = 0;
const mock = createServer(async (req, res) => { for await (const c of req) void c; upstreamCalls++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE); });
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: FAKE_KEY, SCOPOS_UPSTREAM: `http://127.0.0.1:${mock.address().port}/v1/messages`, SCOPOS_USAGE_FILE: join(tmp, 'usage.json'), SCOPOS_MONTHLY_USD: '5' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
for (let i = 0; i < 50 && !/Scopos demo/.test(log); i++) await sleep(100);
const get = path => new Promise((resolve, reject) => request({ host: '127.0.0.1', port: PORT, path, agent: false, headers: { host: `localhost:${PORT}` } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject).end());
const lastHello = async () => (await get('/api/ext/status')).recent.at(-1) || {};
async function waitHello(sig, ms = 10000) {
  const t0 = Date.now();
  for (;;) { const h = await lastHello(); if (h.sig === sig || Date.now() - t0 > ms) return h; await sleep(250); }
}
const original = readFileSync(TARGET);
const edit = () => writeFileSync(TARGET, Buffer.concat([original, Buffer.from(`\n// sigtest ${Date.now()}\n`)]));
const restore = () => writeFileSync(TARGET, original);

// A version fetch can miss its 1.5 s timeout (cold network stack, a virus scan of a just-written file); update.js then
// simply tries again a minute later. The test retries at once instead.
const RETRY = `(self.__check = async t => { for (let i = 0; i < 4; i++) { const r = await self.scoposDevUpdate.check(t); if (!r.offline) return r; } return { offline: true }; }, 1)`;

/** Worker helpers over any CDP `send` (harness or our own pipe): re-attach by target after a reload. */
function workerTools(send, extId) {
  async function attach(notTarget, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const { targetInfos } = await send('Target.getTargets');
      const t = targetInfos.find(x => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${extId}/`) && x.targetId !== notTarget);
      if (t) {
        const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        await send('Runtime.enable', {}, sessionId);
        await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        return { targetId: t.targetId, sessionId };
      }
      await sleep(150);
    }
    return null;
  }
  async function ev(w, expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, w.sessionId);
    if (r.exceptionDetails) throw new Error('worker: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }
  const ping = (w, tabId) => ev(w, `chrome.tabs.sendMessage(${tabId}, { type: 'ping' }, { frameId: 0 }).then(r => !!(r && r.ok), () => false)`);
  const tabOf = (w, prefix) => ev(w, `chrome.tabs.query({}).then(t => (t.find(x => (x.url || '').startsWith('${prefix}')) || {}).id)`);
  return { attach, ev, ping, tabOf };
}

try {
  ok(/Scopos demo/.test(log), 'test server started on ' + PORT);

  // ================= Phase 1: Chrome (harness) =================
  console.log('\n--- Chrome, dev/ext-harness.mjs ---');
  const b = await launch();
  try {
    const { attach, ev, ping, tabOf } = workerTools(b.send, b.extId);
    const w = await attach();
    const info = await ev(w, `new Promise(r => chrome.management.getSelf(i => r({ installType: i.installType, ua: navigator.userAgent, present: !!self.scoposDevUpdate, busyHook: typeof self.scoposBusy })))`);
    console.log(`      installType=${info.installType} headless=${/HeadlessChrome/.test(info.ua)} update.js imported by background=${info.present} scoposBusy=${info.busyHook}`);
    ok(info.installType === 'development', 'CDP Extensions.loadUnpacked gives installType development');
    if (!info.present) { await ev(w, readFileSync(TARGET, 'utf8')); console.log('      (update.js evaluated into the worker: background.js does not import it yet)'); }
    ok(await ev(w, `self.scoposDevUpdate.check('t').then(r => r.skipped || 'acted')`) === 'headless', 'headless without opt-in: update.js stays idle');

    await ev(w, `chrome.storage.local.set({ devServer: '${BASE}', devAutoUpdate: true })`);
    await ev(w, RETRY);
    const disk0 = await get('/api/ext/version');
    const r1 = await ev(w, `self.__check('test')`);
    ok(r1.upToDate === true && r1.sig === disk0.sig, 'first check: loaded = disk', JSON.stringify(r1));
    const own = await ev(w, `self.scoposDevUpdate.ownSig(${JSON.stringify(disk0.files)})`);
    ok(own === disk0.sig, 'worker crypto.subtle sig = server node:crypto sig', `${own} / ${disk0.sig}`);
    const st = await get('/api/ext/status');
    const h1 = st.recent.at(-1) || {};
    ok(h1.sig === disk0.sig && h1.id === b.extId && h1.headless === true, 'hello arrived with the server sig', JSON.stringify(h1));
    ok(st.loaded === null, "a headless hello is not shown as the user's loaded extension");

    // Brain.call through the proxy, from the worker (real Origin: chrome-extension://<id>), no key.
    const calls0 = upstreamCalls;
    const out = await ev(w, `self.ScoposBrain.call({ model: self.ScoposBrain.MODELS.locate, max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }, '', { endpoint: '${BASE}/api/claude' })`);
    ok(out && out.element_id === 3 && upstreamCalls === calls0 + 1, 'Brain.call via /api/claude from the worker (no key) parses the streamed reply', JSON.stringify(out));
    ok(log.includes(b.extId), 'server saw the chrome-extension:// origin');

    // A dotfile is not part of the sig (other agents may edit real files meanwhile, so compare file lists).
    writeFileSync(DOTFILE, 'x');
    await sleep(2200);
    const withDot = await get('/api/ext/version');
    ok(!withDot.files.includes('.sigtest') && withDot.files.every(f => !f.split('/').some(p => p.startsWith('.'))), 'dotfiles are not hashed');
    rmSync(DOTFILE, { force: true });

    // A real edit changes the sig.
    const before = (await get('/api/ext/version')).sig;
    edit();
    await sleep(2200);
    const disk1 = await get('/api/ext/version');
    ok(disk1.sig !== before, 'editing a file changes the sig', `${before} -> ${disk1.sig}`);
    const live = await ev(w, `fetch(chrome.runtime.getURL('core/update.js'), { cache: 'no-store' }).then(r => r.text()).then(t => t.includes('// sigtest'))`);
    console.log(`      (an unpacked extension reads its own files from disk live: ${live}; so the loaded sig is fixed once per load)`);

    // Decision: busy -> no reload; idle -> reload (stubbed).
    await ev(w, `(self.__reloads = 0, self.__realReload = chrome.runtime.reload, chrome.runtime.reload = () => { self.__reloads++; }, self.__busy = true, self.__origBusy = self.scoposBusy, self.scoposBusy = () => self.__busy, chrome.storage.local.remove('scoposDevReloads'))`);
    const r2 = await ev(w, `self.__check('test')`);
    ok(r2.busy === true && r2.upToDate === false && (await ev(w, 'self.__reloads')) === 0, 'busy: stale but no reload', JSON.stringify(r2));
    ok((await lastHello()).sig === disk0.sig, 'busy: hello still reports the loaded (old) sig');
    const r3 = await ev(w, `(self.__busy = false, self.__check('test'))`);
    ok(r3.reloading === true && (await ev(w, 'self.__reloads')) === 1, 'idle: chrome.runtime.reload() called', JSON.stringify(r3));
    const throwing = await ev(w, `(self.scoposBusy = () => { throw new Error('x'); }, self.__check('test').then(r => r.busy === true && self.__reloads === 1))`);
    ok(throwing, 'a throwing scoposBusy counts as busy');
    await ev(w, `(async () => { self.scoposBusy = () => false; for (const t of ['t2', 't3', 't4']) await self.__check(t); })()`);
    ok((await ev(w, 'self.__reloads')) === 3 && (await ev(w, 'self.scoposDevUpdate.state.gaveUp')) === true, 'loop guard: at most 3 reloads in 10 minutes', String(await ev(w, 'self.__reloads')));
    await ev(w, `(chrome.runtime.reload = self.__realReload, self.scoposBusy = self.__origBusy, chrome.storage.local.remove('scoposDevReloads'))`);
    restore();

    // injectAll: an open http tab gets the manifest's content scripts (content.js replaces its previous copy).
    const page = await b.open(`${BASE}/`);
    const tabId = await tabOf(w, `${BASE}/`);
    const n = await ev(w, `self.scoposDevUpdate.injectAll()`);
    ok(n >= 1 && (await ping(w, tabId)), 'injectAll() injects into open tabs and the page still answers', `groups injected: ${n}`);
    await page.close();
  } finally { await b.close(); }

  // ================= Phase 2: Edge, real reload =================
  if (!EDGE) console.log('\n--- Edge not found: real-reload phase skipped ---');
  else {
    console.log('\n--- Edge, --load-extension (real reload) ---');
    const profile = mkdtempSync(join(tmpdir(), 'scopos-edge-'));
    mkdirSync(join(profile, 'Default'));
    writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
    const proc = spawn(EDGE, [`--user-data-dir=${profile}`, '--remote-debugging-pipe', `--load-extension=${extensionDir()}`, '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-features=msEdgeSidebarV2,Translate', '--headless=new', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const outp = proc.stdio[3], inp = proc.stdio[4];
    let buf = '', seq = 0; const waiting = new Map();
    inp.on('data', d => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\0')) >= 0) { let m; try { m = JSON.parse(buf.slice(0, i)); } catch (e) { m = {}; } buf = buf.slice(i + 1); if (m.id && waiting.has(m.id)) { const p = waiting.get(m.id); waiting.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } } });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); outp.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
    try {
      let extId = null;
      for (let i = 0; i < 50 && !extId; i++) {
        const { targetInfos } = await send('Target.getTargets');
        const t = targetInfos.find(x => x.type === 'service_worker' && /\/background\.js$/.test(x.url));
        if (t) extId = new URL(t.url).host; else await sleep(200);
      }
      ok(!!extId, 'Edge loaded the extension', extId || '');
      if (extId) {
        const { attach, ev, ping, tabOf } = workerTools(send, extId);
        let w = await attach();
        ok((await ev(w, `new Promise(r => chrome.management.getSelf(i => r(i.installType)))`)) === 'development', '--load-extension gives installType development');
        await ev(w, `chrome.storage.local.set({ devServer: '${BASE}', devAutoUpdate: true })`);
        await ev(w, RETRY);
        const disk0 = await get('/api/ext/version');
        const r1 = await ev(w, `self.__check('test')`);
        ok(r1.upToDate === true && (await lastHello()).sig === disk0.sig, 'first check: hello with the server sig', JSON.stringify(r1));

        const { targetId } = await send('Target.createTarget', { url: `${BASE}/` });
        await sleep(2500);
        const tabId = await tabOf(w, `${BASE}/`);
        ok(await ping(w, tabId), 'content script answers before the reload');

        edit();
        await sleep(2200);
        const disk1 = await get('/api/ext/version');
        await ev(w, `(chrome.storage.session.set({ selftestMarker: 1 }), self.__busy = true, self.scoposBusy = () => self.__busy, 1)`);
        const r2 = await ev(w, `self.__check('test')`);
        await sleep(1500);
        ok(r2.busy === true && (await ev(w, `chrome.storage.session.get('selftestMarker').then(s => s.selftestMarker === 1)`)), 'busy: no reload (same load, session intact)', JSON.stringify(r2));

        const t0 = Date.now();
        await ev(w, `(self.__busy = false, setTimeout(() => self.__check('test'), 50), 1)`);
        const w2 = await attach(w.targetId, 15000);
        ok(!!w2, 'idle: the extension reloaded itself (new worker)', w2 ? `${Date.now() - t0} ms` : '');
        if (w2) {
          w = w2;
          await sleep(500);
          ok(await ev(w, `chrome.storage.session.get('selftestMarker').then(s => !s.selftestMarker)`), 'session storage cleared by the reload');
          const h = await waitHello(disk1.sig);
          ok(h.sig === disk1.sig, 'after the reload the hello carries the new sig', `${h.sig} (disk ${disk1.sig})`);
          let pong = false;
          for (let i = 0; i < 20 && !pong; i++) { pong = await ping(w, tabId); if (!pong) await sleep(250); }
          ok(pong, 'the tab opened before the reload answers again without a refresh (onInstalled re-injection)');
        }
        await send('Target.closeTarget', { targetId }).catch(() => {});
      }
    } finally {
      restore();
      try { await send('Browser.close'); } catch (e) { /* gone */ }
      await sleep(400);
      try { proc.kill(); } catch (e) { /* gone */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* locked */ }
    }
  }
} catch (e) {
  ok(false, 'unexpected error', e.stack || e.message);
} finally {
  restore();
  rmSync(DOTFILE, { force: true });
  ok(sha(readFileSync(TARGET)) === sha(original), 'core/update.js restored byte-exact');
  srv.kill(); mock.close();
  rmSync(tmp, { recursive: true, force: true });
  if (failed) console.log('\n--- server log ---\n' + log.replace(/sk-ant-[\w-]+/g, 'sk-ant-…'));
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
}
