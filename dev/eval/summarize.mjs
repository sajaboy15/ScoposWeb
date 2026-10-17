// Prints one line per saved ask-map run (and the locate / continue / learn summaries) from $EVAL_OUT,
// re-grading the saved ask answers with the current grader and tasks. No Claude call.
//   node dev/eval/summarize.mjs --tms <map-tms.json> --ledgerly <map-ledgerly.json>
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT, loadJSON, pct, sum, spent } from './lib.mjs';
import { grade } from './grade.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const maps = { tms: arg('tms'), ledgerly: arg('ledgerly') };
const tasks = p => JSON.parse(readFileSync(join(HERE, `tasks-${p}.json`), 'utf8'));
const f4 = x => (x == null ? '—' : '$' + x.toFixed(x < 0.001 ? 5 : 4));
for (const f of readdirSync(OUT).filter(f => /^ask-.*\.json$/.test(f)).sort()) {
  const j = loadJSON(join(OUT, f));
  const product = j.summary.product;
  const map = maps[product] && loadJSON(maps[product]);
  const ts = tasks(product);
  const rows = j.rows.map(r => ({ ...r, g: map && r.steps ? grade(ts.find(t => t.id === r.id), { answer: r.answer, steps: r.steps }, map) : r.grade }));
  const ok = rows.filter(r => !r.error), ms = ok.map(r => r.ms);
  const cold = ok.filter(r => r.usage.write > 0), warm = ok.filter(r => r.usage.read > 0);
  const kinds = [...new Set(rows.map(r => r.kind))].map(k => { const x = rows.filter(r => r.kind === k); return `${k} ${x.filter(r => r.g.exact).length}/${x.length}`; }).join(', ');
  console.log(`${f.replace(/^ask-|\.json$/g, '').padEnd(44)} n=${rows.length} exact=${rows.filter(r => r.g.exact).length} usable=${rows.filter(r => r.g.usable).length} lang=${rows.filter(r => r.g.langOk !== false).length} invented=${sum(rows.map(r => r.g.invalid || 0))} emptyAnswer=${rows.filter(r => !r.error && !(r.answer || '').trim()).length} errors=${rows.length - ok.length} p50=${(pct(ms, 0.5) / 1000).toFixed(1)}s p95=${(pct(ms, 0.95) / 1000).toFixed(1)}s out=${Math.round(sum(ok.map(r => r.usage.out)) / ok.length)} cold=${f4(cold.length ? sum(cold.map(r => r.cost)) / cold.length : null)} warm=${f4(warm.length ? sum(warm.map(r => r.cost)) / warm.length : null)} | ${kinds}`);
}
for (const f of readdirSync(OUT).filter(f => /^(locate|continue|learn)-.*\.json$/.test(f)).sort()) {
  const j = loadJSON(join(OUT, f));
  console.log(f.replace(/\.json$/, '').padEnd(44), JSON.stringify(j.summary || { cost: j.cost, ms: j.ms, ...j.grade, dupList: undefined, missingForms: undefined }));
}
console.log(`ledger: $${spent().toFixed(3)} spent`);
