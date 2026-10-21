/*
 * Scopos SDK widget: what a software vendor embeds for its own customers.
 *
 *   <script src="https://cdn.example.com/scopos.js"
 *           data-endpoint="/api/scopos"           // the vendor's server; it holds the Claude key
 *           data-product="Ledgerly, счета и платежи"
 *           data-playbooks="/scopos-playbooks.json" // optional: scenarios recorded with the extension
 *           data-learn                              // optional: allow learn mode (localhost, or with data-learn-token)
 *           async></script>
 *
 * A small launcher sits in the corner; the panel takes a question, answers with
 * steps and runs them on the page with the same pointer as the extension. The
 * running walkthrough is kept in sessionStorage so it continues after page loads.
 * Saved scenarios run instantly and never reach the server; the server caches
 * answers for everyone, so a repeated question costs nothing either.
 *
 * Normally this file is part of scopos-core.<hash>.js, which the small loader (sdk/loader.js, served as
 * scopos.js) loads: the config then comes from the loader (S._boot), the loader's launcher is swapped for
 * this one, calls queued on the loader's Scopos.widget stub are run, and the learn-mode code
 * (explore.js + guard.js) is loaded only when learn mode is used.
 */
(function () {
  const S = window.Scopos;
  if (!S || (S.widget && !S.widget._stub)) return;
  const ldr = S._boot || null; // the loader's handover (dist/scopos.js), if it loaded us
  const me = ldr ? null : document.currentScript || document.querySelector('script[data-endpoint][src*="scopos"]');
  const data = ldr ? ldr.data || {} : (me && me.dataset) || {};
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/i.test(location.hostname);
  const cfg = {
    endpoint: data.endpoint || '/api/scopos',
    product: data.product || '',
    playbooksUrl: data.playbooks,
    label: data.label || 'Спросить',
    learnToken: data.learnToken || '',
  };
  // Learn mode clicks through the product on the current account, so the integrator has to turn it on
  // explicitly, and it only works on a developer's machine or with the vendor's learn token.
  cfg.learn = data.learn != null && !/^(false|off|0|no)$/i.test(data.learn) && (localHost || !!cfg.learnToken);

  const KEY = 'scopos:run';
  const CHAT_KEY = 'scopos:chat';
  let playbooks = Array.isArray(window.ScoposPlaybooks) ? window.ScoposPlaybooks : [];
  let state = null; // { runId, question, answer, steps, index, source, status, error, suggestions, replanned }
  let chat = [];    // the last turns, short text only: the question and the one-sentence answer
  let current = null; // { runId, ctl } of the request in flight
  let progress = null; // { chars, steps } while the server streams an answer

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const save = () => {
    try {
      state ? sessionStorage.setItem(KEY, JSON.stringify(state)) : sessionStorage.removeItem(KEY);
      sessionStorage.setItem(CHAT_KEY, JSON.stringify(chat));
    } catch (e) { /* storage full or blocked: the walkthrough still runs on this page */ }
  };
  const load = () => {
    try { chat = JSON.parse(sessionStorage.getItem(CHAT_KEY) || '[]') || []; } catch (e) { chat = []; }
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  };
  const newRun = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  const playbooksReady = cfg.playbooksUrl ? fetch(cfg.playbooksUrl).then(r => (r.ok ? r.json() : [])).then(list => { if (Array.isArray(list)) { playbooks = list; instantDirty(); } }).catch(() => {}) : Promise.resolve();

  // Guides the explorer and Claude wrote for this product (see learn mode below).
  let learned = null; // { summary, guides, faq, views, learnedAt }
  const addLearned = k => {
    learned = k && k.guides && k.guides.length ? k : null;
    if (!learned) return;
    const ids = new Set(learned.guides.map(g => g.id));
    playbooks = [...learned.guides, ...playbooks.filter(p => !ids.has(p.id))];
    instantDirty();
  };
  const knowledgeReady = fetch(cfg.endpoint + '/knowledge').then(r => (r.ok ? r.json() : null)).then(k => { addLearned(k); render(); }).catch(() => {});

  // ---------- requests to the vendor's server ----------
  /** POSTs JSON. With onProgress, asks for a streamed reply (NDJSON progress lines, then the result). */
  async function post(path, body, { signal, onProgress, headers } = {}) {
    const res = await fetch(cfg.endpoint + path, {
      method: 'POST', signal, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(onProgress ? { accept: 'application/x-ndjson, application/json' } : {}), ...(headers || {}) },
      body: JSON.stringify(body),
    });
    if (onProgress && /ndjson/.test(res.headers.get('content-type') || '') && res.body) {
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '', last = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.type === 'progress') onProgress(ev); else last = ev;
        }
      }
      if (buf.trim()) { try { last = JSON.parse(buf.trim()); } catch (e) { /* cut off */ } }
      if (!last) throw new Error('Сервер оборвал ответ. Попробуйте ещё раз.');
      if (last.type === 'error') throw new Error(last.error || 'Не получилось ответить');
      return last;
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `Сервер ответил ошибкой ${res.status}`);
    return out;
  }
  const deadline = (ctl, ms) => { const t = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), ms); return () => clearTimeout(t); };

  // ---------- learn mode ----------
  const LEARN_KEY = 'scopos:explore';
  const exploreStore = {
    load: async () => { try { return JSON.parse(sessionStorage.getItem(LEARN_KEY) || 'null'); } catch (e) { return null; } },
    save: async st => {
      try { sessionStorage.setItem(LEARN_KEY, JSON.stringify(st)); } catch (e) {
        // Out of room: stop rather than restart from stale state after the next page load.
        S.explore.stop();
        learning = { status: 'error', error: 'Карта не поместилась в память вкладки. Изучение остановлено.' };
        render();
        throw e;
      }
    },
  };
  const learnHeaders = () => (cfg.learnToken ? { 'x-scopos-learn-token': cfg.learnToken } : {});
  // The explorer and the network guard (~150 KB) come in their own file, fetched only when learn mode is used.
  const needLearn = () => (S.explore ? Promise.resolve() : ldr && ldr.learn ? ldr.load(ldr.learn) : Promise.reject(new Error('Код режима изучения не загружен.')));
  let learning = null; // { status: 'confirm'|'exploring'|'writing'|'done'|'error', ... }
  let learnTimer = 0;
  const LEARN_MS = 12 * 60e3; // a deep learn writes its parts ~3 at a time: a few minutes for a big product
  const learnOpts = {
    store: exploreStore,
    onProgress: p => { learning = { status: 'exploring', ...p }; render(); },
    onAbort: reason => {
      try { sessionStorage.removeItem(LEARN_KEY); } catch (e) { /* ignore */ }
      if (reason === 'cancelled') { learning = null; render(); return; } // the user called it off: back to normal
      learning = { status: 'error', error: reason === 'origin' ? 'Изучение остановлено: вкладка ушла на другой сайт.' : reason === 'redirect' ? 'Изучение остановлено: продукт перенаправляет на вход. Войдите и запустите снова.' : 'Изучение остановлено.' };
      render();
    },
    onDone: async map => {
      try { sessionStorage.removeItem(LEARN_KEY); } catch (e) { /* ignore */ }
      if (!map || !map.views || !map.views.length) { learning = { status: 'error', error: 'Не нашёл ни одного экрана.' }; render(); return; }
      learning = { status: 'writing', views: map.views.length, probes: map.probes, startedAt: Date.now() };
      setOpen(true); render();
      clearInterval(learnTimer);
      learnTimer = setInterval(() => { if (learning && learning.status === 'writing') render(); else clearInterval(learnTimer); }, 1000);
      // Writing guides takes a minute or two; a request that hangs past 3 minutes is reported, not waited on forever.
      const ctl = new AbortController(), clear = deadline(ctl, LEARN_MS);
      try {
        const out = await post('/learn', { map, product: cfg.product }, { headers: learnHeaders(), signal: ctl.signal });
        addLearned(out);
        learning = { status: 'done', views: map.views.length, probes: map.probes, guides: (out.guides || []).length, faq: (out.faq || []).length, summary: out.summary };
      } catch (e) {
        const late = ctl.signal.aborted && ctl.signal.reason && ctl.signal.reason.name === 'TimeoutError';
        learning = { status: 'error', error: late ? 'Сервер не ответил за 3 минуты: гайды не написаны. Попробуйте изучить ещё раз.' : (e && e.message) || 'Не получилось' };
      } finally {
        clear();
        clearInterval(learnTimer); // the 1 s re-render runs only while writing
        learnTimer = 0;
      }
      render();
    },
  };
  function confirmLearning() {
    if (!cfg.learn) return;
    learning = { status: 'confirm' };
    setOpen(true); render();
  }
  async function startLearning() {
    if (!cfg.learn) return;
    const ctl = new AbortController(), clear = deadline(ctl, 30000);
    try {
      const [ok] = await Promise.all([post('/learn', { check: true }, { headers: learnHeaders(), signal: ctl.signal }), needLearn()]);
      if (ok && ok.key === false) { learning = { status: 'error', error: 'На сервере не подключён ключ Claude: откройте /setup. Без него гайды не написать.' }; render(); return; }
    } catch (e) {
      learning = { status: 'error', error: ctl.signal.aborted ? 'Сервер не ответил. Попробуйте ещё раз.' : e.message || 'Сервер не разрешил изучение.' }; render(); return;
    } finally { clear(); }
    stopAsk();
    S.guide.stop(false);
    state = null; save();
    learning = { status: 'exploring', views: 0, probes: 0, label: 'Начинаю' };
    setOpen(false); render();
    S.explore.start(learnOpts);
  }

  // ---------- UI ----------
  const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; }
.w { position: fixed; right: max(18px, env(safe-area-inset-right, 0px)); bottom: max(18px, env(safe-area-inset-bottom, 0px)); z-index: 2147483645;
  --paper: #fbfaf7; --paper-2: #f3efe8; --ink: #2b2825; --ink-2: #6d675f; --ink-3: #a39c92; --rule: #ebe6de;
  --accent: #c47f56; --accent-ink: #9a5d3a; --accent-soft: rgba(196,127,86,.14); --shadow: 0 18px 48px rgba(60,45,30,.16), 0 2px 6px rgba(60,45,30,.06);
  font: 14px/1.5 "Onest", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
@media (prefers-color-scheme: dark) { .w { --paper: #23201d; --paper-2: #2b2723; --ink: #efe9e1; --ink-2: #bdb4a9; --ink-3: #8b8278; --rule: #38332d; --accent: #e0a07a; --accent-ink: #f0bb98; --accent-soft: rgba(224,160,122,.16); --shadow: 0 18px 48px rgba(0,0,0,.45); } }
.launch { display: flex; align-items: center; gap: 9px; height: 44px; padding: 0 18px 0 14px; border-radius: 999px; border: 1px solid var(--rule); background: var(--paper); color: var(--ink);
  box-shadow: var(--shadow); cursor: pointer; font: inherit; font-weight: 500; transition: transform .25s cubic-bezier(.22,.9,.24,1); }
.launch:hover { transform: translateY(-2px); }
.ring { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--accent); position: relative; flex: none; }
.ring::after { content: ""; position: absolute; inset: 0; margin: auto; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.panel { position: absolute; right: 0; bottom: 56px; width: min(360px, calc(100vw - 36px)); max-height: min(560px, calc(100vh - 100px)); display: flex; flex-direction: column;
  background: var(--paper); border: 1px solid var(--rule); border-radius: 20px; box-shadow: var(--shadow); overflow: hidden;
  opacity: 0; transform: translateY(10px) scale(.98); transform-origin: 100% 100%; pointer-events: none;
  visibility: hidden; transition: opacity .2s ease, transform .3s cubic-bezier(.22,.9,.24,1), visibility 0s linear .3s; }
/* Closed is hidden, not only transparent: nothing animates or paints in it, and its buttons leave the tab order. */
.open .panel { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition-delay: 0s; }
.head { display: flex; align-items: center; gap: 9px; padding: 14px 16px 6px; font-weight: 600; }
.head small { font-weight: 400; color: var(--ink-3); margin-left: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.x { margin-left: auto; border: 0; background: none; color: var(--ink-3); width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 17px; flex: none; }
.x:hover { background: var(--paper-2); color: var(--ink); }
.body { padding: 6px 16px 10px; overflow-y: auto; }
.hi { color: var(--ink-2); margin: 4px 0 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 0; background: var(--accent-soft); color: var(--accent-ink); border-radius: 999px; padding: 5px 11px; font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.q { color: var(--ink-3); font-size: 12.5px; margin: 6px 0 4px; }
.a { font-size: 15px; margin: 0 0 10px; }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
li { display: grid; grid-template-columns: 20px 1fr; gap: 10px; padding: 5px 0; color: var(--ink-2); font-size: 13.5px; }
li i { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--rule); display: grid; place-items: center; font-style: normal; font-size: 10.5px; color: var(--ink-3); }
li.done i { background: var(--accent); border-color: var(--accent); color: var(--paper); }
li.cur { color: var(--ink); font-weight: 500; }
li.cur i { border-color: var(--accent); color: var(--accent-ink); box-shadow: 0 0 0 4px var(--accent-soft); }
.meta { font-size: 11.5px; color: var(--ink-3); margin-top: 8px; }
.meta .fast { color: var(--accent-ink); }
.err { background: rgba(181,88,76,.1); border-radius: 12px; padding: 10px 12px; font-size: 13px; }
.think { display: flex; gap: 10px; align-items: center; color: var(--ink-2); padding: 8px 0; }
.spin { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--accent-soft); border-top-color: var(--accent); flex: none; }
/* Spins only while someone can see it; on weak machines (.lite) a few turns, then the elapsed time carries on alone. */
.open .spin { animation: spin .9s linear infinite; }
.lite.open .spin { animation-iteration-count: 8; }
@keyframes spin { to { transform: rotate(360deg); } }
.row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.btn { border: 1px solid var(--rule); background: var(--paper); color: var(--ink); border-radius: 999px; padding: 6px 13px; font: inherit; font-size: 13px; cursor: pointer; }
.btn:hover { background: var(--paper-2); }
.btn.main { background: var(--ink); border-color: var(--ink); color: var(--paper); }
.note { font-size: 12.5px; color: var(--ink-3); margin: 8px 0 0; }
form { display: flex; gap: 8px; align-items: center; margin: 4px 10px 10px; padding: 4px 4px 4px 12px; border: 1px solid var(--rule); border-radius: 16px; }
form:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; color: var(--ink); height: 34px; outline: none; }
.go { width: 34px; height: 34px; border-radius: 50%; border: 0; background: var(--ink); cursor: pointer; display: grid; place-items: center; }
.go .ring { border-color: var(--paper); width: 14px; height: 14px; } .go .ring::after { background: var(--paper); width: 4px; height: 4px; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:focus-visible { outline: none; }
@media (prefers-reduced-motion: reduce) { .launch { transition: opacity .15s linear; } .panel { transition: opacity .15s linear, visibility 0s linear .15s; } .open .spin { animation: none; } }
`;

  const host = document.createElement('scopos-widget');
  host.setAttribute('data-scopos-ui', '');
  const root = host.attachShadow({ mode: 'closed' });
  // The same weak-machine rule as the pointer: 4 cores or 4 GB or less gets finite animations.
  const lite = (() => { try { return (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4; } catch (e) { return false; } })();
  root.innerHTML = `<style>${CSS_TEXT}</style><div class="w${lite ? ' lite' : ''}">
    <div class="panel" role="dialog" aria-label="Scopos">
      <div class="head"><span class="ring"></span>Scopos ${cfg.product ? `<small>${esc(cfg.product)}</small>` : ''}<button class="x" data-do="close" aria-label="Свернуть">×</button></div>
      <div class="body" aria-live="polite"></div>
      <form><input placeholder="Как это сделать?" aria-label="Вопрос" maxlength="600"><button class="go" aria-label="Спросить"><span class="ring"></span></button></form>
    </div>
    <button class="launch" data-do="toggle"><span class="ring"></span>${esc(cfg.label)}</button>
  </div>`;
  const w = root.querySelector('.w'), body = root.querySelector('.body'), input = root.querySelector('input');

  function launchText() {
    if (learning && learning.status === 'exploring') return `Изучаю · ${learning.views || 0} экр.`;
    if (learning && learning.status === 'writing') return 'Пишу гайды…';
    if (state && state.status === 'running' && state.steps.length) return `Шаг ${Math.min((state.index || 0) + 1, state.steps.length)} из ${state.steps.length}`;
    return esc(cfg.label);
  }
  function renderLearning() {
    const L = learning;
    if (L.status === 'confirm') {
      return `<p class="a">Изучить продукт?</p><p class="hi">Scopos пройдёт по экранам и нажмёт кнопки, которые открывают окна, вкладки и меню, и запомнит каждую кнопку. Потом Claude напишет готовые гайды.</p>
        <p class="note">Он ничего не заполняет и не отправляет: пока он ходит, отправка форм и запросов на запись заблокирована. Всё равно лучше запускать под тестовым аккаунтом.</p>
        <div class="row"><button class="btn main" data-do="learn-go">Начать изучение</button><button class="btn" data-do="learn-cancel">Отмена</button></div>`;
    }
    if (L.status === 'writing') {
      const s = Math.round((Date.now() - (L.startedAt || Date.now())) / 1000);
      return waiting(`learn:${L.startedAt}`, `Изучил ${L.views} экранов и окон. Claude пишет гайды и вопросы к ним${s > 2 ? ` · ${s} с` : '…'}`, '', '<p class="note">Обычно две-четыре минуты. Потом почти любой вопрос отвечается мгновенно.</p>');
    }
    if (L.status === 'error') return `<div class="err">${esc(L.error)}</div><div class="row">${cfg.learn ? '<button class="btn main" data-do="learn-again">Изучить заново</button>' : ''}<button class="btn" data-do="learn-cancel">Закрыть</button></div>`;
    return `<p class="a">Изучил продукт: ${L.views} экранов и окон, ${L.probes || 0} проверенных кнопок.</p><p class="hi">${esc(L.summary || '')}</p>
      <div class="q">Готовые гайды · ${L.guides || 0}${L.faq ? ` · ${L.faq} вопросов отвечаются мгновенно` : ''}</div><div class="chips">${playbooks.filter(p => p.learned).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>`;
  }

  // Progress lines arrive 4×/s and the learn timer ticks every second: write only what changed.
  let bodyHTML = null, launchHTML = null;
  const setBody = html => { if (html !== bodyHTML) { bodyHTML = html; body.innerHTML = html; } };
  /**
   * A spinner with a status line. While the same wait (key) goes on, only the line's text node is
   * updated and null is returned, so the spinner is never rebuilt and its animation never restarts.
   */
  function waiting(key, text, before, after) {
    const t = body.querySelector('.think');
    if (t && t.dataset.k === key) {
      const say = t.querySelector('.say');
      if (say && say.textContent !== text) { say.textContent = text; bodyHTML = null; }
      return null;
    }
    return `${before}<div class="think" data-k="${esc(key)}"><span class="spin"></span><span class="say">${esc(text)}</span></div>${after}`;
  }

  function render() {
    const launch = root.querySelector('.launch');
    const lh = `<span class="ring"></span>${launchText()}`;
    if (launch && lh !== launchHTML) { launchHTML = lh; launch.innerHTML = lh; }
    if (learning && learning.status !== 'exploring') { const h = renderLearning(); if (h !== null) setBody(h); return; }
    if (!state) {
      setBody(`<p class="hi">Спросите, как что-то сделать. Я покажу каждый шаг прямо здесь, на странице.</p>
        ${playbooks.length ? `${learned ? `<div class="q">Готовые гайды · изучено ${learned.views} экранов</div>` : ''}<div class="chips">${playbooks.slice(0, learned ? 8 : 4).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : ''}`);
      return;
    }
    if (state.status === 'thinking') {
      const line = progress && progress.chars ? `Пишу шаги${progress.steps ? ' · ' + progress.steps : '…'}` : 'Читаю страницу и продумываю шаги';
      const h = waiting(`ask:${state.runId}`, line, `<div class="q">${esc(state.question)}</div>`, '<div class="row"><button class="btn" data-do="cancel">Отменить</button></div>');
      if (h !== null) setBody(h);
      return;
    }
    if (state.status === 'error') {
      setBody(`<div class="q">${esc(state.question)}</div><div class="err">${esc(state.error)}</div><div class="row"><button class="btn main" data-do="retry">Спросить ещё раз</button><button class="btn" data-do="reset">Новый вопрос</button></div>`);
      return;
    }
    if (state.status === 'suggest') {
      setBody(`<div class="q">${esc(state.question)}</div><p class="a">Возможно, вы про:</p>
        <div class="chips">${(state.suggestions || []).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>
        <div class="row"><button class="btn" data-do="ask-anyway">Нет, спросить Claude</button></div>`);
      return;
    }
    const idx = state.index || 0, done = state.status === 'done';
    const tag = state.source === 'playbook' ? '<span class="fast">Готовый гайд · мгновенно</span>'
      : state.source === 'faq' ? '<span class="fast">Готовый ответ · мгновенно</span>'
      : state.source === 'cache' ? '<span class="fast">мгновенно · из кэша</span>'
      : state.source === 'map' ? 'Claude · по карте продукта' : 'Ответ Claude';
    setBody(`<div class="q">${esc(state.question)}</div>${state.answer ? `<p class="a">${esc(state.answer)}</p>` : ''}
      ${state.steps.length ? `<ol>${state.steps.map((s, i) => `<li class="${i < idx || done ? 'done' : i === idx ? 'cur' : ''}"><i>${i + 1}</i><span>${esc(s.instruction)}</span></li>`).join('')}</ol>` : ''}
      ${state.show && !state.steps.length ? `<div class="chips"><button class="chip" data-pb="${esc(state.show.id)}">Показать на экране: ${esc(state.show.name)}</button></div>` : ''}
      <div class="meta">${tag}${done ? ' · готово' : ''}</div>
      ${done || !state.steps.length ? '<div class="row"><button class="btn" data-do="reset">Новый вопрос</button></div>' : ''}`);
  }

  function setOpen(on) { w.classList.toggle('open', on); if (on) setTimeout(() => input.focus(), 50); }

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-do],[data-pb]');
    if (!b) return;
    if (b.dataset.pb) { learning = null; const pb = playbooks.find(p => p.id === b.dataset.pb); if (pb) { stopAsk(); runSteps(newRun(), pb.name, `Сценарий «${pb.name}»`, pb.steps, 'playbook', !!pb.live); } return; }
    const act = b.dataset.do;
    if (act === 'toggle') setOpen(!w.classList.contains('open'));
    if (act === 'close') setOpen(false);
    if (act === 'cancel') { stopAsk(); state = null; save(); render(); input.focus(); }
    if (act === 'retry' && state) ask(state.question);
    if (act === 'ask-anyway' && state) ask(state.question, { force: true });
    if (act === 'reset') { stopAsk(); S.guide.stop(false); state = null; save(); render(); input.focus(); }
    if (act === 'learn-go') startLearning();
    if (act === 'learn-again') confirmLearning();
    if (act === 'learn-cancel') { learning = null; render(); }
  });
  root.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const t = input.value.trim(); if (t) { input.value = ''; ask(t); } });

  // ---------- instant answers: guides, their FAQ phrasings and facts matched locally, 0 tokens ----------
  // The block below is the same code as in extension/core/brain.js (dev/instant-selftest.mjs checks they match).
  // ==== instant answers: begin ====
  /*
   * Instant answers: a question matched locally against the guides' names, their FAQ phrasings and the learned
   * facts, before any Claude call (0 tokens, about a millisecond). This block is copied verbatim into sdk/widget.js
   * (the SDK does not load brain.js); dev/instant-selftest.mjs fails when the two copies differ.
   *
   *   const ix = Instant.index({ guides, faq, product });   // once per knowledge
   *   Instant.match(ix, question) ->
   *     { kind: 'guide', guide, steps, score }   sure: run it (steps carry the values the question gives)
   *     { kind: 'fact', answer, show, score }    a fact from the map; show = a guide that opens its screen, or null
   *     { kind: 'suggest', suggest: [guide] }    unsure: up to 3 guides to offer
   *     { kind: 'none', suggest: [] }            nothing close: ask Claude
   * faq: [{ q, guide: id | null, answer: string | null, fact?: key }]: a phrasing of a guide (answer null), or of a
   * fact (answer set; entries with the same fact key are one fact; the answer in the question's language wins).
   * Precision over recall: a guide runs only when one guide explains every word of the question (its phrasings, the
   * synonyms learned from them, the fields it fills), no other plausible guide comes close, and no action word
   * clashes (add vs delete, edit vs create...).
   */
  const Instant = (() => {
    const low = s => String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е');
    const CYR = /[а-я]/;
    const STOP = new Set(('a an the to of for in on at by with from into onto about as and or but not no is are was were be been being am ' +
      'do does did done can could would should will shall may might must i we you he she they it me us him her them my our your his ' +
      'their its this that these those there here what which who whom whose where when why how please want wanna need needs like ' +
      'let lets just also some any all every each one have has had get got go going make sure way thing things right now currently ' +
      'today then than so if up out over again ok okay hi hello thanks take bring tell know help hey still yet already really actually ' +
      'как где когда куда откуда почему зачем что чтобы кто какой какая какое какие каком какую какого сколько ли ' +
      'мне меня мой моя мое мои мою моего мы нас нам наш наша наше наши нашу нашего нашей вы вам вас ваш ваша ваши я ты ' +
      'он она оно они его ее их им свой своя свое свои свою своего этот эта это эти этого этой тот та то те там тут здесь ' +
      'в во на по с со к ко от до из за для о об про при у над под без через и или а но не ни же бы ну вот ' +
      'можно нужно надо хочу хотим хотел хотела могу может можем пожалуйста сделать делать сделай есть быть было будет ' +
      'сейчас теперь сегодня уже еще тоже также просто привет спасибо').split(' '));
    const MONTH = /^(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)$|^(январ|феврал|апрел|сентябр|октябр|ноябр|декабр)|^(март|мая|май|июн|июл|август)[аеяь]?$/;
    const MONEY = /^(dollars?|usd|eur|euros?|rub|руб\S*|доллар\S*|евро|тенге)$/;
    // Action words, by class. A question with a class the guide lacks never runs it; a guide that deletes, cancels or
    // turns something off never runs for a question without that word. 'view' only explains a word, it never clashes.
    const ACTS = [
      ['delete', /^(delet|remov|eras|удал|убра|убер|стере|стир)/],
      ['cancel', /^(cancel|void|annul|отмен|аннул)/],
      ['off', /^(disabl|deactiv|выключ|отключ|деактив)/],
      ['on', /^(enabl|activat|включ|активир)/],
      ['change', /^(chang|edit|updat|modif|renam|switch|replac|измен|смен|помен|редакт|обнов|переимен|исправ|поправ|замен|переключ)/],
      ['create', /^(add|adds|added|adding|new|newly|нов)$|^(creat|regist|добав|созд|нов[аыоуе]|завед|выстав|оформ)/],
    ];
    const VIEW = /^(show|view|see|look|open|display|list|покаж|показ|посмотр|смотр|открой|откр|глян|список)/;
    const HARD = new Set(['delete', 'cancel', 'off']);
    const actOf = w => { for (const [k, re] of ACTS) if (re.test(w)) return k; return VIEW.test(w) ? 'view' : null; };
    // Operations with a button of their own. A question that names one runs only a guide that performs it: its name
    // or a control it presses says so ("Sync" is not "Upload file"; "Send to driver" is not the bot's settings with a
    // "Send salary statements" checkbox). FAQ wordings don't count: a tutorial title can land on the wrong guide.
    const OPS = [
      ['send', /^(send|sent|отправ|пошл|перешл|пересла)/],
      ['sync', /^(sync|synchron|синхрон)/],
      ['import', /^(import|upload|импорт|загруз)/],
      ['export', /^(export|download|экспорт|выгруз|скача)/],
      ['print', /^(print|печат|распечат)/],
      ['share', /^(share|sharing|подел|расшар)/],
      ['split', /^(split)/],
      ['copy', /^(copy|copie|duplicat|clon|копи|дублир)/],
      ['recalc', /^(recalc|пересчит|пересчет)/],
      ['terminate', /^(terminat|уволь|уволит|увольн)/],
      ['merge', /^(merg|объедин)/],
      ['mark', /^(mark|marks|marked|marking)$|^(отмет|помет)/],
    ];
    // A participle names a state, not the act asked for ("the remit notice printed on invoices", «отправленные счета»).
    const PARTICIPLE = /^[a-z]+ed$|^sent$|^[а-я]+(?:енн|анн|ённ|ящ|ющ|ащ|ущ|вш)[а-я]*$/;
    const opOf = w => { if (PARTICIPLE.test(w)) return null; for (const [k, re] of OPS) if (re.test(w)) return k; return null; };
    // Controls a guide presses (not the fields and checkboxes it fills): what it does, as operations.
    const PRESS = /^(button|link|menuitem|tab|treeitem|option|row|gridcell)$/;
    function opsOf(text) {
      const out = new Set();
      for (const x of words(text)) { const k = opOf(x.w); if (k) out.add(k); }
      return out;
    }
    /** The operations a guide performs: in its name, and on the controls it presses. pressedOnly: not the name. */
    function guideOps(g, pressedOnly) {
      const out = pressedOnly ? new Set() : opsOf(g && g.name);
      for (const s of (g && Array.isArray(g.steps) ? g.steps : [])) {
        if (s && s.action === 'click' && s.target && typeof s.target.text === 'string' && (!s.target.role || PRESS.test(s.target.role))) opsOf(s.target.text).forEach(k => out.add(k));
      }
      return out;
    }
    const WORD = /[$€₽#]?[\p{L}\p{N}](?:[\p{L}\p{N}@.,:/+'’_-]*[\p{L}\p{N}])?/gu;
    const EN_SUF = [['ations', ''], ['ation', ''], ['ments', ''], ['ment', ''], ['ings', ''], ['ing', ''], ['ies', 'y'], ['ied', 'y'], ['ers', ''], ['er', ''], ['ed', ''], ['es', ''], ['ly', ''], ['s', '']];
    const RU_SUF = ['иями', 'ями', 'ами', 'ией', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ость', 'ости', 'ться', 'тся', 'ешь', 'ете', 'ите', 'ает', 'яет', 'ует', 'ала', 'ила', 'ыла', 'ать', 'ять', 'ить', 'еть', 'уть', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ия', 'ья', 'ии', 'ью', 'а', 'я', 'о', 'е', 'и', 'ы', 'у', 'ю', 'ь', 'й'].sort((a, b) => b.length - a.length);
    // Words repeat a lot (labels, "Click", the product's nouns): each is stemmed once.
    const STEMS = new Map();
    function stem(w) {
      let v = STEMS.get(w);
      if (v === undefined) {
        if (STEMS.size > 50000) STEMS.clear();
        v = stem0(w);
        STEMS.set(w, v);
      }
      return v;
    }
    function stem0(w) {
      if (CYR.test(w)) {
        for (const s of RU_SUF) if (w.length - s.length >= 3 && w.endsWith(s)) { w = w.slice(0, -s.length); break; }
        return w.slice(0, 7);
      }
      w = w.replace(/['’]s?$/, '');
      if (w.length > 3) {
        for (const [s, r] of EN_SUF) if (w.length - s.length >= 3 && w.endsWith(s)) { w = w.slice(0, -s.length) + r; break; }
        if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
      }
      return w.slice(0, 7);
    }
    // Stems match exactly, or one is the other plus at most two letters (груз ≠ грузовик, помен = поменя).
    const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 2 && (a.startsWith(b) || b.startsWith(a)));

    /** Words of a text: { raw, w (lower), s (stem), n, at, end, cap, num (a value-looking word: digits, @, $), q (in quotes) }. */
    function words(text) {
      const src = String(text == null ? '' : text).slice(0, 600);
      const quoted = [];
      src.replace(/[«"“]([^»"”]{1,80})[»"”]/g, (m, inner, at) => { quoted.push([at, at + m.length]); return m; });
      const out = [];
      WORD.lastIndex = 0;
      for (let m; (m = WORD.exec(src));) {
        const raw = m[0], at = m.index, w = low(raw), num = /[\d@$€₽#]/.test(raw);
        out.push({ raw, w, s: num ? '' : stem(w), n: out.length, at, end: at + raw.length, cap: /^\p{Lu}/u.test(raw), num, q: quoted.some(([a, b]) => at > a && at < b) });
      }
      return out;
    }
    // Stems of the letter parts of a word ("driver's" → driv, "a/r" → nothing: too short).
    const partsOf = (x, drop) => (x.num ? [] : x.w.split(/[^\p{L}]+/u).filter(p => p.length >= 2 && !STOP.has(p) && !(drop && drop.has(p))));
    function toks(text, drop) {
      const out = [];
      for (const x of words(text)) for (const p of partsOf(x, drop)) { const s = stem(p); if (!out.includes(s)) out.push(s); }
      return out;
    }
    function actsOf(list, withView) {
      const out = new Set();
      const text = ' ' + list.map(x => x.w).join(' ') + ' ';
      for (const x of list) { const k = actOf(x.w); if (k && (k !== 'view' || withView)) out.add(k); }
      if (/ turn(ing|s)? off /.test(text) || / switch(ing|es)? off /.test(text)) out.add('off');
      if (/ turn(ing|s)? on /.test(text) || / switch(ing|es)? on /.test(text)) out.add('on');
      return out;
    }
    // An option's own words: "Unit 105 · Peterbilt 579" → "Unit 105"; placeholders ("Select a driver") are no option.
    const head = o => String(o || '').split(/\s[·—–|]\s|\s-\s/)[0].replace(/\([^)]*\)/g, ' ').trim();
    const placeholder = o => /^(select|choose|pick|any|all|none|—|-|выберите|выбрать|любой|все|нет)\b/i.test(String(o || '').trim());
    const OPTS = new WeakMap();
    // A select step's options with their words, worked out once per step.
    function optWords(step) {
      if (!step || typeof step !== 'object') return [];
      let v = OPTS.get(step);
      if (!v) {
        v = (Array.isArray(step.options) ? step.options : []).filter(o => typeof o === 'string' && !placeholder(o))
          .map(o => ({ o, hw: words(head(o)).filter(x => x.num || !STOP.has(x.w)) })).filter(x => x.hw.length);
        OPTS.set(step, v);
      }
      return v;
    }

    // ---- values ----
    // The same normalisation as Brain.norm, so a value checks the same everywhere.
    const vnorm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'“”.,:;!?()]/g, ' ').replace(/\s+/g, ' ').trim();
    /**
     * A proposed value is kept only if the user actually said it (it appears in the question) or, for a select, it
     * is one of the control's real options. Page text can't plant values.
     */
    function safeValue(value, question, options) {
      if (value == null || value === '') return null;
      const v = String(value).slice(0, 200);
      if (options && options.length) {
        const hit = options.find(o => vnorm(o) === vnorm(v)) || options.find(o => vnorm(o).includes(vnorm(v)) && vnorm(v).length > 2);
        if (hit) return hit;
      }
      const q = vnorm(question), nv = vnorm(v);
      if (nv && q.includes(nv)) return v;
      // Numbers the user typed, possibly reformatted ("50 000" vs "50000").
      const digits = nv.replace(/\D/g, '');
      if (digits.length >= 2 && q.replace(/\D/g, '').includes(digits)) return v;
      return null;
    }
    const DATE = /\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/;
    const NUMBER = /^[$€₽]?\d[\d.,\s]*$/;
    /** The option of a select step the question names: { option, used: Set of word indexes } or null (none, or a tie). */
    function optionIn(step, qw, block) {
      let best = null, tie = false;
      for (const { o, hw } of optWords(step)) {
        const used = new Set();
        const ok = hw.every(h => {
          const at = qw.findIndex(x => !used.has(x.n) && !(block && block.has(x.n)) && (h.num ? x.w === h.w : !x.num && same(x.s, h.s)));
          if (at < 0) return false;
          used.add(qw[at].n);
          return true;
        });
        if (!ok) continue;
        if (!best || hw.length > best.size) { best = { option: o, used, size: hw.length }; tie = false; } else if (hw.length === best.size && o !== best.option) tie = true;
      }
      return best && !tie ? best : null;
    }
    /**
     * Steps with the values the question gives: the option of a select the question names, and for a text field the
     * value next to its label ("phone 555-0142", "rate $2,800", "120 gallons"). Only what safeValue confirms; dates are
     * left to the user (a date field may want another format, and a step waits for its value). The guide is not changed.
     */
    function fill(steps, question) {
      const qw = words(question);
      const src = Array.isArray(steps) ? steps : [];
      const out = src.map(s => ({ ...s }));
      const used = new Set();
      out.forEach((s, i) => {
        if (s.action !== 'select') return;
        const hit = optionIn(src[i], qw, used);
        if (!hit) return;
        const v = safeValue(hit.option, question, s.options);
        if (v) { s.value = v; hit.used.forEach(n => used.add(n)); }
      });
      const fields = out.filter(s => s.action === 'type' && !s.value && s.target && s.target.text)
        .map(s => ({ s, stems: toks(String(s.target.text).replace(/[*()]/g, ' ')) }));
      const labels = fields.flatMap(f => f.stems);
      // Value spans: runs of value-looking words (digits, $, @, or capitalised mid-sentence words that are no label).
      const isVal = x => x.num || x.q || (x.cap && x.n > 0 && !STOP.has(x.w) && !labels.some(t => same(t, x.s)));
      const spans = [];
      for (let i = 0; i < qw.length; i++) {
        if (used.has(qw[i].n) || !isVal(qw[i])) continue;
        let j = i;
        while (j + 1 < qw.length && isVal(qw[j + 1]) && !used.has(qw[j + 1].n) && !/[,;]/.test(String(question).slice(qw[j].end, qw[j + 1].at))) j++;
        spans.push({ from: i, to: j, text: String(question).slice(qw[i].at, qw[j].end) });
        i = j;
      }
      const count = {};
      fields.forEach(f => f.stems.forEach(t => { count[t] = (count[t] || 0) + 1; }));
      const taken = new Set();
      const anchorOf = (f, uniqueOnly) => {
        for (let i = 0; i < qw.length; i++) {
          if (qw[i].num || used.has(qw[i].n)) continue;
          if (f.stems.some(t => same(t, qw[i].s) && (!uniqueOnly || count[t] === 1))) return i;
        }
        return -1;
      };
      for (const uniqueOnly of [true, false]) {
        for (const f of fields) {
          if (f.s.value) continue;
          const a = anchorOf(f, uniqueOnly);
          if (a < 0) continue;
          // A number right before the label ("120 gallons"), else the first value within six words after it.
          const sp = spans.find(x => !taken.has(x) && x.to === a - 1 && NUMBER.test(x.text)) || spans.find(x => !taken.has(x) && x.from > a && x.from <= a + 6);
          if (!sp || DATE.test(sp.text) || words(sp.text).some(x => MONTH.test(x.w))) continue;
          const v = safeValue(sp.text.replace(/^[«"“]|[»"”]$/g, ''), question, null);
          if (v) { f.s.value = v; taken.add(sp); }
        }
      }
      return out;
    }

    // ---- the index ----
    function index({ guides = [], faq = [], product = '' } = {}) {
      const t0 = Date.now();
      const prod = new Set(words(String(product || '').split(/[,—–:(|]/)[0]).map(x => x.w).filter(w => w.length >= 3));
      const T = [], byId = new Map();
      for (const g of Array.isArray(guides) ? guides : []) {
        if (!g || g.id == null || typeof g.name !== 'string' || !g.name.trim() || !Array.isArray(g.steps) || !g.steps.length || byId.has(String(g.id))) continue;
        const t = { kind: 'guide', guide: g, texts: [g.name], field: [], labels: [], ops: guideOps(g) };
        for (const s of g.steps) {
          if (!s) continue;
          if (s.target && typeof s.target.text === 'string') { t.field.push(s.target.text); t.labels.push(s.target.text); }
          if (typeof s.instruction === 'string') t.field.push(s.instruction);
          if (s.action === 'select') optWords(s).forEach(x => { t.field.push(head(x.o)); t.labels.push(head(x.o)); });
        }
        byId.set(String(g.id), t);
        T.push(t);
      }
      const facts = new Map();
      for (const f of Array.isArray(faq) ? faq : []) {
        if (!f || typeof f.q !== 'string' || !f.q.trim()) continue;
        const q = f.q.slice(0, 200);
        if (typeof f.answer === 'string' && f.answer.trim()) {
          const k = f.fact != null ? 'f:' + f.fact : 'a:' + f.answer;
          let t = facts.get(k);
          if (!t) { t = { kind: 'fact', texts: [], field: [], labels: [], answers: {}, show: null }; facts.set(k, t); T.push(t); }
          if (t.texts.length < 12) t.texts.push(q);
          const lang = CYR.test(low(q)) ? 'ru' : 'xx';
          if (!t.answers[lang]) t.answers[lang] = f.answer.slice(0, 400);
          if (!t.answers.ru && typeof f.answer_ru === 'string' && f.answer_ru.trim()) t.answers.ru = f.answer_ru.slice(0, 400);
          if (!t.show && f.guide != null && byId.has(String(f.guide))) t.show = byId.get(String(f.guide)).guide;
        } else if (f.guide != null && byId.has(String(f.guide))) {
          const t = byId.get(String(f.guide));
          if (t.texts.length < 12) t.texts.push(q);
        }
      }
      const N = T.length, df = new Map(), core = new Map(), field = new Map();
      // The same texts come back often ("Click «Drivers» in the main navigation"): tokenised once per index.
      const tkm = new Map();
      const tk = x => { let v = tkm.get(x); if (!v) { v = toks(x, prod); tkm.set(x, v); } return v; };
      const push = (m, k, i) => { const a = m.get(k); if (!a) m.set(k, [i]); else if (a[a.length - 1] !== i) a.push(i); };
      const lab = s => low((s.target && s.target.text) || s.instruction || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      T.forEach((t, i) => {
        t.i = i;
        const ws = t.texts.map(x => words(x));
        t.name = tk(t.texts[0]);
        t.phrases = t.texts.map(tk).filter(p => p.length);
        const all = new Set(t.phrases.flat());
        all.forEach(s => { df.set(s, (df.get(s) || 0) + 1); push(core, s, i); });
        const fs = new Set();
        for (const x of t.field) for (const s of tk(x)) if (!all.has(s)) fs.add(s);
        fs.forEach(s => push(field, s, i));
        // Labels of the controls it touches, as stems: a question that names one whole ("phone", "dry van", "USDOT
        // number") is talking about this guide's form.
        t.labelStems = t.labels.map(x => tk(String(x).replace(/[*()]/g, ' '))).filter(l => l.length && l.length <= 4);
        t.acts = new Set(ws.flatMap(w => [...actsOf(w, true)]));
        t.nameActs = actsOf(ws[0]);
        t.nameView = actsOf(ws[0], true).has('view');
        t.hard = t.kind === 'guide' ? new Set([...t.nameActs].filter(k => HARD.has(k))) : new Set();
        if (t.kind === 'guide') {
          // What the guide ends on and which fields it fills: two guides alike in both are the same task.
          const st = t.guide.steps.filter(s => s && s.action !== 'look');
          t.end = st.length ? st[st.length - 1].action + ':' + lab(st[st.length - 1]) : '';
          t.fields = new Set(st.filter(s => s.action === 'type' || s.action === 'select').map(lab));
          t.live = t.guide.live ? 1 : 0;
        }
      });
      const idf = s => Math.log((N + 1) / ((df.get(s) || 0) + 0.5));
      T.forEach(t => { t.pw = t.phrases.map(p => p.map(idf)); t.pws = t.pw.map(a => a.reduce((x, y) => x + y, 0) || 1); });
      // Synonyms learned from the FAQ: a phrasing that differs from its guide's name by a word or two pairs those
      // words ("bill" ~ "invoice", "водител" ~ "driver"); a pair counts when it holds for two or more guides.
      const one = new Map(), pair = new Map();
      const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
      // Action words are left out: their classes already match across languages.
      const plain = list => list.filter(s => !actOf(s));
      for (const t of T) {
        const name = plain(t.name);
        if (t.kind !== 'guide' || !name.length) continue;
        const A = new Set(), B = new Set(), P = new Set();
        for (const p0 of t.phrases.slice(1)) {
          const p = plain(p0);
          const ua = p.filter(s => !name.some(n => same(n, s)));
          const ub = name.filter(n => !p.some(s => same(n, s)));
          if (!ua.length || !ub.length || ua.length > 2 || ub.length > 2) continue;
          ua.forEach(a => { A.add(a); ub.forEach(b => P.add(a + '|' + b)); });
          ub.forEach(b => B.add(b));
        }
        A.forEach(a => inc(one, 'a' + a)); B.forEach(b => inc(one, 'b' + b)); P.forEach(k => inc(pair, k));
      }
      const syn = new Map();
      const addSyn = (a, b) => { if (!syn.has(a)) syn.set(a, new Set()); syn.get(a).add(b); };
      for (const [k, n] of pair) {
        const [a, b] = k.split('|');
        if (a !== b && n >= 2 && n >= 0.5 * Math.min(one.get('a' + a), one.get('b' + b))) { addSyn(a, b); addSyn(b, a); }
      }
      return { T, N, df, core, field, syn, prod, vocab: [...new Set([...core.keys(), ...field.keys()])], guides: T.filter(t => t.kind === 'guide').length, facts: facts.size, ms: Date.now() - t0 };
    }

    // ---- matching ----
    const SURE = 0.7, EXPLAINED = 0.9, MARGIN = 0.1, SUGGEST = 0.45, NAME_EDGE = 0.2, NAME_EXTRA = 0.25;
    // A question about a value ("what plan are we on", «сколько счетов ждут оплаты»): a fact answers it. Anything else
    // ("how do I…", a command) is a task: only guides compete.
    const VALUE_Q = /^(what|whats|which|who|whose|when|is|are|was|were|do|does|did|have|has|how (many|much|long|big|often))\b|^(какой|какая|какое|какие|каков|какова|сколько|кто|когда|чей|чья|есть ли)(?![\p{L}])|(^|\s)ли(?![\p{L}])/u;
    // Two guides that end on the same control and fill mostly the same fields are one answer (the same task from two
    // screens); so is a guide that stops at the opener (live, no fields) and one that goes on through the form.
    // So are two guides with the same words in their names ("Send invoices to factoring" from the list, "Send an
    // invoice to factoring" from a row's menu), and one whose fields are all among the other's ("Change a load's rate"
    // and "Edit load details (… Pay)": the same «Edit load» form).
    function equivalent(a, b) {
      if (a.name && b.name && a.name.length && a.name.length === b.name.length && a.name.every(s => b.name.some(t => same(s, t)))) return true;
      if (!a.end || a.end !== b.end) return false;
      const x = a.fields, y = b.fields;
      if (!x.size || !y.size) return (!x.size && !y.size) || (!x.size ? a.live : b.live) === 1;
      let both = 0;
      x.forEach(f => { if (y.has(f)) both++; });
      return both / (x.size + y.size - both) >= 0.5 || both === Math.min(x.size, y.size);
    }
    function match(ix, question, debug) {
      const none = { kind: 'none', suggest: [], score: 0, top: [] };
      if (!ix || !ix.T || !ix.T.length) return none;
      const qw = words(question);
      const Q = [];
      for (const x of qw) for (const p of partsOf(x, ix.prod)) {
        const s = stem(p);
        if (!Q.some(q => q.s === s)) Q.push({ s, w: p, x, act: actOf(p) });
      }
      for (const q of Q) {
        q.M = new Set();
        for (const v of ix.vocab) if (same(q.s, v)) q.M.add(v);
        q.S = new Set();
        q.M.forEach(v => (ix.syn.get(v) || []).forEach(s => { if (!q.M.has(s)) q.S.add(s); }));
        q.core = new Set(); q.fld = new Set(); q.syn = new Set();
        q.M.forEach(v => { (ix.core.get(v) || []).forEach(i => q.core.add(i)); (ix.field.get(v) || []).forEach(i => q.fld.add(i)); });
        q.S.forEach(v => (ix.core.get(v) || []).forEach(i => q.syn.add(i)));
        q.known = q.core.size > 0 || q.fld.size > 0 || q.syn.size > 0 || !!q.act;
        q.idf = Math.log((ix.N + 1) / (q.core.size + 0.5));
      }
      // Values: numbers, quoted text, months and money, and capitalised words mid-sentence that nothing in the guides
      // knows (a name like "Jake Morris" or "Summit Freight": a run of capitalised words goes together).
      for (let i = 0; i < qw.length; i++) {
        if (!(qw[i].cap && qw[i].n > 0)) continue;
        let j = i;
        while (j + 1 < qw.length && qw[j + 1].cap) j++;
        const run = Q.filter(q => q.x.n >= i && q.x.n <= j);
        if (run.some(q => !q.known)) run.forEach(q => { q.value = true; });
        i = j;
      }
      for (const q of Q) if (q.x.q || (!q.known && (MONTH.test(q.w) || MONEY.test(q.w)))) q.value = true;
      const C = Q.filter(q => !q.value).slice(0, 30);
      if (!C.length) return none;
      const sum = C.reduce((n, q) => n + q.idf, 0) || 1;
      const QM = new Set(), QS = new Set();
      C.forEach(q => { q.M.forEach(v => QM.add(v)); q.S.forEach(v => QS.add(v)); });
      const valueQ = VALUE_Q.test(low(String(question)).trim());
      const qActs = actsOf(qw);
      const qOps = new Set(C.map(q => opOf(q.w)).filter(Boolean));
      const qView = actsOf(qw, true).has('view');
      // How much of the question (its words other than the action) a guide's own name says.
      const plainC = C.filter(q => !q.act), plainSum = plainC.reduce((n, q) => n + q.idf, 0) || 1;
      const nameCov = t => {
        let c = 0;
        for (const q of plainC) { if (t.name.some(s => q.M.has(s))) c += q.idf; else if (t.name.some(s => q.S.has(s))) c += 0.8 * q.idf; }
        return c / plainSum;
      };
      // How much of a guide's own name (its words other than the action) the question does not say: «Change a trip's
      // driver pay» names a trip and a driver that "change the load pay" never mentions.
      const nameExtra = t => {
        let all = 0, out = 0;
        for (const s of t.name) {
          if (actOf(s)) continue;
          const w = Math.log((ix.N + 1) / ((ix.df.get(s) || 0) + 0.5));
          all += w;
          if (!QM.has(s) && !QS.has(s)) out += w;
        }
        return all ? out / all : 0;
      };
      // A field name counts for a guide only when it is a slot the user fills ("phone 555-0142", "120 gallons") or
      // the whole label of one of its controls ("billing email", "dry van"): "address" alone is not "Street address".
      const valAt = new Set(qw.filter(x => x.num).map(x => x.n));
      Q.forEach(q => { if (q.value) valAt.add(q.x.n); });
      C.forEach(q => { q.slot = valAt.has(q.x.n + 1) || valAt.has(q.x.n + 2) || (valAt.has(q.x.n - 1) && qw[q.x.n - 1].num); q.rare = q.core.size < 0.3 * ix.N; });
      const labelled = (t, q) => t.labelStems && t.labelStems.some(l => l.some(s => q.M.has(s)) && l.every(s => QM.has(s)));
      // Which question words each stem matches, as bits (direct, and through a learned synonym).
      const bitM = new Map(), bitS = new Map();
      C.forEach((q, k) => { q.M.forEach(v => bitM.set(v, (bitM.get(v) || 0) | (1 << k))); q.S.forEach(v => bitS.set(v, (bitS.get(v) || 0) | (1 << k))); });
      const all = (1 << C.length) - 1;
      // Targets that share a word or a synonym with the question (a field alone can't make a phrasing match), and
      // could still explain enough of it: below R 0.29 even a perfect phrasing scores under SUGGEST.
      const ub = new Float64Array(ix.N);
      let anyAct = 0;
      C.forEach(q => {
        if (q.act) { anyAct += q.idf; return; }
        q.core.forEach(i => { ub[i] += q.idf; });
        q.syn.forEach(i => { if (!q.core.has(i)) ub[i] += 0.8 * q.idf; });
        q.fld.forEach(i => { if (!q.core.has(i) && !q.syn.has(i)) ub[i] += q.idf; });
      });
      const cand = new Set();
      C.forEach(q => { q.core.forEach(i => cand.add(i)); q.syn.forEach(i => cand.add(i)); });
      const scored = [];
      for (const i of cand) {
        const t = ix.T[i];
        if ((t.kind === 'fact' && !valueQ) || (ub[i] + anyAct) / sum < 0.29) continue;
        // R: how much of the question this target explains (its phrasings, learned synonyms, its action words, a
        // little its fields); C: how much of its best phrasing the question says. score = their harmonic mean.
        let mAll = 0, sAll = 0, actMask = 0;
        for (let k = 0; k < C.length; k++) if (C[k].act && t.acts.has(C[k].act)) actMask |= 1 << k;
        let bestC = 0, exact = false;
        for (let pi = 0; pi < t.phrases.length; pi++) {
          const p = t.phrases[pi], pw = t.pw[pi];
          let cov = 0, m = 0, s = 0;
          for (let j = 0; j < p.length; j++) {
            const a = bitM.get(p[j]), b = bitS.get(p[j]);
            if (a) { cov += pw[j]; m |= a; } else if (b) { cov += 0.8 * pw[j]; s |= b; }
          }
          mAll |= m; sAll |= s;
          const Cv = cov / t.pws[pi];
          if (Cv > bestC) bestC = Cv;
          if (Cv > 0.999 && ((m | actMask) & all) === all) exact = true;
        }
        let r = 0, expl = 0, missing = false;
        for (let k = 0; k < C.length; k++) {
          const q = C[k], bit = 1 << k, e = ((mAll | actMask) & bit) ? 1 : (sAll & bit) ? 0.8 : 0, f = e < 1 && q.fld.has(i);
          // A field the user fills ("phone 555-0142") or names whole ("oil change") is as good as a phrasing word; any
          // other mention of a field only a little.
          const filled = f && (q.slot || labelled(t, q));
          r += q.idf * (filled ? 1 : f ? Math.max(e, 0.4) : e);
          // Every word of the question must be this target's (a slot or a control it names counts), except very common ones.
          if (e > 0 || filled) expl += q.idf; else if (q.rare) missing = true;
        }
        const R = r / sum;
        scored.push({ t, score: R + bestC > 0 ? (2 * R * bestC) / (R + bestC) : 0, R, explained: expl / sum, missing, exact });
      }
      scored.sort((a, b) => b.score - a.score || b.exact - a.exact);
      // Action words, without the words a select option of the guide takes ("oil change" is a service type).
      const clash = t => {
        let qa = qActs;
        if (t.kind === 'guide') {
          const skip = new Set();
          for (const s of t.guide.steps) if (s && s.action === 'select') { const h = optionIn(s, qw); if (h) h.used.forEach(n => skip.add(n)); }
          if (skip.size) qa = actsOf(qw.filter(x => !skip.has(x.n)));
        }
        for (const k of qa) if (!t.acts.has(k) || (HARD.has(k) && !t.nameActs.has(k))) return true;
        for (const k of t.hard) if (!qa.has(k)) return true;
        if (t.kind === 'guide') for (const k of qOps) if (!t.ops.has(k)) return true;
        return false;
      };
      // Two facts that tie and give the same numbers are one answer (the dashboard and the list both say "3 of 15").
      const digits = t => (Object.values(t.answers).join(' ').match(/\d+/g) || []).sort().join(',');
      const agree = (a, b) => a.t.kind === 'fact' && b.t.kind === 'fact' && !!digits(a.t) && digits(a.t) === digits(b.t);
      const head12 = scored.slice(0, 12).map(s => ({ ...s, clash: clash(s.t) }));
      const ok = head12.filter(s => !s.clash);
      const unknown = C.filter(q => !q.known).reduce((n, q) => n + q.idf, 0) / sum;
      // Plausible: explains the whole question. The best plausible one wins when no other plausible one is close, or
      // when only it has a phrasing that is exactly the question, or when the close ones are the same task.
      const plausible = s => s.score >= SURE && s.explained >= EXPLAINED && !s.missing;
      const pick = pool => {
        const P = pool.filter(plausible);
        let b = P[0];
        if (!b || unknown > 0.1) return null;
        if (head12.some(s => s.clash && s.t.kind === b.t.kind && s.score > b.score && plausible(s))) return null;
        // A rival whose name lacks the question's action word while b's name has it is no rival ("edit a load" vs
        // "See a load's history").
        const named = s => [...qActs].every(k => s.t.nameActs.has(k));
        // The object must be the question's. A guide whose name says clearly more of the question's own words, and no
        // action the question lacks, is the better answer ("update the rate on a load": «Change a load's rate» over
        // «Edit a load»); when it does not explain the question well enough to run, b is only a guess ("change the
        // load pay": b «Change a trip's driver pay», while «Edit load details (… Pay)» names the load and the pay).
        const cov = new Map(), nc = s => { if (!cov.has(s)) cov.set(s, s.t.kind === 'guide' ? nameCov(s.t) : 0); return cov.get(s); };
        const own = s => s.t.kind === 'guide' && [...s.t.nameActs].every(k => qActs.has(k)) && (!s.t.nameView || qView);
        // Only when b's name says something the question does not («Create a new invoice batch» for "create an invoice
        // batch for delivered loads" says nothing extra, and «Add a load to an invoice batch» is no better for it).
        const xb = b.t.kind === 'guide' ? nameExtra(b.t) : 0;
        if (b.t.kind === 'guide' && !b.exact && xb > NAME_EXTRA) {
          const nb = nc(b);
          const says = s => s !== b && own(s) && nc(s) >= nb + NAME_EDGE && !equivalent(b.t, s.t);
          const better = P.filter(s => says(s) && nameExtra(s.t) < xb).sort((x, y) => nc(y) - nc(x) || y.score - x.score);
          if (better.length) b = better[0];
          else if (pool.some(s => says(s) && !plausible(s) && s.score >= SUGGEST && s.R >= b.R - 0.15)) return null;
        }
        const nameBeats = s => b.t.kind === 'guide' && nc(b) >= nc(s) + NAME_EDGE;
        const rivals = P.filter(s => s !== b && b.score - s.score < MARGIN && !(named(b) && !named(s)) && !nameBeats(s));
        if (!rivals.length) return b;
        if (b.exact && rivals.every(s => !s.exact)) return b;
        if (rivals.every(s => agree(b, s))) return b;
        if (b.t.kind === 'guide' && rivals.every(s => equivalent(b.t, s.t))) return [b, ...rivals].sort((x, y) => (x.t.live - y.t.live) || (y.score - x.score))[0];
        return null;
      };
      const top = ok.slice(0, 3).map(s => ({ name: s.t.kind === 'guide' ? s.t.guide.name : s.t.texts[0], kind: s.t.kind, score: +s.score.toFixed(3), R: +s.R.toFixed(3) }));
      const dbg = debug ? { debug: head12.map(s => ({ name: s.t.kind === 'guide' ? s.t.guide.name : s.t.texts[0], kind: s.t.kind, score: +s.score.toFixed(3), R: +s.R.toFixed(3), explained: +s.explained.toFixed(2), missing: s.missing, exact: s.exact, clash: s.clash })), unknown: +unknown.toFixed(2), valueQ, C: C.map(q => q.s) } : {};
      const facts = ok.filter(s => s.t.kind === 'fact'), guides = ok.filter(s => s.t.kind === 'guide');
      const f = valueQ ? pick(facts) : null;
      if (f) {
        const a = f.t.answers;
        return { kind: 'fact', answer: (CYR.test(low(question)) ? a.ru || a.xx : a.xx || a.ru) || '', show: f.t.show || null, score: f.score, top, ...dbg };
      }
      // A question about a value is not a task: only a guide that shows something may answer it (never one that
      // creates or changes), and not when several facts answer it equally well.
      const g = valueQ && facts.some(plausible) ? null : pick(valueQ ? guides.filter(s => !s.t.nameActs.size) : guides);
      if (g) return { kind: 'guide', guide: g.t.guide, steps: fill(g.t.guide.steps, question), score: g.score, top, ...dbg };
      const suggest = guides.filter(s => s.score >= SUGGEST).slice(0, 3).map(s => s.t.guide);
      return { kind: suggest.length ? 'suggest' : 'none', suggest, score: ok[0] ? ok[0].score : 0, top, ...dbg };
    }
    return { index, match, fill, safeValue, words, stem, opsOf, guideOps };
  })();
  // ==== instant answers: end ====
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  // The index over every guide this page knows (learned + recorded) and the learned FAQ: built once, again only when
  // the guides change.
  let instant = null;
  const instantIndex = () => instant || (instant = Instant.index({ guides: playbooks, faq: (learned && learned.faq) || [], product: cfg.product }));
  const instantDirty = () => {
    instant = null;
    const idle = window.requestIdleCallback || (fn => setTimeout(fn, 200));
    idle(() => { try { instantIndex(); } catch (e) { /* built on the first question instead */ } });
  };

  // ---------- asking ----------
  function stopAsk() { if (current) { current.ctl.abort(); current = null; } progress = null; }
  const scan = query => { try { return S.scan({ query }); } catch (e) { return S.scan(); } };
  const remember = (question, answer) => { chat = [...chat, { role: 'user', content: question.slice(0, 600) }, { role: 'assistant', content: String(answer || '').slice(0, 600) }].slice(-6); };

  async function ask(question, { force = false } = {}) {
    stopAsk();
    S.guide.stop(false);
    learning = null;
    const runId = newRun();
    if (!force) {
      // 1. A learned guide, a FAQ phrasing or a fact answers it: instantly, 0 tokens, nothing sent anywhere.
      let m = null;
      try { m = Instant.match(instantIndex(), question); } catch (e) { m = null; }
      if (m && m.kind === 'guide') return runSteps(runId, question, `Сценарий «${m.guide.name}»`, m.steps, 'playbook', !!m.guide.live);
      if (m && m.kind === 'fact') {
        remember(question, m.answer);
        return runSteps(runId, question, m.answer, [], 'faq', false, m.show ? { id: m.show.id, name: m.show.name } : null);
      }
      if (m && m.suggest.length) {
        state = { runId, question, status: 'suggest', steps: [], suggestions: m.suggest.map(p => ({ id: p.id, name: p.name })) };
        save(); render(); setOpen(true); return;
      }
    }
    const ctl = new AbortController();
    current = { runId, ctl };
    const clear = deadline(ctl, 75000);
    state = { runId, question, status: 'thinking', steps: [] }; save(); render();
    try {
      // force: the user turned the suggestions down, so the server does not answer from the guides either.
      const out = await post('', { question, page: scan(question), history: chat, product: cfg.product, ...(force ? { force: true } : {}) }, {
        signal: ctl.signal,
        onProgress: p => { if (current && current.runId === runId) { progress = p; render(); } },
      });
      if (!state || state.runId !== runId) return; // asked again or cancelled meanwhile
      remember(question, out.answer);
      const steps = out.ready ? out.steps || [] : toSteps(out.steps || []);
      const show = out.show ? playbooks.find(p => p.id === out.show) : null;
      runSteps(runId, question, out.answer, steps, out.source || (out.ready ? 'map' : 'claude'), !!out.live, show ? { id: show.id, name: show.name } : null);
    } catch (e) {
      if (!state || state.runId !== runId) return;
      if (ctl.signal.aborted) {
        // Cancelled by the user stays quiet; our own deadline becomes a readable error.
        if (ctl.signal.reason && ctl.signal.reason.name === 'TimeoutError') { state = { runId, question, status: 'error', error: 'Сервер не ответил вовремя. Попробуйте ещё раз.', steps: [] }; save(); render(); }
        return;
      }
      state = { runId, question, status: 'error', error: (e && e.message) || 'Не получилось ответить', steps: [] }; save(); render();
    } finally {
      clear();
      if (current && current.runId === runId) current = null;
      progress = null;
    }
  }

  // Claude's ids point at this page's controls; steps for later pages carry only the label it expects.
  const toSteps = list => list.map(s => {
    const el = s.element_id != null ? S.byId(s.element_id) : null;
    return { instruction: s.instruction, action: s.action, value: s.value, target: el ? S.describe(el) : s.element_text ? { sel: [], text: s.element_text, role: null } : null };
  });

  // The user reached a page where the expected control isn't: plan the rest from what is on screen now.
  async function replan(index) {
    if (!state || state.status !== 'running') return;
    const runId = state.runId;
    state.replanned = state.replanned || [];
    if (state.replanned.includes(index) || state.replanned.length >= 2) return;
    state.replanned.push(index); save();
    const progressDone = state.steps.slice(0, index).map(s => s.instruction);
    const ctl = new AbortController();
    const clear = deadline(ctl, 75000);
    try {
      const out = await post('', { question: state.question, page: scan(state.question), history: chat.slice(0, -2), progress: progressDone, product: cfg.product }, { signal: ctl.signal });
      if (!state || state.runId !== runId || state.index !== index) return;
      const rest = toSteps(out.steps || []);
      state.steps = state.steps.slice(0, index).concat(rest);
      if (!rest.length) { state.status = 'done'; state.index = index; S.guide.stop(false); save(); render(); return; }
      save(); render();
      start(index);
    } catch (e) { /* keep waiting; the card still shows the instruction */ } finally { clear(); }
  }

  const here = () => location.pathname + (location.hash && location.hash !== '#' && location.hash !== '#/' ? location.hash : '');
  const samePage = path => !path || (S.samePlace ? S.samePlace(path, location.pathname + location.search + location.hash) : S.pathKey ? S.pathKey(path) === S.pathKey(location.pathname + location.search + location.hash) : String(path).replace(/#\/?$/, '') === here());

  // live: the guide stops where the learned map stopped (a form the explorer did not open); at its end the
  // rest is planned once from the page the user is on.
  // show: for an answer with no steps (a fact), the guide that opens the screen it is on ({ id, name }), or null.
  function runSteps(runId, question, answer, steps, source, live = false, show = null) {
    progress = null;
    state = { runId, question, answer, steps, source, live: !!live, show, index: 0, status: steps.length ? 'running' : 'answered', replanned: [], heals: 0, mores: 0 };
    save(); render();
    // Step aside so the page is visible; the pointer card carries the walkthrough from here.
    if (steps.length) { start(0); setTimeout(() => setOpen(false), 450); } else setOpen(true);
  }

  function start(index) {
    const runId = state.runId;
    const mine = () => state && state.runId === runId;
    S.guide.start(state.steps, {
      index,
      onChange: ({ index: i }) => { if (!mine()) return; state.index = Math.min(i, state.steps.length); if (i >= state.steps.length && !state.live) state.status = 'done'; save(); render(); },
      live: !!state.live,
      // The end of a live guide, or a step that is not on the page: one small request plans the rest from here.
      more: async ({ index: i, done }) => {
        if (!mine() || (state.mores || 0) >= 2) return null;
        state.mores = (state.mores || 0) + 1; save();
        const ctl = new AbortController();
        const clear = deadline(ctl, 60000);
        try {
          const out = await post('', { question: state.question, page: scan(state.question), progress: (done || state.steps.slice(0, i).map(s => s.instruction)).slice(0, 20), product: cfg.product }, { signal: ctl.signal });
          return mine() ? toSteps(out.steps || []) : null;
        } catch (e) { return null; } finally { clear(); }
      },
      onSteps: list => { if (!mine() || !Array.isArray(list)) return; state.steps = list; save(); render(); },
      onEnd: reason => { if (!mine()) return; state.status = reason === 'done' ? 'done' : 'answered'; if (reason === 'done') state.index = state.steps.length; save(); render(); },
      missingDelay: state.source === 'claude' ? 1200 : 2500,
      onMissing: async (step, i) => {
        if (!mine()) return null;
        if (state.source === 'claude') { replan(i); return null; }
        // A saved step's control is on another page: the user just isn't there yet.
        if (step.target && step.target.path && !samePage(step.target.path)) return null;
        if ((state.heals || 0) >= 3) return null;
        state.heals = (state.heals || 0) + 1;
        // Re-find a moved control through the vendor's server (one small Haiku request), for this run only.
        let candidates = [];
        try { candidates = S.candidatesFor ? (S.candidatesFor(step.target, 8) || []).map(c => c.id).filter(Number.isInteger) : []; } catch (e) { candidates = []; }
        const query = [step.instruction, step.target && step.target.text].filter(Boolean).join(' ');
        const ctl = new AbortController();
        const clear = deadline(ctl, 30000);
        try {
          const out = await post('', { locate: { instruction: step.instruction, oldText: step.target && step.target.text }, page: scan(query), candidates }, { signal: ctl.signal });
          if (!mine()) return null;
          const el = out && out.element_id != null ? S.byId(out.element_id) : null;
          return el ? S.describe(el) : null;
        } catch (e) { return null; } finally { clear(); }
      },
    });
  }

  /** A ready-made guide by id or name (learned, recorded or from data-playbooks). Resolves to whether it started. */
  async function startGuide(name) {
    await Promise.all([knowledgeReady, playbooksReady]);
    const key = norm(name);
    const pb = playbooks.find(p => p.id === name) || playbooks.find(p => norm(p.name) === key);
    if (!pb) return false;
    learning = null;
    stopAsk();
    runSteps(newRun(), pb.name, `Сценарий «${pb.name}»`, pb.steps, 'playbook', !!pb.live);
    return true;
  }

  async function boot() {
    (document.body || document.documentElement).appendChild(host);
    state = load();
    // A request that was in flight when the page unloaded is gone: don't show a spinner forever.
    if (state && state.status === 'thinking') state = { ...state, status: 'error', error: 'Ответ прервался при переходе. Спросите ещё раз.' };
    render();
    // Our launcher is drawn: the loader's goes away in the same task (no flicker), keeping the focus if it had it.
    if (ldr && ldr.handoff && ldr.handoff()) root.querySelector('.launch').focus();
    // Calls made on the loader's stub (a click on its launcher, Scopos.widget.* from the page) run now.
    for (const [m, args, ok, fail] of ldr && ldr.queue ? ldr.queue.splice(0) : []) {
      try { Promise.resolve(S.widget[m](...args)).then(ok, fail); } catch (e) { fail(e); }
    }
    if (cfg.learn) {
      let walking = false;
      try { walking = !!sessionStorage.getItem(LEARN_KEY); } catch (e) { walking = false; }
      if (walking && (await needLearn().then(() => S.explore.resume(learnOpts), () => false))) { learning = { status: 'exploring', views: 0, probes: 0 }; render(); return; }
    } else {
      try { sessionStorage.removeItem(LEARN_KEY); } catch (e) { /* ignore */ }
    }
    if (new URLSearchParams(location.search).has('scopos-learn')) {
      const u = new URL(location.href); u.searchParams.delete('scopos-learn');
      window.history.replaceState(window.history.state, '', u.href);
      if (cfg.learn) return confirmLearning();
      console.warn('[Scopos] режим изучения выключен: добавьте data-learn к тегу <script> (работает на localhost или с data-learn-token).');
    }
    if (state && state.status === 'running' && (state.index < state.steps.length || state.live)) start(state.index);
  }
  // The API goes in before boot(), which runs the calls queued on the loader's stub.
  S.widget = { open: () => setOpen(true), ask, startGuide, cfg: { endpoint: cfg.endpoint, product: cfg.product, learn: cfg.learn } };
  if (cfg.learn) S.widget.learn = confirmLearning;
  // Loaded on idle with nothing waiting: boot in the next task, so evaluating this file and building the widget
  // are two short tasks instead of one long one (weak machines). A running guide or a queued click boots at once.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else if (ldr && !ldr.urgent && !(ldr.queue && ldr.queue.length)) setTimeout(boot, 0);
  else boot();
})();
