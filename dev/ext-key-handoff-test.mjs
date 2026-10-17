// The one-time key handoff (/setup «Передать ключ расширению Scopos» -> the extension's own key), end to end:
//   node dev/ext-key-handoff-test.mjs            (SHOTS=<dir> also saves screenshots of /setup and the panel)
// Runs its own servers with a FAKE key (never the real .scopos-key.local, never :4173): the server under test on
// 4199, a second one on 4198 with a 1 s approval for the expiry case, and a plain page server for the extension to
// work on. The real extension runs in a throwaway headless Chrome (dev/ext-harness.mjs). No Claude call is made:
// Brain.call is stubbed in the worker, and the server's upstream points nowhere.
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './ext-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4199, PORT_SHORT = 4198;
const FAKE = 'sk-ant-test-fake-0000';
const OTHER = 'abcdefghijklmnopabcdefghijklmnop'; // some other extension id
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'scopos-handoff-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failed++; };

// ---- servers ----
function startServer(port, extraEnv = {}) {
  const proc = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: FAKE, SCOPOS_UPSTREAM: 'http://127.0.0.1:9/v1/messages', SCOPOS_USAGE_FILE: join(tmp, `usage-${port}.json`), SCOPOS_EXT_IDS: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = { proc, log: '' };
  proc.stdout.on('data', d => { s.log += d; }); proc.stderr.on('data', d => { s.log += d; });
  return s;
}
async function waitUp(s) { for (let i = 0; i < 80 && !/Scopos demo/.test(s.log); i++) await sleep(100); }
const main = startServer(PORT);
const short = startServer(PORT_SHORT, { SCOPOS_HANDOFF_TTL_MS: '1000' });
await waitUp(main); await waitUp(short);
// A plain web page for the extension to work on once the Scopos server is gone.
const pages = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Team</title><h1>Команда</h1><button id="inv">Пригласить коллегу</button><a href="/settings">Настройки</a>'); });
await new Promise(r => pages.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${pages.address().port}/team`;

function http(port, method, path, { headers = {}, body, host = `localhost:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port, agent: false, method, path, headers: { host, ...(data ? { 'content-length': data.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(raw); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, raw, json: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const J = { 'content-type': 'application/json' };
const SETUP_ORIGIN = port => ({ ...J, origin: `http://localhost:${port}` });
const hello = (port, id, headless = false) => http(port, 'POST', '/api/ext/hello', { headers: { ...J, 'x-scopos-ext': id }, body: { id, version: '0.2.0', sig: 'test', headless } });
const approve = (port, id, headers = SETUP_ORIGIN(port)) => http(port, 'POST', '/api/ext/key-handoff/approve', { headers, body: { id } });
const collect = (port, headers) => http(port, 'POST', '/api/ext/key-handoff', { headers: { ...J, ...headers }, body: {} });
const status = port => http(port, 'GET', '/api/ext/status');

const b = await launch();
const ID = b.extId;
const W = expr => b.evalWorker(expr);
try {
  console.log('extension', ID);
  await W(`chrome.storage.local.set({ devServer: 'http://localhost:${PORT}' })`);
  const stored = () => W(`chrome.storage.local.get(['apiKey', 'apiKeySource']).then(s => ({ key: s.apiKey || '', source: s.apiKeySource || null }))`);

  // ---- 1. no approval: nothing ----
  let r = await W('keyHandoff()');
  ok(r && r.refused === 403, 'no approval: the extension is refused', JSON.stringify(r));
  ok((await stored()).key === '', 'no approval: no key stored');
  r = await status(PORT);
  ok(r.json && r.json.handoff && r.json.handoff.pending === null && !r.raw.includes(FAKE), 'status: no pending approval, no key in it');

  // ---- 2. the approve route: /setup only ----
  r = await approve(PORT, ID);
  ok(r.status === 409, 'approve: an id that never said hello as loaded is refused', r.status);
  await hello(PORT, OTHER); // another extension says hello as the loaded one
  r = await approve(PORT, OTHER, J);
  ok(r.status === 403, 'approve: without Origin refused', r.status);
  r = await approve(PORT, OTHER, { ...J, origin: 'http://evil.example' });
  ok(r.status === 403, 'approve: foreign Origin refused', r.status);
  r = await approve(PORT, OTHER, { ...J, origin: `chrome-extension://${OTHER}` });
  ok(r.status === 403, 'approve: an extension Origin refused (only /setup approves)', r.status);
  r = await approve(PORT, OTHER, { 'content-type': 'text/plain', origin: `http://localhost:${PORT}` });
  ok(r.status === 415, 'approve: non-JSON refused', r.status);
  r = await approve(PORT, OTHER, { ...SETUP_ORIGIN(PORT), 'sec-fetch-site': 'cross-site' });
  ok(r.status === 403, 'approve: Sec-Fetch-Site cross-site refused', r.status);
  r = await approve(PORT, OTHER, { ...SETUP_ORIGIN(PORT), 'x-forwarded-for': '1.2.3.4' });
  ok(r.status === 403, 'approve: through a proxy refused', r.status);
  r = await http(PORT, 'POST', '/api/ext/key-handoff/approve', { headers: { ...J, origin: 'http://evil.example:4199' }, host: `evil.example:${PORT}`, body: { id: OTHER } });
  ok(r.status === 403, 'approve: foreign Host (DNS rebinding) refused', r.status);
  r = await http(PORT, 'GET', '/api/ext/key-handoff/approve');
  ok(r.status === 405 || r.status === 403, 'approve: GET does nothing', r.status);
  ok((await status(PORT)).json.handoff.pending === null, 'approve: none of the refused calls created an approval');

  // ---- 3. an approval for another id: our extension is refused ----
  r = await approve(PORT, OTHER);
  ok(r.status === 200 && r.json.id === OTHER && !r.raw.includes(FAKE), 'approve: OK for the loaded id, no key in the reply', r.status);
  r = await W('keyHandoff()');
  ok(r && r.refused === 403, 'approval for another id: our extension is refused', JSON.stringify(r));
  ok((await stored()).key === '', 'approval for another id: no key stored');
  r = await hello(PORT, ID, true);
  ok(r.json && r.json.ok && !r.json.keyOffer, 'hello: no keyOffer for an id that was not approved');
  r = await hello(PORT, OTHER, false);
  ok(r.json && r.json.keyOffer === true && !r.raw.includes(FAKE), 'hello: keyOffer for the approved id, no key in it');

  // ---- 4. web origins and requests without the extension Origin never get it ----
  for (const [name, h] of [
    ['no Origin, x-scopos-ext of the approved id', { 'x-scopos-ext': OTHER }],
    ['web Origin of this server', { origin: `http://localhost:${PORT}` }],
    ['web Origin of another site', { origin: 'http://evil.example' }],
    ['Origin null', { origin: 'null' }],
    ['extension Origin + mismatching x-scopos-ext', { origin: `chrome-extension://${OTHER}`, 'x-scopos-ext': ID }],
  ]) {
    r = await collect(PORT, h);
    ok(r.status === 403 && !r.raw.includes(FAKE), `collect refused: ${name}`, r.status);
  }
  r = await collect(PORT, { origin: `chrome-extension://${OTHER}`, 'x-forwarded-for': '1.2.3.4' });
  ok(r.status === 403 && !r.raw.includes(FAKE), 'collect refused: through a proxy', r.status);
  r = await http(PORT, 'POST', '/api/ext/key-handoff', { headers: { ...J, origin: `chrome-extension://${OTHER}` }, host: `evil.example:${PORT}`, body: {} });
  ok(r.status === 403 && !r.raw.includes(FAKE), 'collect refused: foreign Host', r.status);
  r = await http(PORT, 'POST', '/api/ext/key-handoff', { headers: { 'content-type': 'text/plain', origin: `chrome-extension://${OTHER}` }, body: '{}' });
  ok(r.status === 415 && !r.raw.includes(FAKE), 'collect refused: non-JSON', r.status);
  r = await http(PORT, 'GET', '/api/ext/key-handoff', { headers: { origin: `chrome-extension://${OTHER}` } });
  ok(r.status === 405 && !r.raw.includes(FAKE), 'collect refused: GET', r.status);
  ok((await status(PORT)).json.handoff.pending !== null, 'the refused attempts did not use up the approval');

  // ---- 5. used: the approved id collects once, the second time is refused ----
  r = await collect(PORT, { origin: `chrome-extension://${OTHER}` });
  ok(r.status === 200 && r.json && r.json.key === FAKE, 'collect: the approved id gets the key once (request as that extension would send it)');
  ok(r.headers['cache-control'] === 'no-store', 'collect: reply is no-store');
  r = await collect(PORT, { origin: `chrome-extension://${OTHER}` });
  ok(r.status === 403 && !r.raw.includes(FAKE), 'collect: a used approval is refused', r.status);
  r = await status(PORT);
  ok(r.json.handoff.pending === null && r.json.handoff.done && r.json.handoff.done.id === OTHER && !r.raw.includes(FAKE), 'status: done for that id, no key');

  // ---- 6. expired (server on 4198 with a 1 s approval) ----
  await hello(PORT_SHORT, OTHER);
  r = await approve(PORT_SHORT, OTHER);
  ok(r.status === 200, 'expiry server: approved', r.status);
  await sleep(1300);
  r = await collect(PORT_SHORT, { origin: `chrome-extension://${OTHER}` });
  ok(r.status === 403 && !r.raw.includes(FAKE), 'collect: an expired approval is refused', r.status);
  r = await status(PORT_SHORT);
  ok(r.json.handoff.pending === null && r.json.handoff.expired === true, 'status: expired');

  // ---- 7. /setup UI and the happy path through the hello cycle ----
  await hello(PORT, ID, false); // as a headed Chrome would: our extension is now the loaded one
  const setup = await b.open(`http://localhost:${PORT}/setup`);
  await sleep(800);
  const hs = () => setup.eval(`(() => { const b = document.querySelector('#handoff-state'); return { hidden: b.hidden, text: b.innerText, button: !!document.querySelector('#handoff') }; })()`);
  let ui = await hs();
  ok(!ui.hidden && ui.button && /Передать ключ расширению Scopos/.test(ui.text) && ui.text.includes(ID), '/setup: button shown with the loaded id', JSON.stringify(ui.text));
  if (SHOTS) await setup.screenshot(join(SHOTS, 'setup-1-button.png'));

  // A web page (this very origin, then another site) with an approval open for our extension still gets nothing.
  // Click like a person (a trusted event: the page ignores synthetic clicks).
  const rect = await setup.eval(`(() => { const b = document.querySelector('#handoff'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await setup.click(rect.x, rect.y);
  await sleep(600);
  ui = await hs();
  ok(/Жду, когда расширение заберёт ключ/.test(ui.text), '/setup: waiting state after the click', JSON.stringify(ui.text));
  r = await status(PORT);
  ok(r.json.handoff.pending && r.json.handoff.pending.id === ID && r.json.handoff.pending.expiresAt - Date.now() <= 120000, 'approval: for exactly our id, at most 2 minutes');
  if (SHOTS) await setup.screenshot(join(SHOTS, 'setup-2-waiting.png'));
  const sameOrigin = await setup.eval(`fetch('/api/ext/key-handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async r => ({ status: r.status, text: await r.text() }), e => ({ error: String(e) }))`);
  ok(sameOrigin.status === 403 && !String(sameOrigin.text).includes(FAKE), 'web page on the server origin: refused', JSON.stringify(sameOrigin.status));
  const web = await b.open(PAGE);
  const cross = await web.eval(`fetch('http://localhost:${PORT}/api/ext/key-handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async r => ({ status: r.status, text: await r.text() }), e => ({ error: String(e) }))`);
  ok(!!cross.error || (cross.status === 403 && !String(cross.text).includes(FAKE)), 'web page on another site: refused', JSON.stringify(cross).slice(0, 80));
  const noCors = await web.eval(`fetch('http://localhost:${PORT}/api/ext/key-handoff', { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: '{}' }).then(() => 'sent', e => String(e))`);
  ok(noCors === 'sent' || /Failed/.test(noCors), 'web page no-cors request: opaque, nothing readable');
  ok((await status(PORT)).json.handoff.pending !== null, 'web attempts did not use up the approval');

  // The hello cycle (core/update.js): the reply says keyOffer, the worker collects.
  await W(`chrome.storage.local.set({ devAutoUpdate: true })`);
  const chk = await W(`self.scoposDevUpdate.check('test').then(r => ({ r, handoff: self.scoposDevUpdate.state.handoff || null }))`);
  ok(chk.handoff && chk.handoff.got === true, 'hello cycle: keyOffer -> key collected', JSON.stringify(chk));
  await W(`chrome.storage.local.set({ devAutoUpdate: false })`);
  let s = await stored();
  ok(s.key === FAKE && s.source === 'server', 'extension: key stored as its own (apiKeySource server)');
  r = await W('keyHandoff({ force: true })');
  ok(r && r.refused === 403, 'extension: a second collect is refused (used)', JSON.stringify(r));
  await sleep(2600); // the page polls every 2 s while waiting
  ui = await hs();
  ok(/Ключ передан расширению ✓/.test(ui.text) && /Убрать ключ из расширения/.test(ui.text), '/setup: «Ключ передан расширению ✓»', JSON.stringify(ui.text));
  if (SHOTS) await setup.screenshot(join(SHOTS, 'setup-3-done.png'));
  ok(!main.log.includes(FAKE) && !short.log.includes(FAKE), 'server logs never contain the key');

  // Content scripts (inside web pages' processes) can't read it.
  const cs = await web.evalScopos(`chrome.storage.local.get('apiKey').then(s => s.apiKey ? 'READ' : 'empty', e => 'denied: ' + e.message)`).catch(e => 'denied: ' + e.message);
  ok(cs !== 'READ', 'content script cannot read the stored key', cs.slice(0, 80));

  // ---- 8. the panel: settings label, «Убрать ключ», then the panel-open handoff path ----
  const panel = await b.open(`chrome-extension://${ID}/sidepanel/sidepanel.html`);
  await sleep(500);
  await panel.eval(`document.querySelector('#tab-set').click()`);
  await sleep(500);
  const keyText = () => panel.eval(`document.querySelector('#key-state').innerText`);
  let kt = await keyText();
  ok(/Ключ: свой \(получен с локального сервера\)/.test(kt) && /Убрать ключ из расширения/.test(kt), 'panel: «Ключ: свой (получен с локального сервера)»', JSON.stringify(kt));
  if (SHOTS) await panel.screenshot(join(SHOTS, 'panel-1-own-from-server.png'));
  await panel.eval(`document.querySelector('#key-del').click()`);
  await sleep(1500);
  s = await stored();
  ok(s.key === '' && s.source === null, 'panel: «Убрать ключ из расширения» removes it');
  kt = await keyText();
  ok(/Передать ключ расширению/.test(kt), 'panel: with the server up, the hint to hand the key over', JSON.stringify(kt));
  // Approve again (as /setup would) and open the panel: it collects on open.
  r = await approve(PORT, ID);
  ok(r.status === 200, 'approve again for our id', r.status);
  await panel.goto(`chrome-extension://${ID}/sidepanel/sidepanel.html`, { waitMs: 1500 });
  s = await stored();
  ok(s.key === FAKE && s.source === 'server', 'panel open: key collected');

  // ---- 9. the server is gone: the extension still answers, with its own key ----
  main.proc.kill(); short.proc.kill();
  await sleep(500);
  r = await http(PORT, 'GET', '/api/ext/version').then(() => 'up', () => 'down');
  ok(r === 'down', 'server on 4199 stopped');
  await W(`(() => {
    self.__calls = [];
    self.__realCall = self.__realCall || Brain.call;
    Brain.call = async (body, key, opts = {}) => { self.__calls.push({ ownKey: key === ${JSON.stringify(FAKE)}, endpoint: opts.endpoint || null, model: body && body.model }); return { answer: 'Нажмите «Пригласить коллегу».', steps: [] }; };
    return true;
  })()`);
  const a = await W(`auth().then(a => a && { mode: a.mode, endpoint: a.endpoint || null, keyIsFake: a.key === ${JSON.stringify(FAKE)} })`);
  ok(a && a.mode === 'own' && a.endpoint === null && a.keyIsFake, 'server stopped: auth() uses the own key, no proxy', JSON.stringify(a));
  const tabId = await W(`chrome.tabs.query({}).then(t => (t.find(x => (x.url || '').startsWith(${JSON.stringify(PAGE)})) || {}).id)`);
  const asked = await W(`ask(${tabId}, 'Как пригласить коллегу?', { force: true }).then(s => ({ status: s.status, answer: s.answer, source: s.source }), e => ({ error: e.message }))`);
  const calls = await W('self.__calls');
  ok(asked && !asked.error && /Пригласить/.test(asked.answer || ''), 'server stopped: a question is answered', JSON.stringify(asked));
  ok(calls.length === 1 && calls[0].ownKey && calls[0].endpoint === null, 'server stopped: Brain.call got the own key and no proxy endpoint', JSON.stringify(calls));

  // ---- 10. no key and no server: the helpful message ----
  await W(`chrome.storage.local.remove(['apiKey', 'apiKeySource', 'apiKeyAt'])`);
  const none = await W(`ask(${tabId}, 'Где поменять пароль?', { force: true }).then(() => ({ ok: true }), e => ({ code: e.code, message: e.message }))`);
  ok(none.code === 'key' && none.message.includes(`Нет ключа. Откройте http://localhost:${PORT}/setup и нажмите «Передать ключ расширению», или вставьте ключ здесь`), 'no key: the ask error says where to get one', JSON.stringify(none.message));
  await panel.goto(`chrome-extension://${ID}/sidepanel/sidepanel.html`, { waitMs: 600 });
  await panel.eval(`document.querySelector('#tab-set').click()`);
  await sleep(2500);
  kt = await keyText();
  ok(/Нет ключа\. Откройте http:\/\/localhost:4199\/setup и нажмите «Передать ключ расширению», или вставьте ключ здесь\./.test(kt), 'panel: no-key state is the helpful one', JSON.stringify(kt));
  if (SHOTS) await panel.screenshot(join(SHOTS, 'panel-2-no-key.png'));
  await W('Brain.call = self.__realCall; true');
} catch (e) {
  failed++;
  console.log('FAIL  crashed:', e && e.stack || e);
} finally {
  await b.close();
  try { main.proc.kill(); } catch (e) { /* gone */ }
  try { short.proc.kill(); } catch (e) { /* gone */ }
  pages.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
