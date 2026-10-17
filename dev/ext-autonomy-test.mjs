// End-to-end checks for the extension's autonomy work (background.js, content.js, the side panel), in the
// headless harness with ZERO real Claude calls: Brain.call is stubbed in the worker, and the proxy path goes to
// a fake local server started here that answers /api/ext/version and streams a canned /api/claude reply.
//
//   node dev/ext-autonomy-test.mjs          (needs the demo server on http://localhost:4173)
//
// Covers: precise Chrome errors, the "no access" panel state and its retry, guide:more / guide:steps / guide:end
// saving a longer guide, passive map growth (merge rules, real snapshot, route change), auto-guides, the monthly
// budget, proxy detection and a full proxied call through brain.js, the net flag for the explorer, scoposBusy,
// double injection, and the panel's settings and version.
import { createServer } from 'node:http';
import { launch } from './ext-harness.mjs';

const DEMO = 'http://localhost:4173/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
};
const section = s => console.log('\n# ' + s);
async function until(fn, ms = 5000, step = 100) { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(step); } return v; }

// ---------- a fake Scopos server: /api/ext/version and a streamed /api/claude ----------
const proxyLog = [];
let proxyReply = { answer: 'Через прокси', steps: [] };
let proxyStatus = 200;
const fake = createServer((req, res) => {
  if (req.url === '/api/ext/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ version: '0.2.0', sig: 'x', files: [] })); }
  if (req.url === '/api/claude' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      proxyLog.push({ headers: req.headers, body: (() => { try { return JSON.parse(body); } catch (e) { return null; } })() });
      if (proxyStatus !== 200) { res.writeHead(proxyStatus, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'budget_exceeded', message: 'Месячный бюджет на Claude ($5) исчерпан. Готовые гайды и сохранённые ответы работают.' } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      ev({ type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 1 } } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(proxyReply) } });
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 80 } });
      ev({ type: 'message_stop' });
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end('nope');
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://localhost:${fake.address().port}`;

const b = await launch();
const W = expr => b.evalWorker(expr);
try {
  const page = await b.open(DEMO);
  await page.evalScopos('1');
  const origin = 'http://localhost:4173';
  const tabId = await W(`chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith('${DEMO}')).id)`);

  // A fake Claude in the worker: counts calls, reports usage like the real one, answers from a queue.
  await W(`(() => {
    self.__realCall = self.__realCall || Brain.call;
    self.__calls = []; self.__replies = [];
    Brain.call = async (body, key, opts = {}) => { // opts.endpoint: the proxy, when there is no key
      __calls.push({ model: body.model, key, endpoint: opts.endpoint || null, system: JSON.stringify(body.system || '').slice(0, 200) });
      if (opts.onUsage) opts.onUsage({ input_tokens: 2000, output_tokens: 200 }, body.model);
      const r = __replies.shift();
      return typeof r === 'function' ? r(body) : (r || { answer: '', steps: [] });
    };
    return chrome.storage.local.set({ apiKey: 'sk-ant-test-not-a-real-key' });
  })()`);

  section('precise Chrome errors');
  const cases = await W(`[
    ['Cannot access contents of the page. Extension manifest must request permission to access the respective host.', { url: 'https://a.example/x' }],
    ['Cannot access a chrome:// URL', {}],
    ['The extensions gallery cannot be scripted.', {}],
    ['Cannot access contents of url "file:///C:/x.html". Extension manifest must request permission to access this host.', { url: 'file:///C:/x.html' }],
    ['Could not establish connection. Receiving end does not exist.', { injected: true }],
    ['Could not establish connection. Receiving end does not exist.', { injected: false }],
    ['Frame with ID 0 was removed.', {}],
    ['No tab with id: 5.', {}],
    ['Frame with ID 0 is showing error page', {}],
  ].map(([m, o]) => { const e = chromeError(new Error(m), o); return [e.code, e.origin || null, e.message]; })`);
  ok(cases[0][0] === 'access' && cases[0][1] === 'https://a.example', 'no host permission -> access (with origin)', cases[0]);
  ok(cases[1][0] === 'restricted' && cases[2][0] === 'restricted', 'chrome:// and web store -> restricted', [cases[1][0], cases[2][0]]);
  ok(cases[3][0] === 'file' && /URL файлов/.test(cases[3][2]), 'file:// without file access -> file', cases[3]);
  ok(cases[4][0] === 'inject' && cases[5][0] === 'loading', 'receiving end after injection -> inject, before -> loading', [cases[4][0], cases[5][0]]);
  ok(cases[6][0] === 'loading' && cases[7][0] === 'closed' && cases[8][0] === 'loading', 'frame removed / closed tab / error page', [cases[6][0], cases[7][0], cases[8][0]]);
  const blank = await W(`chrome.tabs.create({ url: 'about:blank', active: false }).then(async t => { await new Promise(r => setTimeout(r, 300)); try { await toTab(t.id, { type: 'ping' }); return 'no error'; } catch (e) { return e.code; } finally { chrome.tabs.remove(t.id); } })`);
  ok(blank === 'restricted', 'toTab on about:blank -> restricted', blank);
  const askBlank = await W(`chrome.tabs.create({ url: 'about:blank', active: false }).then(async t => { await new Promise(r => setTimeout(r, 300)); try { await ask(t.id, 'как?'); return 'no error'; } catch (e) { return e.code + ' ' + e.message.slice(0, 40); } finally { chrome.tabs.remove(t.id); } })`);
  ok(/^restricted/.test(askBlank), 'ask on a restricted page says so, before any call', askBlank);

  section('double injection is harmless');
  const dbl = await W(`(async () => {
    await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: CORE_FILES });
    await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: CORE_FILES });
    return (await toTab(${tabId}, { type: 'ping' })).ok;
  })()`);
  ok(dbl === true, 'ping answers after two extra injections', dbl);
  ok(await page.evalScopos('!!(window.__scoposContent && window.__scoposContent.alive())'), 'one live content copy');

  section('budget refusal');
  await W(`chrome.storage.local.set({ usage: { total: { tokens: 0, cost: 0, calls: 0 }, origins: {}, months: { [monthKey()]: { tokens: 1, cost: 5, calls: 1 } } }, monthlyLimit: 2 })`);
  const before = await W('__calls.length');
  const refused = await W(`ask(${tabId}, 'уникальный вопрос про бюджет номер 7').then(() => 'answered', e => e.code + '|' + e.message)`);
  ok(/^budget\|Лимит на этот месяц \(\$2\)/.test(refused), 'ask over the limit -> budget message', refused);
  const sessErr = await W(`getSession(${tabId}).then(s => s && s.errorCode)`);
  ok(sessErr === 'budget', 'session carries errorCode budget', sessErr);
  ok((await W('__calls.length')) === before, 'no Claude call over the limit');
  const healOver = await W(`(async () => { await updateSession(${tabId}, c => ({ ...(c || {}), status: 'running', steps: [{ instruction: 'x', action: 'click', target: null }], index: 0, runId: 'r-b', heals: 0, mores: {} })); return heal(${tabId}, { step: { instruction: 'x' }, page: { lines: [] }, candidates: [] }); })()`);
  ok(healOver.id === null && healOver.budget === true, 'heal skipped gracefully', healOver);
  const moreOver = await W(`continueGuide(${tabId}, { index: 1, reason: 'end', done: [], page: { lines: [] } })`);
  ok(moreOver.steps === null && moreOver.budget === true, 'continue skipped gracefully', moreOver);
  await W(`chrome.storage.local.set({ monthlyLimit: 10 })`);
  ok((await W('overBudget()')) === false, 'raised limit lifts the block');
  await W(`updateSession(${tabId}, () => null)`);

  section('guide:more with a fake Claude');
  // A live learned guide with one step («Счета»); Claude continues with «Новый счёт» (a real control on the page).
  const ids = await page.evalScopos(`(() => { const lines = Scopos.scan({ query: '' }).lines; const id = re => { const l = lines.find(x => re.test(x)); return l ? +/\\[(\\d+)\\]/.exec(l)[1] : null; }; return { inv: id(/link "Счета"/), btn: id(/(button|link) "(?!Счета)/) }; })()`);
  ok(ids.inv != null && ids.btn != null, 'found controls on the demo page', ids);
  const target = await page.evalScopos(`Scopos.describe(Scopos.byId(${ids.inv}))`);
  await W(`updatePlaybooks('${origin}', () => [{ id: 'pb-live', name: 'Открыть счета', steps: [{ instruction: 'Откройте «Счета»', action: 'click', value: null, target: ${JSON.stringify(target)} }], created: Date.now(), runs: 0, learned: true, live: true }])`);
  await page.evalScopos(`(() => { const orig = Scopos.guide.start; window.__cap = null; Scopos.guide.start = (steps, opts) => { window.__cap = { steps, opts }; return orig(steps, opts); }; })()`);
  await W(`runPlaybook(${tabId}, '${origin}', 'pb-live')`);
  const cap = await until(() => page.evalScopos(`window.__cap && { live: window.__cap.opts.live, more: typeof window.__cap.opts.more, onSteps: typeof window.__cap.opts.onSteps, n: window.__cap.steps.length }`));
  ok(cap && cap.live === true && cap.more === 'function' && cap.onSteps === 'function', 'S.guide.start gets live, more, onSteps', cap);
  ok((await W('scoposBusy()')) === true, 'scoposBusy() while a guide runs');
  const calls0 = await W('__calls.length');
  await W(`__replies.push({ answer: '', steps: [{ instruction: 'Нажмите «Новый счёт»', element_id: ${ids.btn}, element_text: 'Новый счёт', action: 'click', value: null }] })`);
  const more1 = await page.evalScopos(`window.__cap.opts.more({ index: 1, reason: 'end', done: ['Откройте «Счета»'] })`);
  ok(Array.isArray(more1) && more1.length === 1 && more1[0].target && more1[0].target.text, 'more() returns runnable steps with a page descriptor', more1);
  const c1 = await W(`__calls.slice(${calls0})`);
  ok(c1.length === 1 && /sonnet/.test(c1[0].model), 'one call, on the ask model', c1);
  const s1 = await W(`getSession(${tabId}).then(s => ({ n: s.steps.length, extended: s.extended, mores: s.mores }))`);
  ok(s1.n === 2 && s1.extended === true && s1.mores.end === true, 'session now holds the longer guide', s1);
  const more2 = await page.evalScopos(`window.__cap.opts.more({ index: 2, reason: 'end', done: [] })`);
  ok(more2 === null && (await W('__calls.length')) === calls0 + 1, 'second more for the same reason: no call', more2);
  const resumed = await W(`handle({ type: 'resume' }, { tab: { id: ${tabId}, url: '${DEMO}' } })`);
  ok(resumed.steps && resumed.steps.length === 2 && resumed.live === true && resumed.name === 'Открыть счета', 'resume after a page load uses the extended steps', { n: resumed.steps && resumed.steps.length, live: resumed.live });
  // guide.js reports the new list (onSteps), then the user finishes it (onEnd 'done').
  // (more() was called directly, not by guide.js, so guide.js's own list is stood in for: S.guide.steps() is what onEnd sends.)
  await page.evalScopos(`(() => { const s = window.__cap.steps.concat(${JSON.stringify(more1)}); const own = Scopos.guide.steps; Scopos.guide.steps = () => s; window.__cap.opts.onSteps(s); window.__cap.opts.onEnd('done'); Scopos.guide.steps = own; })()`);
  const pb = await until(async () => { const p = (await W(`getPlaybooks('${origin}')`)).find(x => x.id === 'pb-live'); return p && p.steps.length === 2 ? p : null; });
  ok(pb && pb.steps.length === 2 && pb.live === false, 'finished guide saved with its new step, live:false (ends with a click)', pb ? { n: pb.steps.length, live: pb.live } : await W(`getSession(${tabId}).then(s => ({ status: s.status, n: s.steps.length, ext: s.extended, src: s.source, id: s.playbookId, last: s.steps[s.steps.length - 1] }))`));
  ok((await W(`getSession(${tabId}).then(s => s.status)`)) === 'done', 'session done');
  ok((await W('scoposBusy()')) === false, 'scoposBusy() false after the guide');
  // An empty continuation at the end marks a live guide complete.
  await W(`updatePlaybooks('${origin}', l => l.map(p => ({ ...p, live: true })))`);
  await W(`runPlaybook(${tabId}, '${origin}', 'pb-live')`);
  await W(`__replies.push({ answer: 'всё', steps: [] })`);
  await until(() => page.evalScopos(`window.__cap && window.__cap.steps.length === 2`));
  const more3 = await page.evalScopos(`window.__cap.opts.more({ index: 2, reason: 'end', done: ['a', 'b'] })`);
  const pb3 = (await W(`getPlaybooks('${origin}')`)).find(x => x.id === 'pb-live');
  ok(Array.isArray(more3) && more3.length === 0 && pb3.live === false, 'nothing more to do -> guide marked complete', { more3, live: pb3.live });
  await W(`handle({ type: 'stop', tabId: ${tabId} }, {})`);

  section('a live guide driven by guide.js and real clicks');
  await page.evalScopos(`(() => { if (window.__origStart) Scopos.guide.start = window.__origStart; })()`);
  await W(`updatePlaybooks('${origin}', l => [{ id: 'pb-flow', name: 'Перейти к клиентам', steps: [{ instruction: 'Откройте «Счета»', action: 'click', value: null, target: ${JSON.stringify(target)} }], created: Date.now(), runs: 0, learned: true, live: true }, ...l.filter(p => p.id !== 'pb-flow')])`);
  const callsF = await W('__calls.length');
  await W(`__replies.push({ answer: '', steps: [{ instruction: 'Откройте «Клиенты»', element_id: null, element_text: 'Клиенты', action: 'click', value: null }] })`);
  await W(`runPlaybook(${tabId}, '${origin}', 'pb-flow')`);
  await sleep(700);
  const clickLink = async text => {
    const r = await page.eval(`(() => { const a = [...document.querySelectorAll('a,button')].find(x => x.textContent.trim() === ${JSON.stringify(text)} && x.offsetParent); if (!a) return null; const b = a.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (r) await page.click(r.x, r.y);
    return !!r;
  };
  ok(await clickLink('Счета'), 'clicked «Счета» (the last step of a live guide)');
  const grown = await until(() => W(`getSession(${tabId}).then(s => s && s.steps.length === 2 && s)`), 8000);
  ok(grown && grown.extended === true, 'guide.js asked more at the end; the session grew to 2 steps', grown && { n: grown.steps.length, status: grown.status });
  ok((await W(`__calls.length`)) === callsF + 1, 'exactly one Claude call for it');
  await sleep(600);
  ok(await clickLink('Клиенты'), 'clicked «Клиенты» (the added step)');
  const flow = await until(async () => { const p = (await W(`getPlaybooks('${origin}')`)).find(x => x.id === 'pb-flow'); return p && p.steps.length === 2 && p; }, 10000);
  ok(flow && flow.live === false && flow.steps[1].instruction === 'Откройте «Клиенты»', 'finished: saved with the added step, live:false (free next time)', flow && { n: flow.steps.length, live: flow.live });
  ok((await W(`__calls.length`)) === callsF + 1, 'no second call at the end (one more per reason per run)');
  await W(`handle({ type: 'stop', tabId: ${tabId} }, {})`);
  await page.eval(`location.hash = ''`);

  section('passive learning: merge rules');
  const views = [
    { id: 'V1', key: '/', url: DEMO, kind: 'page', title: 'Обзор', controls: [{ ref: 'V1.1', role: 'link', name: 'Счета', d: { sel: [], text: 'Счета', href: '/zz-new' } }, { ref: 'V1.2', role: 'link', name: 'Клиенты' }] },
    { id: 'V2', key: '/clients', url: DEMO + 'clients', kind: 'page', title: 'Клиенты', controls: [{ ref: 'V2.1', role: 'button', name: 'Добавить' }] },
  ];
  await W(`(async () => { await chrome.storage.local.set({ ['map:${origin}']: { origin: '${origin}', learnedAt: 'x', views: ${JSON.stringify(views)} } }); await chrome.storage.local.remove('passive:${origin}'); await updateLearn('${origin}', () => ({ status: 'done', views: 2, guides: 1, at: Date.now() })); })()`);
  const fv = n => ({ id: 'P', key: '/zz-new', url: DEMO + 'zz-new', kind: 'page', title: 'Новый экран', controls: Array.from({ length: n }, (_, i) => ({ ref: 'P.' + (i + 1), role: 'button', name: 'Кнопка ' + (i + 1), d: { sel: ['#b' + i], text: 'Кнопка ' + (i + 1) } })) });
  const r1 = await W(`observe('${origin}', ${JSON.stringify(fv(3))})`);
  ok(r1.result === 'added' && r1.id === 'V3' && r1.newViews === 1, 'new key -> appended as V3', r1);
  let map = await W(`getMap('${origin}')`);
  const v3 = map.views.find(v => v.id === 'V3');
  ok(v3 && v3.controls.map(c => c.ref).join() === 'V3.1,V3.2,V3.3', 'refs rewritten to V3.n', v3 && v3.controls.map(c => c.ref));
  ok(map.views[0].controls[0].to === 'V3', 'a known link to the new page now leads to it (to: V3)', map.views[0].controls[0]);
  const r2 = await W(`observe('${origin}', ${JSON.stringify(fv(2))})`);
  ok(r2.result === 'kept', 'same key, fewer controls -> kept', r2);
  const r3 = await W(`observe('${origin}', ${JSON.stringify(fv(4))})`);
  map = await W(`getMap('${origin}')`);
  ok(r3.result === 'replaced' && map.views.find(v => v.id === 'V3').controls.length === 4 && map.views.length === 3, 'same key, more controls -> replaced, id kept', r3);
  const r4 = await W(`observe('${origin}', ${JSON.stringify({ ...fv(2), key: '/clients › Новый клиент', kind: 'dialog', title: 'Новый клиент' })})`);
  map = await W(`getMap('${origin}')`);
  const v4 = map.views.find(v => v.id === 'V4');
  ok(r4.result === 'added' && v4 && v4.kind === 'dialog' && v4.parent === 'V2', 'dialog snapshot -> V4 under its page', v4 && { kind: v4.kind, parent: v4.parent });
  const bad = await W(`observe('${origin}', { key: '/x', url: 'https://evil.example/x', controls: [] })`);
  ok(bad.result === 'invalid', 'a view from another origin is refused', bad);

  section('passive learning: from the page');
  ok(await page.evalScopos(`typeof Scopos.explore.snapshot === 'function'`), 'S.explore.snapshot is there (explorer contract)');
  await W(`(async () => { observedAt.clear(); await chrome.storage.session.remove('observed'); })()`);
  const key = await page.evalScopos('Scopos.explore.pageKey()');
  const want1 = await page.evalScopos(`chrome.runtime.sendMessage({ type: 'map:want', key: ${JSON.stringify(key)} })`);
  const want2 = await page.evalScopos(`chrome.runtime.sendMessage({ type: 'map:want', key: ${JSON.stringify(key)} })`);
  ok(want1.ok === true && want2.ok === false, 'map:want: yes once, then throttled for 10 min', [want1, want2]);
  const obs = await page.evalScopos(`chrome.runtime.sendMessage({ type: 'map:observe', view: Scopos.explore.snapshot() })`);
  ok(['replaced', 'kept', 'added'].includes(obs.result), 'real snapshot merged', obs);
  // A route change in the page (pushState) is noticed and observed on its own, after the debounce.
  await W(`(async () => { observedAt.clear(); await chrome.storage.session.remove('observed'); })()`);
  await page.eval(`history.pushState({}, '', '/zz-route-test')`);
  const routed = await until(async () => (await W(`getMap('${origin}')`)).views.find(v => v.key === '/zz-route-test'), 8000, 250);
  ok(!!routed, 'route change -> snapshot merged as a new view by itself', routed && { id: routed.id, n: routed.controls.length });
  await page.eval(`history.back()`);
  const P = await until(async () => { const x = await W(`getPassive('${origin}')`); return x.newViews.length >= 3 && x; }) || await W(`getPassive('${origin}')`);
  ok(P.newViews.length >= 3, 'newViewsSinceGuides counted', P);

  section('auto-guides for the new views');
  await W('__replies.length = 0');
  await W(`(async () => chrome.storage.local.set({ ['passive:${origin}']: { ...(await getPassive('${origin}')), lastGuidesAt: 0 } }))()`);
  await W(`updateLearn('${origin}', c => ({ ...c, at: 0 }))`);
  const callsA = await W('__calls.length');
  await W(`for (let i = 0; i < 8; i++) __replies.push({ summary: 'demo', guides: [{ name: 'Нажать кнопку 1 на новом экране', steps: [{ instruction: 'Нажмите «Кнопка 1»', element_ref: 'V3.1', action: 'click', value: null }], continues_live: false }] })`);
  const auto = await W(`maybeAutoGuides('${origin}')`);
  ok(auto.added >= 1, 'auto-guides wrote and merged a guide', auto);
  const callsB = await W(`__calls.slice(${callsA})`);
  ok(callsB.length >= 1 && callsB.every(c => /opus/.test(c.model)), 'learn-model calls only for the new views', callsB.map(c => c.model));
  const pbs = await W(`getPlaybooks('${origin}')`);
  ok(pbs.some(p => p.learned && p.name === 'Нажать кнопку 1 на новом экране') && pbs.some(p => p.id === 'pb-live'), 'old guides kept, new one added', pbs.map(p => p.name));
  const again = await W(`maybeAutoGuides('${origin}')`);
  ok(again.skipped === 'few' || again.skipped === 'soon', 'right after: 0 tokens', again);
  await W(`__replies.length = 0`);

  section('learn in batches (buildLearnBatches -> finishGuides)');
  ok(await W(`batchesReady()`), 'brain has buildLearnBatches + finishGuides');
  await W(`for (let i = 0; i < 12; i++) __replies.push({ summary: 'Учёт счетов', guides: [{ name: 'Гайд ' + i, steps: [{ instruction: 'Нажмите «Добавить»', element_ref: 'V2.1', action: 'click', value: null }], continues_live: i === 0 }] })`);
  const mapNow = await W(`getMap('${origin}')`);
  await W(`updateLearn('${origin}', () => ({ status: 'exploring', tabId: ${tabId}, startedAt: Date.now(), heartbeatAt: Date.now() }))`);
  await W(`learnFrom('${origin}', ${JSON.stringify(mapNow)})`);
  const L = await W(`readLearnRaw('${origin}')`);
  const learned = (await W(`getPlaybooks('${origin}')`)).filter(p => p.learned);
  ok(L.status === 'done' && L.guides >= 1, 'learn done from batches', { status: L.status, guides: L.guides, error: L.error });
  ok(learned.length >= 1 && learned.every(p => typeof p.live === 'boolean'), 'learned playbooks carry live', learned.map(p => [p.name, p.live]));
  await W(`__replies.length = 0`);

  section('net flag for the explorer');
  await page.evalScopos(`(() => { window.__exp = null; Scopos.explore.start = o => { window.__exp = { netBlocked: o.netBlocked }; return Promise.resolve(true); }; })()`);
  await W(`learnStart(${tabId}, true)`);
  const exp = await until(() => page.evalScopos('window.__exp'));
  ok(exp && exp.netBlocked === true, 'explore:start carries net:true -> netBlocked', exp);
  ok((await W('scoposBusy()')) === true, 'scoposBusy() while exploring');
  await W(`chrome.storage.session.set({ ['explore:${tabId}']: { status: 'running' } })`);
  const load = await page.evalScopos(`chrome.runtime.sendMessage({ type: 'explore:load' })`);
  ok(load.net === true, 'explore:load says net is up', load.net);
  await W(`handle({ type: 'learn:stop', tabId: ${tabId}, origin: '${origin}' }, {})`);
  await W(`chrome.storage.session.remove('explore:${tabId}')`);
  ok((await W(`netActive(${tabId})`)) === false && (await W('scoposBusy()')) === false, 'after stop: net down, not busy');

  section('proxy: the local server pays');
  await W(`chrome.storage.local.remove('apiKey')`);
  await W(`chrome.storage.local.set({ devServer: 'http://localhost:1' })`);
  await W(`proxyCache = null`);
  ok((await W('auth()')) === null, 'no key, no server -> no auth');
  const noAuth = await W(`ask(${tabId}, 'вопрос без ключа номер 9').then(() => 'answered', e => e.code + '|' + e.message)`);
  ok(/^key\|/.test(noAuth), 'ask -> key message', noAuth);
  await W(`chrome.storage.local.set({ devServer: '${FAKE}' })`);
  const a = await W(`auth()`);
  ok(a && a.mode === 'proxy' && a.endpoint === FAKE + '/api/claude', 'server up -> proxy auth', a);
  const ks = await W(`handle({ type: 'key:state', fresh: true }, {})`);
  ok(ks.mode === 'proxy', 'key:state -> proxy', ks);
  // Through brain.js for real (no stub): the request goes to the fake server, without auth headers.
  await W(`Brain.call = __realCall`);
  await W(`chrome.storage.local.remove('map:${origin}')`);
  const proxied = await W(`ask(${tabId}, 'вопрос через локальный сервер номер 11').then(s => s.answer, e => 'ERR ' + e.message)`);
  ok(proxied === 'Через прокси', 'answer came through the proxy', proxied);
  const last = proxyLog[proxyLog.length - 1];
  ok(last && !last.headers['x-api-key'] && last.body && /sonnet/.test(last.body.model), 'proxied request: no x-api-key, ask model', last && { key: last.headers['x-api-key'], model: last.body && last.body.model });
  proxyStatus = 402;
  const over402 = await W(`ask(${tabId}, 'вопрос через локальный сервер номер 12').then(() => 'answered', e => e.code + '|' + e.message)`);
  ok(/^budget|Месячный бюджет на Claude/.test(over402) && !/ошибкой 402/.test(over402), '402 from the proxy -> clean Russian budget message', over402);
  proxyStatus = 200;
  const real4173 = await fetch(DEMO + 'api/ext/version').then(r => r.status).catch(() => 'down');
  console.log('  info demo server /api/ext/version -> ' + real4173 + (real4173 === 200 ? ' (proxy detection will find it)' : ' (server contract not deployed yet; feature-detected)'));

  section('side panel');
  const panel = await b.open(`chrome-extension://${b.extId}/sidepanel/sidepanel.html`);
  await W(`chrome.tabs.update(${tabId}, { active: true })`);
  await sleep(600);
  const site = await panel.eval(`document.getElementById('site').textContent`);
  ok(site === 'localhost:4173', 'panel follows the active tab', site);
  ok((await panel.eval(`document.getElementById('ver').textContent`)) === 'Scopos 0.2.0', 'footer: Scopos 0.2.0');
  await W(`chrome.storage.local.set({ usage: { total: { tokens: 0, cost: 0, calls: 0 }, origins: {}, months: { [monthKey()]: { tokens: 1, cost: 0.07, calls: 1 } } }, monthlyLimit: 2 })`);
  await panel.eval(`document.getElementById('tab-set').click()`);
  const month = await until(() => panel.eval(`(t => t.startsWith('В этом') && t)(document.getElementById('month').textContent)`));
  ok(month === 'В этом месяце: $0.07 из $2', 'settings: month line', month);
  const keyState = await until(() => panel.eval(`(t => /Ключ:/.test(t) && t)(document.getElementById('key-state').textContent)`));
  ok(/Ключ: из локального сервера Scopos/.test(keyState || ''), 'settings: key from the local server', keyState);
  ok((await panel.eval(`document.getElementById('limit').value`)) === '2' && (await panel.eval(`document.getElementById('auto-guides').checked`)) === true, 'limit 2 and auto-guides on by default');

  section('no access: panel state, grant, retry');
  // Required host permissions can't be removed with chrome.permissions.remove ("You cannot remove required
  // permissions"), so Chrome's "on click" site access is simulated: contains() says no for 127.0.0.1, and the
  // tab has no live content script (as with withheld access).
  const p2 = await b.open('http://127.0.0.1:4173/');
  await p2.evalScopos('window.__scoposContent.shutdown(); 1');
  const tab2 = await W(`chrome.tabs.query({}).then(ts => ts.find(t => (t.url || '').startsWith('http://127.0.0.1:4173')).id)`);
  await W(`(() => { self.__contains = self.__contains || chrome.permissions.contains; chrome.permissions.contains = async q => !(q && q.origins && q.origins[0] === 'http://127.0.0.1:4173/*') && self.__contains.call(chrome.permissions, q); })()`);
  const acc = await W(`accessState(${tab2})`);
  ok(acc.ok === false && acc.code === 'access' && acc.origin === 'http://127.0.0.1:4173', 'accessState -> access', acc);
  await W(`chrome.tabs.update(${tabId}, { active: true })`); await sleep(300);
  await W(`chrome.tabs.update(${tab2}, { active: true })`);
  await panel.eval(`document.getElementById('tab-ask').click()`);
  const banner = await until(() => panel.eval(`(b => !b.hidden && b.innerText)(document.getElementById('access'))`));
  ok(/Нет доступа к этому сайту/.test(banner || '') && /Разрешить доступ/.test(banner || ''), 'panel shows «Нет доступа к этому сайту» + «Разрешить доступ»', banner);
  const askNo = await W(`ask(${tab2}, 'вопрос без доступа номер 13').then(() => 'answered', e => e.code)`);
  ok(askNo === 'access', 'ask without access -> access error, no call');
  // Grant: the panel calls chrome.permissions.request from the click (stubbed: headless has no prompt), then retries.
  await W(`Brain.call = async (body, key, opts = {}) => { __calls.push({ model: body.model, key, endpoint: opts.endpoint || null }); return { answer: 'Готово', steps: [] }; }`);
  await panel.eval(`(() => { window.__req = null; chrome.permissions.request = q => { window.__req = q; return Promise.resolve(true); }; })()`);
  await panel.eval(`document.getElementById('q').value = 'вопрос после доступа номер 14'; document.getElementById('composer').requestSubmit(); 1`);
  const errCard = await until(() => panel.eval(`(b => b && b.textContent)(document.querySelector('#feed [data-grant]'))`));
  ok(errCard === 'Разрешить доступ', 'error card offers «Разрешить доступ»', errCard);
  await W(`chrome.permissions.contains = self.__contains`);
  await panel.eval(`document.querySelector('#feed [data-grant]').click()`);
  const req = await until(() => panel.eval('window.__req'));
  ok(req && req.origins && req.origins[0] === 'http://127.0.0.1:4173/*', 'permissions.request for origin/*', req);
  const answered = await until(() => panel.eval(`(t => /Готово/.test(t) && t)(document.getElementById('feed').innerText)`), 8000);
  ok(!!answered, 'retried after the grant: answer shown (content script re-injected)', answered && answered.slice(0, 80));
  ok(await p2.evalScopos('!!(window.__scoposContent && window.__scoposContent.alive())'), 'a fresh content copy runs in the tab');
} catch (e) {
  failed++;
  console.log('  FAIL threw: ' + (e && e.stack || e));
} finally {
  await b.close();
  fake.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
