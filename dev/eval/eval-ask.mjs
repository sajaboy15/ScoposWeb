// ask-map eval: runs every task of a product through Brain.buildAskMap on one model/effort, in sequence (so the
// cached map block is warm after the first call, as in real use), grades each answer and prints a summary.
//
//   node dev/eval/eval-ask.mjs --product tms|ledgerly --map <map.json> [--model claude-sonnet-5-5] [--effort low]
//        [--limit N] [--only id,id] [--full-map] [--dry]
//
//   --map       a map saved by dev/explore-walk.mjs (its JSON has { map }) or a bare map { views }
//   --full-map  send the whole map as the cached block even when it is over Brain.MAP_BUDGET (what-if: the
//               current code sends a question-dependent subset, uncached, for maps over budget)
//   --lang-fix  what-if: replace the map prompt's "write in the product's interface language" with "write in the
//               language of the user's question; control names stay as labeled" (brain.js is not changed)
//   --suffix s  appended to the result file name (repeat runs)
//   --regrade   grade the saved answers again, no Claude call
//   --dry       build the bodies and print sizes; no Claude call
// Results: $EVAL_OUT/ask-<product>-<model>-<effort>[-full].json; spend in $EVAL_OUT/spend.jsonl (cap $EVAL_BUDGET).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain, run, withModel, save, pct, sum, spent, loadJSON, BUDGET } from './lib.mjs';
import { grade, labelForRef } from './grade.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes('--' + k);
const product = arg('product', 'tms');
const model = arg('model', Brain.MODELS.ask);
const effort = arg('effort', 'low');
const full = flag('full-map');
const langFix = flag('lang-fix');
const LANG_FROM = "write in the product's interface language. no markdown.";
const LANG_TO = "write the answer and every instruction in the language of the user's question, whatever the interface language: an English question gets English instructions (Click «Save»), a Russian question gets Russian ones. the examples above are only examples of style. control names stay exactly as labeled on screen. no markdown.";
if (langFix && !Brain.MAP_SYSTEM.includes(LANG_FROM)) throw new Error('--lang-fix: the map prompt changed; update LANG_FROM');
const raw = loadJSON(arg('map'));
const map = raw.map || raw;
let tasks = JSON.parse(readFileSync(join(HERE, `tasks-${product}.json`), 'utf8'));
if (arg('only')) { const ids = new Set(arg('only').split(',')); tasks = tasks.filter(t => ids.has(t.id)); }
if (arg('limit')) tasks = tasks.slice(0, +arg('limit'));
const firstPage = map.views.find(v => v.kind === 'page').id;

function bodyFor(t) {
  let b = Brain.buildAskMap({ question: t.q, map, current: t.current || firstPage, product: '' });
  if (full) {
    const text = Brain.mapText(map, { budget: 1e9 }).text;
    b.system = [{ type: 'text', text: Brain.MAP_SYSTEM }, { type: 'text', text: `<product_map>\n${text}\n</product_map>`, cache_control: { type: 'ephemeral', ttl: '1h' } }];
  }
  if (langFix) b.system = [{ ...b.system[0], text: b.system[0].text.replace(LANG_FROM, LANG_TO) }, ...b.system.slice(1)];
  return withModel(b, model, effort);
}

const mt = Brain.mapText(map, {});
console.log(`${product}: ${map.views.length} views; map text ${mt.text.length} chars, complete=${mt.complete} (budget ${Brain.MAP_BUDGET})${full ? '; --full-map: ' + Brain.mapText(map, { budget: 1e9 }).text.length + ' chars' : ''}`);
if (flag('dry')) {
  for (const t of tasks) { const b = bodyFor(t); console.log(t.id, JSON.stringify(b.system).length, 'chars of system', b.system[1].cache_control ? 'cached' : 'NOT cached'); }
  process.exit(0);
}

const rows = [];
const variant = `${full ? '-full' : ''}${langFix ? '-langfix' : ''}${arg('suffix') ? '-' + arg('suffix') : ''}`;
const outFile = `ask-${product}-${model}-${effort}${variant}.json`;
// --regrade: grade the saved answers again (after a grader or task change), no Claude call.
if (flag('regrade')) {
  const old = loadJSON(join(process.env.EVAL_OUT || join(HERE, 'out'), outFile));
  for (const r of old.rows) {
    const t = tasks.find(x => x.id === r.id);
    if (!t) continue;
    r.grade = r.steps ? grade(t, { answer: r.answer, steps: r.steps }, map) : r.grade;
    rows.push(r);
  }
}
for (const t of flag('regrade') ? [] : tasks) {
  let r;
  try { r = await run(bodyFor(t), { tag: `ask-${product}-${model}-${effort}${variant}:${t.id}`, reserve: 0.05 }); }
  catch (e) { if (e.budget) { console.log('STOP', e.message); break; } throw e; }
  const g = r.out ? grade(t, r.out, map) : { exact: false, usable: false, why: 'error: ' + r.error };
  const u = r.usage || {};
  rows.push({
    id: t.id, kind: t.kind, q: t.q, ms: r.ms, cost: r.cost, error: r.error,
    usage: { in: u.input_tokens || 0, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, out: u.output_tokens || 0 },
    grade: g, answer: r.out && r.out.answer,
    steps: r.out ? (r.out.steps || []).map(s => ({ ...s, label: s.element_ref ? labelForRef(map, s.element_ref) : null })) : null,
  });
  console.log(`${g.exact ? 'EXACT ' : g.usable ? 'usable' : 'FAIL  '} ${t.id.padEnd(8)} ${(r.ms / 1000).toFixed(1)}s $${r.cost.toFixed(4)} in ${u.input_tokens} r ${u.cache_read_input_tokens || 0} w ${u.cache_creation_input_tokens || 0} out ${u.output_tokens}${g.langOk === false ? ' LANG' : ''} ${g.why || ''}`);
}

const n = rows.length;
const ms = rows.map(r => r.ms);
const warm = rows.filter(r => r.usage.read > 0), cold = rows.filter(r => r.usage.read === 0);
const avg = (a, f) => (a.length ? sum(a.map(f)) / a.length : null);
const summary = {
  product, model, effort, variant, n, mapChars: mt.text.length, mapComplete: mt.complete,
  exact: rows.filter(r => r.grade.exact).length, usable: rows.filter(r => r.grade.usable).length,
  langOk: rows.filter(r => r.grade.langOk !== false).length,
  invented: sum(rows.map(r => r.grade.invalid || 0)),
  byKind: Object.fromEntries([...new Set(rows.map(r => r.kind))].map(k => { const x = rows.filter(r => r.kind === k); return [k, `${x.filter(r => r.grade.exact).length}/${x.filter(r => r.grade.usable).length}/${x.length}`]; })),
  p50: pct(ms, 0.5), p95: pct(ms, 0.95),
  tokens: { in: avg(rows, r => r.usage.in), read: avg(rows, r => r.usage.read), write: avg(rows, r => r.usage.write), out: avg(rows, r => r.usage.out) },
  costTotal: sum(rows.map(r => r.cost)), costCold: avg(cold, r => r.cost), costWarm: avg(warm, r => r.cost), nCold: cold.length, nWarm: warm.length,
  errors: rows.filter(r => r.error).length,
};
console.log(JSON.stringify(summary, null, 1));
console.log(`spent so far: $${spent().toFixed(3)} of $${BUDGET}`);
save(outFile, { summary, rows });
