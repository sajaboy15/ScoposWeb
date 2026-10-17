// Self-test for the guide-writing parts of extension/core/brain.js: map text with the explorer's flags,
// batched learning for big maps, finishing raw guides into runnable ones, and the proxy endpoint option.
// Runs without network: brain.js is evaluated in a bare context with a fake fetch.
// node dev/guides-selftest.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'core', 'brain.js');
const calls = [];
const sse = events => new ReadableStream({
  start(c) { const enc = new TextEncoder(); for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); },
});
const fakeFetch = async (url, init) => {
  calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  const text = JSON.stringify({ answer: 'ok', steps: [] });
  return {
    ok: true, status: 200, headers: { get: k => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: sse([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ]),
  };
};
const sandbox = { fetch: fakeFetch, TextDecoder, TextEncoder, ReadableStream, AbortSignal, URL, setTimeout, clearTimeout, console };
vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
const B = sandbox.ScoposBrain;

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; return; }
  failed++;
  console.log(`FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 400) : ''}`);
}

// ---------------- a small map with the explorer's new flags ----------------
const nav = (vid) => [
  { ref: `${vid}.1`, role: 'link', name: 'Обзор', section: 'Разделы', to: 'V1' },
  { ref: `${vid}.2`, role: 'link', name: 'Счета', section: 'Разделы', to: 'V2' },
  { ref: `${vid}.3`, role: 'link', name: 'Клиенты', section: 'Разделы', to: 'V3' },
  { ref: `${vid}.4`, role: 'link', name: 'Настройки', section: 'Разделы', to: 'V4' },
];
const small = {
  views: [
    { id: 'V1', kind: 'page', key: '/', title: 'Обзор', controls: nav('V1') },
    { id: 'V2', kind: 'page', key: '/#/invoices', title: 'Счета', controls: [...nav('V2'),
      { ref: 'V2.5', role: 'button', name: 'Новый счёт', to: 'V5' },
      { ref: 'V2.6', role: 'table', name: 'Счета' }] },
    { id: 'V3', kind: 'page', key: '/#/clients', title: 'Клиенты', controls: [...nav('V3'),
      { ref: 'V3.5', role: 'button', name: 'Добавить клиента', unexplored: true },
      { ref: 'V3.6', role: 'table', name: 'Клиенты <script>' }] },
    { id: 'V4', kind: 'page', key: '/#/settings', title: 'Настройки', form: true, controls: [...nav('V4'),
      { ref: 'V4.5', role: 'textbox', name: 'Название компании', state: 'filled' },
      { ref: 'V4.6', role: 'textbox', name: 'ИНН', state: 'empty' },
      { ref: 'V4.7', role: 'button', name: 'Сохранить', commit: true },
      { ref: 'V4.8', role: 'button', name: 'Пригласить коллегу', to: 'V6' }] },
    { id: 'V5', kind: 'page', key: '/#/invoices/new', title: 'Новый счёт', form: true, controls: [...nav('V5'),
      { ref: 'V5.5', role: 'select', name: 'Клиент', options: ['Выберите клиента', 'ИП Каримова'] },
      { ref: 'V5.6', role: 'textbox', name: 'Сумма, ₽' },
      { ref: 'V5.7', role: 'select', name: 'Срок оплаты', options: ['7 дней', '14 дней', '30 дней'] },
      { ref: 'V5.8', role: 'button', name: 'Отправить счёт', commit: true },
      { ref: 'V5.9', role: 'link', name: 'Отмена', to: 'V2' }] },
    { id: 'V6', kind: 'dialog', parent: 'V4', opener: 'V4.8', title: 'Пригласить коллегу', controls: [
      { ref: 'V6.1', role: 'textbox', name: 'Почта' },
      { ref: 'V6.2', role: 'select', name: 'Роль', options: ['Менеджер', 'Бухгалтер'] },
      { ref: 'V6.3', role: 'button', name: 'Отправить приглашение', commit: true },
      { ref: 'V6.4', role: 'button', name: 'Отмена' }] },
  ],
};

// ---- mapText
{
  const t = B.mapText(small).text;
  check('commit flag rendered', /V5\.8 button "Отправить счёт" · commit/.test(t), t);
  check('not opened flag rendered', /V3\.5 button "Добавить клиента" · not opened/.test(t));
  check('form view marked', /VIEW V5 page "Новый счёт" \/#\/invoices\/new · form/.test(t));
  check('region control rendered', /V2\.6 table "Счета"/.test(t));
  check('no angle brackets from page text', !/<script>/.test(t) && /Клиенты  script /.test(t));
  check('GLOBAL listed once', (t.match(/link "Счета"/g) || []).length === 1);
  check('flags before the arrow', /V4\.8 button "Пригласить коллегу" → V6/.test(t));
}

// ---- learn and ask share the first system block; small map → one body
{
  const ask = B.buildAskMap({ question: 'как добавить клиента', map: small, current: 'V1' });
  const learn = B.buildLearn({ map: small, product: 'Ledgerly' });
  const batches = B.buildLearnBatches({ map: small, product: 'Ledgerly' });
  check('first system block identical (learn/ask)', ask.system[0].text === learn.system[0].text && learn.system[0].text === B.MAP_SYSTEM);
  check('map block identical and cached (learn/ask)', ask.system[1].text === learn.system[1].text && !!learn.system[1].cache_control);
  check('small map → one batch equal to buildLearn', batches.length === 1 && JSON.stringify(batches[0]) === JSON.stringify(learn));
  check('learn schema has continues_live', JSON.stringify(learn.output_config.format.schema).includes('continues_live'));
  check('learn uses the learn model', learn.model === B.MODELS.learn);
  check('product map wraps everything', learn.system[1].text.startsWith('<product_map>\n') && learn.system[1].text.endsWith('\n</product_map>'));
  const ex = B.buildLearn({ map: small, existing: ['Выставить счёт'] });
  check('existing names listed', ex.messages[0].content.includes('- Выставить счёт'));
}

// ---------------- finishGuides ----------------
{
  const raw = { summary: 's', guides: [
    { name: 'Изменить название компании', continues_live: false, steps: [
      { instruction: 'Нажмите «Настройки»', element_ref: 'V1.4', action: 'click', value: null },
      { instruction: 'Введите название в поле «Название компании»', element_ref: 'V4.5', action: 'type', value: null }] },
    { name: 'Выставить счёт клиенту', continues_live: false, steps: [
      { instruction: 'Нажмите «Счета»', element_ref: 'V1.2', action: 'click', value: null },
      { instruction: 'Нажмите «Новый счёт»', element_ref: 'V2.5', action: 'click', value: null },
      { instruction: 'Выберите клиента', element_ref: 'V5.5', action: 'select', value: null },
      { instruction: 'Нажмите «Призрак»', element_ref: 'V5.99', action: 'click', value: null },
      { instruction: 'Нажмите «Отправить счёт»', element_ref: 'V5.8', action: 'click', value: null }] },
    { name: 'Добавить клиента', continues_live: false, steps: [
      { instruction: 'Нажмите «Клиенты»', element_ref: 'V1.3', action: 'click', value: null },
      { instruction: 'Нажмите «Добавить клиента»', element_ref: 'V3.5', action: 'click', value: null }] },
    { name: 'добавить  клиента!', continues_live: false, steps: [
      { instruction: 'Нажмите «Клиенты»', element_ref: 'V1.3', action: 'click', value: null }] },
    { name: 'Посмотреть счета', continues_live: false, steps: [
      { instruction: 'Нажмите «Счета»', element_ref: 'V1.2', action: 'click', value: null },
      { instruction: 'Просмотрите список счетов', element_ref: 'V2.6', action: 'look', value: null }] },
    { name: 'Пригласить коллегу', continues_live: false, steps: [
      { instruction: 'Нажмите «Настройки»', element_ref: 'V1.4', action: 'click', value: null },
      { instruction: 'Нажмите «Пригласить коллегу»', element_ref: 'V4.8', action: 'click', value: null },
      { instruction: 'Введите почту', element_ref: 'V6.1', action: 'type', value: null },
      { instruction: 'Нажмите «Отмена»', element_ref: 'V6.4', action: 'click', value: null }] },
    { name: 'Счёт с оплатой за 30 дней', continues_live: false, steps: [
      { instruction: 'Нажмите «Новый счёт»', element_ref: 'V2.5', action: 'click', value: null },
      { instruction: 'Выберите «30 дней»', element_ref: 'V5.7', action: 'select', value: '30 дней' },
      { instruction: 'Укажите сумму', element_ref: null, action: 'type', value: null },
      { instruction: 'Нажмите «Отправить счёт»', element_ref: 'V5.8', action: 'click', value: null }] },
    { name: 'Только призраки', continues_live: false, steps: [
      { instruction: 'Нажмите «X»', element_ref: 'V9.9', action: 'click', value: null }] },
    { name: 'Live by model', continues_live: true, steps: [
      { instruction: 'Click «Clients»', element_ref: 'V1.3', action: 'click', value: null }] },
  ] };
  const g = B.finishGuides(raw, small);
  const by = Object.fromEntries(g.map(x => [x.name, x]));
  const company = by['Изменить название компании'];
  check('commit appended after a field', company && company.steps.length === 3 && company.steps[2].instruction === 'Нажмите «Сохранить»' && company.steps[2].target.text === 'Сохранить', company);
  check('appended commit → not live', company && company.live === false, company && company.live);
  const inv = by['Выставить счёт клиенту'];
  check('unknown ref dropped', inv && inv.steps.length === 4 && !inv.steps.some(s => /Призрак/.test(s.instruction)), inv);
  check('ends with commit → nothing appended, not live', inv && inv.steps[3].target.text === 'Отправить счёт' && inv.live === false);
  check('unexplored last step → live', by['Добавить клиента'] && by['Добавить клиента'].live === true);
  check('duplicate names dropped', g.filter(x => B.norm(x.name).includes('добавить')).length === 1);
  const look = by['Посмотреть счета'];
  check('look step on a region keeps its target, not live', look && look.steps[1].target && look.steps[1].target.role === 'table' && look.live === false, look);
  const inv2 = by['Пригласить коллегу'];
  check('dialog commit appended after a cancel', inv2 && inv2.steps[inv2.steps.length - 1].instruction === 'Нажмите «Отправить приглашение»', inv2 && inv2.steps.map(s => s.instruction));
  const s30 = by['Счёт с оплатой за 30 дней'];
  check('value implied by the name kept', s30 && s30.steps[1].value === '30 дней', s30 && s30.steps[1]);
  check('null target on a non-look step → live', s30 && s30.live === true);
  check('guide without any target dropped', !by['Только призраки']);
  check('continues_live → live', by['Live by model'] && by['Live by model'].live === true);
  // Language of the appended step follows the guide.
  const en = B.finishGuides([{ name: 'Rename company', continues_live: false, steps: [
    { instruction: 'Open "Настройки"', element_ref: 'V1.4', action: 'click', value: null },
    { instruction: 'Type the new name', element_ref: 'V4.5', action: 'type', value: null }] }], small);
  check('appended step reuses the guide wording', en[0] && en[0].steps[2].instruction === 'Open "Сохранить"', en[0] && en[0].steps[2]);
  const en2 = B.finishGuides([{ name: 'Rename company', continues_live: false, steps: [
    { instruction: 'Type the new name', element_ref: 'V4.5', action: 'type', value: null }] }], small);
  check('english fallback wording', en2[0] && en2[0].steps[1].instruction === 'Click "Сохранить"', en2[0] && en2[0].steps[1]);
  // Ends on a field with no commit anywhere: live.
  const noCommit = JSON.parse(JSON.stringify(small));
  noCommit.views[3].controls = noCommit.views[3].controls.filter(c => !c.commit);
  const nc = B.finishGuides([raw.guides[0]], noCommit);
  check('ends on a field without a commit → live', nc[0] && nc[0].live === true && nc[0].steps.length === 2);
  // Step cap.
  const long = { name: 'Long', continues_live: false, steps: Array.from({ length: 40 }, () => ({ instruction: 'Нажмите «Счета»', element_ref: 'V1.2', action: 'click', value: null })) };
  const lg = B.finishGuides([long], small)[0];
  check('steps capped at 25 and marked live', lg.steps.length === 25 && lg.live === true);
  // mergeGuides
  const old = [{ id: 'a', name: 'Добавить клиента', steps: [1], live: true, runs: 3 }, { id: 'b', name: 'Other', steps: [1] }];
  const merged = B.mergeGuides(old, [{ name: 'добавить клиента', steps: [1, 2, 3], live: false }, { name: 'New one', steps: [1] }]);
  check('merge: same name replaced by the complete one, id kept', merged.length === 3 && merged[0].id === 'a' && merged[0].runs === 3 && merged[0].steps.length === 3 && merged[0].live === false, merged);
  check('merge: new names appended in order', merged[2].name === 'New one' && merged[1].name === 'Other');
  const keepOld = B.mergeGuides([{ name: 'X', steps: [1, 2], live: false }], [{ name: 'x', steps: [1, 2, 3, 4], live: true }]);
  check('merge: a live duplicate does not replace a finished guide', keepOld.length === 1 && keepOld[0].live === false);
}

// ---------------- a 150-view TMS map → batches ----------------
function bigMap() {
  const sections = ['dispatch', 'loads', 'drivers', 'trucks', 'trailers', 'customers', 'invoices', 'settlements', 'fuel', 'ifta', 'safety', 'reports', 'settings', 'carriers', 'documents'];
  const views = [];
  let n = 0;
  const gnav = vid => sections.map((s, i) => ({ ref: `${vid}.${i + 1}`, role: 'link', name: s[0].toUpperCase() + s.slice(1), section: 'Menu', to: `V${i * 10 + 1}` }));
  sections.forEach((s, si) => {
    // 7 pages + 3 dialogs per section = 10 views
    const pages = [`/${s}`, `/${s}/new`, `/${s}/:id`, `/${s}/:id/edit`, `/${s}/archive`, `/${s}/import`, `/${s}/settings`];
    pages.forEach((key, pi) => {
      const id = `V${si * 10 + pi + 1}`;
      const controls = gnav(id);
      let r = controls.length;
      for (let k = 0; k < 22; k++) controls.push({ ref: `${id}.${++r}`, role: k % 3 ? 'button' : 'textbox', name: `${s} control ${k} with a longer descriptive label`, section: `${s} block`, state: k % 3 ? undefined : 'empty' });
      controls.push({ ref: `${id}.${++r}`, role: 'table', name: `${s} table` });
      if (pi === 0) for (let d = 0; d < 3; d++) controls.push({ ref: `${id}.${++r}`, role: 'button', name: `Open dialog ${d}`, to: `V${si * 10 + 8 + d}` });
      if (pi === 0) controls.push({ ref: `${id}.${++r}`, role: 'button', name: 'New', to: `V${si * 10 + 2}` });
      controls.push({ ref: `${id}.${++r}`, role: 'button', name: 'Save', commit: true });
      views.push({ id, kind: 'page', key, title: `${s} page ${pi}`, form: pi === 1 || pi === 3, facts: [`${s} fact one`, `${s} fact two`], controls });
      n++;
    });
    for (let d = 0; d < 3; d++) {
      const id = `V${si * 10 + 8 + d}`;
      const controls = [];
      for (let k = 0; k < 10; k++) controls.push({ ref: `${id}.${k + 1}`, role: k % 2 ? 'textbox' : 'select', name: `${s} dialog ${d} field ${k}`, options: k % 2 ? undefined : ['A', 'B', 'C'] });
      controls.push({ ref: `${id}.11`, role: 'button', name: 'Create', commit: true });
      views.push({ id, kind: 'dialog', parent: `V${si * 10 + 1}`, opener: `V${si * 10 + 1}.${16 + 22 + 1 + d}`, title: `${s} dialog ${d}`, controls });
      n++;
    }
  });
  return { views };
}
{
  const map = bigMap();
  check('synthetic map has 150 views', map.views.length === 150, map.views.length);
  check('synthetic map is over budget', !B.mapText(map).complete);
  const bodies = B.buildLearnBatches({ map, product: 'TruckTMS', existing: ['Добавить груз'] });
  check('several bodies', bodies.length >= 3, bodies.length);
  const seen = {};
  const OPEN = '<product_map>\n', CLOSE = '\n</product_map>';
  bodies.forEach((b, i) => {
    const sys = b.system.map(x => x.text).join('');
    const inner = sys.slice(sys.indexOf(OPEN) + OPEN.length, sys.lastIndexOf(CLOSE));
    check(`body ${i} map under budget`, inner.length <= B.MAP_BUDGET, inner.length);
    check(`body ${i} has GLOBAL`, inner.startsWith('GLOBAL (on every page'), inner.slice(0, 60));
    check(`body ${i} first block is MAP_SYSTEM`, b.system[0].text === B.MAP_SYSTEM && !b.system[0].cache_control);
    check(`body ${i} shared prefix cached`, b.system[1].text === bodies[0].system[1].text && !!b.system[1].cache_control && !b.system[2].cache_control);
    check(`body ${i} lists existing guides`, b.messages[0].content.includes('- Добавить груз'));
    check(`body ${i} names the other parts`, b.messages[0].content.includes(`part ${i + 1}`) && b.messages[0].content.includes('other parts'));
    check(`body ${i} model and schema`, b.model === B.MODELS.learn && JSON.stringify(b.output_config.format.schema).includes('continues_live'));
    const ids = [...inner.matchAll(/^VIEW (\S+) /gm)].map(m => m[1]);
    ids.forEach(id => { (seen[id] = seen[id] || []).push(i); });
    // Dialogs travel with the page they open from.
    for (const v of map.views.filter(v => v.kind === 'dialog' && ids.includes(v.id))) check(`dialog ${v.id} with parent`, ids.includes(v.parent));
    // Every ref used in the part's details exists in the map (no invented refs in stubs).
  });
  const all = map.views.map(v => v.id);
  check('every view described exactly once', all.every(id => seen[id] && seen[id].length === 1), all.filter(id => !seen[id] || seen[id].length !== 1));
  check('no extra views', Object.keys(seen).length === all.length);
  const g1 = B.learnGroups(map), g2 = B.learnGroups(map);
  check('grouping deterministic', JSON.stringify(g1.groups.map(g => g.ids)) === JSON.stringify(g2.groups.map(g => g.ids)));
  check('groups follow sections', g1.groups.every(g => new Set(g.ids.map(id => Math.floor((+id.slice(1) - 1) / 10))).size <= 3));
  // A page whose only way in is from another part gets a LINKS line.
  const deep = { views: map.views.concat([{ id: 'V999', kind: 'page', key: '/hidden/deep', title: 'Deep', controls: [{ ref: 'V999.1', role: 'button', name: 'Deep save', commit: true }] }]) };
  deep.views[0].controls.push({ ref: 'V1.999', role: 'link', name: 'To deep', to: 'V999' });
  const dbodies = B.buildLearnBatches({ map: deep });
  const withDeep = dbodies.find(b => /^VIEW V999 /m.test(b.system[2].text));
  check('stub links into a part from another part', withDeep && (/^VIEW V1 /m.test(withDeep.system[2].text) || /LINKS ON V1 .*\n.*V1\.999 link "To deep" → V999/.test(withDeep.system[2].text)));
}

// ---------------- row controls: one per row, generic label, any row at run time ----------------
{
  const rowOf = { box: { tag: 'table', name: 'loads', head: ['load #', 'status', 'actions'] }, row: 'tr', col: 2, hcol: 'actions', nth: 0, role: 'button', pre: 'actions for load', suf: '', label: 'Actions for load …' };
  const linkOf = { box: rowOf.box, row: 'tr', col: 0, hcol: 'load #', nth: 0, role: 'link', pre: '', suf: '', data: true, label: 'Load #' };
  const nav2 = vid => nav(vid).map(c => ({ ...c, to: c.to === 'V2' ? 'V7' : c.to }));
  const tms = { views: [
    { id: 'V1', kind: 'page', key: '/', title: 'Обзор', controls: nav2('V1') },
    { id: 'V7', kind: 'page', key: '/#/loads', title: 'Loads', controls: [...nav2('V7'),
      { ref: 'V7.5', role: 'button', name: 'Actions for load 1066', row: true, rowLabel: 'Actions for load …', to: 'V8',
        d: { v: 2, sel: [], text: 'Actions for load 1066', role: 'button', path: '/#/loads', fp: { role: 'button', name: 'actions for load', rowOf } } },
      { ref: 'V7.6', role: 'link', name: '1066', row: true, rowLabel: 'Load #', to: 'V9', d: { v: 2, sel: [], text: '1066', role: 'link', path: '/#/loads', fp: { role: 'link', name: '#', rowOf: linkOf } } },
      { ref: 'V7.7', role: 'table', name: 'Loads' }] },
    { id: 'V8', kind: 'panel', parent: 'V7', opener: 'V7.5', title: 'Actions for load …', controls: [
      { ref: 'V8.1', role: 'menuitem', name: 'Edit', d: { v: 2, sel: [], text: 'Edit', role: 'menuitem', path: '/#/loads', fp: { role: 'menuitem', name: 'edit' } } }] },
    { id: 'V9', kind: 'page', key: '/#/loads/:id', title: 'Load 1066', controls: [...nav2('V9'),
      { ref: 'V9.5', role: 'button', name: 'Edit load', d: { v: 2, sel: [], text: 'Edit load', role: 'button', path: '/#/loads/:id', fp: { role: 'button', name: 'edit load' } } }] },
  ] };
  const t = B.mapText(tms).text;
  check('row: rendered with the generic label and · one per row', /V7\.5 button "Actions for load …" · one per row → V8/.test(t), t);
  check('row: a record link rendered by its column', /V7\.6 link "Load #" · one per row → V9/.test(t));
  check('row: the sample record never reaches the map text through a row control', !/Actions for load 1066/.test(t) && !/link "1066"/.test(t));
  check('row: record screen marked · one record', /VIEW V9 page "Load 1066" \/#\/loads\/:id · one record/.test(t) && !/VIEW V7 [^\n]*one record/.test(t));
  check('row: a panel a row control opens is · one record too', /VIEW V8 panel "Actions for load …" opens from V7\.5 on V7 · one record/.test(t));
  check('row: MAP_SYSTEM explains one per row and asks for the record you need', /· one per row/.test(B.MAP_SYSTEM) && /on the load you need/.test(B.MAP_SYSTEM) && /у нужного груза/.test(B.MAP_SYSTEM) && /never name a record/.test(B.MAP_SYSTEM));
  const ask = B.buildAskMap({ question: 'как изменить ставку груза', map: tms, current: 'V7' });
  const learn = B.buildLearn({ map: tms });
  check('row: cached first block identical between learn and ask', ask.system[0].text === learn.system[0].text && ask.system[0].text === B.MAP_SYSTEM && ask.system[1].text === learn.system[1].text);
  check('row: learn rules ask for the record the user needs', /one per row control, and the step says to pick the record/.test(learn.messages[0].content));
  const steps = B.refSteps([
    { instruction: 'Click Loads', element_ref: 'V1.2', action: 'click', value: null },
    { instruction: 'Click ⋯ (Actions) on the load you need', element_ref: 'V7.5', action: 'click', value: null },
    { instruction: 'Click Edit', element_ref: 'V8.1', action: 'click', value: null },
    { instruction: 'Open the load you need from the Load # column', element_ref: 'V7.6', action: 'click', value: null },
    { instruction: 'Click Edit load', element_ref: 'V9.5', action: 'click', value: null }], tms, 'Change a load rate');
  const [nav1, act, menu, link, detail] = steps.map(s => s.target);
  check('row: step target carries row, rowLabel and rowOf', act.row === true && act.rowLabel === 'Actions for load …' && act.rowOf && act.rowOf.pre === 'actions for load' && act.rowOf.col === 2);
  check('row: step target text is the generic label, not the sample', act.text === 'Actions for load …' && link.text === 'Load #' && link.rowOf.data === true);
  check('row: plain steps carry no row flag', !nav1.row && !menu.row && !detail.row && !('rowOf' in detail));
  check('row: the step on the record screen keeps its :id path', detail.path === '/#/loads/:id');
  const fin = B.finishGuides({ guides: [{ name: 'Change a load rate', continues_live: false, steps: [
    { instruction: 'Click Loads', element_ref: 'V1.2', action: 'click', value: null },
    { instruction: 'Click ⋯ (Actions) on the load you need', element_ref: 'V7.5', action: 'click', value: null },
    { instruction: 'Click Edit', element_ref: 'V8.1', action: 'click', value: null }] }] }, tms);
  check('row: finished guide keeps the row target', fin.length === 1 && fin[0].steps[1].target.row === true && !fin[0].live);
}

// ---------------- continuation request ----------------
{
  const page = { title: 'Клиенты', url: 'http://x/#/clients', headings: ['Клиенты'], lines: ['[1] button "Добавить клиента"'] };
  const b = B.buildContinue({ guideName: 'Добавить клиента', page, done: ['Нажмите «Клиенты»', 'Нажмите «Добавить клиента»'], product: 'Ledgerly' });
  const txt = b.messages[b.messages.length - 1].content.map(c => c.text).join('\n');
  check('continue: ask model, low effort', b.model === B.MODELS.ask && b.output_config.effort === 'low');
  check('continue: progress listed', txt.includes('1. Нажмите «Клиенты»') && txt.includes('only the remaining steps') && txt.includes('Добавить клиента'));
  check('continue: page wrapped', txt.includes('<page>'));
  const steps = B.askSteps({ steps: [{ instruction: 'Введите имя', element_id: 1, element_text: 'Имя', action: 'type', value: 'Иван' }, { instruction: 'Нажмите «Сохранить»', element_id: null, element_text: 'Сохранить', action: 'click', value: null }] }, [{ sel: ['#n'], text: 'Имя' }, null], 'Добавить клиента');
  check('askSteps: descriptor used, value not from the question dropped', steps[0].target.sel[0] === '#n' && steps[0].value === null);
  check('askSteps: label fallback target', steps[1].target && steps[1].target.text === 'Сохранить' && steps[1].target.sel.length === 0);
}

// ---------------- call(): endpoint and headers ----------------
{
  const body = B.buildAskMap({ question: 'q', map: small, current: 'V1' });
  calls.length = 0;
  await B.call(body, null, { endpoint: 'http://localhost:4173/api/scopos/claude' });
  let c = calls[0];
  check('proxy: url', c && c.url === 'http://localhost:4173/api/scopos/claude');
  check('proxy without key: only content-type', c && JSON.stringify(c.headers) === JSON.stringify({ 'content-type': 'application/json' }), c && c.headers);
  check('proxy: body intact (stream, fallbacks)', c && c.body.stream === true && c.body.model === body.model);
  calls.length = 0;
  await B.call(body, '', { endpoint: 'http://localhost:4173/api/scopos/claude' });
  check('proxy with empty key: no auth', calls[0] && !('x-api-key' in calls[0].headers) && !Object.keys(calls[0].headers).some(k => k.startsWith('anthropic-')));
  calls.length = 0;
  await B.call(body, 'sk-test', { endpoint: 'http://localhost:4173/api/scopos/claude', fromBrowser: false });
  c = calls[0];
  check('proxy with key: anthropic headers', c && c.headers['x-api-key'] === 'sk-test' && c.headers['anthropic-version'] && c.url.startsWith('http://localhost'));
  calls.length = 0;
  const out = await B.call(body, 'sk-test');
  c = calls[0];
  check('default: Anthropic API', c && c.url === B.API_URL && c.headers['x-api-key'] === 'sk-test' && c.headers['anthropic-dangerous-direct-browser-access'] === 'true' && c.headers['anthropic-beta']);
  check('stream parsed', out && out.answer === 'ok');
  check('headers(): proxy and key', JSON.stringify(B.headers(null, true, true, 'http://p')) === '{"content-type":"application/json"}' && B.headers('k', false, false, 'http://p')['x-api-key'] === 'k');
  // A proxy answering with plain JSON.
  sandbox.fetch = async (url, init) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ content: [{ type: 'text', text: '{"answer":"plain","steps":[]}' }], stop_reason: 'end_turn', usage: {} }) });
  const plain = await B.call(body, null, { endpoint: 'http://p' });
  check('proxy plain JSON response parsed', plain && plain.answer === 'plain');
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
