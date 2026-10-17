// Runs the REAL explorer through the extension worker (learnStart) in a throwaway headless Chrome and checks the
// saved product map. No Claude call can happen: the profile has no key, its proxy server points nowhere and its
// monthly budget is 0, so the walk ends in status 'mapped'.
//
//   node dev/explore-walk.mjs                       # the Ledgerly demo on :4173, with assertions
//   node dev/explore-walk.mjs <url> [out.json]      # any product: prints views, probes, time, writes
//
// Writes are counted from the page's own network events (CDP): a non-GET request that got a response reached the
// server. The demo must map the invite dialog, the add-client dialog and the new-invoice page with their fields and
// commit buttons, and send zero writes.
import { writeFileSync } from 'node:fs';
import { launch } from './ext-harness.mjs';

const url = process.argv[2] || 'http://localhost:4173/';
const out = process.argv[3] || '';
const demo = !process.argv[2];
const origin = new URL(url).origin;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const b = await launch({ width: 1366, height: 860 });
const t0 = Date.now();
let failed = 0;
const check = (name, ok, extra) => { if (!ok) { failed++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } else console.log('ok  ', name); };
try {
  await b.evalWorker(`chrome.storage.local.set({ devServer: 'http://127.0.0.1:9', monthlyLimit: 0 })`);
  const p = await b.open('about:blank');
  await p.send('Network.enable', {});
  const pending = new Map(), reached = [], blocked = [];
  b.on(m => {
    if (m.sessionId !== p.sessionId) return;
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (!/^(GET|HEAD|OPTIONS)$/.test(r.method)) pending.set(m.params.requestId, { method: r.method, url: r.url });
    }
    if (m.method === 'Network.webSocketCreated') reached.push({ method: 'WS', url: m.params.url });
    if (m.method === 'Network.responseReceived' && pending.has(m.params.requestId)) reached.push({ ...pending.get(m.params.requestId), status: m.params.response.status });
    if (m.method === 'Network.loadingFailed' && pending.has(m.params.requestId)) blocked.push({ ...pending.get(m.params.requestId), err: m.params.errorText });
  });
  await p.goto(url, { waitMs: 1500 });
  const snap = await p.evalScopos(`(() => { const t = performance.now(); const v = Scopos.explore.snapshot(); return { ms: +(performance.now() - t).toFixed(1), controls: v.controls.length }; })()`);
  console.log('snapshot of the start page:', JSON.stringify(snap));
  const tabId = await b.evalWorker(`chrome.tabs.query({}).then(ts => (ts.find(t => (t.url || '').startsWith(${JSON.stringify(origin)})) || {}).id)`);
  await b.evalWorker(`learnStart(${tabId}, true)`);
  let L = null;
  while (Date.now() - t0 < 17 * 60e3) {
    await sleep(1000);
    try { L = await b.evalWorker(`readLearn(${JSON.stringify(origin)})`); } catch (e) { continue; }
    if (L && L.status !== 'exploring') break;
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  const key = JSON.stringify('map:' + origin);
  const map = await b.evalWorker(`chrome.storage.local.get(${key}).then(o => o[${key}])`);
  if (out) writeFileSync(out, JSON.stringify({ learn: L, map, reached, blocked, secs }, null, 1));
  const views = map ? map.views : [];
  const kinds = {};
  views.forEach(v => { kinds[v.kind] = (kinds[v.kind] || 0) + 1; });
  console.log(`status ${L && L.status}; ${secs}s; views ${views.length} ${JSON.stringify(kinds)}; probes ${map && map.probes}; forms ${views.filter(v => v.form).length}; map ${map ? Math.round(JSON.stringify(map).length / 1024) : 0} KB`);
  console.log(`writes that reached a server: ${reached.length}; writes failed/blocked on the wire: ${blocked.length}`);
  for (const v of views) {
    const c = v.controls;
    console.log(`  ${v.id} ${v.kind}${v.form ? ' form' : ''} "${v.title}" · ${c.length} controls` +
      `${c.some(x => x.commit) ? ' · commit: ' + c.filter(x => x.commit).map(x => x.name).join(', ') : ''}` +
      `${c.some(x => x.unexplored) ? ' · unexplored: ' + c.filter(x => x.unexplored).length : ''}`);
  }
  check('zero writes reached the server', reached.length === 0, reached);
  check('the walk ended without Claude (mapped)', L && L.status === 'mapped', L && L.status);
  if (demo) {
    const find = (kind, title) => views.find(v => v.kind === kind && v.title === title);
    const has = (v, role, name) => v && v.controls.some(c => c.role === role && c.name === name);
    const invite = find('dialog', 'Пригласить коллегу'), client = find('dialog', 'Новый клиент'), invoice = find('page', 'Новый счёт');
    check('invite dialog mapped with its fields and commit', invite && invite.form && has(invite, 'textbox', 'Почта') && has(invite, 'select', 'Роль')
      && invite.controls.some(c => c.name === 'Отправить приглашение' && c.commit));
    check('the invite opener leads to it', views.some(v => v.controls.some(c => c.name === 'Пригласить коллегу' && c.to === (invite && invite.id))));
    check('add-client dialog mapped with its fields and commit', client && client.form && ['Название', 'ИНН', 'Email'].every(n => has(client, 'textbox', n))
      && client.controls.some(c => c.name === 'Сохранить клиента' && c.commit));
    check('new-invoice page mapped with its fields and commit', invoice && invoice.form && has(invoice, 'select', 'Клиент') && has(invoice, 'textbox', 'Сумма, ₽')
      && invoice.controls.some(c => c.name === 'Отправить счёт' && c.commit));
    check('company form has its «Сохранить» commit', views.some(v => v.title === 'Настройки' && v.form && v.controls.some(c => c.name === 'Сохранить' && c.commit)));
    check('the plan form behind «Сменить тариф» is mapped', views.some(v => v.kind === 'panel' && v.controls.some(c => c.name === 'Подтвердить' && c.commit)));
    check('tables are named regions', views.some(v => v.controls.some(c => c.role === 'table' && c.name === 'Клиенты' && c.d)));
  }
} finally { await b.close(); }
console.log(failed ? `\nexplore walk: ${failed} failed` : '\nexplore walk: all passed');
process.exit(failed ? 1 : 0);
