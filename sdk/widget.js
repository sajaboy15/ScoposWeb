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

  const playbooksReady = cfg.playbooksUrl ? fetch(cfg.playbooksUrl).then(r => (r.ok ? r.json() : [])).then(list => { if (Array.isArray(list)) playbooks = list; }).catch(() => {}) : Promise.resolve();

  // Guides the explorer and Claude wrote for this product (see learn mode below).
  let learned = null; // { summary, guides, views, learnedAt }
  const addLearned = k => {
    learned = k && k.guides && k.guides.length ? k : null;
    if (!learned) return;
    const ids = new Set(learned.guides.map(g => g.id));
    playbooks = [...learned.guides, ...playbooks.filter(p => !ids.has(p.id))];
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
  const LEARN_MS = 180e3;
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
        learning = { status: 'done', views: map.views.length, probes: map.probes, guides: (out.guides || []).length, summary: out.summary };
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
      return waiting(`learn:${L.startedAt}`, `Изучил ${L.views} экранов и окон. Claude пишет гайды${s > 2 ? ` · ${s} с` : '…'}`, '', '<p class="note">Обычно это минута-две.</p>');
    }
    if (L.status === 'error') return `<div class="err">${esc(L.error)}</div><div class="row">${cfg.learn ? '<button class="btn main" data-do="learn-again">Изучить заново</button>' : ''}<button class="btn" data-do="learn-cancel">Закрыть</button></div>`;
    return `<p class="a">Изучил продукт: ${L.views} экранов и окон, ${L.probes || 0} проверенных кнопок.</p><p class="hi">${esc(L.summary || '')}</p>
      <div class="q">Готовые гайды · ${L.guides || 0}</div><div class="chips">${playbooks.filter(p => p.learned).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>`;
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
      : state.source === 'cache' ? '<span class="fast">мгновенно · из кэша</span>'
      : state.source === 'map' ? 'Claude · по карте продукта' : 'Ответ Claude';
    setBody(`<div class="q">${esc(state.question)}</div>${state.answer ? `<p class="a">${esc(state.answer)}</p>` : ''}
      ${state.steps.length ? `<ol>${state.steps.map((s, i) => `<li class="${i < idx || done ? 'done' : i === idx ? 'cur' : ''}"><i>${i + 1}</i><span>${esc(s.instruction)}</span></li>`).join('')}</ol>` : ''}
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

  // ---------- local intent matcher: a question that names a guide runs it with 0 tokens ----------
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(['как', 'где', 'мне', 'можно', 'сделать', 'это', 'хочу', 'нужно', 'надо', 'что', 'чтобы', 'свой', 'свою', 'мой', 'мою', 'пожалуйста', 'how', 'the', 'can', 'where', 'what', 'and', 'want', 'need']);
  const ACTION = ['отмен', 'удал', 'измен', 'выключ', 'отключ', 'убра', 'убер', 'смен', 'помен', 'cancel', 'delet', 'remov', 'edit', 'chang', 'disabl', 'turn off'];
  const stems = s => norm(s).split(' ').filter(x => x.length > 2 && !STOP.has(x))
    .map(x => { let y = x; for (let i = 0; i < 2 && y.length > 4 && /[аеиоуыэюяйь]$/.test(y); i++) y = y.slice(0, -1); return y.slice(0, 6); });
  const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  const coverage = (from, to) => (from.length ? from.filter(x => to.some(t => same(x, t))).length / from.length : 0);
  const actions = s => { const n = ' ' + norm(s) + ' '; return new Set(ACTION.filter(a => n.includes(' ' + a))); };
  function matchGuides(question) {
    const q = stems(question), qa = actions(question);
    const scored = [];
    for (const pb of playbooks) {
      const n = stems(pb.name);
      if (!n.length || !q.length) continue;
      const toQ = coverage(n, q), toN = coverage(q, n), na = actions(pb.name);
      const clash = [...qa].some(a => !na.has(a)) || [...na].some(a => !qa.has(a));
      scored.push({ pb, score: (toQ + toN) / 2, sure: toQ >= 0.75 && toN >= 0.6 && !clash });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].sure) return { run: scored[0].pb, suggest: [] };
    return { run: null, suggest: scored.filter(s => s.score >= 0.4 || s.sure).slice(0, 3).map(s => s.pb) };
  }

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
      const m = matchGuides(question);
      if (m.run) return runSteps(runId, question, `Сценарий «${m.run.name}»`, m.run.steps, 'playbook', !!m.run.live);
      if (m.suggest.length) {
        state = { runId, question, status: 'suggest', steps: [], suggestions: m.suggest.map(p => ({ id: p.id, name: p.name })) };
        save(); render(); setOpen(true); return;
      }
    }
    const ctl = new AbortController();
    current = { runId, ctl };
    const clear = deadline(ctl, 75000);
    state = { runId, question, status: 'thinking', steps: [] }; save(); render();
    try {
      const out = await post('', { question, page: scan(question), history: chat, product: cfg.product }, {
        signal: ctl.signal,
        onProgress: p => { if (current && current.runId === runId) { progress = p; render(); } },
      });
      if (!state || state.runId !== runId) return; // asked again or cancelled meanwhile
      remember(question, out.answer);
      const steps = out.ready ? out.steps || [] : toSteps(out.steps || []);
      runSteps(runId, question, out.answer, steps, out.source || (out.ready ? 'map' : 'claude'));
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
  const samePage = path => !path || (S.pathKey ? S.pathKey(path) === S.pathKey(location.pathname + location.search + location.hash) : String(path).replace(/#\/?$/, '') === here());

  // live: the guide stops where the learned map stopped (a form the explorer did not open); at its end the
  // rest is planned once from the page the user is on.
  function runSteps(runId, question, answer, steps, source, live = false) {
    progress = null;
    state = { runId, question, answer, steps, source, live: !!live, index: 0, status: steps.length ? 'running' : 'answered', replanned: [], heals: 0, mores: 0 };
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
