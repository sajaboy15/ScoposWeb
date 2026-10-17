// continue eval: a live guide ran out of steps (or a step is missing) and Brain.buildContinue plans the rest from
// the real page the user is on (capture-pages.mjs). Graded on ids: every id is on the page, the first step is the
// expected control, the required fields are covered, and it ends on the expected commit.
//
//   node dev/eval/eval-continue.mjs [--models claude-haiku-5-5,claude-sonnet-5-5] [--pages $EVAL_OUT/pages-tms.json]
import { join } from 'node:path';
import { Brain, OUT, run, withModel, save, loadJSON, pct, sum, spent, BUDGET } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const pages = loadJSON(arg('pages', join(OUT, 'pages-tms.json')));
const models = arg('models', 'claude-haiku-5-5,claude-sonnet-5-5').split(',');
const idBy = (pid, label) => { const l = pages[pid].lines.find(x => x.includes(`"${label}"`)); return l ? +/^\[(\d+)\]/.exec(l)[1] : null; };

const CASES = [
  { id: 'add-truck', page: 'add-truck', guideName: 'Add a new truck', done: ['Click «Trucks» in the main navigation.', 'Click «Add truck».'],
    first: 'Unit # *', fields: ['Unit # *', 'Make *', 'VIN *'], commit: 'Save truck' },
  { id: 'invite', page: 'users-roles', guideName: 'Invite a user to the team', done: ['Click «Settings».', 'Click the «Users & Roles» tab.'],
    first: 'Invite user', fields: [], commit: null },
  { id: 'add-stop', page: 'new-load-stop', guideName: 'Add an extra stop to a new load', done: ['Click «Loads».', 'Click «+ New load».', 'Click «+ Add stop».'],
    first: 'Stop type', fields: ['Stop type', 'Address'], commit: 'Create load' },
  { id: 'schedule', page: 'maintenance-schedule', guideName: 'Schedule service for a truck', done: ['Click «Maintenance».', 'Click «Schedule service».'],
    first: null, fields: ['Truck *', 'Service type *', 'Date *'], commit: 'Schedule service' },
  { id: 'invoice', page: 'invoices', guideName: 'Create an invoice for a delivered load', done: ['Click «Billing» in the main navigation.'],
    first: 'Create invoice', fields: [], commit: null },
];

function grade(c, out) {
  const ids = new Set(pages[c.page].lines.map(l => (/^\[(\d+)\]/.exec(l) || [])[1]).filter(Boolean).map(Number));
  const steps = (out && out.steps) || [];
  const got = steps.map(s => s.element_id);
  const invalid = got.filter(i => i != null && !ids.has(i)).length;
  const firstOk = !c.first || got[0] === idBy(c.page, c.first);
  const fieldsOk = c.fields.every(f => got.includes(idBy(c.page, f)));
  const commitId = c.commit && idBy(c.page, c.commit);
  const lastClick = [...steps].reverse().find(s => s.action !== 'look');
  const commitOk = !c.commit || (lastClick && lastClick.element_id === commitId);
  const english = steps.every(s => !/[а-яё]/i.test(s.instruction || ''));
  return { ok: steps.length > 0 && invalid === 0 && firstOk && fieldsOk && commitOk, invalid, firstOk, fieldsOk, commitOk, english, n: steps.length };
}

const summary = {};
for (const model of models) {
  const rows = [];
  for (const c of CASES) {
    const body = withModel(Brain.buildContinue({ guideName: c.guideName, page: pages[c.page], done: c.done, product: '' }), model);
    let r;
    try { r = await run(body, { tag: `continue-${model}`, reserve: 0.05 }); }
    catch (e) { if (e.budget) { console.log('STOP', e.message); break; } throw e; }
    const g = r.out ? grade(c, r.out) : { ok: false, error: r.error };
    rows.push({ id: c.id, ms: r.ms, cost: r.cost, usage: r.usage, grade: g, out: r.out });
    console.log(`${g.ok ? 'ok  ' : 'FAIL'} ${model} ${c.id}: ${JSON.stringify(g)} · ${(r.ms / 1000).toFixed(1)}s $${r.cost.toFixed(4)}`);
    if (r.out) r.out.steps.forEach(s => console.log(`      ${s.action} [${s.element_id}] ${s.instruction}`));
  }
  const ms = rows.map(r => r.ms);
  summary[model] = { n: rows.length, ok: rows.filter(r => r.grade.ok).length, english: rows.filter(r => r.grade.english).length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), costPerCall: sum(rows.map(r => r.cost)) / rows.length, tokensIn: sum(rows.map(r => (r.usage && r.usage.input_tokens) || 0)) / rows.length, tokensOut: sum(rows.map(r => (r.usage && r.usage.output_tokens) || 0)) / rows.length };
  save(`continue-${model}.json`, { summary: summary[model], rows });
}
console.log(JSON.stringify(summary, null, 1));
console.log(`spent so far: $${spent().toFixed(3)} of $${BUDGET}`);
