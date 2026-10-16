/* Side panel UI. State lives in the service worker; this file renders it and sends intents. */
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bg = msg => chrome.runtime.sendMessage(msg);

  let tab = null;        // { id, url, origin, host }
  let session = null;    // the service worker's session for this tab
  let playbooks = [];
  let view = 'ask';
  let saving = false;    // "save as scenario" form open
  let thinkTimer = 0;

  // ---------- active tab ----------
  async function loadTab() {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t) return;
    let origin = '', host = '';
    try { const u = new URL(t.url); origin = u.origin; host = u.host || u.protocol.replace(':', ''); } catch (e) {}
    tab = { id: t.id, url: t.url, origin, host };
    $('#site').textContent = host;
    $('#site').title = t.url || '';
    session = (await bg({ type: 'session', tabId: tab.id })).session;
    await loadPlaybooks();
    render();
  }
  async function loadPlaybooks() {
    playbooks = tab && tab.origin ? (await bg({ type: 'playbooks', origin: tab.origin })).list || [] : [];
    $('#pb-num').textContent = playbooks.length ? playbooks.length : '';
  }
  chrome.tabs.onActivated.addListener(loadTab);
  chrome.tabs.onUpdated.addListener((id, info) => { if (tab && id === tab.id && info.status === 'complete') loadTab(); });
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'session' && tab && msg.tabId === tab.id) { session = msg.session; render(); }
    if (msg.type === 'record:stop-request' && tab && msg.tabId === tab.id) stopRecording();
  });

  // ---------- tabs ----------
  function setView(v) {
    view = v;
    document.querySelectorAll('.tabs button').forEach((b, i) => {
      const on = b.dataset.view === v;
      b.setAttribute('aria-selected', on);
      if (on) $('.glider').style.transform = `translateX(${i * 100}%)`;
    });
    $('#view-ask').hidden = v !== 'ask';
    $('#view-pb').hidden = v !== 'pb';
    $('#view-set').hidden = v !== 'set';
    $('#composer').hidden = v !== 'ask';
    if (v === 'pb') renderPlaybooks();
    if (v === 'set') renderKey();
  }
  document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });

  // ---------- ask ----------
  const q = $('#q');
  q.addEventListener('input', autosize);
  q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
  function autosize() { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 140) + 'px'; }
  $('#composer').addEventListener('submit', async e => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text || !tab) return;
    q.value = ''; autosize();
    await askQuestion(text);
  });
  async function askQuestion(text) {
    saving = false;
    session = { question: text, status: 'thinking', steps: [], index: 0 };
    render();
    const res = await bg({ type: 'ask', tabId: tab.id, question: text });
    if (res && res.error) session = { question: text, status: 'error', error: res.error, steps: [] };
    else if (res && res.session) session = res.session;
    render();
  }

  function render() {
    if (view === 'pb') renderPlaybooks();
    const feed = $('#feed');
    const busy = session && session.status === 'thinking';
    $('#composer').classList.toggle('busy', !!busy);
    $('#send').disabled = !!busy;
    clearInterval(thinkTimer);
    if (!session || session.status === 'recording' && view === 'ask') { feed.innerHTML = hello(); return; }
    if (busy) {
      feed.innerHTML = `<div class="q">${esc(session.question)}</div><div class="thinking"><span class="spin"></span><span id="think-t">Читаю страницу</span></div>`;
      const t0 = Date.now();
      thinkTimer = setInterval(() => { const el = $('#think-t'); if (el) el.textContent = Date.now() - t0 > 1400 ? 'Продумываю шаги' : 'Читаю страницу'; }, 400);
      return;
    }
    if (session.status === 'error') {
      const needKey = /ключ/i.test(session.error || '');
      feed.innerHTML = `${session.question ? `<div class="q">${esc(session.question)}</div>` : ''}<div class="error">${esc(session.error)}${needKey ? '<div><button class="btn main" data-act="open-settings">Открыть настройки</button></div>' : ''}</div>`;
      return;
    }
    const steps = session.steps || [];
    const idx = session.index || 0;
    const done = session.status === 'done';
    const fast = session.source === 'playbook';
    feed.innerHTML = `
      <div class="q">${esc(session.question)}</div>
      ${session.answer ? `<p class="answer">${esc(session.answer)}</p>` : ''}
      ${steps.length ? `<ol class="steps">${steps.map((s, i) => `
        <li class="step ${i < idx || done ? 'done' : i === idx ? 'cur' : ''}" data-go="${i}">
          <span class="dot"><span>${i + 1}</span></span>
          <div class="txt">${esc(s.instruction)}${s.value ? `<br><span class="val">${esc(s.value)}</span>` : ''}</div>
        </li>`).join('')}</ol>` : ''}
      <div class="meta">${fast ? '<span class="tag fast">Сценарий · мгновенно · 0 токенов</span>' : `<span class="tag">Claude${session.ms ? ' · ' + (session.ms / 1000).toFixed(1).replace('.', ',') + ' с' : ''}</span>`}</div>
      ${steps.length && !done ? `<div class="actions row"><button class="btn ghost" data-act="stop">Остановить</button>${idx > 0 ? '<button class="btn ghost" data-act="restart">С начала</button>' : ''}</div>` : ''}
      ${done ? doneCard(fast) : ''}`;
    if (saving) { const f = $('#save-name'); if (f) f.focus(); }
  }

  function hello() {
    const pbs = playbooks.slice(0, 5);
    return `<div class="hello">
      <div class="orbit" aria-hidden="true"><i></i><i></i><b></b></div>
      <h1>Что нужно сделать${tab && tab.host ? ` на ${esc(tab.host)}` : ''}?</h1>
      <p>Спросите своими словами. Scopos прочитает страницу и покажет каждый шаг прямо на ней.</p>
      ${pbs.length ? `<div class="label">Сценарии этого сайта</div><div class="chips">${pbs.map(p => `<button class="chip pb" data-run="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : ''}
      <div class="label">Например</div>
      <div class="chips">${['Как пригласить коллегу?', 'Где поменять пароль?', 'Как выгрузить отчёт?'].map(t => `<button class="chip" data-ask="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    </div>`;
  }

  function doneCard(fast) {
    if (fast) return `<div class="done-card"><b>Готово</b><p>Сценарий пройден до конца.</p><div class="row"><button class="btn ghost" data-act="restart">Пройти ещё раз</button><button class="btn ghost" data-act="new">Новый вопрос</button></div></div>`;
    if (saving) return `<div class="done-card"><b>Сохранить как сценарий</b><p>В следующий раз он запустится мгновенно и бесплатно.</p>
      <input class="field" id="save-name" value="${esc(session.question)}" aria-label="Название сценария">
      <div class="row"><button class="btn main" data-act="save">Сохранить</button><button class="btn ghost" data-act="cancel-save">Отмена</button></div></div>`;
    return `<div class="done-card"><b>Готово</b><p>Сохраните эти шаги как сценарий, чтобы коллеги проходили их без ожидания.</p><div class="row"><button class="btn soft" data-act="ask-save">Сохранить как сценарий</button><button class="btn ghost" data-act="new">Новый вопрос</button></div></div>`;
  }

  $('#feed').addEventListener('click', async e => {
    const a = e.target.closest('[data-act],[data-go],[data-run],[data-ask]');
    if (!a) return;
    if (a.dataset.ask) return askQuestion(a.dataset.ask);
    if (a.dataset.run) return runPlaybook(a.dataset.run);
    if (a.dataset.go != null && session && session.steps && session.steps.length) {
      session = (await bg({ type: 'go', tabId: tab.id, index: +a.dataset.go })).session || session; return render();
    }
    switch (a.dataset.act) {
      case 'open-settings': return setView('set');
      case 'stop': case 'new': session = (await bg({ type: 'stop', tabId: tab.id })).session; saving = false; render(); q.focus(); return;
      case 'restart': session = (await bg({ type: 'go', tabId: tab.id, index: 0 })).session || session; return render();
      case 'ask-save': saving = true; return render();
      case 'cancel-save': saving = false; return render();
      case 'save': {
        const name = ($('#save-name').value || session.question).trim();
        await bg({ type: 'playbook:save', origin: tab.origin, name, steps: session.steps });
        saving = false; await loadPlaybooks();
        session = (await bg({ type: 'stop', tabId: tab.id })).session; render();
        flash(`Сценарий «${name}» сохранён`);
      }
    }
  });
  $('#feed').addEventListener('keydown', e => { if (e.target.id === 'save-name' && e.key === 'Enter') { e.preventDefault(); $('[data-act="save"]').click(); } });

  async function runPlaybook(id) {
    setView('ask');
    const res = await bg({ type: 'playbook:run', tabId: tab.id, origin: tab.origin, id });
    if (res.error) flash(res.error);
    session = res.session || session; render();
  }

  // ---------- playbooks view ----------
  const ruCount = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many}`; };
  function renderPlaybooks() {
    const recording = session && session.status === 'recording';
    $('#rec-start').hidden = !!recording;
    $('#pb-export').hidden = !playbooks.length || !!recording;
    const box = $('#rec-box');
    box.hidden = !recording;
    if (recording) {
      const steps = session.recorded || [];
      box.innerHTML = `<div class="rec"><div class="live"><i></i>Запись идёт</div>
        <div class="muted">Пройдите действие на странице как обычно. Каждый клик и заполненное поле станут шагом. Текст, который вы вводите, не записывается.</div>
        ${steps.length ? `<ol>${steps.map((s, i) => `<li><input data-edit="${i}" value="${esc(s.instruction)}" aria-label="Шаг ${i + 1}"></li>`).join('')}</ol>` : '<p class="faint small">Пока ни одного шага.</p>'}
        <input class="field" id="rec-name" placeholder="Название, например «Выставить счёт»" aria-label="Название сценария">
        <div class="row"><button class="btn main" data-act="rec-save" ${steps.length ? '' : 'disabled'}>Остановить и сохранить</button><button class="btn ghost" data-act="rec-cancel">Отменить</button></div></div>`;
    }
    $('#pb-list').innerHTML = playbooks.length ? playbooks.map(p => `
      <div class="pb"><b>${esc(p.name)}</b>
        <small>${ruCount(p.steps.length, 'шаг', 'шага', 'шагов')}${p.runs ? ' · запускали ' + ruCount(p.runs, 'раз', 'раза', 'раз') : ''}${p.healed ? ' · сам обновился ' + ruCount(p.healed, 'раз', 'раза', 'раз') : ''}</small>
        <div class="row"><button class="icon play" data-run="${esc(p.id)}" title="Запустить" aria-label="Запустить">▶</button><button class="icon" data-del="${esc(p.id)}" title="Удалить" aria-label="Удалить">✕</button></div>
      </div>`).join('') : (recording ? '' : '<div class="empty">Здесь появятся сценарии: сохраните ответ Scopos или запишите свой.</div>');
  }
  $('#rec-start').addEventListener('click', async () => {
    if (!tab) return;
    const res = await bg({ type: 'record:start', tabId: tab.id }).catch(() => null);
    session = res && res.session; renderPlaybooks();
  });
  let recEdits = {};
  $('#view-pb').addEventListener('input', e => { if (e.target.dataset.edit != null) recEdits[e.target.dataset.edit] = e.target.value; });
  $('#view-pb').addEventListener('click', async e => {
    const run = e.target.closest('[data-run]'); if (run) return runPlaybook(run.dataset.run);
    const del = e.target.closest('[data-del]');
    if (del) {
      if (del.dataset.confirm) { await bg({ type: 'playbook:delete', origin: tab.origin, id: del.dataset.del }); await loadPlaybooks(); return renderPlaybooks(); }
      del.dataset.confirm = '1'; del.textContent = 'Удалить?'; del.style.width = 'auto'; del.style.padding = '0 10px';
      setTimeout(() => { if (del.isConnected) { delete del.dataset.confirm; del.textContent = '✕'; del.style.width = ''; del.style.padding = ''; } }, 2500);
      return;
    }
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'rec-save') stopRecording(true);
    if (a.dataset.act === 'rec-cancel') stopRecording(false);
  });
  // Scenarios recorded here can ship inside a vendor's own product: scopos.js reads this JSON via data-playbooks.
  $('#pb-export').addEventListener('click', () => {
    const data = JSON.stringify(playbooks.map(({ id, name, steps }) => ({ id, name, steps })), null, 2);
    try { navigator.clipboard.writeText(data).then(() => flash('JSON сценариев скопирован'), () => flash('Браузер не дал скопировать')); } catch (e) { flash('Браузер не дал скопировать'); }
  });
  async function stopRecording(save = true) {
    const name = ($('#rec-name') && $('#rec-name').value.trim()) || 'Мой сценарий';
    const res = await bg({ type: 'record:stop', tabId: tab.id });
    const steps = (res.steps || []).map((s, i) => (recEdits[i] ? { ...s, instruction: recEdits[i] } : s));
    recEdits = {};
    session = null;
    if (save && steps.length) { await bg({ type: 'playbook:save', origin: tab.origin, name, steps }); flash(`Сценарий «${name}» сохранён`); }
    await loadPlaybooks(); renderPlaybooks();
  }

  // ---------- settings ----------
  async function renderKey() {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    $('#key').value = '';
    $('#key').placeholder = apiKey ? '••••••••' + apiKey.slice(-4) : 'sk-ant-…';
    $('#key-state').innerHTML = apiKey ? '<span class="pill ok">Подключено</span><button class="btn ghost" id="key-del">Удалить ключ</button>' : '<span class="pill need">Нужен ключ</span>';
  }
  $('#key-save').addEventListener('click', async () => {
    const v = $('#key').value.trim();
    if (!/^sk-ant-/.test(v)) { flash('Ключ начинается с sk-ant-'); return; }
    await chrome.storage.local.set({ apiKey: v });
    renderKey(); flash('Ключ сохранён');
  });
  $('#key').addEventListener('keydown', e => { if (e.key === 'Enter') $('#key-save').click(); });
  $('#key-state').addEventListener('click', async e => { if (e.target.id === 'key-del') { await chrome.storage.local.remove('apiKey'); renderKey(); } });

  // ---------- toast ----------
  function flash(text) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = text; t.classList.add('on');
    clearTimeout(flash.t); flash.t = setTimeout(() => t.classList.remove('on'), 1800);
  }

  setView('ask');
  loadTab();
  q.focus();
})();
