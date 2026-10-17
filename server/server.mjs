// Scopos server: the vendor-side half of the SDK, plus the demo app.
//
//   ANTHROPIC_API_KEY=sk-ant-... node server/server.mjs      -> http://localhost:4173
//
// Public (same-origin only, JSON only, rate-limited, daily budget):
//   POST /api/scopos  { question, page, history }               -> { answer, steps, source }
//                     { locate: { instruction, oldText }, page, candidates } -> { element_id }
//   GET  /api/scopos/knowledge  learned guides for the widget; questions are then answered from the whole map
//   GET  /scopos.js   the SDK bundle (built in memory, rebuilt when a source file changes)
//   GET  /            the demo app (Ledgerly)
// Every route: the Host header must be localhost:PORT, 127.0.0.1:PORT, [::1]:PORT or one listed in SCOPOS_HOSTS /
// SCOPOS_ORIGINS (DNS rebinding); anything else gets 403. HTML is never frameable (X-Frame-Options, frame-ancestors).
// This machine only (Host must be localhost:PORT, no proxy headers):
//   GET  /dev/*, /extension/sidepanel/*   dev pages, e.g. /dev/panel-preview.html (the side panel with a stubbed chrome API)
//   GET  /setup       paste the Claude key in a browser instead of an env var (saved to .scopos-key.local)
//   *    /api/key     key status, save, test, delete
//   POST /api/scopos/learn   { map } from the explorer -> guides written by Claude
//                            (also allowed with header x-scopos-learn-token = SCOPOS_LEARN_TOKEN)
//   GET  /api/scopos/stats   token usage, cache hits, today's budget, this month's spend { month: { spent, cap } }
//   GET  /api/ext/status     { disk: {version, sig}, loaded: {version, sig, id, seenAt} | null, upToDate, recent }
// The Chrome extension, from this machine only (loopback + local Host + no proxy + Origin chrome-extension://<id>):
//   POST /api/claude         a Messages API request built by brain.js, forwarded with this server's key and streamed
//                            back unchanged (SSE), so the extension needs no key of its own. Validated: model is one
//                            of Brain.MODELS, max_tokens <= 32000, no tools / mcp_servers / container, body < 1.5 MB.
//   GET  /api/ext/version    { version, sig, files, changedAt, claude }: what is on disk under extension/ (see extSig);
//                            claude = this server has a key, so /api/claude can answer
//   POST /api/ext/hello      { version, sig, id, headless }: what Chrome has loaded (core/update.js, every minute);
//                            a headless Chrome (test harness) never counts as "loaded", it only shows in status.recent
// Safety-test counters (same origin, no key): POST /api/tms/write, GET /api/tms/writes, POST /api/tms/writes/reset,
//   and the same under /api/demo/ for Ledgerly.
//
// Env: PORT, ANTHROPIC_API_KEY, SCOPOS_DAILY_LIMIT (default 2000 model calls a day), SCOPOS_LEARN_TOKEN,
//      SCOPOS_ORIGINS (extra allowed origins, comma-separated; their hosts are allowed too), SCOPOS_HOSTS (extra
//      allowed Host headers, e.g. app.example.com), SCOPOS_TRUST_PROXY=1 (rate-limit by the rightmost X-Forwarded-For),
//      SCOPOS_MONTHLY_USD (default 5: every Claude call stops once this month's estimated spend reaches it; counted
//      in .scopos-usage.local.json), SCOPOS_EXT_IDS (comma-separated extension ids allowed on /api/claude; unset = any
//      extension on this machine, logged), SCOPOS_UPSTREAM and SCOPOS_USAGE_FILE (tests only: where /api/claude
//      forwards to, where the month is counted).
//
// The key stays on this server; browsers only ever talk to /api/scopos, the extension to /api/claude.
// No dependencies beyond Node 20+.
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { timingSafeEqual, createHash } from 'node:crypto';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, signature } from '../sdk/build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Brain = createRequire(import.meta.url)('../extension/core/brain.js');
const PORT = +process.env.PORT || 4173;
const KEY_FILE = join(root, '.scopos-key.local');
const KNOWLEDGE_FILE = join(root, '.scopos-knowledge.local.json');
const ANSWERS_FILE = join(root, '.scopos-answers.local.json');
const USAGE_FILE = process.env.SCOPOS_USAGE_FILE || join(root, '.scopos-usage.local.json'); // the env override is for tests
const DAILY_LIMIT = +process.env.SCOPOS_DAILY_LIMIT || 2000;
const MONTHLY_USD = (v => (v !== '' && Number.isFinite(+v) && +v >= 0 ? +v : 5))(String(process.env.SCOPOS_MONTHLY_USD ?? '').trim());
const TRUST_PROXY = process.env.SCOPOS_TRUST_PROXY === '1';
const LEARN_TOKEN = process.env.SCOPOS_LEARN_TOKEN || '';
const EXTRA_ORIGINS = new Set((process.env.SCOPOS_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean));
let knowledge = (() => { try { return JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf8')); } catch (e) { return null; } })();
let KEY = process.env.ANTHROPIC_API_KEY || (() => { try { return readFileSync(KEY_FILE, 'utf8').trim(); } catch (e) { return ''; } })();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function json(res, code, data) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('too large'); chunks.push(c); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  return body;
}

// ---------- who is asking ----------
// Hosts and origins come from a fixed list, never from the request: a DNS-rebinding page reaches this server
// with Host: evil.example:PORT and Origin: http://evil.example:PORT, and both are refused.
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const hostOf = o => { try { return new URL(o).host.toLowerCase(); } catch (e) { return ''; } };
const HOSTS = new Set([
  ...LOCAL_HOSTS,
  ...(process.env.SCOPOS_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  ...[...EXTRA_ORIGINS].map(hostOf).filter(Boolean),
]);
const ORIGINS = new Set([...[...HOSTS].flatMap(h => [`http://${h}`, `https://${h}`]), ...EXTRA_ORIGINS]);
const hostOk = req => HOSTS.has(String(req.headers.host || '').toLowerCase());
const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
// Behind a reverse proxy or a tunnel every request comes from 127.0.0.1, so the socket address proves nothing there.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server', 'forwarded', 'x-real-ip', 'via',
  'cf-connecting-ip', 'cf-ray', 'true-client-ip', 'x-client-ip', 'fastly-client-ip', 'x-cluster-client-ip', 'x-original-forwarded-for', 'forwarded-for'];
const proxied = req => PROXY_HEADERS.some(h => req.headers[h] != null);
// Admin routes: this machine, addressed by its loopback name (defeats DNS rebinding), not through a proxy.
const localAdmin = req => loopback(req) && !proxied(req) && LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase());
/** Browsers send Origin on POST; it must be this server (or a configured one). No Origin = not a browser page. */
function originOk(req, adminOnly = false) {
  const o = req.headers.origin;
  if (!o) return true;
  if (adminOnly) return [...LOCAL_HOSTS].some(h => o === `http://${h}`);
  return ORIGINS.has(o);
}
const isJson = req => /^application\/json\b/i.test(req.headers['content-type'] || '');
function tokenOk(req) {
  if (!LEARN_TOKEN) return false;
  const a = Buffer.from(String(req.headers['x-scopos-learn-token'] || '')), b = Buffer.from(LEARN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- spend limits ----------
// Per-IP: 12 model calls a minute. The map is pruned every minute and capped (oldest entry evicted), so rotating
// addresses can neither grow it nor lock everyone else out.
const hits = new Map();
// Behind your own proxy (SCOPOS_TRUST_PROXY=1), the RIGHTMOST X-Forwarded-For entry is the one that proxy appended;
// everything to its left is whatever the client sent.
const clientIp = req => {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    const list = String(req.headers['x-forwarded-for']).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) return list[list.length - 1];
  }
  return req.socket.remoteAddress || '?';
};
function allowed(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60_000);
  if (list.length >= 12) { hits.delete(ip); hits.set(ip, list); return false; }
  if (!hits.has(ip)) while (hits.size >= 20_000) hits.delete(hits.keys().next().value);
  list.push(now);
  hits.delete(ip); hits.set(ip, list); // re-insert: Map order = least recently seen first
  return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, list] of hits) { const keep = list.filter(t => now - t < 60_000); if (keep.length) hits.set(ip, keep); else hits.delete(ip); } }, 60_000).unref();
// Global: SCOPOS_DAILY_LIMIT model calls a day for everyone together.
const day = { date: '', calls: 0 };
function budgetLeft() {
  const d = new Date().toISOString().slice(0, 10);
  if (day.date !== d) { day.date = d; day.calls = 0; }
  return day.calls < DAILY_LIMIT;
}
// Monthly: SCOPOS_MONTHLY_USD of estimated spend per calendar month (local time), kept across restarts in
// .scopos-usage.local.json as { months: { "2026-10": { spent, calls } } } (the last 12 months).
// Checked before every Claude call; cached answers and learned guides never reach this.
const monthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const usageBook = (() => {
  try { const u = JSON.parse(readFileSync(USAGE_FILE, 'utf8')); if (u && u.months && typeof u.months === 'object') return u; } catch (e) { /* none yet */ }
  return { months: {} };
})();
function monthNow() {
  const k = monthKey();
  const m = usageBook.months[k];
  if (m && Number.isFinite(m.spent)) return m;
  return (usageBook.months[k] = { spent: 0, calls: 0 });
}
const monthLeft = () => monthNow().spent < MONTHLY_USD;
const BUDGET_MSG = `Месячный бюджет на Claude ($${MONTHLY_USD}) исчерпан. Готовые гайды и сохранённые ответы работают. Лимит: SCOPOS_MONTHLY_USD.`;
let usageTimer = 0;
function persistUsage() {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(() => {
    const keys = Object.keys(usageBook.months).sort();
    for (const k of keys.slice(0, -12)) delete usageBook.months[k];
    writeFile(USAGE_FILE, JSON.stringify(usageBook)).catch(e => console.warn('[scopos] usage not saved:', e.message));
  }, 1000);
}

// ---------- usage and cost, logged per call ----------
const PRICE = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] }; // $ per 1M tokens
const stats = { since: new Date().toISOString(), calls: 0, cacheHits: 0, guideHits: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, byKind: {} };
function usageLogger(kind) {
  return (u, model) => {
    if (!u) return;
    const [pi, po] = PRICE[model] || PRICE['claude-opus-5-5'];
    const cost = ((u.input_tokens || 0) * pi + (u.cache_creation_input_tokens || 0) * pi * 2 + (u.cache_read_input_tokens || 0) * pi * 0.1 + (u.output_tokens || 0) * po) / 1e6;
    stats.calls++;
    stats.tokens.input += u.input_tokens || 0; stats.tokens.output += u.output_tokens || 0;
    stats.tokens.cacheRead += u.cache_read_input_tokens || 0; stats.tokens.cacheWrite += u.cache_creation_input_tokens || 0;
    stats.cost += cost;
    const k = (stats.byKind[kind] = stats.byKind[kind] || { calls: 0, cost: 0 });
    k.calls++; k.cost += cost;
    const m = monthNow();
    m.spent = +(m.spent + cost).toFixed(6); m.calls = (m.calls || 0) + 1;
    persistUsage();
    console.log(`[scopos] ${kind} · ${model} · in ${u.input_tokens || 0} · out ${u.output_tokens || 0} · cache read ${u.cache_read_input_tokens || 0} · cache write ${u.cache_creation_input_tokens || 0} · ~$${cost.toFixed(4)}`);
  };
}

// ---------- shared answer cache: one vendor, many users asking the same things ----------
const ANSWERS_MAX = 200, ANSWER_TTL = 7 * 24 * 3600 * 1000;
const answers = new Map(); // key -> { answer, steps, at }; insertion order = least recently used first
try {
  const saved = JSON.parse(readFileSync(ANSWERS_FILE, 'utf8'));
  if (knowledge && saved.learnedAt === knowledge.learnedAt) for (const [k, v] of saved.entries || []) answers.set(k, v);
} catch (e) { /* none yet */ }
let persistTimer = 0;
function persistAnswers() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    writeFile(ANSWERS_FILE, JSON.stringify({ learnedAt: knowledge && knowledge.learnedAt, entries: [...answers] })).catch(e => console.warn('[scopos] answer cache not saved:', e.message));
  }, 2000);
}
function cacheGet(k) {
  const v = answers.get(k);
  if (!v) return null;
  answers.delete(k);
  if (Date.now() - v.at > ANSWER_TTL) { persistAnswers(); return null; }
  answers.set(k, v);
  return v;
}
function cachePut(k, v) {
  answers.delete(k);
  answers.set(k, { ...v, at: Date.now() });
  while (answers.size > ANSWERS_MAX) answers.delete(answers.keys().next().value);
  persistAnswers();
}
function pathTemplate(url) {
  try {
    const u = new URL(url);
    const fix = s => s.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,})(?=\/|$|\?)/gi, '/:id');
    return fix(u.pathname) + (u.hash && u.hash !== '#' && u.hash !== '#/' ? fix(u.hash) : '');
  } catch (e) { return ''; }
}

// ---------- input caps ----------
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
function cleanPage(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.lines)) return null;
  return {
    title: str(p.title, 200),
    url: str(p.url, 500),
    headings: Array.isArray(p.headings) ? p.headings.filter(h => typeof h === 'string').slice(0, 12).map(h => h.slice(0, 80)) : [],
    lines: p.lines.filter(l => typeof l === 'string').slice(0, 300).map(l => l.slice(0, 200)),
  };
}
const cleanHistory = h => (Array.isArray(h) ? h.filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string').slice(-6).map(t => ({ role: t.role, content: t.content.slice(0, 1200) })) : []);
function cleanDescriptor(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { sel: [], text: '', role: null };
  const s = JSON.stringify(d);
  return s.length <= 4000 ? JSON.parse(s) : { sel: Array.isArray(d.sel) ? d.sel.filter(x => typeof x === 'string').slice(0, 4).map(x => x.slice(0, 300)) : [], text: str(d.text, 80), role: str(d.role, 30) || null, path: str(d.path, 300) };
}
/** A product map from the explorer, capped: ≤100 views (40 pages + 60 dialogs/panels), ≤150 controls each, every string bounded. */
function cleanMap(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.views) || !m.views.length || m.views.length > 400) return null;
  const views = [];
  for (const v of m.views) {
    if (!v || typeof v.id !== 'string' || !Array.isArray(v.controls) || v.controls.length > 250) return null;
    views.push({
      id: v.id.slice(0, 12), key: str(v.key, 300), url: str(v.url, 500),
      kind: ['page', 'dialog', 'panel'].includes(v.kind) ? v.kind : 'page',
      parent: typeof v.parent === 'string' ? v.parent.slice(0, 12) : undefined,
      opener: typeof v.opener === 'string' ? v.opener.slice(0, 16) : undefined,
      title: str(v.title, 120), form: v.form === true || undefined,
      headings: Array.isArray(v.headings) ? v.headings.filter(h => typeof h === 'string').slice(0, 8).map(h => h.slice(0, 80)) : [],
      // Short static text of the screen; Brain.mapText checks it for personal data again when it renders it.
      facts: Array.isArray(v.facts) ? v.facts.filter(f => typeof f === 'string').slice(0, 12).map(f => f.slice(0, 80)) : undefined,
      controls: v.controls.filter(c => c && typeof c.ref === 'string').map(c => ({
        ref: c.ref.slice(0, 16), role: str(c.role, 30), name: str(c.name, 120),
        section: str(c.section, 80) || undefined, state: str(c.state, 80) || undefined,
        options: Array.isArray(c.options) ? c.options.filter(o => typeof o === 'string').slice(0, 30).map(o => o.slice(0, 80)) : undefined,
        d: cleanDescriptor(c.d),
        to: typeof c.to === 'string' ? c.to.slice(0, 12) : undefined,
        // How a task ends (commit) and where the map stops (an opener the explorer did not press).
        commit: c.commit === true || undefined, unexplored: c.unexplored === true || undefined,
        row: c.row === true || undefined, rowLabel: str(c.rowLabel, 80) || undefined,
      })),
    });
  }
  return { origin: str(m.origin, 200), status: str(m.status, 20), probes: Math.max(0, +m.probes || 0), views };
}

/** An AbortSignal that fires when the browser goes away, so nobody pays for an answer no one reads. */
function clientGone(res) {
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  return ctl.signal;
}

/**
 * Replies to /api/scopos. A client that accepts application/x-ndjson gets progress lines while Claude
 * writes ({type:'progress', chars, steps}) and then one {type:'result'} or {type:'error'} line, so the
 * widget can show "Пишу шаги…". Everyone else gets one plain JSON reply.
 */
function responder(req, res) {
  const stream = /application\/x-ndjson/i.test(req.headers.accept || '');
  let started = false, last = 0;
  return {
    onText(text) {
      if (!stream || res.writableEnded) return;
      const now = Date.now();
      if (now - last < 250) return;
      last = now;
      if (!started) { res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); started = true; }
      res.write(JSON.stringify({ type: 'progress', chars: text.length, steps: (text.match(/"instruction"\s*:\s*"(?:[^"\\]|\\.)*"/g) || []).length }) + '\n');
    },
    send(code, data) {
      if (res.writableEnded) return;
      if (started) res.end(JSON.stringify(code >= 400 ? { type: 'error', ...data } : { type: 'result', ...data }) + '\n');
      else json(res, code, data);
    },
  };
}

// ---------- POST /api/scopos ----------
async function api(req, res) {
  let body;
  try { body = await readBody(req, 200_000); } catch (e) { return json(res, 400, { error: 'Неверный запрос' }); }
  const page = cleanPage(body.page);
  if (!page) return json(res, 400, { error: 'Нет карты страницы' });
  if (!KEY) return json(res, 503, { error: 'Ключ Claude ещё не подключён: откройте /setup. Сценарии работают и без него.' });

  const signal = clientGone(res);
  const r = responder(req, res);
  const spend = () => {
    if (!monthLeft()) return BUDGET_MSG;
    if (!budgetLeft()) return 'На сегодня лимит вопросов исчерпан. Готовые гайды работают как обычно.';
    if (!allowed(clientIp(req))) return 'Слишком много вопросов подряд. Подождите минуту.';
    day.calls++;
    return null;
  };
  try {
    if (body.locate && typeof body.locate === 'object') {
      const why = spend();
      if (why) return json(res, 429, { error: why });
      const candidates = Array.isArray(body.candidates) ? body.candidates.filter(Number.isInteger).slice(0, 8) : [];
      const out = await Brain.call(Brain.buildLocate({ instruction: str(body.locate.instruction, 200), oldText: str(body.locate.oldText, 80), page, candidates }), KEY, { fromBrowser: false, signal, onUsage: usageLogger('locate') });
      return json(res, 200, { element_id: Number.isInteger(out.element_id) ? out.element_id : null });
    }
    const question = str(body.question, 600).trim();
    if (!question) return json(res, 400, { error: 'Пустой вопрос' });
    const history = cleanHistory(body.history);
    const progress = Array.isArray(body.progress) ? body.progress.filter(p => typeof p === 'string').slice(0, 20).map(p => p.slice(0, 200)) : [];

    // With a learned map, plan across every screen at once; the steps come back ready to run.
    if (knowledge && knowledge.map && !progress.length) {
      const map = knowledge.map;
      const current = Brain.viewOf(map, page.url);
      // Shared between all users, so only a question without a conversation is cached or served from cache:
      // a crafted history (a fake assistant turn) must never shape an answer that other people then receive.
      const cacheable = !history.length;
      const k = [Brain.norm(question), current || pathTemplate(page.url), knowledge.learnedAt].join('|');
      if (cacheable) {
        const hit = cacheGet(k);
        if (hit) { stats.cacheHits++; return json(res, 200, { answer: hit.answer, steps: hit.steps, ready: true, source: 'cache' }); }
      }
      const why = spend();
      if (why) return json(res, 429, { error: why });
      // The product name is pinned at learn time: a client can't change the cached prefix or the prompt.
      const out = await Brain.call(Brain.buildAskMap({ question, map, current, history, product: knowledge.product || '' }), KEY, { fromBrowser: false, signal, onText: r.onText, onUsage: usageLogger('ask-map') });
      const steps = Brain.refSteps(out.steps || [], map, question);
      const answer = String(out.answer || '').slice(0, 600);
      if (cacheable) cachePut(k, { answer, steps });
      return r.send(200, { answer, steps, ready: true, source: 'map' });
    }
    const why = spend();
    if (why) return json(res, 429, { error: why });
    const out = await Brain.call(Brain.buildAsk({ question, page, history, progress, product: (knowledge && knowledge.product) || '' }), KEY, { fromBrowser: false, signal, onText: r.onText, onUsage: usageLogger(progress.length ? 'replan' : 'ask') });
    const steps = (out.steps || []).map(s => ({ ...s, value: Brain.safeValue(s.value, question, null) }));
    return r.send(200, { answer: String(out.answer || '').slice(0, 600), steps, source: 'claude' });
  } catch (e) {
    if (signal.aborted) return;
    return r.send(502, { error: e.message || 'Claude не ответил' });
  }
}

// ---------- POST /api/scopos/learn ----------
let learning = false;
// Model output to runnable guides: finishGuides drops only the bad steps (not the whole guide), appends the
// commit a form needs and flags guides that continue live where the map stops.
function learnedGuides(raw, map) {
  if (typeof Brain.finishGuides === 'function') {
    const guides = Brain.finishGuides({ guides: raw }, map).map((g, i) => ({ id: 'learned-' + (i + 1), name: String(g.name).slice(0, 90), learned: true, live: !!g.live, steps: g.steps }));
    return { guides, dropped: raw.length - guides.length };
  }
  return learnedGuidesOld({ guides: raw }, map);
}
function learnedGuidesOld(out, map) {
  const refs = new Set();
  map.views.forEach(v => v.controls.forEach(c => refs.add(c.ref)));
  const all = Array.isArray(out.guides) ? out.guides : [];
  // Every referenced control must exist in the map, and a guide needs at least one pointer.
  const guides = all
    .filter(g => g && typeof g.name === 'string' && Array.isArray(g.steps) && g.steps.length && g.steps.every(s => !s.element_ref || refs.has(s.element_ref)))
    .map((g, i) => ({ id: 'learned-' + (i + 1), name: g.name.slice(0, 90), learned: true, steps: Brain.refSteps(g.steps, map, g.name) }))
    .filter(g => g.steps.some(s => s.target));
  return { guides, dropped: all.length - guides.length };
}

async function learnApi(req, res) {
  if (!(localAdmin(req) && originOk(req, true)) && !tokenOk(req)) return json(res, 403, { error: 'Изучать продукт можно только с этого компьютера или с токеном изучения.' });
  let body;
  try { body = await readBody(req, 8_000_000); } catch (e) { return json(res, 400, { error: 'Неверный запрос' }); }
  if (body.check) return json(res, 200, { ok: true, key: !!KEY });
  if (!KEY) return json(res, 503, { error: 'Сначала подключите ключ на /setup' });
  const map = cleanMap(body.map);
  if (!map) return json(res, 400, { error: 'Нет карты продукта или она слишком большая (до 400 экранов и 250 элементов на экране).' });
  if (learning) return json(res, 409, { error: 'Уже пишу гайды по другой карте. Подождите минуту.' });
  if (!monthLeft()) return json(res, 429, { error: BUDGET_MSG });
  learning = true;
  const product = str(body.product, 120);
  const signal = clientGone(res);
  let lastLog = 0;
  try {
    // A big product is written in parts (related screens together); each part sees the names already written.
    const bodies = typeof Brain.buildLearnBatches === 'function' ? null : [Brain.buildLearn({ map, product })];
    const raw = [];
    let summary = '';
    const total = bodies ? 1 : Brain.buildLearnBatches({ map, product }).length;
    for (let i = 0; i < total; i++) {
      if (i > 0 && !monthLeft()) { console.log('[scopos] месячный бюджет кончился: остальные части не пишу'); break; }
      const b = bodies ? bodies[0] : Brain.buildLearnBatches({ map, product, existing: raw.map(g => g.name) })[i];
      if (!b) break;
      const out = await Brain.call(b, KEY, {
        fromBrowser: false, signal, onUsage: usageLogger('learn'),
        onText: t => { const now = Date.now(); if (now - lastLog > 5000) { lastLog = now; console.log(`[scopos] Claude пишет гайды · часть ${i + 1} из ${total} · ${t.length} символов`); } },
      });
      if (!summary) summary = String(out.summary || '');
      if (Array.isArray(out.guides)) raw.push(...out.guides.filter(g => g && typeof g.name === 'string' && Array.isArray(g.steps)));
    }
    const { guides, dropped } = learnedGuides(raw, map);
    knowledge = { learnedAt: new Date().toISOString(), product, summary: summary.slice(0, 300), map, guides };
    await writeFile(KNOWLEDGE_FILE, JSON.stringify(knowledge));
    answers.clear(); persistAnswers(); // answers were tied to the old map
    console.log(`[scopos] изучено: ${map.views.length} экранов, ${guides.length} гайдов${dropped ? `, ${dropped} отброшено` : ''}`);
    return json(res, 200, { summary: knowledge.summary, guides, views: map.views.length, dropped, learnedAt: knowledge.learnedAt });
  } catch (e) {
    if (signal.aborted) return;
    return json(res, 502, { error: e.message || 'Claude не ответил' });
  } finally { learning = false; }
}

// The folder to pick in chrome://extensions. When this server runs inside a packaged (MSIX) app, AppData\Roaming
// is redirected into the package's LocalCache, and Chrome only sees that real location.
function extensionPath() {
  const p = join(root, 'extension');
  const m = p.match(/^(.*[\\/]AppData[\\/])Roaming[\\/](.*)$/i);
  if (!m) return p;
  try {
    for (const pkg of readdirSync(join(m[1], 'Local', 'Packages'))) {
      const real = join(m[1], 'Local', 'Packages', pkg, 'LocalCache', 'Roaming', m[2]);
      if (existsSync(join(real, 'manifest.json'))) return real;
    }
  } catch (e) { /* not Windows or no packages folder */ }
  return p;
}

// ---------- /api/key (admin) ----------
async function keyApi(req, res) {
  if (req.method === 'GET') return json(res, 200, { set: !!KEY, last4: KEY ? KEY.slice(-4) : null, fromEnv: !!process.env.ANTHROPIC_API_KEY, extensionPath: extensionPath() });
  if (req.method === 'DELETE') { KEY = ''; await rm(KEY_FILE, { force: true }); return json(res, 200, { set: false }); }
  if (req.method !== 'POST') return json(res, 405, { error: 'Метод не поддерживается' });
  let body;
  try { body = await readBody(req, 10_000); } catch (e) { return json(res, 400, { error: 'Неверный запрос' }); }
  if (body.test) {
    if (!KEY) return json(res, 400, { error: 'Сначала сохраните ключ' });
    if (!monthLeft()) return json(res, 200, { ok: false, error: BUDGET_MSG });
    try {
      await Brain.call(Brain.buildLocate({ instruction: 'нажмите «Сохранить»', oldText: 'Сохранить', page: { title: 'проверка', url: 'http://localhost', headings: [], lines: ['[1] button "Сохранить"'] } }), KEY, { fromBrowser: false, timeoutMs: 30000, onUsage: usageLogger('key-test') });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  const key = String(body.key || '').trim();
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) return json(res, 400, { error: 'Ключ должен начинаться с sk-ant-' });
  KEY = key;
  await writeFile(KEY_FILE, key, { mode: 0o600 });
  return json(res, 200, { set: true, last4: key.slice(-4) });
}

// ---------- the Chrome extension: who it is ----------
// A web page can neither send Origin: chrome-extension://… nor a custom header without a CORS preflight, and the
// preflight is answered for extension origins only. Together with localAdmin (loopback, local Host, no proxy), only
// an extension running in a browser on this machine (or a process on it, which could read the key file anyway) gets in.
const EXT_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
const EXT_IDS = new Set((process.env.SCOPOS_EXT_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const extSeen = new Set();
const extPinned = id => !EXT_IDS.size || EXT_IDS.has(id);
/** The calling extension's id, or null. Origin, when sent, must be chrome-extension://<id> (and match x-scopos-ext if
 *  that is sent too); without an Origin the x-scopos-ext header must carry the id. */
function extCaller(req) {
  const o = req.headers.origin, h = req.headers['x-scopos-ext'];
  let id;
  if (o != null) {
    const m = EXT_ORIGIN.exec(String(o));
    if (!m || (h != null && String(h) !== m[1])) return null;
    id = m[1];
  } else {
    if (h == null || !/^[a-p]{32}$/.test(String(h))) return null;
    id = String(h);
  }
  if (!extPinned(id)) return null;
  if (!EXT_IDS.size && !extSeen.has(id)) { extSeen.add(id); console.log(`[scopos] расширение ${id} подключилось (закрепить: SCOPOS_EXT_IDS=${id})`); }
  return id;
}
/** CORS for extension origins only (pinned ones, when SCOPOS_EXT_IDS is set); every other origin gets no CORS header. */
function extCors(req, res) {
  const m = EXT_ORIGIN.exec(String(req.headers.origin || ''));
  res.setHeader('vary', 'origin');
  if (!m || !extPinned(m[1])) return false;
  res.setHeader('access-control-allow-origin', m[0]);
  return true;
}
function extPreflight(req, res) {
  if (!localAdmin(req) || !extCors(req, res)) { res.writeHead(403); return res.end(); }
  const h = { 'access-control-allow-methods': 'GET, POST', 'access-control-max-age': '600',
    'access-control-allow-headers': 'content-type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-scopos-ext' };
  if (req.headers['access-control-request-private-network']) h['access-control-allow-private-network'] = 'true';
  res.writeHead(204, h);
  res.end();
}

// ---------- POST /api/claude: the extension's Claude calls, with this server's key ----------
const UPSTREAM = process.env.SCOPOS_UPSTREAM || Brain.API_URL;
const PROXY_MODELS = new Set(Object.values(Brain.MODELS));
const PROXY_BETA = Brain.headers('', false, true)['anthropic-beta']; // the refusal-fallback beta brain.js sends; nothing else
const PROXY_MAX_BYTES = 1_500_000;
const extCalls = []; // timestamps: 60 calls a minute for the extension, against runaway loops
// Errors in the Messages API shape, so brain.js shows error.message (it is not retried except for 429).
const apiErr = (res, code, type, message) => json(res, code, { type: 'error', error: { type, message } });

async function readRaw(req, limit) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('too large'), { tooLarge: true }); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
function proxyBodyError(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'Тело запроса должно быть объектом';
  if (!PROXY_MODELS.has(b.model)) return 'Модель не разрешена';
  if (!Number.isInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > 32000) return 'max_tokens должен быть от 1 до 32000';
  for (const k of ['tools', 'mcp_servers', 'container']) if (k in b) return `Поле ${k} не разрешено`;
  if (!Array.isArray(b.messages) || !b.messages.length) return 'Нет messages';
  return null;
}

async function claudeProxy(req, res) {
  let body;
  try { body = JSON.parse(await readRaw(req, PROXY_MAX_BYTES)); } catch (e) {
    if (!e.tooLarge) return apiErr(res, 400, 'invalid_request_error', 'Неверный JSON');
    res.setHeader('connection', 'close'); // the rest of the body is never read: this socket can't carry another request
    apiErr(res, 413, 'request_too_large', 'Запрос больше 1,5 МБ');
    return res.on('finish', () => req.destroy());
  }
  const bad = proxyBodyError(body);
  if (bad) return apiErr(res, 400, 'invalid_request_error', bad);
  const beta = req.headers['anthropic-beta'];
  if (beta != null && !String(beta).split(',').map(s => s.trim()).filter(Boolean).every(v => v === PROXY_BETA)) return apiErr(res, 400, 'invalid_request_error', 'Этот anthropic-beta не разрешён');
  if (!KEY) return apiErr(res, 412, 'no_key', 'Ключ Claude ещё не подключён: откройте http://localhost:' + PORT + '/setup');
  if (!monthLeft()) return apiErr(res, 402, 'budget_exceeded', BUDGET_MSG);
  if (!budgetLeft()) return apiErr(res, 402, 'daily_limit', 'На сегодня лимит вызовов Claude исчерпан. Готовые гайды работают как обычно.');
  const now = Date.now();
  while (extCalls.length && now - extCalls[0] > 60_000) extCalls.shift();
  if (extCalls.length >= 60) return json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Слишком много вызовов подряд. Подождите минуту.' } });
  extCalls.push(now);
  day.calls++;

  const headers = { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' };
  // brain.js sends no headers at all in proxy mode, so a body that asks for refusal fallbacks gets the beta here.
  if (beta != null || body.fallbacks != null) headers['anthropic-beta'] = PROXY_BETA;
  const gone = clientGone(res);
  const signal = AbortSignal.any([gone, AbortSignal.timeout(300_000)]);
  const usage = {};
  let up;
  try {
    up = await fetch(UPSTREAM, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (gone.aborted) return;
    return apiErr(res, 502, 'upstream_error', 'Нет связи с Claude API. Проверьте интернет.');
  }
  const type = up.headers.get('content-type') || 'application/json';
  const out = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  for (const h of ['retry-after', 'request-id']) { const v = up.headers.get(h); if (v) out[h] = v; }
  res.writeHead(up.status, out);
  if (res.flushHeaders) res.flushHeaders();
  const sse = up.ok && /text\/event-stream/i.test(type);
  const dec = new TextDecoder();
  let buf = '', whole = '';
  try {
    for await (const chunk of up.body) {
      res.write(chunk);
      if (!up.ok) continue;
      const text = dec.decode(chunk, { stream: true });
      if (!sse) { if (whole.length < 4_000_000) whole += text; continue; }
      buf += text.replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch (e) { continue; }
        if (ev.type === 'message_start' && ev.message && ev.message.usage) Object.assign(usage, ev.message.usage);
        else if (ev.type === 'message_delta' && ev.usage) Object.assign(usage, ev.usage);
      }
    }
    if (up.ok && !sse) { try { Object.assign(usage, JSON.parse(whole).usage || {}); } catch (e) { /* not JSON */ } }
    res.end();
  } catch (e) {
    res.destroy(); // the browser left or the upstream broke mid-stream: brain.js sees a cut stream
  } finally {
    // Whatever was used is billed, also when the stream was cut short.
    if (Object.keys(usage).length) usageLogger('extension')(usage, body.model);
  }
}

// ---------- GET /api/ext/version: the extension on disk ----------
// sig = first 16 hex of SHA-256 over "<path>\n<sha256 hex of the file>\n" for every file under extension/ in `files`
// order (POSIX paths, sorted by code unit; dotfiles, dot-folders and *.lnk skipped). File bytes are hashed with every
// CR that precedes an LF removed, so a CRLF checkout and an LF one give the same sig. core/update.js computes the
// very same thing with crypto.subtle from the extension's own files; keep the two in step.
const EXT_DIR = join(root, 'extension');
function extListing(dir = EXT_DIR, rel = '', out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.') || /\.lnk$/i.test(d.name)) continue;
    const r = rel ? rel + '/' + d.name : d.name, full = join(dir, d.name);
    if (d.isDirectory()) extListing(full, r, out);
    else if (d.isFile()) { const s = statSync(full); out.push({ rel: r, full, mtime: s.mtimeMs, size: s.size }); }
  }
  return out;
}
const sha256 = data => createHash('sha256').update(data).digest('hex');
function lfBytes(buf) {
  let n = 0; const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) { if (buf[i] === 13 && buf[i + 1] === 10) continue; out[n++] = buf[i]; }
  return out.subarray(0, n);
}
let extSigCache = { at: 0, stamp: '', value: null };
function extSig() {
  const now = Date.now();
  if (extSigCache.value && now - extSigCache.at < 2000) return extSigCache.value;
  const list = extListing().sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const stamp = list.map(f => `${f.rel}:${f.mtime}:${f.size}`).join('|');
  if (extSigCache.value && stamp === extSigCache.stamp) { extSigCache.at = now; return extSigCache.value; }
  let version = null, lines = '';
  for (const f of list) {
    const bytes = readFileSync(f.full);
    if (f.rel === 'manifest.json') { try { version = JSON.parse(bytes.toString('utf8')).version || null; } catch (e) { /* half-written */ } }
    lines += `${f.rel}\n${sha256(lfBytes(bytes))}\n`;
  }
  const value = { version, sig: sha256(lines).slice(0, 16), files: list.map(f => f.rel), changedAt: Math.round(Math.max(0, ...list.map(f => f.mtime))) };
  extSigCache = { at: now, stamp, value };
  return value;
}

// ---------- POST /api/ext/hello, GET /api/ext/status: what Chrome has loaded ----------
// The last hello from a real (headed) Chrome; headless ones (test harnesses) only go into extRecent.
let extLoaded = null; // { version, sig, id, seenAt }
const extRecent = []; // the last 5 hellos of any kind, newest last: { version, sig, id, seenAt, headless }
async function extHello(req, res, id) {
  let b;
  try { b = await readBody(req, 4000); } catch (e) { return json(res, 400, { error: 'Неверный запрос' }); }
  if (b.id != null && b.id !== id) return json(res, 400, { error: 'id не совпадает с Origin' });
  const seen = { version: str(b.version, 40) || null, sig: str(b.sig, 80) || null, id, seenAt: new Date().toISOString() };
  extRecent.push({ ...seen, headless: b.headless === true });
  if (extRecent.length > 5) extRecent.shift();
  if (b.headless !== true) extLoaded = seen;
  return json(res, 200, { ok: true, upToDate: seen.sig === extSig().sig });
}
function extStatus() {
  const { version, sig } = extSig();
  return { disk: { version, sig }, loaded: extLoaded, upToDate: !!(extLoaded && extLoaded.sig === sig), recent: extRecent };
}

// ---------- write counters for the safety tests (TMS and Ledgerly demos) ----------
// A demo's "commit" POSTs here instead of writing anything; a test reads the count to prove the agent wrote nothing.
const writeLogs = { tms: { count: 0, last: [] }, demo: { count: 0, last: [] } };
async function countWrite(req, res, log) {
  let action = '';
  try {
    const raw = await readRaw(req, 20_000);
    try { const b = JSON.parse(raw); action = str(b && (b.action || b.type), 120); } catch (e) { action = raw.slice(0, 120); }
  } catch (e) { /* counted anyway: the attempt is what matters */ }
  log.count++;
  log.last.push({ at: new Date().toISOString(), action });
  if (log.last.length > 20) log.last.splice(0, log.last.length - 20);
  return json(res, 200, { ok: true });
}

// ---------- static files and the SDK bundle ----------
// No page of ours may be framed (clickjacking /setup's buttons from another site).
const NO_FRAME = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };
const SETUP_FULL = normalize(join(root, 'demo', 'setup.html')).toLowerCase();
async function file(res, path, { setup = false } = {}) {
  const full = normalize(join(root, path));
  if (!full.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
  // The setup page only through the admin route, however the path was spelled.
  if (!setup && full.toLowerCase() === SETUP_FULL) { res.writeHead(404); return res.end('Not found'); }
  try {
    const data = await readFile(full);
    const type = TYPES[extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', ...(type.startsWith('text/html') ? NO_FRAME : {}) });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('Not found'); }
}
// Windows resolves aliases of one file: any case, a trailing dot or space, "::$DATA" streams, 8.3 short names (~1).
const winAlias = p => /[:\\~]|[. ]$|[. ]\//.test(p);
const SETUP_FILE = '/demo/setup.html';
let bundle = { sig: '', code: '' };
function sdkBundle() {
  const sig = signature();
  if (sig !== bundle.sig) bundle = { sig, code: build({ write: false }) };
  return bundle.code;
}

async function handle(req, res) {
  try {
    // Every route: the Host must be one of ours (DNS rebinding), whatever the path.
    if (!hostOk(req)) return json(res, 403, { error: 'Unknown host' });
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    // The extension's routes: this machine only, from a chrome-extension:// origin. They come before the same-origin
    // rule below, which they replace with their own (CORS for extension origins only, never for web pages).
    if (path === '/api/claude' || path === '/api/ext/version' || path === '/api/ext/hello') {
      if (req.method === 'OPTIONS') return extPreflight(req, res);
      if (!localAdmin(req)) return json(res, 403, { error: 'Только с этого компьютера' });
      extCors(req, res);
      if (path === '/api/ext/version') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Метод не поддерживается' });
        const o = req.headers.origin;
        if (o && !EXT_ORIGIN.test(o) && !originOk(req, true)) return json(res, 403, { error: 'Запрос с чужого сайта' });
        return json(res, 200, { ...extSig(), claude: !!KEY }); // claude: false tells the extension not to use the proxy
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Метод не поддерживается' });
      if (!isJson(req)) return json(res, 415, { error: 'Нужен JSON' });
      const id = extCaller(req);
      if (!id) return json(res, 403, { error: 'Только для расширения Scopos на этом компьютере' });
      return path === '/api/claude' ? await claudeProxy(req, res) : await extHello(req, res, id);
    }
    // Safety-test write counters: same origin (or no browser at all), any body, no key.
    const wm = /^\/api\/(tms|demo)\/(write|writes|writes\/reset)$/.exec(path);
    if (wm) {
      const log = writeLogs[wm[1]];
      if (wm[2] === 'writes' && (req.method === 'GET' || req.method === 'HEAD')) return json(res, 200, { count: log.count, last: log.last });
      if (wm[2] === 'writes' || req.method !== 'POST') return json(res, 405, { error: 'Метод не поддерживается' });
      if (!originOk(req)) return json(res, 403, { error: 'Запрос с чужого сайта' });
      if (wm[2] === 'write') return await countWrite(req, res, log);
      log.count = 0; log.last = [];
      return json(res, 200, { ok: true, count: 0 });
    }

    // The setup page is admin-only under any name it can be reached by (/setup, /demo/setup.html, /demo//SETUP.HTML on Windows).
    const isSetup = path === '/setup' || path.replace(/\/{2,}/g, '/').toLowerCase() === SETUP_FILE;
    const admin = isSetup || path === '/api/key' || path === '/api/scopos/stats' || path === '/api/ext/status';
    if (admin && !localAdmin(req)) return json(res, 403, { error: 'Только с этого компьютера' });

    // Every state-changing request: JSON only, from this origin only. No CORS headers are ever sent.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!isJson(req)) return json(res, 415, { error: 'Нужен JSON' });
      if (!originOk(req, admin)) return json(res, 403, { error: 'Запрос с чужого сайта' });
    }

    if (path === '/api/scopos' && req.method === 'POST') return await api(req, res);
    if (path === '/api/scopos/learn' && req.method === 'POST') return await learnApi(req, res);
    if (path === '/api/key') return await keyApi(req, res);
    if (path === '/api/scopos/stats') return json(res, 200, { ...stats, cost: +stats.cost.toFixed(4), today: { date: day.date, calls: day.calls, limit: DAILY_LIMIT }, month: { month: monthKey(), spent: +monthNow().spent.toFixed(4), cap: MONTHLY_USD, calls: monthNow().calls || 0 }, cachedAnswers: answers.size, knowledge: knowledge ? { learnedAt: knowledge.learnedAt, views: knowledge.map.views.length, guides: knowledge.guides.length } : null });
    if (path === '/api/ext/status') return json(res, 200, extStatus());
    if (path === '/api/scopos/knowledge') return json(res, 200, knowledge ? { learnedAt: knowledge.learnedAt, summary: knowledge.summary, guides: knowledge.guides, views: knowledge.map.views.length } : { guides: [] });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 404, { error: 'Not found' });
    if (isSetup) return await file(res, 'demo/setup.html', { setup: true });
    if (path === '/scopos.js') { const code = sdkBundle(); res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(code); }
    if (path === '/' || path === '/index.html') return await file(res, 'demo/index.html');
    if (!winAlias(path)) {
      if (/^\/demo\//.test(path)) return await file(res, path.endsWith('/') ? path + 'index.html' : path); // /demo/tms/ -> index.html
      // Dev pages and the side panel's sources: this machine only (loopback, local Host, no proxy).
      if (/^\/(dev|extension\/sidepanel)\//.test(path) && localAdmin(req)) return await file(res, path);
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error('[scopos]', e);
    if (!res.headersSent) json(res, 500, { error: 'Ошибка сервера' }); else res.end();
  }
}
createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`Scopos demo: http://localhost:${PORT}` + (KEY ? '' : `  (ключ Claude можно вставить на http://localhost:${PORT}/setup)`));
});
// "localhost" resolves to ::1 first: without a listener there, Windows retries the refused connection for 1-2 s
// before falling back to 127.0.0.1, longer than the extension's 1.5 s probes. Loopback only, so nothing else changes.
createServer(handle).listen(PORT, '::1').on('error', () => { /* no IPv6 loopback here */ });
