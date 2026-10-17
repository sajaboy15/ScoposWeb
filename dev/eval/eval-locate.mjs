// locate eval: synthetic "the UI changed" cases on real page scans (capture-pages.mjs). A control's label is
// renamed (or the control removed), the page's control lines are shuffled, and Brain.buildLocate must return
// the right id (or null when the control is gone).
//
//   node dev/eval/eval-locate.mjs [--models claude-haiku-5-5,claude-sonnet-5-5] [--pages $EVAL_OUT/pages-tms.json]
import { join } from 'node:path';
import { Brain, OUT, run, withModel, save, loadJSON, pct, sum, spent, BUDGET } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const pages = loadJSON(arg('pages', join(OUT, 'pages-tms.json')));
const models = arg('models', 'claude-haiku-5-5,claude-sonnet-5-5').split(',');

// [page, old label, new label (null: removed), instruction, give the right id among the candidates]
const CASES = [
  ['add-truck', 'Save truck', 'Add to fleet', 'Click «Save truck»', true],
  ['add-truck', 'VIN *', 'Vehicle identification no. *', 'Enter the VIN in «VIN *»', false],
  ['add-driver', 'Save driver', 'Save', 'Click «Save driver»', true],
  ['add-driver', 'CDL number *', 'License number *', 'Enter the CDL number', false],
  ['add-driver', 'Pay rate', 'Rate per mile', 'Enter the pay rate', true],
  ['trucks', 'Add truck', 'New truck', 'Click «Add truck»', false],
  ['drivers', 'Add driver', '+ Driver', 'Click «Add driver»', true],
  ['invoices', 'Create invoice', 'New invoice', 'Click «Create invoice»', false],
  ['invoices', 'Search invoices', 'Find an invoice', 'Type the invoice number in «Search invoices»', true],
  ['users-roles', 'Invite user', 'Add teammate', 'Click «Invite user»', false],
  ['new-load-stop', 'Create load', 'Save load', 'Click «Create load»', true],
  ['add-truck', 'Make *', 'Manufacturer *', 'Select the «Make *»', false],
  ['maintenance-schedule', 'Service type *', 'Type of work *', 'Select the «Service type *»', true],
  ['new-load-stop', '+ Add stop', 'Add another stop', 'Click «+ Add stop»', false],
  ['trucks', 'Add truck', null, 'Click «Add truck»', false],
  ['add-driver', 'Save driver', null, 'Click «Save driver»', false],
  ['invoices', 'Create invoice', null, 'Click «Create invoice»', false],
];

// Deterministic shuffle.
function shuffle(a, seed) { a = a.slice(); let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const idOf = l => { const m = /^\[(\d+)\]/.exec(l); return m ? +m[1] : null; };

function makeCase([pid, oldL, newL, instruction, giveRight], k) {
  const page = pages[pid];
  const idx = page.lines.findIndex(l => l.includes(`"${oldL}"`));
  if (idx < 0) throw new Error(`no "${oldL}" on ${pid}`);
  const want = newL ? idOf(page.lines[idx]) : null;
  let lines = page.lines.slice();
  if (newL) lines[idx] = lines[idx].replace(`"${oldL}"`, `"${newL}"`); else lines.splice(idx, 1);
  lines = shuffle(lines.filter(l => idOf(l) != null), 7 + k);
  // Candidates the page would suggest by similarity: two decoys, plus the right one when giveRight.
  const ids = lines.map(idOf).filter(i => i !== want);
  const cands = shuffle([...(giveRight && want ? [want] : []), ...shuffle(ids, k).slice(0, 2)], k);
  return { pid, oldL, newL, want, body: Brain.buildLocate({ instruction, oldText: oldL, page: { ...page, lines }, candidates: cands }) };
}

const cases = CASES.map(makeCase);
const summary = {};
for (const model of models) {
  const rows = [];
  for (const c of cases) {
    let r;
    try { r = await run(withModel(c.body, model), { tag: `locate-${model}`, reserve: 0.02 }); }
    catch (e) { if (e.budget) { console.log('STOP', e.message); break; } throw e; }
    const got = r.out ? r.out.element_id : 'error';
    const ok = got === c.want;
    rows.push({ ...c, body: undefined, got, ok, ms: r.ms, cost: r.cost, usage: r.usage, error: r.error });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${model} ${c.pid} "${c.oldL}" → ${c.newL ? '"' + c.newL + '"' : '(removed)'}: want ${c.want} got ${got} · ${(r.ms / 1000).toFixed(1)}s $${r.cost.toFixed(5)}`);
  }
  const ms = rows.map(r => r.ms);
  summary[model] = { n: rows.length, correct: rows.filter(r => r.ok).length, renamed: `${rows.filter(r => r.newL && r.ok).length}/${rows.filter(r => r.newL).length}`, removed: `${rows.filter(r => !r.newL && r.ok).length}/${rows.filter(r => !r.newL).length}`, p50: pct(ms, 0.5), p95: pct(ms, 0.95), costPerCall: sum(rows.map(r => r.cost)) / rows.length, tokensIn: sum(rows.map(r => (r.usage && r.usage.input_tokens) || 0)) / rows.length, tokensOut: sum(rows.map(r => (r.usage && r.usage.output_tokens) || 0)) / rows.length };
  save(`locate-${model}.json`, { summary: summary[model], rows });
}
console.log(JSON.stringify(summary, null, 1));
console.log(`spent so far: $${spent().toFixed(3)} of $${BUDGET}`);
