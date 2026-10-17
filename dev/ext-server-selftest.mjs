// Self-test for the extension routes of server/server.mjs, with zero real Claude calls:
//   node dev/ext-server-selftest.mjs
// Starts a fake Anthropic upstream (SSE) and a second server on PORT 4199 (never touches :4173) with a fake key,
// SCOPOS_UPSTREAM pointed at the fake and SCOPOS_USAGE_FILE in the temp dir, then checks /api/claude (origin,
// loopback, host, proxy headers, model, max_tokens, tools, size, beta whitelist, SSE passthrough byte-exact,
// usage into stats, monthly budget refusal, CORS preflight), /api/ext/version (sig = an independent recompute),
// /api/ext/hello + /api/ext/status, and the /api/tms and /api/demo write counters.
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.TEST_PORT || 4199;
const EXT = 'chrome-extension://' + 'abcdefghijklmnopabcdefghijklmnop';
const FAKE_KEY = 'sk-ant-test-' + 'x'.repeat(30);
const tmp = mkdtempSync(join(tmpdir(), 'scopos-selftest-'));
let failed = 0;
const ok = (cond, name, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) failed++; };

// ---- fake upstream ----
const SSE = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"answer":"привет",' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '"steps":[]}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } },
  { type: 'message_stop' },
].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
const upstreamSeen = [];
const mock = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  upstreamSeen.push({ keyIsFake: req.headers['x-api-key'] === FAKE_KEY, beta: req.headers['anthropic-beta'] || null, version: req.headers['anthropic-version'], body: JSON.parse(body) });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': 'req_test' });
  for (const chunk of SSE) { res.write(chunk); await new Promise(r => setTimeout(r, 15)); } // really streamed
  res.end();
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${mock.address().port}/v1/messages`;

// ---- server under test ----
const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: FAKE_KEY, SCOPOS_UPSTREAM: UP, SCOPOS_USAGE_FILE: join(tmp, 'usage.json'), SCOPOS_MONTHLY_USD: '0.02', SCOPOS_EXT_IDS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
for (let i = 0; i < 50 && !/Scopos demo/.test(log); i++) await new Promise(r => setTimeout(r, 100));

function http(method, path, { headers = {}, body, host = `localhost:${PORT}` } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port: PORT, agent: false, method, path, headers: { host, ...(data ? { 'content-length': data.length } : {}), ...headers } }, res => {
      const chunks = []; let firstAt = 0;
      res.on('data', c => { if (!firstAt) firstAt = Date.now(); chunks.push(c); });
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(raw); } catch (e) { /* SSE */ } resolve({ status: res.statusCode, headers: res.headers, raw, json: j }); });
    });
    req.on('error', e => (e.code === 'ECONNRESET' || e.code === 'EPIPE') && method === 'POST' && data && data.length > 1e6 ? null : reject(e));
    if (data) req.write(data);
    req.end();
  });
}
const J = { 'content-type': 'application/json' };
const good = { model: 'claude-sonnet-5-5', max_tokens: 2000, stream: true, system: 's', messages: [{ role: 'user', content: 'hi' }] };
const claude = (body, headers = {}, opts = {}) => http('POST', '/api/claude', { headers: { ...J, origin: EXT, ...headers }, body, ...opts });

try {
  ok(/Scopos demo/.test(log), 'test server started on ' + PORT);

  // --- who may call ---
  ok((await claude(good, { origin: 'http://evil.example' })).status === 403, 'web origin refused');
  ok((await claude(good, { origin: `http://localhost:${PORT}` })).status === 403, 'own web origin refused (extension only)');
  ok((await http('POST', '/api/claude', { headers: J, body: good })).status === 403, 'no Origin and no x-scopos-ext refused');
  ok((await claude(good, { 'x-scopos-ext': 'ponmlkjihgfedcbaponmlkjihgfedcba' })).status === 403, 'x-scopos-ext not matching Origin refused');
  ok((await claude(good, {}, { host: `evil.example:${PORT}` })).status === 403, 'foreign Host refused (rebinding)');
  ok((await claude(good, { 'x-forwarded-for': '1.2.3.4' })).status === 403, 'proxy header refused');
  ok((await claude(good, { 'content-type': 'text/plain' })).status === 415, 'non-JSON refused');
  upstreamSeen.length = 0;

  // --- body checks ---
  const r400 = async (b, name) => { const r = await claude(b); ok(r.status === 400 && r.json && r.json.error && r.json.error.message, name, r.json && r.json.error && r.json.error.message); };
  await r400({ ...good, model: 'claude-3-opus' }, 'unknown model refused');
  await r400({ ...good, max_tokens: 32001 }, 'max_tokens > 32000 refused');
  await r400({ ...good, tools: [{ name: 'x' }] }, 'tools refused');
  await r400({ ...good, mcp_servers: [] }, 'mcp_servers refused');
  await r400({ ...good, container: 'c' }, 'container refused');
  const huge = await claude({ ...good, messages: [{ role: 'user', content: 'x'.repeat(1_600_000) }] });
  ok(huge.status === 413, 'body over 1.5 MB refused', String(huge.status));
  const badBeta = await claude(good, { 'anthropic-beta': 'files-api-2025-04-14' });
  ok(badBeta.status === 400, 'other anthropic-beta refused');
  ok(upstreamSeen.length === 0, 'nothing refused reached upstream');

  // --- passthrough ---
  const t0 = Date.now();
  const r = await claude({ ...good, fallbacks: 'default' }, { 'anthropic-beta': 'server-side-fallback-2026-07-01', 'x-api-key': '', 'anthropic-dangerous-direct-browser-access': 'true', 'x-scopos-ext': EXT.slice(19) });
  ok(r.status === 200 && /text\/event-stream/.test(r.headers['content-type']), 'proxied call streams SSE', r.status + ' ' + r.headers['content-type']);
  ok(r.raw === SSE.join(''), 'SSE passed through byte-exact');
  ok(Date.now() - t0 >= 90, 'response was streamed over time (not buffered instantly)');
  ok(r.headers['access-control-allow-origin'] === EXT, 'CORS header for the extension origin');
  const seen = upstreamSeen[0] || {};
  ok(upstreamSeen.length === 1 && seen.keyIsFake, 'upstream got the server key');
  ok(seen.beta === 'server-side-fallback-2026-07-01', 'fallback beta forwarded');
  ok(seen.body && seen.body.model === 'claude-sonnet-5-5' && seen.body.fallbacks === 'default', 'body forwarded');
  // brain.js-style parse of the passthrough
  let text = '', stop = null; const usage = {};
  for (const block of r.raw.split('\n\n')) { const d = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join(''); if (!d) continue; const ev = JSON.parse(d); if (ev.type === 'content_block_delta') text += ev.delta.text; if (ev.type === 'message_delta') stop = ev.delta.stop_reason; }
  ok(JSON.parse(text).answer === 'привет' && stop === 'end_turn', 'client-side stream parse works');
  const r2 = await claude(good); // no beta header -> none forwarded
  ok(r2.status === 200 && upstreamSeen[1] && upstreamSeen[1].beta === null, 'no beta header forwarded when none sent and no fallbacks');
  // brain.js in proxy mode: no headers at all, body with fallbacks -> the server adds the beta (costs one more call)
  const r3 = await http('POST', '/api/claude', { headers: { ...J, origin: EXT }, body: { ...good, fallbacks: 'default' } });
  ok(r3.status === 200 && upstreamSeen[2] && upstreamSeen[2].beta === 'server-side-fallback-2026-07-01', 'beta added for a fallbacks body sent without headers');

  // --- stats + budget ---
  await new Promise(r => setTimeout(r, 1300)); // usage file is written after 1 s
  const stats = (await http('GET', '/api/scopos/stats')).json;
  ok(stats.byKind.extension && stats.byKind.extension.calls === 3, 'stats count kind extension', JSON.stringify(stats.byKind));
  ok(Math.abs(stats.byKind.extension.cost - 0.021) < 1e-9, 'cost from message_start + message_delta usage', String(stats.byKind.extension.cost));
  ok(stats.month && stats.month.cap === 0.02 && Math.abs(stats.month.spent - 0.021) < 1e-6, 'stats.month {spent, cap}', JSON.stringify(stats.month));
  const book = JSON.parse(readFileSync(join(tmp, 'usage.json'), 'utf8'));
  ok(Object.values(book.months)[0].spent > 0.0209, 'month persisted to the usage file');
  const over = await claude(good);
  ok(over.status === 402 && /Месячный бюджет/.test(over.json.error.message), 'over budget: refused with a Russian message', over.json && over.json.error.message);
  ok(upstreamSeen.length === 3, 'refused call never reached upstream');
  const ask = await http('POST', '/api/scopos', { headers: J, body: { question: 'selftest ' + Date.now(), page: { title: 't', url: 'http://x/', lines: ['[1] button "a"'] } } });
  ok(ask.status === 429 && /Месячный бюджет/.test(ask.json.error) || ask.status === 200 && ask.json.source === 'cache', '/api/scopos also stops (or serves cache)', ask.status + ' ' + (ask.json && (ask.json.error || ask.json.source)));

  // --- preflight ---
  const pre = await http('OPTIONS', '/api/claude', { headers: { origin: EXT, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,anthropic-beta' } });
  ok(pre.status === 204 && pre.headers['access-control-allow-origin'] === EXT && /anthropic-beta/.test(pre.headers['access-control-allow-headers']), 'preflight answered for the extension');
  const preBad = await http('OPTIONS', '/api/claude', { headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
  ok(preBad.status === 403 && !preBad.headers['access-control-allow-origin'], 'preflight refused for a web origin');

  // --- version ---
  const v = await http('GET', '/api/ext/version', { headers: { origin: EXT } });
  ok(v.status === 200 && v.headers['access-control-allow-origin'] === EXT, 'version readable by the extension (CORS)');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  ok(v.json.version === manifest.version, 'version from manifest.json', v.json.version);
  ok(v.json.claude === true, 'version says the server has a key (claude: true)');
  const walk = (d, rel = '') => readdirSync(d, { withFileTypes: true }).flatMap(e => e.name.startsWith('.') || /\.lnk$/i.test(e.name) ? [] : e.isDirectory() ? walk(join(d, e.name), rel + e.name + '/') : [rel + e.name]);
  const files = walk(join(ROOT, 'extension')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const H = b => createHash('sha256').update(b).digest('hex');
  const lf = b => Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  const mySig = H(files.map(f => `${f}\n${H(lf(readFileSync(join(ROOT, 'extension', f))))}\n`).join('')).slice(0, 16);
  ok(JSON.stringify(v.json.files) === JSON.stringify(files) && v.json.sig === mySig, 'sig = independent recompute', v.json.sig + ' / ' + mySig);
  ok((await http('GET', '/api/ext/version', { headers: { origin: 'http://evil.example' } })).status === 403, 'version refused for a web origin');
  ok(!(await http('GET', '/api/ext/version')).headers['access-control-allow-origin'], 'no CORS without an extension origin');
  ok((await http('GET', '/api/ext/version', { host: `evil.example:${PORT}` })).status === 403, 'version refused for a foreign Host');

  // --- hello + status ---
  let st = (await http('GET', '/api/ext/status')).json;
  ok(st.loaded === null && st.upToDate === false && st.disk.sig === v.json.sig, 'status before hello: loaded null');
  ok((await http('POST', '/api/ext/hello', { headers: { ...J, origin: 'http://evil.example' }, body: { version: '0', sig: 'x' } })).status === 403, 'hello refused from a web origin');
  const h = await http('POST', '/api/ext/hello', { headers: { ...J, origin: EXT }, body: { version: manifest.version, sig: v.json.sig, id: EXT.slice(19) } });
  ok(h.status === 200 && h.json.upToDate === true, 'hello accepted');
  st = (await http('GET', '/api/ext/status')).json;
  ok(st.upToDate === true && st.loaded.sig === v.json.sig && st.loaded.id === EXT.slice(19) && st.loaded.seenAt, 'status after hello: upToDate');
  await http('POST', '/api/ext/hello', { headers: { ...J, origin: EXT }, body: { version: manifest.version, sig: 'old', id: EXT.slice(19) } });
  ok((await http('GET', '/api/ext/status')).json.upToDate === false, 'status after an old hello: not upToDate');
  await http('POST', '/api/ext/hello', { headers: { ...J, origin: EXT }, body: { version: manifest.version, sig: v.json.sig, id: EXT.slice(19), headless: true } });
  st = (await http('GET', '/api/ext/status')).json;
  ok(st.upToDate === false && st.loaded.sig === 'old' && st.recent.at(-1).headless === true, 'a headless hello does not count as loaded, shows in recent');
  ok((await http('GET', '/api/ext/status', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status === 403, 'status admin-only');

  // --- write counters ---
  const own = { origin: `http://localhost:${PORT}` };
  await http('POST', '/api/tms/writes/reset', { headers: { ...J, ...own }, body: {} });
  await http('POST', '/api/tms/write', { headers: { ...J, ...own }, body: { action: 'dispatch load 42' } });
  await http('POST', '/api/tms/write', { headers: own }); // no body, no content type: still counted
  ok((await http('POST', '/api/tms/write', { headers: { ...J, origin: 'http://evil.example' }, body: {} })).status === 403, 'cross-origin write refused');
  let w = (await http('GET', '/api/tms/writes')).json;
  ok(w.count === 2 && w.last[0].action === 'dispatch load 42' && w.last[0].at, 'tms counter + last', JSON.stringify(w));
  for (let i = 0; i < 25; i++) await http('POST', '/api/tms/write', { headers: { ...J, ...own }, body: { action: 'a' + i } });
  w = (await http('GET', '/api/tms/writes')).json;
  ok(w.count === 27 && w.last.length === 20 && w.last[19].action === 'a24', 'last keeps 20');
  ok((await http('GET', '/api/demo/writes')).json.count === 0, 'demo counter separate');
  await http('POST', '/api/demo/write', { headers: { ...J, ...own }, body: { action: 'save invoice' } });
  ok((await http('GET', '/api/demo/writes')).json.count === 1, 'demo counter counts');
  await http('POST', '/api/tms/writes/reset', { headers: { ...J, ...own }, body: {} });
  ok((await http('GET', '/api/tms/writes')).json.count === 0, 'reset');
  const tmsPage = await http('GET', '/demo/tms/index.html');
  ok(existsSync(join(ROOT, 'demo', 'tms', 'index.html')) ? tmsPage.status === 200 : tmsPage.status === 404, '/demo/tms/index.html served when present', String(tmsPage.status));
  ok((await http('GET', '/demo/tms/')).status === tmsPage.status, '/demo/tms/ -> index.html');
  ok((await http('GET', '/setup')).status === 200, '/setup still served');
} finally {
  srv.kill(); mock.close();
  rmSync(tmp, { recursive: true, force: true });
  if (failed) console.log('\n--- server log ---\n' + log.replace(/sk-ant-[\w-]+/g, 'sk-ant-…'));
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
}
