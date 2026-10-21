// A long learned guide after a wrong click, in the real extension (headless Chrome) on the TMS replica:
//  1. the guide "Assign a driver to a booked load" (learned on load DT-000172) starts and points at the sidebar;
//  2. a wrong turn mid-guide (another section) takes the guide back to the step that fits there, for free;
//  3. on ANOTHER booked load's page the «Assign» step is found (record numbers like DT-000004 are ids);
//  4. leaving the load's page and coming back by the browser's Back picks the guide up on the load's page;
//  5. a load in another state (assigned) is the same screen: the step waits there, never "go to the page".
// No Claude calls: the guide comes from the learned knowledge (.scopos-knowledge.local.json, the replica's).
// Needs the dev server on :4173. node dev/recover-harness.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launch } from './ext-harness.mjs';

const require = createRequire(import.meta.url);
const Brain = require('../extension/core/brain.js');
const BASE = process.env.SCOPOS_BASE || 'http://localhost:4173';
const APP = `${BASE}/demo/replica/index.html`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`ok   ${name}`); return; }
  failed++;
  console.log(`FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 600) : ''}`);
}
async function until(fn, ms = 5000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(step); }
  return -1;
}

const knowledge = JSON.parse(readFileSync(new URL('../.scopos-knowledge.local.json', import.meta.url), 'utf8'));
const m = Brain.instantMatch(Brain.instantIndex(knowledge), 'Assign a driver to a booked load');
if (m.kind !== 'guide') { console.log('no learned guide for the question (replica knowledge not loaded?)', m.kind); process.exit(1); }
const steps = m.steps;
const at = re => steps.findIndex(s => re.test(s.instruction));
const ASSIGN = at(/«Assign»/), ROW = steps.findIndex(s => s.target && s.target.row);
console.log(`guide «${m.guide.name}»: ${steps.length} steps, row step ${ROW}, «Assign» ${ASSIGN}`);

const state = p => p.evalScopos('Scopos.guide.state()');
const card = p => p.evalScopos('Scopos.pointer.cardText()');
const framed = p => p.evalScopos('(() => { const d = Scopos.pointer.debug(); return !!(d && d.frameOn); })()');
// Clicks the centre of what the guide frames now.
async function clickFramed(p) {
  const d = await p.evalScopos('Scopos.pointer.debug()');
  if (!d || !d.frameOn) throw new Error('nothing framed');
  await p.click(d.target.x + d.target.w / 2, d.target.y + d.target.h / 2);
}
const onIndex = (p, i, ms = 5000) => until(async () => { const s = await state(p); return !!s && s.index === i; }, ms);

const b = await launch();
try {
  const p = await b.open(`${APP}#/dashboard/overview`);
  await p.evalScopos('1');
  await p.evalScopos(`(() => { window.__t = { changes: [], ends: [] }; Scopos.guide.start(${JSON.stringify(steps)}, { onChange: e => __t.changes.push(e.index), onEnd: r => __t.ends.push(r) }); return true; })()`);

  // 1. the first step points at the sidebar
  check('start: step 1 framed (sidebar)', await until(() => framed(p), 4000) >= 0, await card(p));
  await clickFramed(p);
  check('step 1 done → the row step', await onIndex(p, ROW, 5000) >= 0, await state(p));
  check('row step framed on the load list', await until(() => framed(p), 5000) >= 0, await card(p));

  // 2. a wrong turn: another section of the app
  await p.eval(`location.hash = '#/fleet-management/trucks'`);
  const back = await until(async () => { const s = await state(p); return !!s && s.index < ROW; }, 6000);
  check(`wrong turn: back on the way within ${back} ms (free, no Claude)`, back >= 0 && back < 4000, await state(p));
  check('wrong turn: the card says so', /Вернёмся на путь/.test(await card(p)), await card(p));
  check('wrong turn: its control is framed', await until(() => framed(p), 3000) >= 0);

  // 3. back on the way: the list, then ANOTHER booked load (not the sample DT-000172)
  await clickFramed(p);
  check('again → the row step', await onIndex(p, ROW, 5000) >= 0, await state(p));
  // The open group's header only folds it: the user then opens the list from its submenu.
  if (!/load-trip/.test(await p.eval('location.hash'))) await p.eval(`location.hash = '#/load-management/load-trip'`);
  check('the list: the row step framed', await until(() => framed(p), 5000) >= 0, await card(p));
  // Another booked load whose link a user can reach (not under the guide's card).
  let href = null, r = null;
  const links = await p.eval(`[...document.querySelectorAll('a[href*="/create-load/booked/"]')].map(a => a.getAttribute('href')).filter(h => !/DT-000172/.test(h))`);
  for (const h of [...new Set(links)]) {
    await p.eval(`document.querySelector('a[href="${h}"]').scrollIntoView({ block: 'center' })`);
    await sleep(250);
    r = await p.eval(`(() => { const a = document.querySelector('a[href="${h}"]'), b = a.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, e = document.elementFromPoint(x, y); return e && (e === a || a.contains(e)) ? { x, y } : null; })()`);
    if (r) { href = h; break; }
  }
  check('the list has another booked load', !!href, links);
  await p.click(r.x, r.y);
  check(`another load (${href && href.split('/').pop()}): on the «Assign» step`, await onIndex(p, ASSIGN, 5000) >= 0, await state(p));
  check('another load: «Assign» framed, not "go to the page"', await until(() => framed(p), 5000) >= 0, await card(p));

  // 4. leave the load's page and come back with the browser's Back
  await p.eval(`location.hash = '#/load-management/trips'`);
  check('left the load: back to an earlier step', await until(async () => { const s = await state(p); return !!s && s.index < ASSIGN; }, 6000) >= 0, await state(p));
  await p.eval('history.back()');
  const again = await until(async () => { const s = await state(p); return !!s && s.index === ASSIGN && await framed(p); }, 6000);
  check(`came back: on «Assign» again within ${again} ms`, again >= 0, { state: await state(p), card: await card(p) });

  // 5. a load in another state is the same screen: no "go to the page"
  const assigned = await p.eval(`(() => { const a = document.querySelector('a[href*="/create-load/assigned/"]'); return a ? a.getAttribute('href') : null; })()`)
    || '#/load-management/create-load/assigned/4/DT-000004';
  await p.eval(`location.hash = ${JSON.stringify(assigned)}`);
  await sleep(2500);
  const txt = await card(p);
  check('assigned load: never "go to the page"', !/Перейдите на страницу/.test(txt), txt);
  const ends = await p.evalScopos('window.__t.ends');
  check('the guide is still running', (await state(p)) !== null && !ends.length, ends);
} finally {
  await b.close();
}
console.log(`recover-harness: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
