// Row controls in the real extension (headless Chrome, dev/ext-harness.mjs) on the TMS fixture:
//  1. the explorer's snapshot of the loads view marks the controls repeated per row ("Actions for load …", the
//     "Load #" link, the row checkbox) with row: true and a generic rowLabel, once per view, and leaves the rest alone;
//  2. a guide whose step is a row step, written from that map (Brain.refSteps in the worker), runs against a page
//     where the sample record no longer exists (another customer's data): it points at another row's control,
//     advances on a click on ANY row's matching control, not on another control of the row;
//  3. a row the user picked (row N) is preferred by the next row step;
//  4. a step after a row step on the record's own screen (#/loads/:id) resolves for another record.
// Needs the dev server on :4173. node dev/rows-harness.mjs
import { launch } from './ext-harness.mjs';

const BASE = process.env.SCOPOS_BASE || 'http://localhost:4173';
const TMS = `${BASE}/demo/tms/index.html`;
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
const rectOf = (p, sel) => p.eval(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
async function pointedAt(p, sel) {
  const d = await p.evalScopos('(() => { const d = Scopos.pointer.debug(); return d && d.frameOn ? d.target : null; })()');
  const r = await p.eval(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  if (!d || !r) return false;
  return Math.abs(d.x - r.x) < 3 && Math.abs(d.y - r.y) < 3 && Math.abs(d.w - r.w) < 3 && Math.abs(d.h - r.h) < 3;
}
async function clickEl(p, sel) {
  const r = await rectOf(p, sel);
  if (!r) throw new Error('no element ' + sel);
  await sleep(150);
  const r2 = await rectOf(p, sel);
  await p.click(r2.x + r2.w / 2, r2.y + r2.h / 2);
}
// Clicks the first element of a list, from index `from` on, that a user can reach (not under the guide's card).
async function clickFree(p, list, from) {
  const n = await p.eval(`${list}.length`);
  for (let i = from; i < n; i++) {
    const r = await p.eval(`(() => { const e = ${list}[${i}]; e.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(120);
    const pt = await p.eval(`(() => { const e = ${list}[${i}], r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, h = document.elementFromPoint(x, y);
      return h && (h === e || e.contains(h)) ? { x, y, label: e.getAttribute('aria-label'), href: e.getAttribute('href') } : null; })()`);
    if (!pt || !r) continue;
    await p.click(pt.x, pt.y);
    return { i, label: pt.label, href: pt.href };
  }
  throw new Error('nothing reachable in ' + list);
}
const startGuide = (p, steps) => p.evalScopos(`(() => {
  window.__t = { changes: [], ends: [] };
  Scopos.guide.start(${JSON.stringify(steps)}, { onChange: e => __t.changes.push(e.index), onEnd: r => __t.ends.push(r) });
  return true;
})()`);
const state = p => p.evalScopos('Scopos.guide.state()');
// Another customer: the sample loads are gone (1066 … 1061 deleted) and the rest renumbered; then re-rendered.
const otherCustomer = p => p.eval(`(() => {
  const { loads, render } = window.__tmsTest;
  if (window.__other) { render(); return loads.length; } // the same document: already another customer
  window.__other = true;
  for (const id of [1066, 1065, 1064, 1063, 1062, 1061]) { const i = loads.findIndex(l => l.id === id); if (i >= 0) loads.splice(i, 1); }
  loads.forEach(l => { l.id += 6000; });
  render();
  return loads.length;
})()`);
const actionsBtn = n => `document.querySelectorAll('#main tbody tr button[data-act=load-menu]')[${n}]`;

const b = await launch();
try {
  // ---------------- 1. the explorer marks row controls ----------------
  const p = await b.open(`${TMS}#/loads`);
  await p.evalScopos('1');
  const snap = await p.evalScopos('Scopos.explore.snapshot()');
  const rows = snap.controls.filter(c => c.row);
  const by = label => rows.find(c => c.rowLabel === label);
  check('snapshot: loads view key', snap.key === '/demo/tms/index.html#/loads', snap.key);
  check('snapshot: ⋯ marked as a row control "Actions for load …"', !!by('Actions for load …') && by('Actions for load …').role === 'button', rows.map(c => [c.name, c.rowLabel]));
  check('snapshot: the record link is a row control named by its column "Load #"', !!by('Load #') && by('Load #').role === 'link' && by('Load #').d.fp.rowOf.data === true);
  check('snapshot: the row checkbox "Select load …"', !!by('Select load …') && by('Select load …').role === 'checkbox');
  check('snapshot: one representative per row control', snap.controls.filter(c => /^Actions for load /.test(c.name)).length === 1 && snap.controls.filter(c => /^Select load \d/.test(c.name)).length === 1);
  const ro = by('Actions for load …') && by('Actions for load …').d.fp.rowOf;
  check('snapshot: rowOf describes the table and the place in the row', ro && ro.box.tag === 'table' && ro.box.name === 'loads' && ro.box.head.includes('load #') && ro.col === 11 && ro.hcol === 'actions' && ro.nth === 0 && ro.pre === 'actions for load', ro);
  check('snapshot: navigation, tabs and the toolbar are not row controls', !rows.some(c => /^(Loads|Drivers|All|Available|\+ New load|Columns)/.test(c.name)) && snap.controls.some(c => c.name === 'Drivers' && !c.row));
  check('snapshot: the table itself stays a region control', snap.controls.some(c => c.role === 'table' && !c.row));
  // Drivers: "Edit Marcus Reed" → "Edit …"; customers: the company link → "Name".
  await p.goto(`${TMS}#/drivers`);
  const dsnap = await p.evalScopos('Scopos.explore.snapshot()');
  check('snapshot: drivers "Edit …" and the name link "Name"', dsnap.controls.some(c => c.row && c.rowLabel === 'Edit …' && /^Edit /.test(c.name)) && dsnap.controls.some(c => c.row && c.rowLabel === 'Name' && c.role === 'link'), dsnap.controls.filter(c => c.row).map(c => [c.name, c.rowLabel]));
  await p.goto(`${TMS}#/billing/invoices`);
  const isnap = await p.evalScopos('Scopos.explore.snapshot()');
  check('snapshot: invoices "Actions for invoice …"', isnap.controls.some(c => c.row && c.rowLabel === 'Actions for invoice …'));

  // A board whose columns are dates: the load chips are one row control for every day, named by the board.
  await p.goto(`${TMS}#/dispatch`);
  const bsnap = await p.evalScopos('Scopos.explore.snapshot()');
  const chips = bsnap.controls.filter(c => c.row && c.role === 'button');
  check('snapshot: board chips under date columns are one row control named by the board', chips.length === 1 && chips[0].rowLabel === 'Dispatch Board' && chips[0].d.fp.rowOf.col === -2, chips.map(c => [c.name, c.rowLabel]));
  check('resolve: a board chip row step matches chips on every day', await p.evalScopos(`Scopos.resolveRow(${JSON.stringify({ ...chips[0].d, row: true })}).els.length`) === await p.eval(`[...document.querySelectorAll('#main table button.chip')].filter(b => b.offsetParent).length`));

  // The record screen of the sample load (for step 4): its "Edit" link, described on load 1066.
  await p.goto(`${TMS}#/loads/1066`);
  const lsnap = await p.evalScopos('Scopos.explore.snapshot()');
  check('snapshot: the record screen is the :id view', lsnap.key === '/demo/tms/index.html#/loads/:id', lsnap.key);
  const editLink = lsnap.controls.find(c => c.role === 'link' && c.name === 'Edit');
  check('snapshot: record screen has its Edit link, not a row control', !!editLink && !editLink.row);

  // ---------------- 2. a row step on another customer's data ----------------
  const map = { views: [{ ...snap, id: 'V1' }, { ...lsnap, id: 'V2', controls: lsnap.controls.map(c => ({ ...c, ref: c.ref.replace(/^P/, 'V2') })) }] };
  map.views[0].controls = map.views[0].controls.map(c => ({ ...c, ref: c.ref.replace(/^P/, 'V1') }));
  const ref = label => map.views[0].controls.find(c => c.rowLabel === label).ref;
  const steps = await b.evalWorker(`Brain.refSteps(${JSON.stringify([
    { instruction: 'Click ⋯ (Actions) on the load you need', element_ref: ref('Actions for load …'), action: 'click', value: null },
    { instruction: 'Click Edit', element_ref: null, action: 'click', value: null },
  ])}, ${JSON.stringify(map)}, 'Change a load rate')`);
  check('refSteps: row target with rowLabel and rowOf, no sample label', steps[0].target.row === true && steps[0].target.rowLabel === 'Actions for load …' && !!steps[0].target.rowOf && steps[0].target.text === 'Actions for load …');

  await p.goto(`${TMS}#/loads`);
  await p.evalScopos('1');
  const left = await otherCustomer(p);
  check('another customer: the sample record is gone', left > 5 && !(await p.eval(`!!document.querySelector('[aria-label="Actions for load 1066"]')`)) && await p.eval(`document.querySelectorAll('#main tbody tr').length`) > 5);
  check('resolve: a row step finds a row control without the sample', await p.evalScopos(`(() => { const el = Scopos.resolve(${JSON.stringify(steps[0].target)}); return !!el && /^Actions for load 7\\d+$/.test(el.getAttribute('aria-label')); })()`));
  check('resolve: every row is a match', await p.evalScopos(`Scopos.resolveRow(${JSON.stringify(steps[0].target)}).els.length`) === await p.eval(`document.querySelectorAll('#main tbody tr button[data-act=load-menu]').length`));
  check('exact resolve of the sample descriptor (no row flag) finds nothing', await p.evalScopos(`Scopos.resolve(${JSON.stringify({ ...steps[0].target, row: undefined })}) === null`));

  await startGuide(p, steps);
  const firstRow = actionsBtn(0);
  check('guide: points at the first row\'s ⋯ (another load)', await until(() => pointedAt(p, firstRow), 4000) >= 0, await p.evalScopos('Scopos.pointer.debug()'));
  // A click on another control of a row (the driver link) is not the step.
  await p.eval(`document.querySelectorAll('#main tbody tr td a[href^="#/drivers/"]')[2].addEventListener('click', e => e.preventDefault(), { once: true })`);
  await clickEl(p, `document.querySelectorAll('#main tbody tr td a[href^="#/drivers/"]')[2]`);
  await sleep(600);
  check('guide: a click on another control of a row does not advance', (await state(p)).index === 0, await state(p));
  // A click on the ⋯ of the 4th row (not the one pointed at) advances.
  await clickEl(p, actionsBtn(3));
  check('guide: a click on ANY row\'s ⋯ advances', await until(async () => (await state(p) || {}).index === 1, 3000) >= 0, await state(p));
  check('guide: the load menu opened for that row', await p.eval(`!!document.querySelector('#layer [role=menu]') && /Load 7\\d+ actions/.test(document.querySelector('#layer [role=menu]').getAttribute('aria-label'))`));
  await p.evalScopos('Scopos.guide.stop(false)');
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);

  // ---------------- 3. the row the user picked is preferred ----------------
  await p.goto(`${TMS}#/loads`);
  await p.evalScopos('1');
  await otherCustomer(p);
  const steps2 = await b.evalWorker(`Brain.refSteps(${JSON.stringify([
    { instruction: 'Tick the load you need', element_ref: ref('Select load …'), action: 'click', value: null },
    { instruction: 'Click ⋯ (Actions) on that load', element_ref: ref('Actions for load …'), action: 'click', value: null },
  ])}, ${JSON.stringify(map)}, 'Select a load')`);
  await startGuide(p, steps2);
  check('pick: the checkbox step points at the first row', await until(() => pointedAt(p, `document.querySelectorAll('#main tbody tr input[data-act=sel]')[0]`), 4000) >= 0);
  const boxes = `document.querySelectorAll('#main tbody tr input[data-act=sel]')`;
  const { i: at, label: picked } = await clickFree(p, boxes, 4);
  check(`pick: ticking row ${at + 1} advances`, await until(async () => (await state(p) || {}).index === 1, 3000) >= 0, await state(p));
  const want = picked.replace('Select load', 'Actions for load');
  check(`pick: the next row step points into the picked row (${want})`, await until(() => pointedAt(p, `document.querySelector('[aria-label="${want}"]')`), 4000) >= 0, await p.evalScopos('Scopos.pointer.debug()'));
  await p.evalScopos('Scopos.guide.stop(false)');

  // ---------------- 4. a step on the record's own screen after a row step ----------------
  await p.goto(`${TMS}#/loads`);
  await p.evalScopos('1');
  await otherCustomer(p);
  const steps3 = await b.evalWorker(`Brain.refSteps(${JSON.stringify([
    { instruction: 'Open the load you need (Load # column)', element_ref: ref('Load #'), action: 'click', value: null },
    { instruction: 'Click Edit', element_ref: editLink.ref.replace(/^P/, 'V2'), action: 'click', value: null },
  ])}, ${JSON.stringify(map)}, 'Edit a load')`);
  check('detail: the record screen step keeps the :id path', steps3[1].target.path === '/demo/tms/index.html#/loads/:id' && !steps3[1].target.row);
  await startGuide(p, steps3);
  const link = n => `document.querySelectorAll('#main tbody tr td a[href^="#/loads/"]')[${n}]`;
  check('detail: the row link step points at the first load link', await until(() => pointedAt(p, link(0)), 4000) >= 0);
  const links = `document.querySelectorAll('#main tbody tr td a[href^="#/loads/"]')`;
  const { href } = await clickFree(p, links, 2);
  check(`detail: clicking another load's link (${href}) advances and opens it`, await until(async () => (await state(p) || {}).index === 1 && (await p.eval('location.hash')) === href, 4000) >= 0, [await state(p), await p.eval('location.hash')]);
  const editSel = `[...document.querySelectorAll('#main a.btn')].find(a => /\\/edit$/.test(a.getAttribute('href')))`;
  check('detail: the Edit step resolves on another load\'s screen', await until(() => pointedAt(p, editSel), 5000) >= 0, await p.evalScopos('Scopos.pointer.debug()'));
  check('detail: Edit leads to that load', /^#\/loads\/7\d+\/edit$/.test(await p.eval(`${editSel}.getAttribute('href')`)));
  await p.evalScopos('Scopos.guide.stop(false)');
} finally { await b.close(); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
