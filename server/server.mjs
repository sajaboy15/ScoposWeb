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
//   GET  /api/scopos/stats   token usage, cache hits, today's budget
//
// Env: PORT, ANTHROPIC_API_KEY, SCOPOS_DAILY_LIMIT (default 2000 model calls a day), SCOPOS_LEARN_TOKEN,
//      SCOPOS_ORIGINS (extra allowed origins, comma-separated; their hosts are allowed too), SCOPOS_HOSTS (extra
//      allowed Host headers, e.g. app.example.com), SCOPOS_TRUST_PROXY=1 (rate-limit by the rightmost X-Forwarded-For).
//
// The key stays on this server; browsers only ever talk to /api/scopos.
// No dependencies beyond Node 20+.
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, signature } from '../sdk/build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Brain = createRequire(import.meta.url)('../extension/core/brain.js');
const PORT = +process.env.PORT || 4173;
const KEY_FILE = join(root, '.scopos-key.local');
const KNOWLEDGE_FILE = join(root, '.scopos-knowledge.local.json');
const ANSWERS_FILE = join(root, '.scopos-answers.local.json');
const DAILY_LIMIT = +process.env.SCOPOS_DAILY_LIMIT || 2000;
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
  if (!m || typeof m !== 'object' || !Array.isArray(m.views) || !m.views.length || m.views.length > 100) return null;
  const views = [];
  for (const v of m.views) {
    if (!v || typeof v.id !== 'string' || !Array.isArray(v.controls) || v.controls.length > 150) return null;
    views.push({
      id: v.id.slice(0, 12), key: str(v.key, 300), url: str(v.url, 500),
      kind: ['page', 'dialog', 'panel'].includes(v.kind) ? v.kind : 'page',
      parent: typeof v.parent === 'string' ? v.parent.slice(0, 12) : undefined,
      opener: typeof v.opener === 'string' ? v.opener.slice(0, 16) : undefined,
      title: str(v.title, 120),
      headings: Array.isArray(v.headings) ? v.headings.filter(h => typeof h === 'string').slice(0, 8).map(h => h.slice(0, 80)) : [],
      // Short static text of the screen; Brain.mapText checks it for personal data again when it renders it.
      facts: Array.isArray(v.facts) ? v.facts.filter(f => typeof f === 'string').slice(0, 12).map(f => f.slice(0, 80)) : undefined,
      controls: v.controls.filter(c => c && typeof c.ref === 'string').map(c => ({
        ref: c.ref.slice(0, 16), role: str(c.role, 30), name: str(c.name, 120),
        section: str(c.section, 80) || undefined, state: str(c.state, 80) || undefined,
        options: Array.isArray(c.options) ? c.options.filter(o => typeof o === 'string').slice(0, 30).map(o => o.slice(0, 80)) : undefined,
        d: cleanDescriptor(c.d),
        to: typeof c.to === 'string' ? c.to.slice(0, 12) : undefined,
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
function learnedGuides(out, map) {
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
  try { body = await readBody(req, 3_000_000); } catch (e) { return json(res, 400, { error: 'Неверный запрос' }); }
  if (body.check) return json(res, 200, { ok: true, key: !!KEY });
  if (!KEY) return json(res, 503, { error: 'Сначала подключите ключ на /setup' });
  const map = cleanMap(body.map);
  if (!map) return json(res, 400, { error: 'Нет карты продукта или она слишком большая (до 80 экранов и 150 кнопок на экране).' });
  if (learning) return json(res, 409, { error: 'Уже пишу гайды по другой карте. Подождите минуту.' });
  learning = true;
  const product = str(body.product, 120);
  const signal = clientGone(res);
  let lastLog = 0;
  try {
    const out = await Brain.call(Brain.buildLearn({ map, product }), KEY, {
      fromBrowser: false, signal, onUsage: usageLogger('learn'),
      onText: t => { const now = Date.now(); if (now - lastLog > 5000) { lastLog = now; console.log(`[scopos] Claude пишет гайды · ${t.length} символов`); } },
    });
    const { guides, dropped } = learnedGuides(out, map);
    knowledge = { learnedAt: new Date().toISOString(), product, summary: String(out.summary || '').slice(0, 300), map, guides };
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

createServer(async (req, res) => {
  try {
    // Every route: the Host must be one of ours (DNS rebinding), whatever the path.
    if (!hostOk(req)) return json(res, 403, { error: 'Unknown host' });
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    // The setup page is admin-only under any name it can be reached by (/setup, /demo/setup.html, /demo//SETUP.HTML on Windows).
    const isSetup = path === '/setup' || path.replace(/\/{2,}/g, '/').toLowerCase() === SETUP_FILE;
    const admin = isSetup || path === '/api/key' || path === '/api/scopos/stats';
    if (admin && !localAdmin(req)) return json(res, 403, { error: 'Только с этого компьютера' });

    // Every state-changing request: JSON only, from this origin only. No CORS headers are ever sent.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!isJson(req)) return json(res, 415, { error: 'Нужен JSON' });
      if (!originOk(req, admin)) return json(res, 403, { error: 'Запрос с чужого сайта' });
    }

    if (path === '/api/scopos' && req.method === 'POST') return await api(req, res);
    if (path === '/api/scopos/learn' && req.method === 'POST') return await learnApi(req, res);
    if (path === '/api/key') return await keyApi(req, res);
    if (path === '/api/scopos/stats') return json(res, 200, { ...stats, cost: +stats.cost.toFixed(4), today: { date: day.date, calls: day.calls, limit: DAILY_LIMIT }, cachedAnswers: answers.size, knowledge: knowledge ? { learnedAt: knowledge.learnedAt, views: knowledge.map.views.length, guides: knowledge.guides.length } : null });
    if (path === '/api/scopos/knowledge') return json(res, 200, knowledge ? { learnedAt: knowledge.learnedAt, summary: knowledge.summary, guides: knowledge.guides, views: knowledge.map.views.length } : { guides: [] });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 404, { error: 'Not found' });
    if (isSetup) return await file(res, 'demo/setup.html', { setup: true });
    if (path === '/scopos.js') { const code = sdkBundle(); res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(code); }
    if (path === '/' || path === '/index.html') return await file(res, 'demo/index.html');
    if (!winAlias(path)) {
      if (/^\/demo\//.test(path)) return await file(res, path);
      // Dev pages and the side panel's sources: this machine only (loopback, local Host, no proxy).
      if (/^\/(dev|extension\/sidepanel)\//.test(path) && localAdmin(req)) return await file(res, path);
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error('[scopos]', e);
    if (!res.headersSent) json(res, 500, { error: 'Ошибка сервера' }); else res.end();
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Scopos demo: http://localhost:${PORT}` + (KEY ? '' : `  (ключ Claude можно вставить на http://localhost:${PORT}/setup)`));
});
