// learn eval: writes the guides for one map with each model (Brain.buildLearnBatches, the real learn request),
// then grades them automatically.
//
//   node dev/eval/run-learn-compare.mjs --map <map.json> [--models claude-opus-5-5,claude-sonnet-5-5] [--effort medium]
//        [--product "Haulr TMS"] [--regrade]
//
// Metrics per model:
//   guides        how many runnable guides finishGuides kept (raw: how many the model wrote)
//   commitEnd     of the guides that fill a form (fields of a view marked form, not list filters), the share whose last step clicks a · commit control (or that are
//                 honestly live: they end on a · not opened control)
//   refsValid     share of guides in which every element_ref the model wrote exists in the map
//   formCoverage  forms/dialogs of the map (views marked form) that at least one guide fills or finishes
//   formTasks     the same, counting views that are the same task once (same commit label, e.g. three
//                 "Create invoice" dialogs)
//   duplicates    guides that end on the same commit label as an earlier guide and press/fill the same controls
//   sampleLeaks   guides whose name or instructions name a record the explorer saw (load numbers, invoice
//                 numbers, people, trucks) — rows must stay generic
//   rowGeneric    of the guides with a · one per row step, the share whose row step tells the user to pick
//                 the record they need
// Results: $EVAL_OUT/learn-<model>-<effort>.json
import { Brain, run, withModel, save, spent, loadJSON, BUDGET } from './lib.mjs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const raw = loadJSON(arg('map'));
const map = raw.map || raw;
const models = arg('models', 'claude-opus-5-5,claude-sonnet-5-5').split(',');
const effort = arg('effort', 'medium');
const product = arg('product', 'Haulr TMS');

const byRef = {}, viewOfRef = {};
map.views.forEach(v => v.controls.forEach(c => { byRef[c.ref] = c; viewOfRef[c.ref] = v; }));
const forms = map.views.filter(v => v.form);
const label = c => (c.row && c.rowLabel ? c.rowLabel : c.name) || '';
const commitOf = v => (v.controls.find(c => c.commit) || {}).name || v.title;

// Names of sample records the explorer saw: one-record view titles, facts and option lists hold them.
const SAMPLE = /\b10[2-6]\d\b|INV-\d{3,}|Marcus Reed|Tanya Brooks|Emily Novak|Redrock|Bluewater|Truck 1\d\d\b|Unit 1\d\d\b|Dana Whitfield/i;
const PICK = /you need|the one you|нужн|the (load|driver|invoice|truck|customer|record)('s)? (you|that)|any |pick|choose|select the|find the|выбер/i;

function gradeGuides(rawOut, guides) {
  const rawGuides = (rawOut && rawOut.guides) || [];
  const refsValid = rawGuides.filter(g => (g.steps || []).every(s => s.element_ref == null || s.element_ref === '' || byRef[s.element_ref])).length;
  const invented = rawGuides.reduce((n, g) => n + (g.steps || []).filter(s => s.element_ref && !byRef[s.element_ref]).length, 0);
  // A guide that fills a form (a field in a view marked form; list filters and search boxes don't count).
  const fills = rawGuides.filter(g => (g.steps || []).some(s => (s.action === 'type' || s.action === 'select') && byRef[s.element_ref] && viewOfRef[s.element_ref].form));
  const endsOk = fills.filter(g => {
    const last = [...g.steps].reverse().find(s => s.action !== 'look');
    const c = last && byRef[last.element_ref];
    return c && last.action === 'click' && (c.commit || c.unexplored);
  });
  const touched = new Set();
  rawGuides.forEach(g => (g.steps || []).forEach(s => { const v = viewOfRef[s.element_ref]; if (v && v.form && (s.action !== 'click' || byRef[s.element_ref].commit)) touched.add(v.id); }));
  const taskKey = v => commitOf(v).toLowerCase();
  const allTasks = new Set(forms.map(taskKey)), coveredTasks = new Set(forms.filter(v => touched.has(v.id)).map(taskKey));
  const seen = new Map();
  let duplicates = 0;
  const dupList = [];
  for (const g of rawGuides) {
    const last = [...(g.steps || [])].reverse().find(s => s.action === 'click' && byRef[s.element_ref] && byRef[s.element_ref].commit);
    if (!last) continue;
    const fieldSig = (g.steps || []).filter(s => byRef[s.element_ref] && !byRef[s.element_ref].to).map(s => label(byRef[s.element_ref])).sort().join('|');
    const k = label(byRef[last.element_ref]).toLowerCase() + '#' + fieldSig;
    if (seen.has(k)) { duplicates++; dupList.push([seen.get(k), g.name]); } else seen.set(k, g.name);
  }
  const leaks = rawGuides.filter(g => SAMPLE.test(g.name) || (g.steps || []).some(s => SAMPLE.test(s.instruction || '') && !(s.action === 'select' && s.value)));
  const withRow = rawGuides.filter(g => (g.steps || []).some(s => byRef[s.element_ref] && byRef[s.element_ref].row));
  const rowGeneric = withRow.filter(g => (g.steps || []).filter(s => byRef[s.element_ref] && byRef[s.element_ref].row).every(s => PICK.test(s.instruction || '') && !SAMPLE.test(s.instruction || '')));
  return {
    rawCount: rawGuides.length, guides: guides.length, live: guides.filter(g => g.live).length,
    refsValid: `${refsValid}/${rawGuides.length}`, invented,
    commitEnd: `${endsOk.length}/${fills.length}`,
    formCoverage: `${touched.size}/${forms.length}`, formTasks: `${coveredTasks.size}/${allTasks.size}`,
    missingForms: forms.filter(v => !touched.has(v.id)).map(v => `${v.id} ${v.title}`),
    duplicates, dupList,
    sampleLeaks: leaks.map(g => g.name),
    rowGeneric: `${rowGeneric.length}/${withRow.length}`,
  };
}

const results = {};
for (const model of models) {
  const file = `learn-${model}-${effort}.json`;
  if (process.argv.includes('--regrade')) {
    const old = loadJSON(join(process.env.EVAL_OUT || 'dev/eval/out', file));
    old.grade = gradeGuides(old.raw[0], finishGuides(old.raw));
    results[model] = old; save(file, old); console.log(model, JSON.stringify(old.grade, null, 1)); continue;
  }
  const bodies = Brain.buildLearnBatches({ map, product });
  let guides = [], cost = 0, ms = 0;
  const raws = [], usages = [];
  for (const b of bodies) {
    let r;
    try { r = await run(withModel(b, model, effort), { tag: `learn-${model}-${effort}`, reserve: /opus/.test(model) ? 0.6 : 0.3 }); }
    catch (e) { if (e.budget) { console.log('STOP', e.message); process.exit(1); } throw e; }
    cost += r.cost; ms += r.ms; usages.push(r.usage); raws.push(r.out);
    if (r.error) console.log(model, 'error', r.error);
    if (r.out) guides = Brain.mergeGuides(guides, Brain.finishGuides(r.out, map));
  }
  const grade = gradeGuides(raws[0], guides);
  results[model] = { model, effort, bodies: bodies.length, cost, ms, usages, grade, raw: raws, guides: guides.map(g => ({ name: g.name, live: g.live, steps: g.steps.map(s => `${s.action}:${s.target ? s.target.text : '∅'}${s.target && s.target.row ? '[row]' : ''} — ${s.instruction}`) })) };
  save(file, results[model]);
  console.log(`\n== ${model} · ${bodies.length} request(s) · ${(ms / 1000).toFixed(0)}s · $${cost.toFixed(3)} · usage ${JSON.stringify(usages.map(u => u && { in: u.input_tokens, w: u.cache_creation_input_tokens, r: u.cache_read_input_tokens, out: u.output_tokens }))}`);
  console.log(JSON.stringify(grade, null, 1));
  console.log(`spent so far: $${spent().toFixed(3)} of $${BUDGET}`);
}
function finishGuides(raws) { let g = []; for (const r of raws || []) if (r) g = Brain.mergeGuides(g, Brain.finishGuides(r, map)); return g; }
