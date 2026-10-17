// Shared helpers for the model evals in dev/eval: the brain, the key (read here, never printed), per-call cost
// with 1h cache writes and cache reads, a spend ledger with a hard cap, and small stats.
//
// Env:
//   EVAL_OUT     where results and the spend ledger go (default dev/eval/out)
//   EVAL_BUDGET  hard cap in $ across every run that shares the ledger (default 4)
import { createRequire } from 'node:module';
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const Brain = createRequire(import.meta.url)(join(ROOT, 'extension', 'core', 'brain.js'));
export const OUT = process.env.EVAL_OUT || join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
export const BUDGET = +(process.env.EVAL_BUDGET || 4);
const LEDGER = join(OUT, 'spend.jsonl');

// $ per 1M tokens: [input, output, cache read]. A 1h cache write costs 2x input, a 5m write 1.25x.
// Verified against platform.claude.com pricing (2026-10-17): cache reads are 0.05x input for Opus 5.5 and
// Sonnet 5.5 ($0.20 / $0.10), 0.1x for Haiku 5.5 ($0.01). Haiku 5.5 prompts over 100k tokens cost more
// ($0.50 / $2.50); no request here comes near that. Fable 5.1 is not used by brain.js; listed for what-ifs.
export const PRICE = {
  'claude-opus-5-5': [4, 20, 0.20],
  'claude-sonnet-5-5': [2, 10, 0.10],
  'claude-haiku-5-5': [0.10, 0.50, 0.01],
  'claude-fable-5-1': [10, 50, 0.25],
};
export function costOf(u, model) {
  const [pi, po, pr] = PRICE[model];
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens != null ? cc.ephemeral_1h_input_tokens : (u.cache_creation_input_tokens || 0);
  const w5m = cc.ephemeral_5m_input_tokens || 0;
  return ((u.input_tokens || 0) * pi + w1h * pi * 2 + w5m * pi * 1.25 + (u.cache_read_input_tokens || 0) * pr + (u.output_tokens || 0) * po) / 1e6;
}

export function spent() {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).reduce((n, l) => n + (JSON.parse(l).cost || 0), 0);
}

let KEY = null;
function key() {
  if (KEY == null) KEY = (process.env.ANTHROPIC_API_KEY || readFileSync(join(ROOT, '.scopos-key.local'), 'utf8')).trim();
  return KEY;
}

/** Overrides the model and effort of a brain body. Haiku has no server-side fallback. */
export function withModel(body, model, effort) {
  const b = JSON.parse(JSON.stringify(body));
  if (model) b.model = model;
  if (effort) b.output_config.effort = effort;
  if (/haiku/.test(b.model)) delete b.fallbacks;
  else if (!b.fallbacks) b.fallbacks = 'default';
  return b;
}

/**
 * One real call. Refuses when the ledger already reached the budget (or would with `reserve` more).
 * Returns { out, usage, cost, ms, error }.
 */
export async function run(body, { tag = '', reserve = 0, timeoutMs } = {}) {
  const before = spent();
  if (before + reserve >= BUDGET) throw Object.assign(new Error(`budget: $${before.toFixed(3)} spent of $${BUDGET}`), { budget: true });
  let usage = null;
  const t0 = Date.now();
  let out = null, error = null;
  try {
    out = await Brain.call(body, key(), { fromBrowser: false, timeoutMs: timeoutMs || (/opus|fable/.test(body.model) ? 300000 : 120000), onUsage: u => { usage = u; } });
  } catch (e) { error = e.message; }
  const ms = Date.now() - t0;
  const cost = usage ? costOf(usage, body.model) : 0;
  appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), tag, model: body.model, cost, usage }) + '\n');
  return { out, usage, cost, ms, error };
}

export const pct = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
export const sum = a => a.reduce((n, x) => n + x, 0);
export const save = (name, data) => writeFileSync(join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 1));
export const loadJSON = p => JSON.parse(readFileSync(p, 'utf8'));
