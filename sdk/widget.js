/*
 * Scopos SDK widget: what a software vendor embeds for its own customers.
 *
 *   <script src="https://cdn.example.com/scopos.js"
 *           data-endpoint="/api/scopos"           // the vendor's server; it holds the Claude key
 *           data-product="Ledgerly, счета и платежи"
 *           data-playbooks="/scopos-playbooks.json" // optional: scenarios recorded with the extension
 *           async></script>
 *
 * A small launcher sits in the corner; the panel takes a question, answers with
 * steps and runs them on the page with the same pointer as the extension. The
 * running walkthrough is kept in sessionStorage so it continues after page loads.
 * Saved scenarios run instantly and never reach the server.
 */
(function () {
  const S = window.Scopos;
  if (!S || S.widget) return;
  const me = document.currentScript || document.querySelector('script[data-endpoint][src*="scopos"]');
  const cfg = {
    endpoint: (me && me.dataset.endpoint) || '/api/scopos',
    product: (me && me.dataset.product) || document.title,
    playbooksUrl: me && me.dataset.playbooks,
    label: (me && me.dataset.label) || 'Спросить',
  };
  const KEY = 'scopos:run';
  let playbooks = Array.isArray(window.ScoposPlaybooks) ? window.ScoposPlaybooks : [];
  let history = [];
  let state = null; // { question, answer, steps, index, source, status, error }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const save = () => { try { state ? sessionStorage.setItem(KEY, JSON.stringify(state)) : sessionStorage.removeItem(KEY); } catch (e) {} };
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };

  if (cfg.playbooksUrl) fetch(cfg.playbooksUrl).then(r => (r.ok ? r.json() : [])).then(list => { if (Array.isArray(list)) playbooks = list; }).catch(() => {});

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
  opacity: 0; transform: translateY(10px) scale(.98); transform-origin: 100% 100%; pointer-events: none; transition: opacity .2s ease, transform .3s cubic-bezier(.22,.9,.24,1); }
.open .panel { opacity: 1; transform: none; pointer-events: auto; }
.head { display: flex; align-items: center; gap: 9px; padding: 14px 16px 6px; font-weight: 600; }
.head small { font-weight: 400; color: var(--ink-3); margin-left: 2px; }
.x { margin-left: auto; border: 0; background: none; color: var(--ink-3); width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 17px; }
.x:hover { background: var(--paper-2); color: var(--ink); }
.body { padding: 6px 16px 10px; overflow-y: auto; }
.hi { color: var(--ink-2); margin: 4px 0 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 0; background: var(--accent-soft); color: var(--accent-ink); border-radius: 999px; padding: 5px 11px; font: inherit; font-size: 13px; cursor: pointer; }
.q { color: var(--ink-3); font-size: 12.5px; margin: 6px 0 4px; }
.a { font-size: 15px; margin: 0 0 10px; }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
li { display: grid; grid-template-columns: 20px 1fr; gap: 10px; padding: 5px 0; color: var(--ink-2); font-size: 13.5px; }
li i { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--rule); display: grid; place-items: center; font-style: normal; font-size: 10.5px; color: var(--ink-3); }
li.done i { background: var(--accent); border-color: var(--accent); color: var(--paper); }
li.cur { color: var(--ink); font-weight: 500; }
li.cur i { border-color: var(--accent); color: var(--accent-ink); box-shadow: 0 0 0 4px var(--accent-soft); }
.meta { font-size: 11.5px; color: var(--ink-3); margin-top: 8px; }
.err { background: rgba(181,88,76,.1); border-radius: 12px; padding: 10px 12px; font-size: 13px; }
.think { display: flex; gap: 10px; align-items: center; color: var(--ink-2); padding: 8px 0; }
.spin { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--accent-soft); border-top-color: var(--accent); animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
form { display: flex; gap: 8px; align-items: center; margin: 4px 10px 10px; padding: 4px 4px 4px 12px; border: 1px solid var(--rule); border-radius: 16px; }
form:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; color: var(--ink); height: 34px; outline: none; }
.go { width: 34px; height: 34px; border-radius: 50%; border: 0; background: var(--ink); cursor: pointer; display: grid; place-items: center; }
.go .ring { border-color: var(--paper); width: 14px; height: 14px; } .go .ring::after { background: var(--paper); width: 4px; height: 4px; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:focus-visible { outline: none; }
@media (prefers-reduced-motion: reduce) { .panel, .launch { transition: opacity .15s linear; } .spin { animation: none; } }
`;

  const host = document.createElement('scopos-widget');
  host.setAttribute('data-scopos-ui', '');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${CSS_TEXT}</style><div class="w">
    <div class="panel" role="dialog" aria-label="Scopos">
      <div class="head"><span class="ring"></span>Scopos <small>${esc(cfg.product)}</small><button class="x" data-do="close" aria-label="Свернуть">×</button></div>
      <div class="body" aria-live="polite"></div>
      <form><input placeholder="Как это сделать?" aria-label="Вопрос"><button class="go" aria-label="Спросить"><span class="ring"></span></button></form>
    </div>
    <button class="launch" data-do="toggle"><span class="ring"></span>${esc(cfg.label)}</button>
  </div>`;
  const w = root.querySelector('.w'), body = root.querySelector('.body'), input = root.querySelector('input');

  function render() {
    const launch = root.querySelector('.launch');
    if (launch) launch.innerHTML = `<span class="ring"></span>${state && state.status === 'running' && state.steps.length ? `Шаг ${Math.min((state.index || 0) + 1, state.steps.length)} из ${state.steps.length}` : esc(cfg.label)}`;
    if (!state) {
      body.innerHTML = `<p class="hi">Спросите, как что-то сделать. Я покажу каждый шаг прямо здесь, на странице.</p>
        ${playbooks.length ? `<div class="chips">${playbooks.slice(0, 4).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : ''}`;
      return;
    }
    if (state.status === 'thinking') { body.innerHTML = `<div class="q">${esc(state.question)}</div><div class="think"><span class="spin"></span>Читаю страницу и продумываю шаги</div>`; return; }
    if (state.status === 'error') { body.innerHTML = `<div class="q">${esc(state.question)}</div><div class="err">${esc(state.error)}</div>`; return; }
    const idx = state.index || 0, done = state.status === 'done';
    body.innerHTML = `<div class="q">${esc(state.question)}</div>${state.answer ? `<p class="a">${esc(state.answer)}</p>` : ''}
      ${state.steps.length ? `<ol>${state.steps.map((s, i) => `<li class="${i < idx || done ? 'done' : i === idx ? 'cur' : ''}"><i>${i + 1}</i><span>${esc(s.instruction)}</span></li>`).join('')}</ol>` : ''}
      <div class="meta">${state.source === 'playbook' ? 'Сценарий · мгновенно' : 'Ответ Claude'}${done ? ' · готово' : ''}</div>`;
  }

  function setOpen(on) { w.classList.toggle('open', on); if (on) setTimeout(() => input.focus(), 50); }

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-do],[data-pb]');
    if (!b) return;
    if (b.dataset.pb) { const pb = playbooks.find(p => p.id === b.dataset.pb); if (pb) runSteps(pb.name, `Сценарий «${pb.name}»`, pb.steps, 'playbook'); return; }
    if (b.dataset.do === 'toggle') setOpen(!w.classList.contains('open'));
    if (b.dataset.do === 'close') setOpen(false);
  });
  root.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const t = input.value.trim(); if (t) { input.value = ''; ask(t); } });

  // ---------- logic ----------
  const words = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(x => x.length > 2).map(x => x.slice(0, 6));
  function matchPlaybook(question) {
    const q = new Set(words(question));
    let best = null, bestScore = 0;
    for (const pb of playbooks) {
      const n = words(pb.name);
      const score = n.length ? n.filter(x => q.has(x)).length / n.length : 0;
      if (score > bestScore) { best = pb; bestScore = score; }
    }
    return bestScore >= 0.67 ? best : null;
  }

  async function ask(question) {
    S.guide.stop(false);
    const pb = matchPlaybook(question);
    if (pb) return runSteps(question, `Сценарий «${pb.name}»`, pb.steps, 'playbook');
    state = { question, status: 'thinking', steps: [] }; render();
    try {
      const page = S.scan();
      const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, page, history, product: cfg.product }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Сервер ответил ошибкой ${res.status}`);
      history = [...history, { role: 'user', content: question }, { role: 'assistant', content: JSON.stringify(out) }].slice(-6);
      const steps = out.steps.map(s => {
        const el = s.element_id != null ? S.byId(s.element_id) : null;
        return { instruction: s.instruction, action: s.action, value: s.value, target: el ? S.describe(el) : s.element_text ? { sel: [], text: s.element_text, role: null } : null };
      });
      runSteps(question, out.answer, steps, 'claude');
    } catch (e) {
      state = { question, status: 'error', error: e.message || 'Не получилось ответить', steps: [] }; render();
    }
  }

  function runSteps(question, answer, steps, source) {
    state = { question, answer, steps, source, index: 0, status: steps.length ? 'running' : 'answered' };
    save(); render();
    // Step aside so the page is visible; the pointer card carries the walkthrough from here.
    if (steps.length) { start(0); setTimeout(() => setOpen(false), 450); }
  }

  function start(index) {
    S.guide.start(state.steps, {
      index,
      onChange: ({ index: i }) => { if (!state) return; state.index = Math.min(i, state.steps.length); if (i >= state.steps.length) state.status = 'done'; save(); render(); },
      onEnd: reason => { if (!state) return; state.status = reason === 'done' ? 'done' : 'answered'; if (reason === 'done') state.index = state.steps.length; save(); render(); },
      onMissing: async (step) => {
        if (state.source !== 'playbook') return null;
        // Re-find a moved control through the vendor's server (one small request).
        const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locate: { instruction: step.instruction, oldText: step.target && step.target.text }, page: S.scan() }) }).catch(() => null);
        const out = res && res.ok ? await res.json() : null;
        const el = out && out.element_id != null ? S.byId(out.element_id) : null;
        return el ? S.describe(el) : null;
      },
    });
  }

  function boot() {
    (document.body || document.documentElement).appendChild(host);
    state = load();
    render();
    if (state && state.status === 'running' && state.index < state.steps.length) start(state.index);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  S.widget = { open: () => setOpen(true), ask, cfg };
})();
