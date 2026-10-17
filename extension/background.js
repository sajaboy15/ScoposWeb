/*
 * Service worker: state, storage and every Claude call.
 *
 * Per tab, chrome.storage.session holds the running session
 *   guide:<tabId> = { runId, question, answer, steps, index, status, source, via, ms, origin, history, ... }
 * so a walkthrough survives page loads and the side panel can reopen on it. Every answer belongs to
 * a run (runId): a result that arrives after the user asked something else or pressed Stop is dropped.
 *
 * chrome.storage.local, per site:
 *   playbooks:<origin> = [{ id, name, steps, created, runs, learned? }]  saved and learned guides (0 tokens)
 *   answers:<origin>   = [{ k, answer, steps, via, at }]                  last 200 answers (0 tokens on repeat)
 *   map:<origin>, learn:<origin>                                         the explorer's product map and learn state
 *   usage                                                                tokens and approximate cost per site
 */
importScripts('core/brain.js');
const Brain = self.ScoposBrain;
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

chrome.tabs.onRemoved.addListener(async tabId => {
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
function chromeError(e) {
  const m = String((e && e.message) || e || '');
  if (/No tab with id|tab was closed/i.test(m)) return 'Вкладка закрыта.';
  if (/Frame with ID|was removed|back\/forward cache|navigat/i.test(m)) return 'Страница ещё загружается. Подождите секунду и попробуйте снова.';
  return 'На этой странице Scopos не может работать. Обновите страницу или откройте сайт.';
}
async function toTab(tabId, msg) {
  let alive = false;
  try { alive = !!(await chrome.tabs.sendMessage(tabId, { type: 'ping' }, { frameId: 0 })); } catch (e) { alive = false; }
  // Inject only when nothing answers: tabs opened before the extension was installed.
  if (!alive) {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: CORE_FILES }); } catch (e) { throw new Error(chromeError(e)); }
  }
  try { return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }); } catch (e) { throw new Error(chromeError(e)); }
}
const originOf = url => { try { return new URL(url).origin; } catch (e) { return ''; } };
const usable = url => /^(https?|file):/.test(url || '') && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(url);
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
  if (!usable(tab.url)) throw new Error('На этой странице браузер не даёт расширениям работать. Откройте сайт или веб-приложение.');
  const origin = originOf(tab.url);
  const t0 = Date.now();
  const runId = await beginRun(tabId, { question, answer: '', steps: [], index: 0, status: 'thinking', source: 'claude', origin });
  const live = async () => { const s = await getSession(tabId); if (!s || s.runId !== runId) throw stale(); };
  const done = keepAlive();
  try {
    await toTab(tabId, { type: 'guide:stop' }).catch(() => {});
    const prev = await getSession(tabId);
    const history = (prev && prev.history) || [];

    // 1. A saved or learned guide with the same intent: run it, 0 tokens.
    if (!force) {
      const m = matchGuides(question, await getPlaybooks(origin));
      if (m.run) {
        bumpRuns(origin, m.run.id);
        return await start(tabId, runId, { question, answer: `Сценарий «${m.run.name}»`, steps: m.run.steps, source: 'playbook', via: 'playbook', playbookId: m.run.id, ms: Date.now() - t0, origin });
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

    // 3. Ask Claude.
    const apiKey = await getKey();
    if (!apiKey) throw new Error('Добавьте ключ Anthropic API в настройках, и Scopos начнёт отвечать. Готовые сценарии работают и без него.');
    const ctl = controller(tabId, runId);
    try {
      const opts = { signal: ctl.signal, onText: progressTo(tabId, runId), onUsage: (u, model) => recordUsage(origin, u, model) };
      let out, steps, via;
      if (map) {
        // A learned product map: plan across every screen at once, with exact controls.
        out = await Brain.call(Brain.buildAskMap({ question, map, current: view, history }), apiKey, opts);
        steps = Brain.refSteps(out.steps || [], map, question);
        via = 'map';
      } else {
        const page = await toTab(tabId, { type: 'scan', query: question });
        await live();
        out = await Brain.call(Brain.buildAsk({ question, page, history }), apiKey, opts);
        await live();
        const ids = (out.steps || []).map(s => s.element_id);
        const descriptors = ids.length ? await toTab(tabId, { type: 'describe', ids }) : [];
        steps = (out.steps || []).map((s, i) => ({
          instruction: String(s.instruction || '').slice(0, 200),
          action: s.action,
          value: Brain.safeValue(s.value, question, null),
          target: (descriptors && descriptors[i]) || (s.element_text ? { sel: [], text: String(s.element_text).slice(0, 80), role: null } : null),
        }));
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
      await updateSession(tabId, cur => (cur && cur.runId === runId ? { ...cur, status: 'error', error: message } : undefined)).catch(() => {});
    }
    throw e;
  } finally {
    done();
    liveRuns.delete(runId);
  }
}

async function start(tabId, runId, data) {
  const session = await patchSession(tabId, { ...data, index: 0, status: data.steps.length ? 'running' : 'answered', error: null, suggestions: null }, runId);
  if (data.steps.length) await toTab(tabId, { type: 'guide:start', steps: data.steps, index: 0, missingDelay: delayFor(data.via) });
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
    await toTab(tabId, { type: 'guide:stop' }).catch(() => {});
    bumpRuns(origin, pb.id);
    return await start(tabId, runId, { question: pb.name, answer: `Сценарий «${pb.name}»`, steps: pb.steps, source: 'playbook', via: 'playbook', playbookId: pb.id, ms: 0, origin });
  } catch (e) {
    if (!e.stale) await updateSession(tabId, cur => (cur && cur.runId === runId ? { ...cur, status: 'error', error: e.message || String(e) } : undefined)).catch(() => {});
    throw e;
  } finally { liveRuns.delete(runId); }
}

// A Claude answer reached a page where its guessed control isn't: plan the remaining steps from this page.
async function replan(tabId, index, page) {
  const s = await getSession(tabId);
  if (!s || s.status !== 'running') return;
  const runId = s.runId;
  const apiKey = await getKey();
  if (!apiKey) return;
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
    const out = await Brain.call(Brain.buildAsk({ question: s.question, page, history, progress }), apiKey, { signal: ctl.signal, onUsage: (u, m) => recordUsage(s.origin, u, m) });
    const cur = await getSession(tabId);
    if (!cur || cur.runId !== runId || cur.index !== index || ctl.signal.aborted) return;
    const ids = (out.steps || []).map(st => st.element_id);
    const descriptors = ids.length ? await toTab(tabId, { type: 'describe', ids }) : [];
    const rest = (out.steps || []).map((st, i) => ({ instruction: String(st.instruction || '').slice(0, 200), action: st.action, value: Brain.safeValue(st.value, s.question, null), target: (descriptors && descriptors[i]) || (st.element_text ? { sel: [], text: String(st.element_text).slice(0, 80), role: null } : null) }));
    const steps = cur.steps.slice(0, index).concat(rest);
    if (!rest.length) {
      await toTab(tabId, { type: 'guide:stop' }).catch(() => {});
      await patchSession(tabId, { steps, index, status: 'done', replanning: false }, runId);
      return;
    }
    await patchSession(tabId, { steps, replanning: false }, runId);
    await toTab(tabId, { type: 'guide:start', steps, index, missingDelay: delayFor('claude') });
  } catch (e) {
    if (!e.stale) await patchSession(tabId, { replanning: false }, runId).catch(() => {});
  } finally { release(ctl); done(); }
}

// The UI changed and a saved step's control can't be found on its own page: Haiku picks it among the likely candidates.
async function heal(tabId, msg) {
  const s = await getSession(tabId);
  if (!s || s.status !== 'running' || (s.heals || 0) >= MAX_HEALS) return { id: null };
  const apiKey = await getKey();
  if (!apiKey) return { id: null };
  const runId = s.runId;
  await patchSession(tabId, { heals: (s.heals || 0) + 1 }, runId);
  const ctl = controller(tabId, runId);
  try {
    const step = msg.step || {};
    const candidates = Array.isArray(msg.candidates) ? msg.candidates.filter(Number.isInteger).slice(0, 8) : [];
    const out = await Brain.call(Brain.buildLocate({ instruction: step.instruction, oldText: step.target && step.target.text, page: msg.page, candidates }), apiKey, { signal: ctl.signal, onUsage: (u, m) => recordUsage(s.origin, u, m) });
    const cur = await getSession(tabId);
    if (!cur || cur.runId !== runId) return { id: null };
    return { id: Number.isInteger(out.element_id) ? out.element_id : null };
  } finally { release(ctl); }
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

async function learnFrom(origin, map) {
  if (learnCtl.has(origin)) return; // one writer per site
  const ctl = new AbortController();
  learnCtl.set(origin, ctl);
  const done = keepAlive();
  try {
    await chrome.storage.local.set({ [mapKey(origin)]: map });
    await cacheClear(origin); // answers were tied to the old map
    const apiKey = await getKey();
    const views = map.views.length;
    if (!apiKey) { await setLearn(origin, { status: 'mapped', views, probes: map.probes, at: Date.now(), error: 'Карта сохранена. Чтобы Claude написал гайды, добавьте ключ в настройках.' }); return; }
    await setLearn(origin, { status: 'writing', views, probes: map.probes, chars: 0, startedAt: Date.now(), heartbeatAt: Date.now(), error: null });
    let lastMsg = 0, lastBeat = Date.now();
    const onText = text => {
      const now = Date.now();
      if (now - lastMsg > 400) { lastMsg = now; broadcast({ type: 'learn:progress', origin, chars: text.length }); }
      if (now - lastBeat > 15e3) { lastBeat = now; setLearn(origin, { heartbeatAt: now, chars: text.length }).catch(() => {}); }
    };
    const out = await Brain.call(Brain.buildLearn({ map }), apiKey, { signal: ctl.signal, onText, onUsage: (u, m) => recordUsage(origin, u, m) });
    if (ctl.signal.aborted) return;
    const { guides, dropped } = learnedGuides(out, map);
    // Learned guides replace the previous learned set; scenarios the user recorded stay.
    await updatePlaybooks(origin, list => [...guides, ...list.filter(p => !p.learned)]);
    await setLearn(origin, { status: 'done', views, probes: map.probes, guides: guides.length, dropped, summary: String(out.summary || '').slice(0, 300), at: Date.now(), error: null, chars: 0 });
  } catch (e) {
    if (ctl.signal.aborted) return; // restarted or forgotten: that path owns the state
    await setLearn(origin, { status: 'error', error: (e && e.message) || String(e) }).catch(() => {});
  } finally {
    done();
    if (learnCtl.get(origin) === ctl) learnCtl.delete(origin);
  }
}

async function learnStart(tabId, restart) {
  const tab = await chrome.tabs.get(tabId);
  if (!usable(tab.url)) throw new Error('На этой странице браузер не даёт расширениям работать.');
  const origin = originOf(tab.url);
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
    await toTab(tabId, { type: 'explore:start', restart: !!restart });
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
  await chrome.storage.local.remove([mapKey(origin)]);
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

// ---------- messages ----------
const PANEL_TYPES = new Set(['ask', 'session', 'stop', 'go', 'playbooks', 'playbook:save', 'playbook:delete', 'playbook:run', 'record:start', 'record:stop', 'learn:start', 'learn:stop', 'learn:finish', 'learn:state', 'learn:forget', 'usage', 'usage:reset', 'cache:drop']);
const fromPanel = sender => !sender.tab && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (PANEL_TYPES.has(msg.type) && !fromPanel(sender)) { reply({ error: 'forbidden' }); return false; }
  handle(msg, sender)
    .then(r => { try { reply(r || {}); } catch (e) { /* port closed */ } })
    .catch(e => {
      try {
        if (e && e.stale) return reply({ stale: true });
        if (e && e.name === 'AbortError') return reply({ aborted: true });
        reply({ error: (e && e.message) || String(e) });
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
      await toTab(msg.tabId, s.status === 'running' ? { type: 'guide:go', index } : { type: 'guide:start', steps: s.steps, index, missingDelay: delayFor(s.via || s.source) });
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
      return { total: all.total, site: all.origins[msg.origin] || null };
    }
    case 'usage:reset': await locked('usage', () => chrome.storage.local.remove('usage')); return { ok: true };
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
      return s && s.status === 'running' && s.index < s.steps.length ? { steps: s.steps, index: s.index, missingDelay: delayFor(s.via || s.source) } : {};
    }
    case 'guide:change': {
      if (!fromTab) return {};
      const next = await updateSession(fromTab, cur => {
        if (!cur || !cur.steps) return undefined;
        const index = Math.max(0, Math.min(+msg.index || 0, cur.steps.length));
        return { ...cur, index, status: index >= cur.steps.length ? 'done' : 'running' };
      });
      if (next) commitHeals(next, next.index).catch(() => {});
      return { session: next };
    }
    case 'guide:end': {
      if (!fromTab) return {};
      const next = await updateSession(fromTab, cur => (cur && cur.steps ? { ...cur, status: msg.reason === 'done' ? 'done' : 'answered', index: msg.reason === 'done' ? cur.steps.length : cur.index } : undefined));
      if (next && msg.reason === 'done') commitHeals(next, next.steps.length).catch(() => {});
      return {};
    }
    case 'guide:missing': {
      if (!fromTab) return { id: null };
      const s = await getSession(fromTab);
      if (!s) return { id: null };
      if ((s.via || s.source) === 'claude') { replan(fromTab, msg.index, msg.page).catch(() => {}); return { id: null }; }
      try { return await heal(fromTab, msg); } catch (e) { return { id: null }; }
    }
    case 'guide:healed': if (fromTab) await storeHealed(fromTab, msg.index, msg.target); return {};
    case 'record:step':
      if (!fromTab) return {};
      return { session: await updateSession(fromTab, cur => (cur && cur.status === 'recording' ? { ...cur, recorded: [...(cur.recorded || []), msg.step] } : undefined)) };
    // explorer state lives here, so a page load in the middle of the walk resumes on the next page
    case 'explore:load': return fromTab ? { st: (await chrome.storage.session.get(exploreKey(fromTab)))[exploreKey(fromTab)] || null } : {};
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
