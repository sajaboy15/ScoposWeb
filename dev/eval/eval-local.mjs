// Instant answers eval: every task goes through the local matcher (Brain.instantMatch) over a learned knowledge
// (guides + FAQ + facts), with no Claude call at all, and the guide it runs is graded by the same grader as ask-map.
//
//   node dev/eval/eval-local.mjs --product tms|ledgerly --map <map.json> --knowledge <knowledge.json> [--extra] [--verbose]
//
//   --knowledge  what dev/eval/run-deep-learn.mjs wrote ({ guides, faq }), or a server .scopos-knowledge.local.json
//   --extra      also tasks-<product>-extra.json (paraphrases, Russian, facts, impossible asks; used while tuning)
//   --holdout    also tasks-<product>-holdout.json (written after tuning, run once: the honest number)
// Per task: guide (ran a guide: graded), fact (answered from the FAQ: graded like a fact answer), suggest (offered
// chips: does one of them grade?), none (goes to Claude). Wrong = answered locally but the grader says no (an
// impossible task answered locally is always wrong). Also a speed test on a synthetic 300 guides × 6 phrasings.
// Results: $EVAL_OUT/local-<product>.json. No Claude call, no spend.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain, save, pct, loadJSON } from './lib.mjs';
import { grade } from './grade.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes('--' + k);
const product = arg('product', 'tms');
const raw = loadJSON(arg('map'));
const map = raw.map || raw;
const K = loadJSON(arg('knowledge'));
const verbose = flag('verbose');
const sets = [['main', `tasks-${product}.json`]];
if (flag('extra') && existsSync(join(HERE, `tasks-${product}-extra.json`))) sets.push(['extra', `tasks-${product}-extra.json`]);
if (flag('holdout') && existsSync(join(HERE, `tasks-${product}-holdout.json`))) sets.push(['hold', `tasks-${product}-holdout.json`]);

const now = () => Number(process.hrtime.bigint()) / 1e6;
let t = now();
const ix = Brain.instantIndex({ guides: K.guides, faq: K.faq || [], product: K.product || '' });
const indexMs = now() - t;
console.log(`${product}: ${K.guides.length} guides, ${(K.faq || []).length} FAQ entries (${ix.facts} facts) → index ${indexMs.toFixed(1)} ms`);

const asOut = m => (m.kind === 'guide'
  ? { answer: '', steps: m.steps.map(s => ({ element_ref: s.ref || null, action: s.action, instruction: s.instruction, value: s.value })) }
  : { answer: m.answer || '', steps: [] });
const rows = [];
for (const [set, file] of sets) {
  const tasks = JSON.parse(readFileSync(join(HERE, file), 'utf8'));
  for (const task of tasks) {
    t = now();
    const m = Brain.instantMatch(ix, task.q);
    const ms = now() - t;
    const local = m.kind === 'guide' || m.kind === 'fact';
    const g = local ? grade(task, asOut(m), map) : null;
    const impossible = task.kind === 'impossible';
    const right = local && !impossible && g.usable;
    const sugHit = m.kind === 'suggest' && !impossible && m.suggest.some(pb => grade(task, asOut({ kind: 'guide', steps: pb.steps }), map).usable);
    const r = {
      set, id: task.id, kind: task.kind, q: task.q, outcome: m.kind, ms: +ms.toFixed(3), score: +(m.score || 0).toFixed(3),
      guide: m.guide ? m.guide.name : null, answer: m.kind === 'fact' ? m.answer : null,
      exact: !!(local && !impossible && g.exact), usable: !!right, wrong: local && !right, langOk: g ? g.langOk : null, why: g && !g.usable ? g.why : '',
      suggest: (m.suggest || []).map(pb => pb.name), sugHit, top: m.top,
      values: m.kind === 'guide' ? m.steps.filter(s => s.value).map(s => `${(s.target && s.target.text) || '?'}=${s.value}`) : [],
    };
    rows.push(r);
    const tag = r.wrong ? 'WRONG ' : r.exact ? 'EXACT ' : r.usable ? 'usable' : m.kind === 'suggest' ? (sugHit ? 'sug+  ' : 'sug-  ') : '-     ';
    console.log(`${tag} ${set.padEnd(5)} ${task.id.padEnd(12)} ${m.kind.padEnd(7)} ${r.score.toFixed(2)} ${r.guide ? '«' + r.guide + '»' : r.answer ? '“' + r.answer.slice(0, 70) + '”' : ''}${r.values.length ? ' {' + r.values.join(', ') + '}' : ''}${r.why ? ' — ' + r.why : ''}${verbose || (m.kind !== 'guide' && m.kind !== 'fact') ? '  top: ' + JSON.stringify(r.top) : ''}`);
  }
}

function summary(list) {
  const n = list.length, answerable = list.filter(r => r.kind !== 'impossible');
  const c = f => list.filter(f).length;
  return {
    n, local: c(r => r.outcome === 'guide' || r.outcome === 'fact'), guide: c(r => r.outcome === 'guide'), fact: c(r => r.outcome === 'fact'),
    exact: c(r => r.exact), usable: c(r => r.usable), wrong: c(r => r.wrong), suggest: c(r => r.outcome === 'suggest'), suggestHit: c(r => r.sugHit), none: c(r => r.outcome === 'none'),
    instantRight: `${(100 * c(r => r.usable) / n).toFixed(0)}%`, wrongShare: `${(100 * c(r => r.wrong) / n).toFixed(1)}%`, toClaude: `${(100 * c(r => !(r.outcome === 'guide' || r.outcome === 'fact')) / n).toFixed(0)}%`,
    answerable: answerable.length, impossibleLocal: c(r => r.kind === 'impossible' && (r.outcome === 'guide' || r.outcome === 'fact')),
    langMismatch: c(r => r.usable && r.langOk === false),
    byKind: Object.fromEntries([...new Set(list.map(r => r.kind))].map(k => { const x = list.filter(r => r.kind === k); return [k, `${x.filter(r => r.usable).length} right / ${x.filter(r => r.wrong).length} wrong / ${x.length}`]; })),
  };
}
const out = { product, guides: K.guides.length, faq: (K.faq || []).length, facts: ix.facts, indexMs: +indexMs.toFixed(2), sets: {} };
for (const [set] of sets) out.sets[set] = summary(rows.filter(r => r.set === set));
out.sets.all = summary(rows);

// ---- speed: 300 guides × 6 phrasings, built from these guides (renamed copies) ----
{
  const base = K.guides, faqBase = K.faq || [];
  const guides = [], faq = [];
  const words = ['quickly', 'today', 'for a new client', 'again', 'in bulk', 'from the list', 'right away'];
  for (let i = 0; guides.length < 300; i++) {
    const g = base[i % base.length], k = Math.floor(i / base.length);
    const id = `s${i}`;
    guides.push({ ...g, id, name: k ? `${g.name} ${words[k % words.length]} ${k}` : g.name });
    const qs = faqBase.filter(f => f.guide === g.id && !f.answer).map(f => f.q);
    for (let j = 0; j < 6; j++) faq.push({ q: (qs[j % Math.max(1, qs.length)] || g.name) + (j ? ` ${words[j % words.length]}` : ''), guide: id, answer: null });
  }
  faq.push(...faqBase.filter(f => f.answer));
  let t0 = now();
  const big = Brain.instantIndex({ guides, faq, product: K.product || '' });
  const build = now() - t0;
  const qs = rows.map(r => r.q);
  // The first questions also pay for compiling the code (cold); after that every match is warm, as in a page that
  // has answered a question or two.
  const cold = [];
  for (const q of qs.slice(0, 5)) { t0 = now(); Brain.instantMatch(big, q); cold.push(now() - t0); }
  for (let rep = 0; rep < 3; rep++) for (const q of qs) Brain.instantMatch(big, q);
  // Per question: the mean of 30 runs (a single run is below the timer's noise on a busy machine).
  const times = [];
  for (const q of qs) { t0 = now(); for (let rep = 0; rep < 30; rep++) Brain.instantMatch(big, q); times.push((now() - t0) / 30); }
  out.speed = { guides: guides.length, phrasings: faq.length, indexMs: +build.toFixed(1), coldFirstMs: +cold[0].toFixed(2), matchAvgMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(3), matchP95Ms: +pct(times, 0.95).toFixed(3), matchMaxMs: +Math.max(...times).toFixed(3) };
}
out.matchMs = { coldAvg: +(rows.reduce((a, r) => a + r.ms, 0) / rows.length).toFixed(3), coldP95: pct(rows.map(r => r.ms), 0.95) };
console.log(JSON.stringify(out, null, 1));
save(`local-${product}.json`, { ...out, rows });
