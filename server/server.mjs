// Scopos server: the vendor-side half of the SDK, plus the demo app.
//
//   ANTHROPIC_API_KEY=sk-ant-... node server/server.mjs      -> http://localhost:4173
//
// POST /api/scopos  { question, page, history, product }  -> { answer, steps }
//                   { locate: { instruction, oldText }, page } -> { element_id }
// GET  /scopos.js   the SDK bundle (rebuilt on every request while developing)
// GET  /            the demo app (Ledgerly)
// GET  /dev/panel-preview.html  the extension's side panel with a stubbed chrome API
// GET  /setup       paste the Claude key in a browser instead of an env var (saved to .scopos-key.local)
//
// The key stays on this server; browsers only ever talk to /api/scopos.
// No dependencies beyond Node 20+.
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../sdk/build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Brain = createRequire(import.meta.url)('../extension/core/brain.js');
const PORT = +process.env.PORT || 4173;
const KEY_FILE = join(root, '.scopos-key.local');
let KEY = process.env.ANTHROPIC_API_KEY || (() => { try { return readFileSync(KEY_FILE, 'utf8').trim(); } catch (e) { return ''; } })();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// A small per-IP budget so a public demo can't be used to drain the key.
const hits = new Map();
function allowed(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60_000);
  list.push(now); hits.set(ip, list);
  return list.length <= 12;
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 400_000) throw new Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const validPage = p => p && Array.isArray(p.lines) && p.lines.every(l => typeof l === 'string') && p.lines.length <= 400;

async function api(req, res) {
  if (!KEY) return json(res, 503, { error: 'Ключ Claude ещё не подключён: откройте /setup. Сценарии работают и без него.' });
  if (!allowed(req.socket.remoteAddress)) return json(res, 429, { error: 'Слишком много вопросов подряд. Подождите минуту.' });
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Неверный запрос' }); }
  if (!validPage(body.page)) return json(res, 400, { error: 'Нет карты страницы' });
  try {
    if (body.locate) {
      const out = await Brain.call(Brain.buildLocate({ instruction: String(body.locate.instruction || ''), oldText: String(body.locate.oldText || ''), page: body.page }), KEY, { fromBrowser: false });
      return json(res, 200, out);
    }
    const question = String(body.question || '').slice(0, 600);
    if (!question) return json(res, 400, { error: 'Пустой вопрос' });
    const history = Array.isArray(body.history) ? body.history.filter(t => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string').slice(-6) : [];
    const progress = Array.isArray(body.progress) ? body.progress.filter(p => typeof p === 'string').slice(0, 20).map(p => p.slice(0, 200)) : [];
    const out = await Brain.call(Brain.buildAsk({ question, page: body.page, history, progress, product: String(body.product || '').slice(0, 120) }), KEY, { fromBrowser: false });
    return json(res, 200, out);
  } catch (e) {
    return json(res, 502, { error: e.message || 'Claude не ответил' });
  }
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

// Key management for /setup. Only this machine may call it: the server listens on 127.0.0.1, and the
// JSON content type forces a CORS preflight that other sites can't pass, so a web page can't set or read the key.
const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
async function keyApi(req, res) {
  if (!loopback(req)) return json(res, 403, { error: 'Только с этого компьютера' });
  if (req.method === 'GET') return json(res, 200, { set: !!KEY, last4: KEY ? KEY.slice(-4) : null, fromEnv: !!process.env.ANTHROPIC_API_KEY, extensionPath: extensionPath() });
  if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Нужен JSON' });
  if (req.method === 'DELETE') { KEY = ''; await rm(KEY_FILE, { force: true }); return json(res, 200, { set: false }); }
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Неверный запрос' }); }
  if (body.test) {
    if (!KEY) return json(res, 400, { error: 'Сначала сохраните ключ' });
    try {
      await Brain.call(Brain.buildLocate({ instruction: 'нажмите «Сохранить»', oldText: 'Сохранить', page: { title: 'проверка', url: 'http://localhost', headings: [], lines: ['[1] button "Сохранить"'] } }), KEY, { fromBrowser: false });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  const key = String(body.key || '').trim();
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) return json(res, 400, { error: 'Ключ должен начинаться с sk-ant-' });
  KEY = key;
  await writeFile(KEY_FILE, key, { mode: 0o600 });
  return json(res, 200, { set: true, last4: key.slice(-4) });
}

async function file(res, path) {
  const full = normalize(join(root, path));
  if (!full.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('Not found'); }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/scopos' && req.method === 'POST') return api(req, res);
  if (url.pathname === '/api/key') return keyApi(req, res);
  if (url.pathname === '/setup') return file(res, 'demo/setup.html');
  if (url.pathname === '/scopos.js') { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }); return res.end(build()); }
  if (url.pathname === '/' || url.pathname === '/index.html') return file(res, 'demo/index.html');
  if (/^\/(demo|dev|extension\/sidepanel)\//.test(url.pathname)) return file(res, url.pathname);
  res.writeHead(404); res.end('Not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Scopos demo: http://localhost:${PORT}` + (KEY ? '' : `  (ключ Claude можно вставить на http://localhost:${PORT}/setup)`));
});
