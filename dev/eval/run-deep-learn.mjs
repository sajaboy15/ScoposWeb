// Deep learn with real Claude, the way the server and the extension run it (Brain.buildDeepLearn → learnRun →
// finishLearn → buildFaq), and the knowledge it gives: guides with ids, the FAQ index and the facts.
//
//   node dev/eval/run-deep-learn.mjs --map <map.json> [--product "Haulr TMS"] [--docs docs.txt] [--name tms]
//        [--parts N] [--yes]
//
//   without --yes   prints the plan and the cost estimate only (no call)
//   --parts N       sends only the first N parts (a trial); replies are kept in $EVAL_OUT/deep-<name>-part<i>.json,
//                   so a later full run sends only the parts it does not have yet
//   --docs file     vendor workflows (pasted text: titles, summaries or a URL list), passed through Brain.cleanDocs
// Writes $EVAL_OUT/knowledge-<name>.json: { learnedAt, product, summary, guides, faq, stats }.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Brain, run, save, spent, loadJSON, BUDGET, OUT } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const raw = loadJSON(arg('map'));
const map = raw.map || raw;
const product = arg('product', '');
const name = arg('name', 'tms');
const docs = arg('docs') ? readFileSync(arg('docs'), 'utf8') : null;
const bodies = Brain.buildDeepLearn({ map, product, docs });
const est = Brain.learnEstimate(bodies);
console.log(`${map.views.length} views → ${bodies.length} parts, ~${est.guides} guides asked`);
bodies.forEach(b => console.log(`  part ${b.scopos.part}: ${b.scopos.guides} guides · ${b.scopos.focus.join(' ')}`));
console.log(`estimate: ~${est.outputTokens} output tokens, ${est.cachedTokens} cached + ${est.inputTokens} input → ~$${est.usd.toFixed(2)} (${b0(bodies).model})`);
console.log(`spent so far: $${spent().toFixed(3)} of $${BUDGET}`);
if (!process.argv.includes('--yes')) process.exit(0);

function b0(list) { return list[0] || {}; }
const limit = +arg('parts', bodies.length);
const partFile = i => join(OUT, `deep-${name}-part${i + 1}.json`);
let cost = 0;
const usages = [];
const t0 = Date.now();
const outs = await Brain.learnRun(bodies, async (b, i) => {
  if (existsSync(partFile(i))) {
    const s = loadJSON(partFile(i));
    cost += s.cost || 0;
    usages.push({ part: i + 1, ms: s.ms, cost: s.cost, cached: true, out: s.usage && s.usage.output_tokens });
    return s.out;
  }
  const r = await run(b, { tag: `deep-learn-${name}:part${i + 1}`, reserve: 0.35, timeoutMs: 400000 });
  cost += r.cost; usages.push({ part: i + 1, ms: r.ms, cost: r.cost, in: r.usage && r.usage.input_tokens, w: r.usage && r.usage.cache_creation_input_tokens, r: r.usage && r.usage.cache_read_input_tokens, out: r.usage && r.usage.output_tokens });
  console.log(`  part ${i + 1}: ${(r.ms / 1000).toFixed(0)}s $${r.cost.toFixed(3)} out ${r.usage && r.usage.output_tokens} ${r.error ? 'ERROR ' + r.error : (r.out.guides || []).length + ' guides, ' + (r.out.facts || []).length + ' facts'}`);
  if (r.error) throw new Error(r.error);
  save(`deep-${name}-part${i + 1}.json`, { out: r.out, usage: r.usage, cost: r.cost, ms: r.ms });
  return r.out;
}, { concurrency: 3, stop: async i => (i >= limit ? 'not asked (--parts)' : spent() + 0.35 >= BUDGET ? 'budget' : null) });
const ms = Date.now() - t0;
const fin = Brain.finishLearn(outs.filter(o => o && o.out), map);
const guides = fin.guides.map((g, i) => ({ id: 'learned-' + (i + 1), name: g.name, learned: true, live: !!g.live, steps: g.steps, questions: g.questions || [] }));
const faq = Brain.buildFaq(guides, fin.facts);
const stored = guides.map(({ questions, ...g }) => g);
const rawGuides = outs.reduce((n, o) => n + ((o && o.out && o.out.guides) || []).length, 0);
const stats = {
  parts: bodies.length, sent: outs.filter(o => o && o.out).length, skipped: outs.filter(o => o && o.skipped).length, errors: outs.filter(o => o && o.error && !o.skipped).map(o => o.error),
  rawGuides, guides: guides.length, live: guides.filter(g => g.live).length,
  phrasings: faq.filter(f => !f.answer).length, ruPhrasings: faq.filter(f => !f.answer && /[а-яё]/i.test(f.q)).length,
  facts: fin.facts.length, factPhrasings: faq.filter(f => f.answer).length,
  noQuestions: guides.filter(g => !g.questions.length).length,
  estimate: est.usd, cost: +cost.toFixed(4), ms, usages,
};
const knowledge = { learnedAt: new Date().toISOString(), product, summary: fin.summary, guides: stored, faq, stats };
const text = JSON.stringify(knowledge);
stats.bytes = Buffer.byteLength(text); stats.gzip = gzipSync(text).length;
stats.bytesWidget = Buffer.byteLength(JSON.stringify({ guides: stored, faq })); stats.gzipWidget = gzipSync(JSON.stringify({ guides: stored, faq })).length;
save(`knowledge-${name}.json`, knowledge);
console.log(JSON.stringify({ ...stats, usages: undefined }, null, 1));
console.log(`spent so far: $${spent().toFixed(3)} of $${BUDGET}`);
