/*
 * Service worker: state, storage and every Claude call.
 *
 * Per tab, chrome.storage.session holds the running session
 *   guide:<tabId> = { runId, question, answer, steps, index, status, source, via, ms, origin, history, ... }
 * so a walkthrough survives page loads and the side panel can reopen on it. Every answer belongs to
 * a run (runId): a result that arrives after the user asked something else or pressed Stop is dropped.
 *
 * chrome.storage.local, per site:
 *   playbooks:<origin> = [{ id, name, steps, created, runs, learned?, live? }]  saved and learned guides (0 tokens)
 *   answers:<origin>   = [{ k, answer, steps, via, at }]                  last 200 answers (0 tokens on repeat)
 *   map:<origin>, learn:<origin>                                         the explorer's product map and learn state
 *   passive:<origin>   = { newViews: [id], lastGuidesAt }                 views seen while browsing since the last guide writing
 *   usage              = { total, origins, months: { 'YYYY-MM': { tokens, cost, calls } } }
 *   settings: apiKey, devServer (default http://localhost:4173), monthlyLimit ($, default 2), autoGuides (default true)
 */
importScripts('core/brain.js');
const Brain = self.ScoposBrain;

// What must not be cut short by a reload (dev auto-update asks scoposBusy() first): tabs with a running guide,
// a Claude call or a recording, tabs that explore, and sites whose guides are being written.
const busyTabs = new Set(), busyExplore = new Set(), busyWriting = new Set();
self.scoposBusy = () => busyTabs.size > 0 || busyExplore.size > 0 || busyWriting.size > 0;
try { importScripts('core/update.js'); } catch (e) { /* no dev auto-update in this build */ }
// guard.js is DOM-free until used: here it only provides S.guard.pageMain, the page-world patch.
try { importScripts('core/guard.js'); } catch (e) { /* older build without guard.js: the fallback patch below is used */ }
const pageGuard = () => (self.Scopos && self.Scopos.guard && typeof self.Scopos.guard.pageMain === 'function' ? self.Scopos.guard.pageMain : null);

// Injected into tabs that were open before the extension was installed. Same order as the manifest.
const CORE_FILES = ['core/scan.js', 'core/pointer.js', 'core/guide.js', 'core/guard.js', 'core/explore.js', 'content.js'];
const LEARN_STALE_MS = 4 * 60 * 1000;
const ANSWERS_MAX = 200;
const ANSWER_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_REPLANS = 2;
const MAX_HEALS = 3;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'open-scopos' && tab) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// ---------- small async mutex: every read-modify-write of one storage key runs in order ----------
const locks = new Map();
function locked(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const p = prev.then(() => fn());
  const tail = p.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return p;
}
const stale = () => Object.assign(new Error('stale'), { stale: true });
const aborted = () => new DOMException('Остановлено', 'AbortError');

// ---------- sessions ----------
const sessionKey = tabId => `guide:${tabId}`;
const BUSY_STATUS = new Set(['running', 'thinking', 'recording']);
const getSession = async tabId => (await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)] || null;
const broadcast = msg => chrome.runtime.sendMessage(msg).catch(() => {});
/** fn(current) returns the next session, null to clear it, or undefined to leave it as is. */
function updateSession(tabId, fn) {
  return locked(sessionKey(tabId), async () => {
    const cur = await getSession(tabId);
    const next = await fn(cur);
    if (next === undefined) return cur;
    if (next) await chrome.storage.session.set({ [sessionKey(tabId)]: { ...next, tabId } });
    else await chrome.storage.session.remove(sessionKey(tabId));
    if (next && BUSY_STATUS.has(next.status)) busyTabs.add(tabId); else busyTabs.delete(tabId);
    broadcast({ type: 'session', tabId, session: next ? { ...next, tabId } : null });
    return next ? { ...next, tabId } : null;
  });
}
/** Merges a patch; with runId, only into that run (throws `stale` when the user moved on). */
const patchSession = (tabId, patch, runId) => updateSession(tabId, cur => {
  if (runId && (!cur || cur.runId !== runId)) throw stale();
  return { ...(cur || {}), ...patch };
});

// Runs that are alive in this worker. A "thinking" session whose run is not here died with an old worker.
const liveRuns = new Set();
const inflight = new Map(); // runId -> { tabId, ctl }
function abortTab(tabId) {
  for (const [runId, f] of inflight) if (f.tabId === tabId) { f.ctl.abort(); inflight.delete(runId); }
}
function controller(tabId, runId) {
  const ctl = new AbortController();
  inflight.set(runId + ':' + Math.random().toString(36).slice(2), { tabId, ctl });
  return ctl;
}
function release(ctl) { for (const [k, f] of inflight) if (f.ctl === ctl) inflight.delete(k); }

/** Starts a new run for the tab: older answers, replans and heals for it become stale. */
async function beginRun(tabId, base) {
  abortTab(tabId);
  const runId = crypto.randomUUID();
  liveRuns.add(runId);
  const prev = await getSession(tabId);
  await updateSession(tabId, () => ({ history: (prev && prev.history) || [], ...base, runId, startedAt: Date.now(), error: null, suggestions: null, replanned: [], replans: 0, heals: 0, pendingHeals: {} }));
  return runId;
}

// ---------- other storage ----------
const pbKey = origin => `playbooks:${origin}`;
const getPlaybooks = async origin => (await chrome.storage.local.get(pbKey(origin)))[pbKey(origin)] || [];
const updatePlaybooks = (origin, fn) => locked(pbKey(origin), async () => {
  const next = await fn(await getPlaybooks(origin));
  if (next) await chrome.storage.local.set({ [pbKey(origin)]: next });
  return next;
});
const mapKey = origin => `map:${origin}`;
const getMap = async origin => (await chrome.storage.local.get(mapKey(origin)))[mapKey(origin)] || null;
const getKey = async () => (await chrome.storage.local.get('apiKey')).apiKey || '';
const exploreKey = tabId => `explore:${tabId}`;
const learnTabKey = tabId => `learnTab:${tabId}`;

// ---------- who pays for Claude: the extension's own key, else the local Scopos server as a proxy ----------
const DEV_SERVER = 'http://localhost:4173';
const PROXY_TTL_MS = 30e3;
const devServer = async () => {
  const v = (await chrome.storage.local.get('devServer')).devServer;
  return typeof v === 'string' && /^https?:\/\/[^\s/]+$/i.test(v.trim().replace(/\/+$/, '')) ? v.trim().replace(/\/+$/, '') : DEV_SERVER;
};
// brain.js forwards opts.endpoint (and sends no auth headers with an empty key) once it supports the proxy.
const proxyCapable = () => typeof Brain.call === 'function' && /\bendpoint\b/.test(String(Brain.call));
let proxyCache = null; // { server, at, endpoint | null }
/** The local server's Claude proxy, or null. One cheap GET (1.5 s timeout), remembered for 30 s. */
async function proxyEndpoint({ fresh = false } = {}) {
  if (!proxyCapable()) return null;
  const server = await devServer();
  if (!fresh && proxyCache && proxyCache.server === server && Date.now() - proxyCache.at < PROXY_TTL_MS) return proxyCache.endpoint;
  let endpoint = null;
  try {
    const res = await fetch(server + '/api/ext/version', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      let info = {};
      try { info = await res.json(); } catch (e) { info = {}; }
      // A server that says outright it has no Claude key (or no proxy) is not a proxy.
      if (!(info && (info.claude === false || info.hasKey === false || info.proxy === false))) endpoint = server + '/api/claude';
    }
  } catch (e) { endpoint = null; }
  proxyCache = { server, at: Date.now(), endpoint };
  return endpoint;
}
/** { key, endpoint?, mode: 'own' | 'proxy' } or null when nobody can pay for a Claude call. */
async function auth() {
  const key = await getKey();
  if (key) return { key, mode: 'own' };
  const endpoint = await proxyEndpoint();
  return endpoint ? { key: '', endpoint, mode: 'proxy' } : null;
}
/** Every Claude call goes through here: the right credentials, and this month's spend recorded. */
async function claude(body, a, origin, opts = {}) {
  const o = { ...opts, onUsage: (u, m) => { recordUsage(origin, u, m); if (opts.onUsage) opts.onUsage(u, m); } };
  if (a.endpoint) o.endpoint = a.endpoint;
  try { return await Brain.call(body, a.key, o); } catch (e) {
    if (a.mode === 'proxy' && !(e && e.name === 'AbortError')) throw proxyError(e);
    throw e;
  }
}
/**
 * brain.js words an HTTP error as «Claude API ответил ошибкой <status>: <message>.»; from the local server the
 * status means something else, and its message is already Russian ({ error: { type, message } }).
 */
function proxyError(e) {
  const msg = String((e && e.message) || e || '');
  const m = /ошибкой (\d{3})(?::\s*([\s\S]+?))?\.?$/.exec(msg);
  if (!m) return e;
  const status = +m[1], said = (m[2] || '').trim();
  if (status === 402) {
    // budget_exceeded (the server's monthly budget) or daily_limit (its calls per day).
    return coded('budget', (said ? said.replace(/\.?$/, '.') : 'Лимит локального сервера Scopos на Claude исчерпан.') + (/гайд/i.test(said) ? '' : ' Готовые гайды и ответы из кэша работают как обычно.'));
  }
  proxyCache = null; // look at the server again next time
  if (status === 503) return coded('key', 'У локального сервера Scopos нет ключа Claude. Вставьте ключ на его странице /setup или добавьте свой ключ в настройках.');
  if (status === 404 || status === 405) return coded('key', 'Этот сервер Scopos не умеет передавать запросы Claude. Обновите его или добавьте свой ключ в настройках.');
  if (status === 403) return coded('key', 'Локальный сервер Scopos не принял запрос от расширения. Добавьте свой ключ в настройках.');
  return said ? new Error(`Локальный сервер Scopos: ${said.replace(/\.?$/, '.')}`) : e;
}
const NO_AUTH = 'Добавьте ключ Anthropic API в настройках или запустите локальный сервер Scopos с ключом, и Scopos начнёт отвечать. Готовые гайды работают и без него.';

// ---------- monthly budget: every Claude call counts, over the limit only guides and the cache answer ----------
const DEFAULT_LIMIT = 2;
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
async function monthLimit() {
  const v = (await chrome.storage.local.get('monthlyLimit')).monthlyLimit;
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
}
async function monthSpend() {
  const u = (await chrome.storage.local.get('usage')).usage;
  return (u && u.months && u.months[monthKey()] && u.months[monthKey()].cost) || 0;
}
const overBudget = async () => (await monthSpend()) >= (await monthLimit());
const fmtUsd = n => '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
const budgetMessage = async () => `Лимит на этот месяц (${fmtUsd(await monthLimit())}) израсходован. Готовые гайды и ответы из кэша работают как обычно, новые вопросы Claude подождут до следующего месяца. Лимит можно поднять в настройках.`;
const autoGuidesOn = async () => (await chrome.storage.local.get('autoGuides')).autoGuides !== false;

chrome.tabs.onRemoved.addListener(async tabId => {
  busyTabs.delete(tabId); busyExplore.delete(tabId);
  abortTab(tabId);
  netUnblock(tabId); // hoisted; the explorer's network block dies with its tab
  const k = learnTabKey(tabId);
  const origin = (await chrome.storage.session.get(k))[k];
  await chrome.storage.session.remove([sessionKey(tabId), exploreKey(tabId), k]).catch(() => {});
  if (origin) await updateLearn(origin, cur => (cur && cur.status === 'exploring' && cur.tabId === tabId ? { ...cur, status: 'error', error: 'Вкладку закрыли, изучение прервалось. Запустите его заново.' } : undefined)).catch(() => {});
});

// ---------- keep the worker alive while a long call runs ----------
let keepers = 0, keepTimer = 0;
function keepAlive() {
  keepers++;
  if (!keepTimer) {
    keepTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20e3);
    if (chrome.alarms) chrome.alarms.create('scopos-keepalive', { periodInMinutes: 0.5 }).catch(() => {});
  }
  let done = false;
  return () => {
    if (done) return; done = true;
    if (--keepers > 0) return;
    keepers = 0; clearInterval(keepTimer); keepTimer = 0;
    if (chrome.alarms) chrome.alarms.clear('scopos-keepalive').catch(() => {});
  };
}
if (chrome.alarms) chrome.alarms.onAlarm.addListener(() => { /* waking the worker is the point */ });

// ---------- talking to the page ----------
// Errors carry a code the panel acts on: 'access' (offer «Разрешить доступ»), 'restricted', 'file', 'loading', 'closed', 'inject'.
const coded = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {});
const MSG = {
  access: 'Нет доступа к этому сайту. Chrome не разрешает Scopos читать эту страницу: в настройках расширения доступ к сайтам стоит «по клику» или «на выбранных сайтах». Нажмите «Разрешить доступ».',
  restricted: 'Это служебная страница браузера (chrome://, магазин расширений, страница новой вкладки). На таких страницах Chrome не даёт расширениям работать. Откройте сайт продукта.',
  file: 'Чтобы Scopos работал с локальными файлами, откройте chrome://extensions, у Scopos нажмите «Подробнее» и включите «Разрешить доступ к URL файлов». Потом обновите эту страницу.',
  loading: 'Страница ещё загружается или только что сменилась. Подождите секунду и попробуйте снова.',
  errorPage: 'Страница не загрузилась (Chrome показывает свою страницу ошибки). Обновите её и попробуйте снова.',
  closed: 'Вкладка закрыта.',
  inject: 'Scopos не успел запуститься на этой странице. Обновите её (F5) и попробуйте снова.',
};
const isRestricted = url => /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|brave|opera|vivaldi|about|view-source|data|blob|javascript):/i.test(url || '') ||
  /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url || '');
/** Maps Chrome's own messages to what the user can do about them. */
function chromeError(e, { url = '', injected = false } = {}) {
  const m = String((e && e.message) || e || '');
  const origin = originOf(url);
  if (/No tab with id|tab was closed/i.test(m)) return coded('closed', MSG.closed);
  if (/Cannot access a chrome(-extension)?:\/\/ URL|extensions gallery cannot be scripted|cannot be scripted|Cannot access a .*:\/\/ URL/i.test(m)) return coded('restricted', MSG.restricted);
  if (/^file:/i.test(url) && /Cannot access contents|must request permission|permission/i.test(m)) return coded('file', MSG.file);
  if (/showing error page|error page/i.test(m)) return coded('loading', MSG.errorPage);
  if (/Cannot access contents of (the page|url)|must request permission|Missing host permission/i.test(m)) return coded('access', MSG.access, { origin });
  if (/Frame with ID .* (was removed|is not)|frame was removed|No frame with id|back\/forward cache|navigat|document.*(unloaded|changed)|message channel closed|message port closed/i.test(m)) return coded('loading', MSG.loading);
  if (/Receiving end does not exist|Could not establish connection/i.test(m)) return injected ? coded('inject', MSG.inject) : coded('loading', MSG.loading);
  return coded('inject', 'На этой странице Scopos не может работать. Обновите страницу или откройте другой сайт.');
}
const originOf = url => { try { const o = new URL(url).origin; return o === 'null' ? '' : o; } catch (e) { return ''; } };
const usable = url => /^(https?|file):/.test(url || '') && !isRestricted(url);

/** Throws a coded error when Chrome will not let the extension into this tab's page. */
async function ensureAccess(tab) {
  const url = (tab && (tab.url || tab.pendingUrl)) || '';
  if (!url || isRestricted(url) || !/^(https?|file):/i.test(url)) throw coded('restricted', MSG.restricted);
  if (/^file:/i.test(url)) {
    let ok = true;
    try { ok = await chrome.extension.isAllowedFileSchemeAccess(); } catch (e) { ok = true; }
    if (!ok) throw coded('file', MSG.file);
    return;
  }
  const origin = originOf(url);
  let ok = true;
  try { ok = await chrome.permissions.contains({ origins: [origin + '/*'] }); } catch (e) { ok = true; }
  if (!ok) throw coded('access', MSG.access, { origin });
}

const ping = tabId => chrome.tabs.sendMessage(tabId, { type: 'ping' }, { frameId: 0 }).then(r => !!r, () => false);
/**
 * Sends a message to the tab's content script. Tabs opened before the extension was (re)loaded have no live
 * copy: the access check runs first, then the scripts are injected (a second copy next to a live one stays out).
 */
async function toTab(tabId, msg) {
  let tab = null, injected = false;
  if (!(await ping(tabId))) {
    try { tab = await chrome.tabs.get(tabId); } catch (e) { throw coded('closed', MSG.closed); }
    await ensureAccess(tab);
    try { await chrome.scripting.executeScript({ target: { tabId }, files: CORE_FILES }); } catch (e) { throw chromeError(e, { url: tab.url }); }
    injected = true;
    if (msg.type === 'ping') {
      if (await ping(tabId)) return { ok: true };
      throw coded('inject', MSG.inject);
    }
  }
  try { return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }); } catch (e) {
    if (!tab) tab = await chrome.tabs.get(tabId).catch(() => null);
    throw chromeError(e, { url: tab ? tab.url : '', injected });
  }
}
/** The panel's access check: a live content script is enough; otherwise what ensureAccess says. */
async function accessState(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (e) { return { ok: false, code: 'closed', message: MSG.closed }; }
  if (usable(tab.url) && (await ping(tabId))) return { ok: true, origin: originOf(tab.url) };
  try { await ensureAccess(tab); return { ok: true, origin: originOf(tab.url) }; } catch (e) { return { ok: false, code: e.code, message: e.message, origin: e.origin || originOf(tab.url) }; }
}
/** "/invoices/42#/x" -> "/invoices/:id#/x": record pages share one cache entry. */
function pathTemplate(url) {
  try {
    const u = new URL(url);
    const fix = s => s.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,})(?=\/|$|\?)/gi, '/:id');
    return fix(u.pathname) + (u.hash && u.hash !== '#' && u.hash !== '#/' ? fix(u.hash) : '');
  } catch (e) { return ''; }
}

// ---------- local intent matcher: a question that names a saved guide runs it with 0 tokens ----------
const STOP = new Set(['как', 'где', 'мне', 'можно', 'сделать', 'это', 'хочу', 'нужно', 'надо', 'что', 'чтобы', 'свой', 'свою', 'мой', 'мою', 'пожалуйста', 'how', 'the', 'can', 'where', 'what', 'and', 'want', 'need']);
const ACTION = ['отмен', 'удал', 'измен', 'выключ', 'отключ', 'убра', 'убер', 'смен', 'помен', 'cancel', 'delet', 'remov', 'edit', 'chang', 'disabl', 'turn off'];
function stems(s) {
  return Brain.norm(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .map(w => { let x = w; for (let i = 0; i < 2 && x.length > 4 && /[аеиоуыэюяйь]$/.test(x); i++) x = x.slice(0, -1); return x.slice(0, 6); });
}
const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
const coverage = (from, to) => (from.length ? from.filter(w => to.some(t => same(w, t))).length / from.length : 0);
function actions(s) { const n = ' ' + Brain.norm(s) + ' '; return new Set(ACTION.filter(a => n.includes(' ' + a))); }
/** { run: guide | null, suggest: [guide] }: run only when both directions agree and no action verb differs. */
function matchGuides(question, list) {
  const q = stems(question), qa = actions(question);
  const scored = [];
  for (const pb of list) {
    const n = stems(pb.name);
    if (!n.length || !q.length) continue;
    const toQ = coverage(n, q), toN = coverage(q, n);
    const na = actions(pb.name);
    const verbClash = [...qa].some(a => !na.has(a)) || [...na].some(a => !qa.has(a));
    scored.push({ pb, toQ, toN, score: (toQ + toN) / 2, sure: toQ >= 0.75 && toN >= 0.6 && !verbClash });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.find(s => s.sure);
  if (best && best === scored[0]) return { run: best.pb, suggest: [] };
  return { run: null, suggest: scored.filter(s => s.score >= 0.4 || s.sure).slice(0, 3).map(s => s.pb) };
}

// ---------- answer cache: the same question on the same screen replays instantly ----------
const answersKey = origin => `answers:${origin}`;
const cacheKey = (question, origin, where, learnedAt) => [Brain.norm(question), origin, where || '', learnedAt || ''].join('|');
async function cacheGet(origin, k) {
  const list = (await chrome.storage.local.get(answersKey(origin)))[answersKey(origin)] || [];
  const hit = list.find(a => a.k === k && Date.now() - a.at < ANSWER_TTL_MS);
  return hit || null;
}
function cachePut(origin, k, value) {
  return locked(answersKey(origin), async () => {
    const list = (await chrome.storage.local.get(answersKey(origin)))[answersKey(origin)] || [];
    const next = [{ k, ...value, at: Date.now() }, ...list.filter(a => a.k !== k)].slice(0, ANSWERS_MAX);
    await chrome.storage.local.set({ [answersKey(origin)]: next });
  }).catch(() => {});
}
const cacheDrop = (origin, k) => locked(answersKey(origin), async () => {
  const list = (await chrome.storage.local.get(answersKey(origin)))[answersKey(origin)] || [];
  await chrome.storage.local.set({ [answersKey(origin)]: list.filter(a => a.k !== k) });
}).catch(() => {});
const cacheClear = origin => chrome.storage.local.remove(answersKey(origin)).catch(() => {});
// A follow-up like "а где это?" depends on the conversation, so it is neither cached nor read from cache.
const selfContained = (question, history) => !history.length || stems(question).length >= 3;

// ---------- token usage: running totals per site, shown in Settings ----------
const PRICE = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] }; // $ per 1M tokens, in / out
function costOf(u, model) {
  const [pi, po] = PRICE[model] || PRICE['claude-opus-5-5'];
  return ((u.input_tokens || 0) * pi + (u.cache_creation_input_tokens || 0) * pi * 2 + (u.cache_read_input_tokens || 0) * pi * 0.1 + (u.output_tokens || 0) * po) / 1e6;
}
function recordUsage(origin, u, model) {
  if (!u) return;
  const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
  const cost = costOf(u, model);
  locked('usage', async () => {
    const all = (await chrome.storage.local.get('usage')).usage || { total: { tokens: 0, cost: 0, calls: 0 }, origins: {} };
    const o = all.origins[origin] || { tokens: 0, cost: 0, calls: 0, cacheHits: 0 };
    o.tokens += tokens; o.cost += cost; o.calls++;
    all.origins[origin] = o;
    all.total.tokens += tokens; all.total.cost += cost; all.total.calls++;
    // Per calendar month, for the monthly limit. Kept for a year.
    const mk = monthKey();
    all.months = all.months || {};
    const mo = all.months[mk] || { tokens: 0, cost: 0, calls: 0 };
    mo.tokens += tokens; mo.cost += cost; mo.calls++;
    all.months[mk] = mo;
    const keep = Object.keys(all.months).sort().slice(-12);
    all.months = Object.fromEntries(keep.map(k => [k, all.months[k]]));
    await chrome.storage.local.set({ usage: all });
  }).catch(() => {});
}
function countCacheHit(origin) {
  locked('usage', async () => {
    const all = (await chrome.storage.local.get('usage')).usage || { total: { tokens: 0, cost: 0, calls: 0 }, origins: {} };
    const o = all.origins[origin] || { tokens: 0, cost: 0, calls: 0, cacheHits: 0 };
    o.cacheHits = (o.cacheHits || 0) + 1;
    all.origins[origin] = o;
    await chrome.storage.local.set({ usage: all });
  }).catch(() => {});
}

// Streams "Пишу шаги…" to the panel: characters so far, steps closed so far and the answer sentence once it is readable.
function progressTo(tabId, runId) {
  let last = 0;
  return text => {
    const now = Date.now();
    if (now - last < 180) return;
    last = now;
    let answer = '';
    const m = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"?/);
    if (m) { try { answer = JSON.parse('"' + m[1].replace(/\\$/, '') + '"'); } catch (e) { answer = ''; } }
    const steps = (text.match(/"instruction"\s*:\s*"(?:[^"\\]|\\.)*"/g) || []).length;
    broadcast({ type: 'progress', tabId, runId, chars: text.length, steps, answer });
  };
}

const pushHistory = (history, question, answer) => [...history, { role: 'user', content: String(question).slice(0, 600) }, { role: 'assistant', content: String(answer || '').slice(0, 600) }].slice(-6);
const delayFor = via => (via === 'claude' ? 1200 : 2500);

// ---------- the ask flow ----------
async function ask(tabId, question, { force = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!usable(tab.url)) throw /^file:/i.test(tab.url || '') ? coded('file', MSG.file) : coded('restricted', MSG.restricted);
  const origin = originOf(tab.url);
  const t0 = Date.now();
  const runId = await beginRun(tabId, { question, answer: '', steps: [], index: 0, status: 'thinking', source: 'claude', origin });
  const live = async () => { const s = await getSession(tabId); if (!s || s.runId !== runId) throw stale(); };
  const done = keepAlive();
  try {
    await toTab(tabId, { type: 'ping' }); // no access, or no way in: say so now, before any tokens are spent
    await toTab(tabId, { type: 'guide:stop' }).catch(() => {});
    const prev = await getSession(tabId);
    const history = (prev && prev.history) || [];

    // 1. A saved or learned guide with the same intent: run it, 0 tokens.
    if (!force) {
      const m = matchGuides(question, await getPlaybooks(origin));
      if (m.run) {
        bumpRuns(origin, m.run.id);
        return await start(tabId, runId, { question, answer: `Сценарий «${m.run.name}»`, steps: m.run.steps, source: 'playbook', via: 'playbook', playbookId: m.run.id, live: !!m.run.live, ms: Date.now() - t0, origin });
      }
      if (m.suggest.length) return await patchSession(tabId, { status: 'suggest', suggestions: m.suggest.map(p => ({ id: p.id, name: p.name })), ms: Date.now() - t0 }, runId);
    }

    // 2. The same question on the same screen was answered before: replay it, 0 tokens.
    const map = await getMap(origin);
    const view = map ? Brain.viewOf(map, tab.url) : null;
    const k = cacheKey(question, origin, view || pathTemplate(tab.url), map && map.learnedAt);
    const cacheable = selfContained(question, history);
    if (cacheable) {
      const hit = await cacheGet(origin, k);
      if (hit) {
        countCacheHit(origin);
        return await start(tabId, runId, { question, answer: hit.answer, steps: hit.steps, source: 'cache', via: hit.via, cacheKey: k, ms: Date.now() - t0, origin, history: pushHistory(history, question, hit.answer) });
      }
    }

    // 3. Ask Claude, within this month's limit.
    if (await overBudget()) throw coded('budget', await budgetMessage());
    const a = await auth();
    if (!a) throw coded('key', NO_AUTH);
    const ctl = controller(tabId, runId);
    try {
      const opts = { signal: ctl.signal, onText: progressTo(tabId, runId) };
      let out, steps, via;
      if (map) {
        // A learned product map: plan across every screen at once, with exact controls.
        out = await claude(Brain.buildAskMap({ question, map, current: view, history }), a, origin, opts);
        steps = Brain.refSteps(out.steps || [], map, question);
        via = 'map';
      } else {
        const page = await toTab(tabId, { type: 'scan', query: question });
        await live();
        out = await claude(Brain.buildAsk({ question, page, history }), a, origin, opts);
        await live();
        steps = await pageSteps(tabId, out.steps, question);
        via = 'claude';
      }
      if (ctl.signal.aborted) throw aborted();
      await live();
      const answer = String(out.answer || '').slice(0, 600);
      if (cacheable) cachePut(origin, k, { answer, steps, via });
      return await start(tabId, runId, { question, answer, steps, source: via, via, cacheKey: k, ms: Date.now() - t0, origin, history: pushHistory(history, question, answer) });
    } finally { release(ctl); }
  } catch (e) {
    // Show the error on this run only; a newer question or a Stop owns the session now.
    if (!(e && (e.stale || e.name === 'AbortError'))) {
      const message = (e && e.message) || String(e);
      await updateSession(tabId, cur => (cur && cur.runId === runId ? { ...cur, status: 'error', error: message, errorCode: (e && e.code) || null, errorOrigin: (e && e.origin) || null } : undefined)).catch(() => {});
    }
    throw e;
  } finally {
    done();
    liveRuns.delete(runId);
  }
}

/** Claude's page-id steps ({ element_id, element_text, ... }) as runnable steps with descriptors read from the tab. */
async function pageSteps(tabId, raw, question) {
  const list = Array.isArray(raw) ? raw.filter(s => s && typeof s === 'object').slice(0, 30) : [];
  const ids = list.map(s => (Number.isInteger(s.element_id) ? s.element_id : null));
  const descriptors = ids.some(id => id != null) ? await toTab(tabId, { type: 'describe', ids }) : [];
  return list.map((s, i) => ({
    instruction: String(s.instruction || '').slice(0, 200),
    action: s.action,
    value: Brain.safeValue(s.value, question, null),
    target: (descriptors && descriptors[i]) || (s.element_text ? { sel: [], text: String(s.element_text).slice(0, 80), role: null } : null),
  }));
}

/** What the content script needs to run a session's steps (also on resume after a page load). */
const guideMsg = (s, index) => ({ type: 'guide:start', steps: s.steps, index, missingDelay: delayFor(s.via || s.source), live: !!s.live, name: s.question || '' });

async function start(tabId, runId, data) {
  const session = await patchSession(tabId, { ...data, live: !!data.live, index: 0, status: data.steps.length ? 'running' : 'answered', error: null, errorCode: null, suggestions: null, mores: {}, extended: false }, runId);
  if (data.steps.length) await toTab(tabId, guideMsg(session, 0));
  return session;
}

function bumpRuns(origin, id) {
  return updatePlaybooks(origin, list => {
    const pb = list.find(p => p.id === id);
    if (!pb) return null;
    pb.runs = (pb.runs || 0) + 1;
    return list;
  }).catch(() => {});
}

async function runPlaybook(tabId, origin, id) {
  const pb = (await getPlaybooks(origin)).find(p => p.id === id);
  if (!pb) throw new Error('Сценарий не найден. Возможно, его удалили.');
  const runId = await beginRun(tabId, { question: pb.name, answer: '', steps: [], index: 0, status: 'thinking', source: 'playbook', origin });
  try {
    await toTab(tabId, { type: 'ping' });
    await toTab(tabId, { type: 'guide:stop' }).catch(() => {});
    bumpRuns(origin, pb.id);
    return await start(tabId, runId, { question: pb.name, answer: `Сценарий «${pb.name}»`, steps: pb.steps, source: 'playbook', via: 'playbook', playbookId: pb.id, live: !!pb.live, ms: 0, origin });
  } catch (e) {
    if (!e.stale) await updateSession(tabId, cur => (cur && cur.runId === runId ? { ...cur, status: 'error', error: e.message || String(e), errorCode: e.code || null, errorOrigin: e.origin || null } : undefined)).catch(() => {});
    throw e;
  } finally { liveRuns.delete(runId); }
}

// A Claude answer reached a page where its guessed control isn't: plan the remaining steps from this page.
async function replan(tabId, index, page) {
  const s = await getSession(tabId);
  if (!s || s.status !== 'running') return;
  const runId = s.runId;
  if (await overBudget()) return; // over the monthly limit: the guide just waits on this page
  const a = await auth();
  if (!a) return;
  let claimed = false;
  await updateSession(tabId, cur => {
    if (!cur || cur.runId !== runId || (cur.replanned || []).includes(index) || (cur.replans || 0) >= MAX_REPLANS) return undefined;
    claimed = true;
    return { ...cur, replanned: [...(cur.replanned || []), index], replans: (cur.replans || 0) + 1, replanning: true };
  });
  if (!claimed) return;
  const ctl = controller(tabId, runId);
  const done = keepAlive();
  try {
    const progress = s.steps.slice(0, index).map(st => st.instruction);
    // The session history already ends with this question and its answer; send only what came before.
    const history = (s.history || []).slice(0, -2);
    const out = await claude(Brain.buildAsk({ question: s.question, page, history, progress }), a, s.origin, { signal: ctl.signal });
    const cur = await getSession(tabId);
    if (!cur || cur.runId !== runId || cur.index !== index || ctl.signal.aborted) return;
    const rest = await pageSteps(tabId, out.steps, s.question);
    const steps = cur.steps.slice(0, index).concat(rest);
    if (!rest.length) {
      await toTab(tabId, { type: 'guide:stop' }).catch(() => {});
      await patchSession(tabId, { steps, index, status: 'done', replanning: false }, runId);
      return;
    }
    const next = await patchSession(tabId, { steps, replanning: false }, runId);
    await toTab(tabId, guideMsg(next, index));
  } catch (e) {
    if (!e.stale) await patchSession(tabId, { replanning: false }, runId).catch(() => {});
  } finally { release(ctl); done(); }
}

// The UI changed and a saved step's control can't be found on its own page: Haiku picks it among the likely candidates.
async function heal(tabId, msg) {
  const s = await getSession(tabId);
  if (!s || s.status !== 'running' || (s.heals || 0) >= MAX_HEALS) return { id: null };
  if (await overBudget()) return { id: null, budget: true };
  const a = await auth();
  if (!a) return { id: null };
  const runId = s.runId;
  await patchSession(tabId, { heals: (s.heals || 0) + 1 }, runId);
  const ctl = controller(tabId, runId);
  try {
    const step = msg.step || {};
    const candidates = Array.isArray(msg.candidates) ? msg.candidates.filter(Number.isInteger).slice(0, 8) : [];
    // The map's record of this screen (when the product was learned) tells Haiku what the control used to sit among.
    const view = await mapViewFor(s.origin, msg.url);
    const out = await claude(Brain.buildLocate({ instruction: step.instruction, oldText: step.target && step.target.text, page: msg.page, candidates, view }), a, s.origin, { signal: ctl.signal });
    const cur = await getSession(tabId);
    if (!cur || cur.runId !== runId) return { id: null };
    return { id: Number.isInteger(out.element_id) ? out.element_id : null };
  } finally { release(ctl); }
}

/** A compact copy of the map view for this address: title and control labels, no descriptors. */
async function mapViewFor(origin, url) {
  if (!origin || !url) return null;
  const map = await getMap(origin).catch(() => null);
  if (!map || !Array.isArray(map.views)) return null;
  const id = Brain.viewOf(map, url);
  const v = id && map.views.find(x => x.id === id);
  if (!v) return null;
  return { id: v.id, key: v.key, title: v.title, controls: (v.controls || []).slice(0, 120).map(c => ({ ref: c.ref, role: c.role, name: c.row && c.rowLabel ? c.rowLabel : c.name, section: c.section })) };
}

// ---------- continuing a guide past its end (a live guide) or past a step it can't find ----------
const MAX_DONE = 30;
/**
 * The guide asks for more: reason 'end' (a live guide ran out of steps) or 'missing' (step `index` isn't here).
 * One call per reason per run, on the ask model, from the current page. Returns { steps } (page descriptors) or
 * { steps: null }. The session's steps become steps[0..index) + the new ones, so a page load resumes on them.
 */
async function continueGuide(tabId, msg) {
  const s = await getSession(tabId);
  if (!s || s.status !== 'running' || !Array.isArray(s.steps)) return { steps: null };
  if (typeof Brain.buildContinue !== 'function') return { steps: null };
  const reason = msg.reason === 'missing' ? 'missing' : 'end';
  // A Claude answer that is already being re-planned from this page (guide:missing → replan) needs no second call.
  if (reason === 'missing' && (s.replanning || (s.replanned || []).includes(msg.index))) return { steps: null };
  if (await overBudget()) return { steps: null, budget: true };
  const a = await auth();
  if (!a) return { steps: null };
  const runId = s.runId;
  let claimed = false;
  await updateSession(tabId, cur => {
    if (!cur || cur.runId !== runId || (cur.mores || {})[reason]) return undefined;
    claimed = true;
    return { ...cur, mores: { ...(cur.mores || {}), [reason]: true }, continuing: true };
  });
  if (!claimed) return { steps: null };
  const ctl = controller(tabId, runId);
  const done = keepAlive();
  try {
    const doneList = (Array.isArray(msg.done) ? msg.done : s.steps.slice(0, msg.index).map(st => st.instruction))
      .filter(x => typeof x === 'string').slice(-MAX_DONE).map(x => x.slice(0, 200));
    const question = String(msg.name || s.question || '').slice(0, 600);
    const out = await claude(Brain.buildContinue({ question, page: msg.page, done: doneList, product: '' }), a, s.origin, { signal: ctl.signal });
    const cur = await getSession(tabId);
    if (!cur || cur.runId !== runId || ctl.signal.aborted) return { steps: null };
    const rest = await pageSteps(tabId, out.steps, question);
    const at = Math.max(0, Math.min(Number.isInteger(msg.index) ? msg.index : cur.steps.length, cur.steps.length));
    if (!rest.length) {
      await patchSession(tabId, { continuing: false }, runId);
      // Nothing left to do after the end: this learned guide is complete as it is.
      if (reason === 'end' && cur.source === 'playbook' && cur.playbookId) await setPlaybookLive(cur.origin, cur.playbookId, false);
      return { steps: [] };
    }
    await patchSession(tabId, { steps: cur.steps.slice(0, at).concat(rest), continuing: false, extended: true }, runId);
    return { steps: rest };
  } catch (e) {
    if (!e.stale) await patchSession(tabId, { continuing: false }, runId).catch(() => {});
    return { steps: null };
  } finally { release(ctl); done(); }
}

const setPlaybookLive = (origin, id, live) => updatePlaybooks(origin, list => {
  const pb = list.find(p => p.id === id);
  if (!pb || !!pb.live === live) return null;
  pb.live = live;
  return list;
}).catch(() => {});

/** Steps reported by the page at the end of a guide, reduced to the shape a stored step has. */
function cleanSteps(list) {
  if (!Array.isArray(list) || !list.length || list.length > 60) return null;
  const out = [];
  for (const st of list) {
    if (!st || typeof st !== 'object' || typeof st.instruction !== 'string') return null;
    out.push({ instruction: st.instruction.slice(0, 200), action: typeof st.action === 'string' ? st.action.slice(0, 20) : 'click', value: st.value == null ? null : String(st.value).slice(0, 200), target: st.target && typeof st.target === 'object' ? st.target : null });
  }
  return out;
}

/** A guide that was extended this run finished: the longer version becomes the saved guide (complete and free next time). */
async function saveExtended(session, reported) {
  if (!session || session.source !== 'playbook' || !session.playbookId || !session.extended) return;
  const steps = cleanSteps(reported) || cleanSteps(session.steps);
  if (!steps) return;
  const last = steps[steps.length - 1];
  await updatePlaybooks(session.origin, list => {
    const pb = list.find(p => p.id === session.playbookId);
    if (!pb) return null;
    pb.steps = steps;
    pb.extendedAt = Date.now();
    if (last && last.action === 'click') pb.live = false;
    return list;
  });
}

// A re-found control is used for this run at once, but written into the saved guide only after the user
// completes that step: a wrong guess never corrupts a scenario.
function storeHealed(tabId, index, target) {
  return updateSession(tabId, cur => {
    if (!cur || !cur.steps || !cur.steps[index] || !target) return undefined;
    const steps = cur.steps.map((st, i) => (i === index ? { ...st, target } : st));
    const pendingHeals = cur.source === 'playbook' && cur.playbookId ? { ...(cur.pendingHeals || {}), [index]: target } : cur.pendingHeals || {};
    return { ...cur, steps, pendingHeals };
  });
}
async function commitHeals(session, upto) {
  const pending = session && session.pendingHeals;
  if (!pending || session.source !== 'playbook' || !session.playbookId) return;
  const ready = Object.keys(pending).map(Number).filter(i => i < upto);
  if (!ready.length) return;
  await updatePlaybooks(session.origin, list => {
    const pb = list.find(p => p.id === session.playbookId);
    if (!pb) return null;
    ready.forEach(i => { if (pb.steps[i]) { pb.steps[i] = { ...pb.steps[i], target: pending[i] }; pb.healed = (pb.healed || 0) + 1; } });
    return list;
  });
  await updateSession(session.tabId, cur => {
    if (!cur || cur.runId !== session.runId) return undefined;
    const left = { ...(cur.pendingHeals || {}) };
    ready.forEach(i => delete left[i]);
    return { ...cur, pendingHeals: left };
  });
}

// ---------- learning: the explorer walks the product, then Claude writes guides from the map ----------
const learnKey = origin => `learn:${origin}`;
const learnCtl = new Map(); // origin -> AbortController of the guide-writing call
const readLearnRaw = async origin => (await chrome.storage.local.get(learnKey(origin)))[learnKey(origin)] || null;
function updateLearn(origin, fn) {
  return locked(learnKey(origin), async () => {
    const cur = await readLearnRaw(origin);
    const next = await fn(cur);
    if (next === undefined) return cur;
    if (next) await chrome.storage.local.set({ [learnKey(origin)]: next });
    else await chrome.storage.local.remove(learnKey(origin));
    if (cur && cur.tabId != null && !(next && next.status === 'exploring' && next.tabId === cur.tabId)) busyExplore.delete(cur.tabId);
    if (next && next.status === 'exploring' && next.tabId != null) busyExplore.add(next.tabId);
    broadcast({ type: 'learn', origin, learn: next });
    return next;
  });
}
const setLearn = (origin, patch) => updateLearn(origin, cur => ({ ...(cur || {}), ...patch }));

/** The learn state, with dead runs (closed tab, killed worker, no heartbeat for 4 min) turned into errors. */
async function readLearn(origin) {
  const cur = await readLearnRaw(origin);
  if (!cur || (cur.status !== 'exploring' && cur.status !== 'writing')) return cur;
  const beat = cur.heartbeatAt || cur.startedAt || 0;
  let dead = Date.now() - beat > LEARN_STALE_MS;
  if (cur.status === 'writing' && !learnCtl.has(origin)) dead = true; // the worker that was writing is gone
  if (cur.status === 'exploring' && cur.tabId != null) { try { await chrome.tabs.get(cur.tabId); } catch (e) { dead = true; } }
  if (!dead) return cur;
  if (cur.status === 'exploring' && cur.tabId != null) await netUnblock(cur.tabId);
  return updateLearn(origin, c => (c && c.status === cur.status ? { ...c, status: 'error', error: 'Изучение прервалось. Запустите его заново.' } : undefined));
}
const learnBusy = L => !!L && (L.status === 'exploring' || L.status === 'writing');

/** Learned guides: every referenced control must exist in the map, and a guide needs at least one pointer. */
function learnedGuides(out, map) {
  const refs = new Set();
  map.views.forEach(v => v.controls.forEach(c => refs.add(c.ref)));
  const all = Array.isArray(out.guides) ? out.guides : [];
  const guides = all
    .filter(g => g && g.name && Array.isArray(g.steps) && g.steps.length && g.steps.every(st => !st.element_ref || refs.has(st.element_ref)))
    .map(g => ({ id: crypto.randomUUID(), name: String(g.name).slice(0, 90), steps: Brain.refSteps(g.steps, map, g.name), created: Date.now(), runs: 0, learned: true }))
    .filter(g => g.steps.some(st => st.target));
  return { guides, dropped: all.length - guides.length };
}

/** Steps from finishGuides may already be runnable ({ target }) or still ref-based ({ element_ref }). */
const runnableSteps = (steps, map, name) => (Array.isArray(steps) && steps.some(st => st && st.element_ref !== undefined && st.target === undefined) ? Brain.refSteps(steps, map, name) : steps || []);
const batchesReady = () => typeof Brain.buildLearnBatches === 'function' && typeof Brain.finishGuides === 'function';

/**
 * Writes guides from a map in batches (buildLearnBatches → one call each → finishGuides). Stops early on abort or
 * when the monthly limit is reached; a later batch that fails keeps what the earlier ones wrote.
 * Returns { guides: [playbook], dropped, summary, error? }.
 */
async function writeGuides(origin, { map, guideMap, existing = [], a, ctl, onText, onBatch }) {
  const bodies = Brain.buildLearnBatches({ map: guideMap || map, product: '', existing }) || [];
  const raw = [];
  let summary = '', error = null, chars = 0;
  for (let i = 0; i < bodies.length; i++) {
    if (ctl.signal.aborted) throw aborted();
    if (await overBudget()) { error = await budgetMessage(); break; }
    if (onBatch) onBatch(i, bodies.length);
    try {
      const base = chars;
      const out = await claude(bodies[i], a, origin, { signal: ctl.signal, onText: onText && (t => onText(base + t.length)) });
      if (out && Array.isArray(out.guides)) raw.push(...out.guides);
      if (!summary && out && out.summary) summary = String(out.summary);
      chars = base + JSON.stringify(out || {}).length;
    } catch (e) {
      if (ctl.signal.aborted || !raw.length) throw e;
      error = (e && e.message) || String(e);
      break;
    }
  }
  const finished = Brain.finishGuides(raw, map) || [];
  const guides = finished
    .filter(g => g && g.name && Array.isArray(g.steps) && g.steps.length)
    .map(g => ({ id: crypto.randomUUID(), name: String(g.name).slice(0, 90), steps: runnableSteps(g.steps, map, g.name), created: Date.now(), runs: 0, learned: true, live: !!g.live }))
    .filter(g => g.steps.some(st => st && st.target));
  return { guides, dropped: Math.max(0, raw.length - guides.length), summary, error };
}

async function learnFrom(origin, map) {
  if (learnCtl.has(origin)) return; // one writer per site
  const ctl = new AbortController();
  learnCtl.set(origin, ctl);
  busyWriting.add(origin);
  const done = keepAlive();
  try {
    await chrome.storage.local.set({ [mapKey(origin)]: map });
    await chrome.storage.local.set({ [passiveKey(origin)]: { newViews: [], lastGuidesAt: Date.now() } });
    await cacheClear(origin); // answers were tied to the old map
    const views = map.views.length;
    if (await overBudget()) { await setLearn(origin, { status: 'mapped', views, probes: map.probes, at: Date.now(), error: 'Карта сохранена. ' + (await budgetMessage()) }); return; }
    const a = await auth();
    if (!a) { await setLearn(origin, { status: 'mapped', views, probes: map.probes, at: Date.now(), error: 'Карта сохранена. Чтобы Claude написал гайды, добавьте ключ в настройках или запустите локальный сервер Scopos с ключом.' }); return; }
    await setLearn(origin, { status: 'writing', views, probes: map.probes, chars: 0, batch: 0, batches: 0, startedAt: Date.now(), heartbeatAt: Date.now(), error: null });
    let lastMsg = 0, lastBeat = Date.now();
    const onChars = n => {
      const now = Date.now();
      if (now - lastMsg > 400) { lastMsg = now; broadcast({ type: 'learn:progress', origin, chars: n }); }
      if (now - lastBeat > 15e3) { lastBeat = now; setLearn(origin, { heartbeatAt: now, chars: n }).catch(() => {}); }
    };
    let guides, dropped, summary, note = null;
    if (batchesReady()) {
      const existing = (await getPlaybooks(origin)).filter(p => !p.learned).map(p => p.name);
      const r = await writeGuides(origin, { map, existing, a, ctl, onText: onChars, onBatch: (i, n) => setLearn(origin, { batch: i + 1, batches: n, heartbeatAt: Date.now() }).catch(() => {}) });
      ({ guides, dropped, summary } = r);
      note = r.error;
    } else {
      // Older brain.js: one call for every guide.
      const out = await claude(Brain.buildLearn({ map }), a, origin, { signal: ctl.signal, onText: t => onChars(t.length) });
      ({ guides, dropped } = learnedGuides(out, map));
      summary = String(out.summary || '');
    }
    if (ctl.signal.aborted) return;
    // Learned guides replace the previous learned set; scenarios the user recorded stay.
    await updatePlaybooks(origin, list => [...guides, ...list.filter(p => !p.learned)]);
    await setLearn(origin, { status: 'done', views, probes: map.probes, guides: guides.length, dropped, summary: String(summary || '').slice(0, 300), at: Date.now(), error: note ? 'Часть гайдов не дописана: ' + note : null, chars: 0, batch: 0, batches: 0 });
  } catch (e) {
    if (ctl.signal.aborted) return; // restarted or forgotten: that path owns the state
    await setLearn(origin, { status: 'error', error: (e && e.message) || String(e) }).catch(() => {});
  } finally {
    done();
    busyWriting.delete(origin);
    if (learnCtl.get(origin) === ctl) learnCtl.delete(origin);
  }
}

// ---------- passive learning: the map grows while the user browses, guides follow when there is enough new ----------
const passiveKey = origin => `passive:${origin}`;
const getPassive = async origin => (await chrome.storage.local.get(passiveKey(origin)))[passiveKey(origin)] || { newViews: [], lastGuidesAt: 0 };
const OBSERVE_EVERY_MS = 10 * 60 * 1000;
const AUTO_MIN_VIEWS = 3;
const AUTO_EVERY_MS = 24 * 3600 * 1000;
const observedAt = new Map(); // `${origin}|${key}` -> time (also kept in session storage across worker restarts)

/** Whether the page should take a snapshot now: a map exists, nothing runs in the tab, not seen in the last 10 min. */
async function observeWanted(tabId, url, key) {
  const origin = originOf(url);
  if (!origin || !/^https?:/.test(url) || typeof key !== 'string' || !key || key.length > 300) return false;
  if (!(await getMap(origin))) return false;
  const L = await readLearnRaw(origin);
  if (learnBusy(L) || learnCtl.has(origin)) return false;
  const s = await getSession(tabId);
  if (s && BUSY_STATUS.has(s.status)) return false;
  const k = `${origin}|${key}`;
  const store = (await chrome.storage.session.get('observed')).observed || {};
  const last = Math.max(observedAt.get(k) || 0, store[k] || 0);
  if (Date.now() - last < OBSERVE_EVERY_MS) return false;
  observedAt.set(k, Date.now());
  const now = Date.now();
  const next = Object.fromEntries(Object.entries({ ...store, [k]: now }).filter(([, t]) => now - t < OBSERVE_EVERY_MS));
  await chrome.storage.session.set({ observed: next }).catch(() => {});
  return true;
}

const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
/** A snapshot view from the page, reduced to the fields a map view has (page text is untrusted and unbounded). */
function cleanView(view, origin) {
  if (!view || typeof view !== 'object' || typeof view.key !== 'string' || !view.key || !Array.isArray(view.controls)) return null;
  if (view.url && originOf(view.url) !== origin) return null;
  const controls = view.controls.slice(0, 300).filter(c => c && typeof c === 'object' && typeof c.name === 'string').map(c => ({
    ref: cap(c.ref, 20), role: cap(c.role, 30), name: c.name.slice(0, 120), section: cap(c.section, 80), state: cap(c.state, 80),
    options: Array.isArray(c.options) ? c.options.filter(o => typeof o === 'string').slice(0, 30).map(o => o.slice(0, 60)) : undefined,
    d: c.d && typeof c.d === 'object' && JSON.stringify(c.d).length < 4000 ? c.d : undefined,
    to: cap(c.to, 20), href: cap(c.href || (c.d && c.d.href), 500),
    commit: c.commit === true ? true : undefined, unexplored: c.unexplored === true ? true : undefined,
    // One control per table row: the generic label, never a sample record's (rowOf travels inside d).
    row: c.row === true ? true : undefined, rowLabel: cap(c.rowLabel, 80),
  }));
  return {
    key: view.key.slice(0, 300), url: cap(view.url, 500) || '', kind: ['page', 'dialog', 'panel'].includes(view.kind) ? view.kind : 'page',
    title: cap(view.title, 120) || '', headings: Array.isArray(view.headings) ? view.headings.filter(h => typeof h === 'string').slice(0, 12).map(h => h.slice(0, 120)) : undefined,
    facts: Array.isArray(view.facts) ? view.facts.filter(f => typeof f === 'string').slice(0, 12).map(f => f.slice(0, 80)) : undefined,
    form: view.form === true ? true : undefined,
    controls,
  };
}

/**
 * Merges one observed page view into the stored map (pure, for tests): the same key keeps its id and takes the new
 * controls when there are at least as many; a new key is appended as V<max+1>. Refs become `<id>.<n>`, and a control
 * whose link points at a known page gets `to`. Returns { map, result: 'replaced' | 'added' | 'kept', id }.
 */
function mergeView(map, v) {
  const views = map.views.slice();
  const keyOf = href => { try { return Brain.pageKey(new URL(href, map.origin || undefined).href); } catch (e) { return null; } };
  const byKey = new Map(views.filter(x => x.kind === 'page').map(x => [x.key, x.id]));
  const ids = new Set(views.map(x => x.id));
  const withRefs = (id, list) => list.map((c, i) => {
    const out = { ...c, ref: `${id}.${i + 1}` };
    delete out.href;
    let to = c.to && ids.has(c.to) && c.to !== 'P' ? c.to : undefined;
    if (!to && c.href) { const k = keyOf(c.href); const hit = k && byKey.get(k); if (hit && hit !== id) to = hit; }
    if (to) out.to = to; else delete out.to;
    return out;
  });
  const kind = v.kind || 'page';
  const at = views.findIndex(x => (x.kind || 'page') === kind && x.key === v.key);
  if (at >= 0) {
    const old = views[at];
    if ((v.controls || []).length < (old.controls || []).length) return { map, result: 'kept', id: old.id };
    views[at] = { ...old, title: v.title || old.title, facts: v.facts || old.facts, headings: v.headings || old.headings, form: v.form || old.form, controls: withRefs(old.id, v.controls), seenAt: Date.now() };
    return { map: { ...map, views }, result: 'replaced', id: old.id };
  }
  const max = views.reduce((m, x) => { const n = /^V(\d+)$/.exec(x.id || ''); return n ? Math.max(m, +n[1]) : m; }, 0);
  const id = 'V' + (max + 1);
  ids.add(id);
  // A dialog snapshot's key is '<page key> › <title>': it hangs under that page when the page is known.
  const parent = kind === 'page' ? undefined : byKey.get(String(v.key).split(' › ')[0]);
  const pageTitle = parent ? (views.find(x => x.id === parent) || {}).title : v.title;
  views.push({ id, key: v.key, url: v.url, kind, parent, title: v.title, headings: v.headings, facts: v.facts, form: v.form, controls: withRefs(id, v.controls).map(c => (c.d ? { ...c, d: { ...c.d, view: pageTitle || v.title } } : c)), observed: true, seenAt: Date.now() });
  // Controls elsewhere that link to the new page now lead to it.
  if (kind === 'page') for (let i = 0; i < views.length - 1; i++) {
    const x = views[i];
    if (!(x.controls || []).some(c => !c.to && c.d && c.d.href && keyOf(c.d.href) === v.key)) continue;
    views[i] = { ...x, controls: x.controls.map(c => (!c.to && c.d && c.d.href && keyOf(c.d.href) === v.key ? { ...c, to: id } : c)) };
  }
  return { map: { ...map, views }, result: 'added', id };
}

async function observe(origin, view) {
  const v = cleanView(view, origin);
  if (!v) return { result: 'invalid' };
  const r = await locked(mapKey(origin), async () => {
    const map = await getMap(origin);
    if (!map || !Array.isArray(map.views)) return { result: 'nomap' };
    const m = mergeView(map, v);
    if (m.result !== 'kept') await chrome.storage.local.set({ [mapKey(origin)]: m.map });
    return m;
  });
  if (r.result !== 'added') return { result: r.result, id: r.id };
  const P = await locked(passiveKey(origin), async () => {
    const cur = await getPassive(origin);
    const next = { ...cur, newViews: [...new Set([...(cur.newViews || []), r.id])].slice(-50) };
    await chrome.storage.local.set({ [passiveKey(origin)]: next });
    return next;
  });
  maybeAutoGuides(origin).catch(() => {});
  return { result: 'added', id: r.id, newViews: P.newViews.length };
}

/** The new views, their dialogs and the first page (it carries the navigation every guide starts from). */
function subMap(map, ids) {
  const want = new Set(ids);
  const first = map.views.find(v => v.kind === 'page');
  return { ...map, views: map.views.filter(v => v === first || want.has(v.id) || (v.parent && want.has(v.parent))) };
}

function mergeLearned(old, fresh) {
  if (typeof Brain.mergeGuides === 'function') {
    const merged = Brain.mergeGuides(old, fresh);
    if (Array.isArray(merged)) return merged.filter(g => g && g.name && Array.isArray(g.steps)).map(g => ({ ...g, id: g.id || crypto.randomUUID(), learned: true, created: g.created || Date.now(), runs: g.runs || 0 }));
  }
  const names = new Set(old.map(g => Brain.norm(g.name)));
  return [...old, ...fresh.filter(g => !names.has(Brain.norm(g.name)))];
}

const autoRunning = new Set();
/** 0 tokens unless: ≥3 new views, auto-guides on, budget left, a day since the last writing, someone to pay. */
async function maybeAutoGuides(origin, { force = false } = {}) {
  if (autoRunning.has(origin) || learnCtl.has(origin)) return { skipped: 'busy' };
  const P = await getPassive(origin);
  const fresh = (P.newViews || []);
  if (fresh.length < AUTO_MIN_VIEWS) return { skipped: 'few' };
  if (!(await autoGuidesOn())) return { skipped: 'off' };
  const L = await readLearnRaw(origin);
  if (learnBusy(L)) return { skipped: 'busy' };
  const last = Math.max(P.lastGuidesAt || 0, (L && L.at) || 0, (L && L.autoAt) || 0);
  if (!force && Date.now() - last < AUTO_EVERY_MS) return { skipped: 'soon' };
  if (!batchesReady()) return { skipped: 'brain' };
  if (await overBudget()) return { skipped: 'budget' };
  const a = await auth();
  if (!a) return { skipped: 'auth' };
  const map = await getMap(origin);
  if (!map) return { skipped: 'nomap' };
  autoRunning.add(origin);
  const ctl = new AbortController();
  learnCtl.set(origin, ctl);
  busyWriting.add(origin);
  const done = keepAlive();
  // Whatever happens, wait a day before the next try: a failing call must not repeat on every page view.
  await chrome.storage.local.set({ [passiveKey(origin)]: { ...P, lastGuidesAt: Date.now() } });
  try {
    const list = await getPlaybooks(origin);
    const ids = fresh.filter(id => map.views.some(v => v.id === id));
    const r = await writeGuides(origin, { map, guideMap: subMap(map, ids), existing: list.map(p => p.name), a, ctl });
    if (ctl.signal.aborted) return { skipped: 'aborted' };
    let added = 0;
    await updatePlaybooks(origin, cur => {
      const learned = cur.filter(p => p.learned);
      const merged = mergeLearned(learned, r.guides);
      added = Math.max(0, merged.length - learned.length);
      return [...merged, ...cur.filter(p => !p.learned)];
    });
    await locked(passiveKey(origin), async () => {
      const cur = await getPassive(origin);
      await chrome.storage.local.set({ [passiveKey(origin)]: { ...cur, newViews: (cur.newViews || []).filter(id => !ids.includes(id)), lastGuidesAt: Date.now() } });
    });
    const count = (await getPlaybooks(origin)).filter(p => p.learned).length;
    await updateLearn(origin, c => (c && !learnBusy(c) ? { ...c, guides: count, autoAt: Date.now(), autoAdded: added, views: map.views.length } : undefined));
    return { added, guides: r.guides.length, error: r.error || null };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  } finally {
    done();
    autoRunning.delete(origin);
    busyWriting.delete(origin);
    if (learnCtl.get(origin) === ctl) learnCtl.delete(origin);
  }
}

async function learnStart(tabId, restart) {
  const tab = await chrome.tabs.get(tabId);
  if (!usable(tab.url)) throw coded('restricted', MSG.restricted);
  const origin = originOf(tab.url);
  await toTab(tabId, { type: 'ping' }); // no access: the panel offers «Разрешить доступ» before anything changes
  const cur = await readLearn(origin);
  if (learnBusy(cur) && !restart) throw new Error('Scopos уже изучает этот сайт. Дождитесь конца или нажмите «Изучить заново».');
  if (learnCtl.has(origin)) { learnCtl.get(origin).abort(); learnCtl.delete(origin); }
  if (cur && cur.status === 'exploring' && cur.tabId != null && cur.tabId !== tabId) {
    await toTab(cur.tabId, { type: 'explore:stop' }).catch(() => {});
    await netUnblock(cur.tabId);
  }
  abortTab(tabId);
  await toTab(tabId, { type: 'guide:stop' }).catch(() => {});
  await updateSession(tabId, () => null);
  await chrome.storage.session.remove(exploreKey(tabId));
  await chrome.storage.session.set({ [learnTabKey(tabId)]: origin });
  const now = Date.now();
  await updateLearn(origin, () => ({ status: 'exploring', views: 0, probes: 0, label: 'Начинаю', error: null, tabId, startedAt: now, heartbeatAt: now }));
  try {
    // The network block goes up before the first press and stays across page loads (session rules are per tab,
    // not per document). Without it the walk does not start: the page patch alone is not enough.
    let net = false;
    try { net = await netBlock(tabId, tab.url); } catch (e) { net = false; }
    if (!net) throw new Error('Не удалось включить защиту от записи на уровне сети. Изучение не запущено.');
    await toTab(tabId, { type: 'explore:start', restart: !!restart, net: true });
  } catch (e) {
    await netUnblock(tabId);
    await chrome.storage.session.remove(learnTabKey(tabId)).catch(() => {});
    await setLearn(origin, { status: 'error', error: e.message || String(e) });
    throw e;
  }
}

async function learnForget(origin) {
  if (learnCtl.has(origin)) { learnCtl.get(origin).abort(); learnCtl.delete(origin); }
  const cur = await readLearnRaw(origin);
  if (cur && cur.status === 'exploring' && cur.tabId != null) {
    await toTab(cur.tabId, { type: 'explore:stop' }).catch(() => {});
    await netUnblock(cur.tabId);
  }
  await chrome.storage.local.remove([mapKey(origin), passiveKey(origin)]);
  await cacheClear(origin);
  await updateLearn(origin, () => null);
  await updatePlaybooks(origin, list => list.filter(p => !p.learned));
}

// ---------- the main-world guard while the explorer clicks around ----------
// Preferred: core/guard.js's pageMain, installed once per document and switched by 'guard:inject' / 'guard:off'
// with the content script's per-document nonce (passed only as chrome.scripting args, so the page never sees it).
// Under it, the network block below. Fallback when guard.js is missing: the self-contained patch below,
// applied on 'guard:on' and undone on 'guard:off'.
// Both run in the page's own JavaScript world (chrome.scripting, world: 'MAIN'), so they must be self-contained.
function guardPatch() {
  if (window.__scoposGuardFallback) return;
  const saved = {};
  const g = (window.__scoposGuardFallback = { saved });
  const note = what => { try { console.info('[Scopos] заблокировано во время изучения: ' + what); } catch (e) { /* ignore */ } };
  const FP = HTMLFormElement.prototype;
  saved.submit = FP.submit; saved.requestSubmit = FP.requestSubmit;
  FP.submit = function () { note('form.submit'); };
  FP.requestSubmit = function () { note('form.requestSubmit'); };
  g.onSubmit = e => { e.preventDefault(); e.stopImmediatePropagation(); note('submit'); };
  window.addEventListener('submit', g.onSubmit, true);
  saved.confirm = window.confirm; window.confirm = () => { note('confirm'); return false; };
  saved.alert = window.alert; window.alert = () => {};
  saved.prompt = window.prompt; window.prompt = () => null;
  saved.print = window.print; window.print = () => {};
  saved.open = window.open; window.open = () => { note('window.open'); return null; };
  const safe = m => /^(GET|HEAD|OPTIONS)$/i.test(m || 'GET');
  saved.fetch = window.fetch;
  window.fetch = function (input, init) {
    const m = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
    if (!safe(m)) { note('fetch ' + m); return Promise.reject(new TypeError('Scopos: ' + m + ' blocked while learning')); }
    return saved.fetch.apply(this, arguments);
  };
  const XP = XMLHttpRequest.prototype;
  saved.xhrOpen = XP.open; saved.xhrSend = XP.send;
  XP.open = function (method) { this.__scoposMethod = method; return saved.xhrOpen.apply(this, arguments); };
  XP.send = function () {
    if (!safe(this.__scoposMethod)) {
      note('XHR ' + this.__scoposMethod);
      setTimeout(() => { try { this.dispatchEvent(new ProgressEvent('error')); this.dispatchEvent(new ProgressEvent('loadend')); } catch (e) { /* ignore */ } }, 0);
      return undefined;
    }
    return saved.xhrSend.apply(this, arguments);
  };
  if (navigator.sendBeacon) { saved.beacon = navigator.sendBeacon; navigator.sendBeacon = () => { note('sendBeacon'); return false; }; }
  g.onBeforeUnload = e => { e.stopImmediatePropagation(); };
  window.addEventListener('beforeunload', g.onBeforeUnload, true);
  saved.onbeforeunload = Object.getOwnPropertyDescriptor(window, 'onbeforeunload');
  try { window.onbeforeunload = null; Object.defineProperty(window, 'onbeforeunload', { configurable: true, get: () => null, set: () => {} }); } catch (e) { /* ignore */ }
  saved.addEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type) {
    if (this === window && type === 'beforeunload') return undefined;
    return saved.addEventListener.apply(this, arguments);
  };
}
function guardUnpatch() {
  const g = window.__scoposGuardFallback;
  if (!g || !g.saved) return;
  const s = g.saved;
  const FP = HTMLFormElement.prototype;
  FP.submit = s.submit; FP.requestSubmit = s.requestSubmit;
  window.removeEventListener('submit', g.onSubmit, true);
  window.confirm = s.confirm; window.alert = s.alert; window.prompt = s.prompt; window.print = s.print; window.open = s.open;
  window.fetch = s.fetch;
  XMLHttpRequest.prototype.open = s.xhrOpen; XMLHttpRequest.prototype.send = s.xhrSend;
  if (s.beacon) navigator.sendBeacon = s.beacon;
  EventTarget.prototype.addEventListener = s.addEventListener;
  window.removeEventListener('beforeunload', g.onBeforeUnload, true);
  try { if (s.onbeforeunload) Object.defineProperty(window, 'onbeforeunload', s.onbeforeunload); else delete window.onbeforeunload; } catch (e) { /* ignore */ }
  delete window.__scoposGuardFallback;
}
/**
 * Switches the page-world patch. With guard.js, pageMain(nonce, 'on'|'off') runs in every frame of the tab
 * (same-origin iframes have their own fetch/XHR/forms); the nonce is the content script's per-document secret
 * and only travels through chrome.scripting args, never through the page. Returns pageMain's status for the
 * top frame ('ok' when every critical patch is verifiably in place).
 */
async function guard(sender, on, nonce) {
  const main = pageGuard();
  const tabId = sender.tab.id;
  if (main) {
    if (typeof nonce !== 'string' || !/^[a-z0-9]{16,64}$/.test(nonce)) throw new Error('bad guard nonce');
    const run = target => chrome.scripting.executeScript({ target, world: 'MAIN', func: main, args: [nonce, on ? 'on' : 'off'] });
    let results;
    try { results = await run({ tabId, allFrames: true }); } catch (e) { results = await run({ tabId, frameIds: [sender.frameId || 0] }); }
    const top = (results || []).find(r => r && r.frameId === (sender.frameId || 0)) || (results || [])[0];
    return top ? top.result : null;
  }
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [sender.frameId || 0] }, world: 'MAIN', func: on ? guardPatch : guardUnpatch });
  return on ? 'fallback' : null;
}

// ---------- the network-level block while the explorer clicks around (the primary safety net) ----------
// Session rules scoped to the exploring tab: every non-GET request (any resource type, including top-level form
// posts, iframes, workers and natively captured fetch/XHR) and every WebSocket/WebTransport is blocked. A third
// rule covers requests the tab's site makes outside any tab (its service worker or shared workers carry tabId -1).
// Rule ids are deterministic per tab: base = (tabId mod 2^29) * 4, ids base+1..base+3.
const NET_ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];
const NET_WRITE_METHODS = ['post', 'put', 'patch', 'delete', 'connect', 'other'];
const netBase = tabId => (tabId % 0x20000000) * 4;
const netIds = tabId => [1, 2, 3].map(i => netBase(tabId) + i);
const dnr = () => (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules ? chrome.declarativeNetRequest : null);

/** Blocks writes and sockets for this tab at the network level. Idempotent (re-adding replaces the same ids). */
async function netBlock(tabId, url) {
  const api = dnr();
  if (!api || !Number.isInteger(tabId) || tabId < 0) return false;
  const [idWrite, idSock, idWorker] = netIds(tabId);
  const rules = [
    { id: idWrite, priority: 1, action: { type: 'block' }, condition: { tabIds: [tabId], requestMethods: NET_WRITE_METHODS, resourceTypes: NET_ALL_TYPES } },
    { id: idSock, priority: 1, action: { type: 'block' }, condition: { tabIds: [tabId], resourceTypes: ['websocket', 'webtransport'] } },
  ];
  let host = '';
  try { const u = new URL(url || ''); if (/^https?:$/.test(u.protocol)) host = u.hostname.replace(/^\[|\]$/g, ''); } catch (e) { host = ''; }
  // Not for IP literals of IPv6 (initiatorDomains takes domain names); plain hosts and IPv4 work.
  if (host && !host.includes(':')) {
    rules.push({ id: idWorker, priority: 1, action: { type: 'block' }, condition: { tabIds: [chrome.tabs.TAB_ID_NONE], initiatorDomains: [host], requestMethods: NET_WRITE_METHODS, resourceTypes: NET_ALL_TYPES } });
  }
  await api.updateSessionRules({ removeRuleIds: netIds(tabId), addRules: rules });
  return true;
}

/** Lifts the network block for this tab (also any rule that names the tab, whatever its id). */
async function netUnblock(tabId) {
  const api = dnr();
  if (!api || !Number.isInteger(tabId)) return;
  try {
    const ids = new Set(netIds(tabId));
    const all = await api.getSessionRules();
    for (const r of all) if (r.condition && Array.isArray(r.condition.tabIds) && r.condition.tabIds.includes(tabId)) ids.add(r.id);
    await api.updateSessionRules({ removeRuleIds: [...ids] });
  } catch (e) { /* nothing to remove */ }
}

/** True while the write-block rule for this tab is in place (told to the explorer as `netBlocked`). */
async function netActive(tabId) {
  const api = dnr();
  if (!api || !Number.isInteger(tabId)) return false;
  try { const [idWrite] = netIds(tabId); return (await api.getSessionRules()).some(r => r.id === idWrite); } catch (e) { return false; }
}

/** True while this tab runs a walk that the learn state still knows about. */
async function exploringTab(tabId) {
  try { await chrome.tabs.get(tabId); } catch (e) { return false; }
  const k = learnTabKey(tabId);
  const origin = (await chrome.storage.session.get(k))[k];
  if (!origin) return false;
  const L = await readLearnRaw(origin);
  return !!L && L.status === 'exploring' && L.tabId === tabId;
}

/** Worker start: drop rules left behind by a walk that is no longer running (crash, killed worker, closed tab). */
async function netCleanStale() {
  const api = dnr();
  if (!api) return;
  try {
    const all = await api.getSessionRules();
    const groups = new Map(); // base -> { tabId, ids }
    for (const r of all) {
      const base = Math.floor((r.id - 1) / 4) * 4;
      const g = groups.get(base) || { tabId: null, ids: [] };
      g.ids.push(r.id);
      const t = r.condition && Array.isArray(r.condition.tabIds) ? r.condition.tabIds.find(x => x >= 0) : undefined;
      if (t !== undefined) g.tabId = t;
      groups.set(base, g);
    }
    const drop = [];
    for (const g of groups.values()) if (g.tabId == null || !(await exploringTab(g.tabId))) drop.push(...g.ids);
    if (drop.length) await api.updateSessionRules({ removeRuleIds: drop });
  } catch (e) { /* ignore */ }
}
netCleanStale();

// After a worker restart: what was busy before (running guides, walks) is busy still.
(async () => {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('guide:') && v && BUSY_STATUS.has(v.status)) busyTabs.add(+k.slice(6));
      if (k.startsWith('learnTab:')) busyExplore.add(+k.slice(9));
    }
  } catch (e) { /* nothing to restore */ }
})();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.apiKey || changes.devServer)) proxyCache = null;
});

// ---------- messages ----------
const PANEL_TYPES = new Set(['ask', 'session', 'stop', 'go', 'playbooks', 'playbook:save', 'playbook:delete', 'playbook:run', 'record:start', 'record:stop', 'learn:start', 'learn:stop', 'learn:finish', 'learn:state', 'learn:forget', 'usage', 'usage:reset', 'cache:drop', 'access', 'key:state']);
// Our own extension pages only: the side panel, or the same page opened in a tab (tests, a pinned panel tab).
// Content scripts report the web page's URL, and no extension page is web-accessible, so a site can't pass this.
const fromPanel = sender => sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (PANEL_TYPES.has(msg.type) && !fromPanel(sender)) { reply({ error: 'forbidden' }); return false; }
  handle(msg, sender)
    .then(r => { try { reply(r || {}); } catch (e) { /* port closed */ } })
    .catch(e => {
      try {
        if (e && e.stale) return reply({ stale: true });
        if (e && e.name === 'AbortError') return reply({ aborted: true });
        reply({ error: (e && e.message) || String(e), code: (e && e.code) || undefined, origin: (e && e.origin) || undefined });
      } catch (x) { /* port closed */ }
    });
  return true;
});

async function handle(msg, sender) {
  const fromTab = sender.tab && sender.tab.id;
  switch (msg.type) {
    // ---- from the side panel ----
    case 'ask':
      // Errors are already written into this run's session by ask(); the panel also gets them here.
      return { session: await ask(msg.tabId, String(msg.question || '').slice(0, 600), { force: !!msg.force }) };
    case 'session': {
      const s = await getSession(msg.tabId);
      // A "thinking" run this worker doesn't know about died with an older worker.
      if (s && s.status === 'thinking' && !liveRuns.has(s.runId)) {
        return { session: await updateSession(msg.tabId, cur => (cur && cur.runId === s.runId && cur.status === 'thinking' ? { ...cur, status: 'error', error: 'Ответ прервался. Спросите ещё раз.' } : undefined)) };
      }
      return { session: s };
    }
    case 'stop':
      abortTab(msg.tabId);
      await toTab(msg.tabId, { type: 'guide:stop' }).catch(() => {});
      return { session: await updateSession(msg.tabId, () => null) };
    case 'go': {
      const s = await getSession(msg.tabId);
      if (!s || !s.steps || !s.steps.length) return {};
      const index = Math.max(0, Math.min(+msg.index || 0, s.steps.length - 1));
      await toTab(msg.tabId, s.status === 'running' ? { type: 'guide:go', index } : guideMsg(s, index));
      return { session: await patchSession(msg.tabId, { index, status: 'running' }, s.runId) };
    }
    case 'playbooks': return { list: await getPlaybooks(msg.origin) };
    case 'playbook:save': {
      const name = String(msg.name || '').trim().slice(0, 90) || 'Мой сценарий';
      const steps = Array.isArray(msg.steps) ? msg.steps : [];
      const pb = { id: crypto.randomUUID(), name, steps, created: Date.now(), runs: 0 };
      await updatePlaybooks(msg.origin, list => [pb, ...list]);
      return { playbook: pb };
    }
    case 'playbook:delete':
      await updatePlaybooks(msg.origin, list => list.filter(p => p.id !== msg.id));
      return { ok: true };
    case 'playbook:run': return { session: await runPlaybook(msg.tabId, msg.origin, msg.id) };
    case 'record:start':
      abortTab(msg.tabId);
      await toTab(msg.tabId, { type: 'record:start' });
      return { session: await updateSession(msg.tabId, () => ({ runId: crypto.randomUUID(), status: 'recording', recorded: [], steps: [], question: '', answer: '' })) };
    case 'record:stop': {
      const res = await toTab(msg.tabId, { type: 'record:stop' }).catch(() => ({ steps: [] }));
      const s = await getSession(msg.tabId);
      const steps = (s && s.recorded && s.recorded.length ? s.recorded : res && res.steps) || [];
      return { steps, session: await updateSession(msg.tabId, () => null) };
    }
    case 'learn:start': await learnStart(msg.tabId, !!msg.restart); return { ok: true };
    case 'learn:stop': {
      // Cancel: nothing is written from a cancelled walk.
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      const origin = msg.origin || (tab && originOf(tab.url));
      const cur = origin ? await readLearnRaw(origin) : null;
      if (origin) await updateLearn(origin, c => (c && learnBusy(c) ? { ...c, status: 'stopped', error: null } : undefined));
      if (origin && learnCtl.has(origin)) { learnCtl.get(origin).abort(); learnCtl.delete(origin); }
      const target = (cur && cur.tabId != null) ? cur.tabId : msg.tabId;
      // Mark the saved walk as cancelled first: if the page is mid-load, the next page must not resume it.
      const key = exploreKey(target);
      const saved = (await chrome.storage.session.get(key))[key];
      if (saved && saved.status === 'running') await chrome.storage.session.set({ [key]: { ...saved, stopping: true, cancelled: true } });
      await toTab(target, { type: 'explore:cancel' }).catch(() => {});
      await netUnblock(target);
      return { ok: true };
    }
    case 'learn:finish': {
      // "Хватит": the explorer stops and Claude writes guides from what it has seen.
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      const origin = msg.origin || (tab && originOf(tab.url));
      const cur = origin ? await readLearnRaw(origin) : null;
      const target = cur && cur.tabId != null ? cur.tabId : msg.tabId;
      await toTab(target, { type: 'explore:stop' }).catch(() => {});
      await netUnblock(target);
      return { ok: true };
    }
    case 'learn:state': return { learn: await readLearn(msg.origin), hasMap: !!(await getMap(msg.origin)), writing: learnCtl.has(msg.origin) };
    case 'learn:forget': await learnForget(msg.origin); return { ok: true };
    case 'usage': {
      const all = (await chrome.storage.local.get('usage')).usage || { total: { tokens: 0, cost: 0, calls: 0 }, origins: {} };
      const mo = (all.months && all.months[monthKey()]) || { tokens: 0, cost: 0, calls: 0 };
      return { total: all.total, site: all.origins[msg.origin] || null, month: { ...mo, key: monthKey(), limit: await monthLimit() } };
    }
    // The counter resets; this month's spend stays, or the monthly limit would mean nothing.
    case 'usage:reset': await locked('usage', async () => {
      const all = (await chrome.storage.local.get('usage')).usage;
      if (all && all.months) await chrome.storage.local.set({ usage: { total: { tokens: 0, cost: 0, calls: 0 }, origins: {}, months: all.months } });
      else await chrome.storage.local.remove('usage');
    }); return { ok: true };
    case 'access': return await accessState(msg.tabId);
    case 'key:state': {
      const own = !!(await getKey());
      const endpoint = own ? null : await proxyEndpoint({ fresh: !!msg.fresh });
      return { mode: own ? 'own' : endpoint ? 'proxy' : 'none', devServer: await devServer(), proxyReady: proxyCapable() };
    }
    case 'cache:drop': {
      // The user says a cached answer is wrong: forget it, and the next ask goes to Claude.
      const s = await getSession(msg.tabId);
      if (s && s.cacheKey && s.origin) await cacheDrop(s.origin, s.cacheKey);
      return { ok: true };
    }

    // ---- from the page ----
    case 'resume': {
      if (!fromTab) return {};
      // Read inside the session lock, so a guide:change sent just before a navigation lands first.
      const s = await locked(sessionKey(fromTab), () => getSession(fromTab));
      if (s && s.status === 'recording') { await toTab(fromTab, { type: 'record:start' }).catch(() => {}); return {}; }
      // The session's steps: a playbook's own steps plus whatever was added to it during this run.
      return s && s.status === 'running' && s.index < s.steps.length ? guideMsg(s, s.index) : {};
    }
    case 'guide:change': {
      if (!fromTab) return {};
      const next = await updateSession(fromTab, cur => {
        if (!cur || !cur.steps) return undefined;
        const index = Math.max(0, Math.min(+msg.index || 0, cur.steps.length));
        // A live guide past its last step is asking what comes next (guide:more): it ends only with guide:end.
        const waiting = index >= cur.steps.length && cur.live && cur.status === 'running';
        return { ...cur, index, status: index >= cur.steps.length && !waiting ? 'done' : 'running' };
      });
      if (next) commitHeals(next, next.index).catch(() => {});
      return { session: next };
    }
    case 'guide:end': {
      if (!fromTab) return {};
      // The page reports the guide's final steps (S.guide.steps()): what actually ran, extensions included.
      const reported = msg.reason === 'done' ? cleanSteps(msg.steps) : null;
      const next = await updateSession(fromTab, cur => {
        if (!cur || !cur.steps) return undefined;
        const steps = reported && cur.extended ? reported : cur.steps;
        return { ...cur, steps, status: msg.reason === 'done' ? 'done' : 'answered', index: msg.reason === 'done' ? steps.length : cur.index };
      });
      if (next && msg.reason === 'done') {
        await commitHeals(next, next.steps.length).catch(() => {});
        await saveExtended(next, reported).catch(() => {});
      }
      return {};
    }
    case 'guide:missing': {
      if (!fromTab) return { id: null };
      const s = await getSession(fromTab);
      if (!s) return { id: null };
      if ((s.via || s.source) === 'claude') { replan(fromTab, msg.index, msg.page).catch(() => {}); return { id: null }; }
      try { return await heal(fromTab, { ...msg, url: sender.tab.url }); } catch (e) { return { id: null }; }
    }
    case 'guide:more': {
      if (!fromTab) return { steps: null };
      try { return await continueGuide(fromTab, msg); } catch (e) { return { steps: null }; }
    }
    case 'guide:steps': {
      // guide.js changed the list after a `more` answer (appended at the end, or replaced from a missing step on).
      if (!fromTab) return {};
      const steps = cleanSteps(msg.steps);
      if (steps) await updateSession(fromTab, cur => (cur && cur.status === 'running' && cur.steps ? { ...cur, steps, extended: true } : undefined));
      return {};
    }
    // passive learning: the page asks before it snapshots, then sends the view
    case 'map:want': return fromTab ? { ok: await observeWanted(fromTab, sender.tab.url || '', msg.key) } : { ok: false };
    case 'map:observe': {
      if (!fromTab) return {};
      const origin = originOf(sender.tab.url);
      if (!origin || !(await getMap(origin))) return { result: 'nomap' };
      return await observe(origin, msg.view);
    }
    case 'guide:healed': if (fromTab) await storeHealed(fromTab, msg.index, msg.target); return {};
    case 'record:step':
      if (!fromTab) return {};
      return { session: await updateSession(fromTab, cur => (cur && cur.status === 'recording' ? { ...cur, recorded: [...(cur.recorded || []), msg.step] } : undefined)) };
    // explorer state lives here, so a page load in the middle of the walk resumes on the next page
    case 'explore:load': {
      if (!fromTab) return {};
      const st = (await chrome.storage.session.get(exploreKey(fromTab)))[exploreKey(fromTab)] || null;
      return { st, net: st && st.status === 'running' ? await netActive(fromTab) : false };
    }
    case 'explore:save':
      if (!fromTab) return {};
      try { await chrome.storage.session.set({ [exploreKey(fromTab)]: msg.st }); } catch (e) { return { error: 'Не хватило места для карты. Изучение остановлено.' }; }
      return {};
    case 'explore:progress': {
      if (!fromTab) return {};
      const origin = originOf(sender.tab.url);
      await updateLearn(origin, cur => (cur && cur.status === 'exploring' && (cur.tabId == null || cur.tabId === fromTab) ? { ...cur, ...msg.p, status: 'exploring', heartbeatAt: Date.now() } : undefined));
      return {};
    }
    case 'explore:abort': {
      if (!fromTab) return {};
      await netUnblock(fromTab);
      await chrome.storage.session.remove([exploreKey(fromTab), learnTabKey(fromTab)]);
      const origin = await (async () => { const all = await chrome.storage.local.get(null); const hit = Object.entries(all).find(([k, v]) => k.startsWith('learn:') && v && v.tabId === fromTab && learnBusy(v)); return hit ? hit[0].slice(6) : originOf(sender.tab.url); })();
      const why = msg.reason === 'origin' ? 'Изучение остановлено: вкладка ушла на другой сайт.' : msg.reason === 'redirect' ? 'Изучение остановлено: продукт перенаправляет на вход. Войдите и запустите снова.' : 'Изучение остановлено.';
      // A cancel is the user's own choice: a quiet "stopped", not an error.
      await updateLearn(origin, c => (c && learnBusy(c) ? (msg.reason === 'cancelled' ? { ...c, status: 'stopped', error: null } : { ...c, status: 'error', error: why }) : undefined));
      return {};
    }
    case 'explore:done': {
      if (!fromTab) return {};
      // The walk is locked to the origin it started on; the tab may have moved since (e.g. an OAuth redirect).
      const origin = (msg.map && typeof msg.map.origin === 'string' && /^https?:\/\//.test(msg.map.origin)) ? msg.map.origin : originOf(sender.tab.url);
      await netUnblock(fromTab);
      await chrome.storage.session.remove([exploreKey(fromTab), learnTabKey(fromTab)]);
      const cur = await readLearnRaw(origin);
      // A cancelled or restarted walk, or a second "done" from the same walk: nothing to write.
      if (!cur || cur.status !== 'exploring' || learnCtl.has(origin) || !msg.map || !Array.isArray(msg.map.views) || !msg.map.views.length) {
        if (cur && cur.status === 'exploring' && msg.map && !(msg.map.views || []).length) await setLearn(origin, { status: 'error', error: 'Не нашёл ни одного экрана. Откройте главную страницу продукта и запустите снова.' });
        return { ignored: true };
      }
      learnFrom(origin, msg.map).catch(() => {});
      return {};
    }
    case 'guard:on': case 'guard:inject': {
      if (!fromTab) return {};
      // Network block first (the primary net), then the page-world patch. The guard is only ever switched on
      // by the explorer, so a top-frame request always means "a walk runs in this tab".
      let net = false;
      if (!sender.frameId) net = await netBlock(fromTab, sender.tab.url).catch(() => false);
      const main = await guard(sender, true, msg.nonce);
      return { ok: true, net, main };
    }
    case 'guard:off': {
      if (!fromTab) return {};
      await guard(sender, false, msg.nonce).catch(() => {});
      if (!sender.frameId) await netUnblock(fromTab);
      return { ok: true };
    }
    case 'record:stop-request':
      broadcast({ type: 'record:stop-request', tabId: fromTab });
      return {};
    default: return {};
  }
}
