// Guide runner in the real extension (headless Chrome, dev/ext-harness.mjs): the free label fallback, waiting
// for a control that appears later (a dialog), "look" steps on data areas, and opts.more on 'end' and 'missing'.
// Needs the dev server on :4173 (stress page and demo). node dev/guides-harness.mjs
import { launch } from './ext-harness.mjs';

const BASE = process.env.SCOPOS_BASE || 'http://localhost:4173';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`ok   ${name}`); return; }
  failed++;
  console.log(`FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 400) : ''}`);
}

// Rect of a page element (main world), and where the pointer's frame target is (extension world).
const rectOf = (p, sel) => p.eval(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
async function diag(p, sel) {
  return { state: await p.evalScopos('Scopos.guide.state()'), dbg: await p.evalScopos('Scopos.pointer.debug()'), rect: await rectOf(p, sel), t: await p.evalScopos('window.__t') };
}
async function pointedAt(p, sel) {
  const d = await p.evalScopos('(() => { const d = Scopos.pointer.debug(); return d && d.frameOn ? d.target : null; })()');
  const r = await rectOf(p, sel);
  if (!d || !r) return false;
  return Math.abs(d.x - r.x) < 3 && Math.abs(d.y - r.y) < 3 && Math.abs(d.w - r.w) < 3 && Math.abs(d.h - r.h) < 3;
}
async function until(fn, ms = 5000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(step); }
  return -1;
}
// Starts a guide in the extension's world; callbacks are recorded in window.__t there.
const startGuide = (p, steps, extra = '') => p.evalScopos(`(() => {
  window.__t = { changes: [], ends: [], more: [], missing: [], steps: [] };
  Scopos.guide.start(${JSON.stringify(steps)}, {
    onChange: e => __t.changes.push(e.index), onEnd: r => __t.ends.push(r), onSteps: s => __t.steps.push(s.length),
    ${extra}
  });
  return true;
})()`);
const T = p => p.evalScopos('JSON.parse(JSON.stringify(window.__t))');

const b = await launch();
try {
  // ---------------- stress page ----------------
  const p = await b.open(`${BASE}/dev/stress.html`);
  await p.evalScopos('Scopos.scan().lines.length');

  // findLocal directly
  const loc = await p.evalScopos(`(() => {
    const f = s => { const el = Scopos.guide.findLocal(s); return el ? (el.id || el.tagName) : null; };
    return {
      button: f({ instruction: 'Нажмите «Кнопка внутри scale(.8)»', action: 'click', target: { sel: ['#gone'], text: 'Старое имя', role: 'button' } }),
      fuzzy: f({ instruction: 'Нажмите кнопку', action: 'click', target: { sel: [], text: 'кнопка ВНУТРИ scale', role: 'button' } }),
      field: f({ instruction: 'Заполните «Поле внутри масштаба»', action: 'type', target: { sel: ['#x'], text: 'Поле внутри масштаба', role: 'textbox' } }),
      fieldNotButton: f({ instruction: 'Введите «Помощь»', action: 'type', target: null }),
      ambiguous: f({ instruction: 'Нажмите «Сохранить»', action: 'click', target: { sel: [], text: 'Сохранить', role: 'button' } }),
      yo: f({ instruction: 'Нажмите «Пересоздаваемая кнопка»', action: 'click', target: { sel: [], text: 'пересоздаваемая  кнопка!', role: 'button' } }),
      none: f({ instruction: 'Нажмите «Нет такой»', action: 'click', target: { sel: [], text: 'Нет такой', role: 'button' } }),
    };
  })()`);
  check('findLocal: instruction label when the stored text is stale', loc.button === 'scaled-btn', loc);
  check('findLocal: case/punctuation/prefix fuzzy', loc.fuzzy === 'scaled-btn', loc);
  check('findLocal: type step finds the input by placeholder', loc.field === 'scaled-input', loc);
  check('findLocal: type step never takes a button', loc.fieldNotButton === null, loc);
  check('findLocal: two «Сохранить» → no guess', loc.ambiguous === null, loc);
  check('findLocal: re-rendered button by label', /^btn-\d+$/.test(String(loc.yo)), loc);
  check('findLocal: nothing similar → null', loc.none === null, loc);

  // 1. A stale descriptor (wrong selectors, old text) whose instruction label matches: pointed and armed.
  await startGuide(p, [
    { instruction: 'Нажмите «Помощь»', action: 'click', value: null, target: { v: 2, sel: ['#old-help-id'], text: 'Справка (старое)', role: 'button', path: '/dev/stress.html' } },
    { instruction: 'Нажмите «Фиксированная кнопка»', action: 'click', value: null, target: { v: 2, sel: ['.nope'], text: 'Фиксированная кнопка', role: 'button', path: '/dev/stress.html' } },
  ]);
  let ms = await until(() => pointedAt(p, 'document.getElementById("hdr-help")'));
  check('stale descriptor → found by the local fallback', ms >= 0, ms);
  await p.eval('document.getElementById("hdr-help").click()');
  ms = await until(async () => (await T(p)).changes.includes(1));
  check('local match is armed: its click advances', ms >= 0);
  ms = await until(() => pointedAt(p, 'document.getElementById("fixed-btn")'));
  check('second stale step found', ms >= 0, ms < 0 ? await diag(p, 'document.getElementById("fixed-btn")') : undefined);
  await p.evalScopos('Scopos.guide.stop(false)');

  // 2. A step inside a dialog that opens 1.5 s later (and fades in).
  await p.eval(`(() => {
    const d = document.createElement('dialog'); d.id = 'late-dlg';
    d.innerHTML = '<h3>Новый рейс</h3><label>Водитель <input id="late-driver"></label> <button id="late-create">Создать рейс</button>';
    d.style.transition = 'opacity .4s'; d.style.opacity = '0';
    document.body.appendChild(d);
    window.__openedAt = 0;
    setTimeout(() => { d.showModal(); window.__openedAt = performance.now(); requestAnimationFrame(() => { d.style.opacity = '1'; }); }, 1500);
    return true;
  })()`);
  await startGuide(p, [
    { instruction: 'Укажите водителя в поле «Водитель»', action: 'type', value: null, target: { sel: ['#driver-old'], text: 'Водитель', role: 'textbox', path: '/dev/stress.html' } },
    { instruction: 'Нажмите «Создать рейс»', action: 'click', value: null, target: { sel: ['#late-create'], text: 'Создать рейс', role: 'button', path: '/dev/stress.html' } },
  ], 'missingDelay: 30000');
  ms = await until(() => pointedAt(p, 'document.getElementById("late-driver")'), 6000, 50);
  const openedAt = await p.eval('window.__openedAt');
  const foundAt = await p.eval('performance.now()');
  check('control in a dialog that opens later → found once it appears', ms >= 0, ms < 0 ? await diag(p, 'document.getElementById("late-driver")') : ms);
  check('found soon after the dialog opened (< 1.5 s)', ms >= 0 && openedAt > 0 && foundAt - openedAt < 1500, { ms, after: foundAt - openedAt });
  await p.eval(`(() => { const i = document.getElementById('late-driver'); i.focus(); i.value = 'Тимур'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  ms = await until(() => pointedAt(p, 'document.getElementById("late-create")'));
  check('typing in the dialog field advances to the dialog button', ms >= 0, await T(p));
  await p.evalScopos('Scopos.guide.stop(false)');
  await p.eval('document.getElementById("late-dlg").close(); document.getElementById("late-dlg").remove(); true');

  // 3. opts.more on 'end' (live guide): the answer is appended; a null answer ends it.
  await startGuide(p, [
    { instruction: 'Нажмите «Помощь»', action: 'click', value: null, target: { sel: ['#hdr-help'], text: 'Помощь', role: 'button', path: '/dev/stress.html' } },
  ], `live: true, more: async a => { __t.more.push(a); await new Promise(r => setTimeout(r, 300));
      return __t.more.length === 1 ? [{ instruction: 'Нажмите «Кнопка внутри scale(.8)»', action: 'click', value: null, target: { sel: ['#scaled-btn'], text: 'Кнопка внутри scale(.8)', role: 'button' } }] : null; }`);
  await until(() => pointedAt(p, 'document.getElementById("hdr-help")'));
  await p.eval('document.getElementById("hdr-help").click()');
  ms = await until(() => pointedAt(p, 'document.getElementById("scaled-btn")'), 5000);
  let t = await T(p);
  check('more(end) called with the done steps', t.more.length === 1 && t.more[0].reason === 'end' && t.more[0].index === 1 && t.more[0].done[0] === 'Нажмите «Помощь»', t.more);
  check('more(end) answer appended and pointed', ms >= 0 && t.steps[0] === 2, t);
  check('steps() has the appended step', (await p.evalScopos('Scopos.guide.steps().length')) === 2);
  await p.eval('document.getElementById("scaled-btn").click()');
  ms = await until(async () => (await T(p)).ends.length > 0, 5000);
  t = await T(p);
  check('null more(end) → the guide ends as done', ms >= 0 && t.ends[0] === 'done' && t.more.length === 2, t);
  check('steps() kept after the end', (await p.evalScopos('Scopos.guide.steps().length')) === 2);

  // 4. opts.more on 'missing': after the free search and onMissing, the rest is replaced from this page.
  await startGuide(p, [
    { instruction: 'Нажмите «Призрачная кнопка»', action: 'click', value: null, target: { sel: ['#ghost'], text: 'Призрачная кнопка', role: 'button', path: '/dev/stress.html' } },
    { instruction: 'Нажмите «Ещё призрак»', action: 'click', value: null, target: { sel: ['#ghost2'], text: 'Ещё призрак', role: 'button', path: '/dev/stress.html' } },
  ], `missingDelay: 300, onMissing: async (s, i) => { __t.missing.push(i); return null; },
      more: async a => { __t.more.push(a); return [{ instruction: 'Нажмите «Помощь»', action: 'click', value: null, target: { sel: [], text: 'Помощь', role: 'button' } }]; }`);
  const t0 = Date.now();
  ms = await until(() => pointedAt(p, 'document.getElementById("hdr-help")'), 10000, 200);
  t = await T(p);
  check('onMissing tried before more', t.missing.length === 1 && t.missing[0] === 0, t);
  check('more(missing) called once with index 0', t.more.length === 1 && t.more[0].reason === 'missing' && t.more[0].index === 0 && t.more[0].done.length === 0, t.more);
  check('more(missing) answer replaces the rest and is pointed', ms >= 0 && (await p.evalScopos('Scopos.guide.state().total')) === 1, { ms, waited: Date.now() - t0 });
  await p.evalScopos('Scopos.guide.stop(false)');

  // CPU: a waiting step on a quiet page does only a handful of checks.
  await p.evalScopos(`(() => { window.__calls = 0; const r = Scopos.resolve; Scopos.__r = r; Scopos.resolve = d => { __calls++; return r(d); }; return true; })()`);
  await startGuide(p, [{ instruction: 'Нажмите «Призрак»', action: 'click', value: null, target: { sel: ['#ghost'], text: 'Призрак тишины', role: 'button', path: '/dev/stress.html' } }], 'missingDelay: 60000');
  await sleep(6000);
  const calls = await p.evalScopos('__calls');
  await p.evalScopos('Scopos.guide.stop(false); Scopos.resolve = Scopos.__r; true');
  // The stress page re-renders a button every 1.5 s (a mutation with no relevance), so few checks are expected.
  console.log("     searches while waiting 6 s:", calls); check('waiting is quiet (≤ 12 searches in 6 s on a page that re-renders)', calls <= 12, calls);
  await p.close();

  // ---------------- demo ----------------
  const d = await b.open(`${BASE}/#/invoices`);
  await d.evalScopos('Scopos.scan().lines.length');
  // 5. A look step on a data area: framed, and a click inside it doesn't advance.
  await startGuide(d, [
    { instruction: 'Просмотрите список счетов', action: 'look', value: null, target: { sel: [], text: 'Счета', role: 'table', path: '/#/invoices' } },
    { instruction: 'Нажмите «Новый счёт»', action: 'click', value: null, target: null },
  ]);
  ms = await until(() => pointedAt(d, 'document.querySelector("main table")'));
  check('look on a table region → framed table (not the «Счета» link)', ms >= 0);
  await d.eval('document.querySelector("main table td").click(); true');
  await sleep(600);
  check('click inside the table does not advance a look step', (await d.evalScopos('Scopos.guide.state().index')) === 0);
  // 6. A step with no target but a «label»: found by label.
  await d.evalScopos('Scopos.guide.go(1); true');
  ms = await until(() => pointedAt(d, 'document.getElementById("new-invoice")'));
  check('null target with «label» → pointed by label', ms >= 0);
  check('made-up target not saved in steps()', (await d.evalScopos('Scopos.guide.steps()[1].target')) === null);
  await d.evalScopos('Scopos.guide.stop(false)');

  // 6b. A look step with no target (maps without data areas): framed on the table its label names.
  await d.goto(`${BASE}/#/clients`);
  await startGuide(d, [{ instruction: 'Просмотрите клиентов на странице «Клиенты»', action: 'look', value: null, target: null }]);
  ms = await until(() => pointedAt(d, 'document.querySelector("main table")'));
  check('look without target, «label» names the page heading → framed table', ms >= 0);
  await d.evalScopos('Scopos.guide.stop(false)');

  // 7. A select in the invite dialog, stale descriptor: found inside the dialog.
  await d.goto(`${BASE}/#/settings/team`);
  await d.eval('document.getElementById("invite").click(); true');
  await startGuide(d, [
    { instruction: 'Выберите «Бухгалтер» в списке «Роль»', action: 'select', value: 'Бухгалтер', target: { sel: ['select[name="old"]'], text: 'Роль сотрудника', role: 'select', path: '/#/settings/team' } },
  ]);
  ms = await until(() => pointedAt(d, 'document.querySelector("#dlg select")'));
  check('select in an open dialog found by its label', ms >= 0);
  await d.close();
} finally {
  await b.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
