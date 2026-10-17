/* Side panel UI. State lives in the service worker; this file renders it and sends intents. */
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Every request to the worker resolves: a dead worker or a closed port becomes { error }.
  const bg = async msg => {
    try { return (await chrome.runtime.sendMessage(msg)) || {}; } catch (e) { return { error: 'Scopos не ответил. Попробуйте ещё раз.' }; }
  };

  let tab = null;        // { id, url, origin, host }
  let session = null;    // the service worker's session for this tab
  let playbooks = [];
  let view = 'ask';
  let saving = false;    // "save as scenario" form open
  let saveName = '';
  let thinkTimer = 0;
  let progress = null;   // { runId, chars, steps, answer } while Claude streams the answer
  let loadSeq = 0;
  let recEdits = {};     // edited instructions while recording
  let access = null;     // { ok, code, message, origin } for the tab in front
  let pendingRetry = null; // what to do again once the user grants access to the site

  // ---------- active tab: the panel always shows the session of the tab in front ----------
  async function loadTab() {
    const seq = ++loadSeq;
    let t = null;
    try { [t] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) { t = null; }
    if (seq !== loadSeq || !t) return;
    let origin = '', host = '';
    try { const u = new URL(t.url); origin = u.origin === 'null' ? '' : u.origin; host = u.host || u.protocol.replace(':', ''); } catch (e) { /* no url */ }
    const switched = !tab || tab.id !== t.id;
    tab = { id: t.id, url: t.url, origin, host };
    $('#site').textContent = host;
    $('#site').title = t.url || '';
    if (switched) { saving = false; progress = null; pendingRetry = null; }
    const [res, acc] = await Promise.all([bg({ type: 'session', tabId: t.id }), bg({ type: 'access', tabId: t.id })]);
    if (seq !== loadSeq) return;
    session = res.session || null;
    access = acc && !acc.error ? acc : null;
    await loadPlaybooks();
    await loadLearn();
    if (seq !== loadSeq) return;
    render();
    if (view === 'set') renderUsage();
  }

  // ---------- learning ----------
  let learn = null, hasMap = false, learnChars = 0;
  async function loadLearn() {
    if (!tab || !tab.origin) { learn = null; hasMap = false; return; }
    const r = await bg({ type: 'learn:state', origin: tab.origin });
    learn = r.learn || null; hasMap = !!r.hasMap;
    if (learn && learn.chars) learnChars = learn.chars;
  }
  const redo = `<div class="row links"><button class="link" data-learn="restart">Изучить заново</button><button class="link" data-learn="forget">Забыть</button></div>`;
  function renderLearn() {
    const box = $('#learn-box');
    if (!box) return;
    const L = learn || {};
    if (L.status === 'exploring') {
      box.innerHTML = `<h3>Изучаю продукт</h3><div class="stat"><div><b>${L.views || 0}</b><span>экранов</span></div><div><b>${L.probes || 0}</b><span>кнопок проверено</span></div></div>
        <div class="now"><span class="spin"></span><span>${esc(L.label || 'Хожу по экранам')}</span></div>
        <div class="row"><button class="btn soft" data-learn="finish">Хватит, писать гайды</button><button class="btn ghost" data-learn="stop">Отменить</button></div>${redo}`;
    } else if (L.status === 'writing') {
      box.innerHTML = `<h3>Пишу гайды</h3><p>Изучил ${L.views || 0} экранов и окон. Claude пишет по карте готовые инструкции, обычно за минуту-две.</p>
        <div class="now"><span class="spin"></span><span id="learn-now">${learnText()}</span></div>${redo}`;
    } else if (L.status === 'done' || L.status === 'mapped') {
      const when = L.at ? new Date(L.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '';
      box.innerHTML = `<h3>Продукт изучен${when ? ' · ' + when : ''}</h3><div class="stat"><div><b>${L.views || 0}</b><span>экранов и окон</span></div><div><b>${L.guides || 0}</b><span>готовых гайдов</span></div></div>
        ${L.summary ? `<p>${esc(L.summary)}</p>` : ''}${L.error ? `<p>${esc(L.error)}</p>` : ''}${L.autoAt ? `<p class="faint small">${L.autoAdded ? `Сам дописал ${ruCount(L.autoAdded, 'гайд', 'гайда', 'гайдов')} по новым экранам` : 'Просмотрел новые экраны'} · ${new Date(L.autoAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</p>` : ''}${L.dropped ? `<p class="faint small">${L.dropped} ${L.dropped === 1 ? 'гайд отброшен' : 'гайдов отброшено'}: в них были кнопки, которых нет на карте.</p>` : ''}
        <div class="row"><button class="btn ghost" data-learn="restart">Изучить заново</button><button class="btn ghost" data-learn="forget">Забыть</button></div>`;
    } else if (L.status === 'stopped' || (L.status === 'error' && hasMap)) {
      box.innerHTML = `<h3>${L.status === 'stopped' ? 'Изучение остановлено' : 'Не получилось дописать гайды'}</h3>
        ${L.error ? `<p style="color:var(--bad)">${esc(L.error)}</p>` : '<p>Ничего не сохранено. Можно начать заново в любой момент.</p>'}
        <div class="row"><button class="btn main" data-learn="restart">Изучить заново</button>${hasMap || L.status === 'error' ? '<button class="btn ghost" data-learn="forget">Забыть</button>' : ''}</div>`;
    } else {
      box.innerHTML = `<h3>Научите Scopos этому сайту</h3><p>Scopos один раз сам пройдёт по всем экранам, вкладкам и окнам и запомнит каждую кнопку. Потом Claude напишет готовые гайды. Они работают мгновенно, а новые вопросы получают точные шаги по всему продукту.</p>
        ${L.status === 'error' ? `<p style="color:var(--bad)">${esc(L.error)}</p>` : ''}
        <button class="btn main" data-learn="${L.status === 'error' ? 'restart' : 'start'}">${L.status === 'error' ? 'Изучить заново' : 'Изучить продукт'}</button>
        <p class="faint small" style="margin:10px 0 0">Нажимаю только то, что открывает экраны и окна. Ничего не заполняю, не сохраняю и не отправляю: пока я хожу по сайту, отправка форм и запросов на запись заблокирована. Лучше запускать под тестовым аккаунтом.</p>`;
    }
  }
  const learnText = () => {
    const part = learn && learn.batches > 1 ? ` · часть ${learn.batch || 1} из ${learn.batches}` : '';
    return learnChars ? `Claude пишет гайды${part} · ${learnChars.toLocaleString('ru-RU')} символов` : `Claude читает карту продукта${part}`;
  };
  $('#learn-box').addEventListener('click', e => {
    const b = e.target.closest('[data-learn]');
    if (b && tab) learnAct(b.dataset.learn);
  });
  async function learnAct(act) {
    if (!tab) return;
    let r = {};
    if (act === 'start' || act === 'restart') {
      learnChars = 0;
      r = await bg({ type: 'learn:start', tabId: tab.id, restart: act === 'restart' });
      if (r.code === 'access') { needAccess(r, () => learnAct(act)); return; }
    }
    if (act === 'stop') r = await bg({ type: 'learn:stop', tabId: tab.id, origin: tab.origin });
    if (act === 'finish') { r = await bg({ type: 'learn:finish', tabId: tab.id, origin: tab.origin }); if (!r.error) flash('Останавливаюсь и передаю карту Claude'); }
    if (act === 'forget') { r = await bg({ type: 'learn:forget', origin: tab.origin }); if (!r.error) flash('Карта и гайды этого сайта забыты'); }
    if (r && r.error) flash(r.error);
    await loadLearn(); await loadPlaybooks(); renderLearn(); renderPlaybooks();
  }

  async function loadPlaybooks() {
    playbooks = tab && tab.origin ? (await bg({ type: 'playbooks', origin: tab.origin })).list || [] : [];
    $('#pb-num').textContent = playbooks.length ? playbooks.length : '';
  }
  chrome.tabs.onActivated.addListener(() => loadTab());
  chrome.tabs.onUpdated.addListener((id, info) => { if (tab && id === tab.id && (info.status === 'complete' || info.url)) loadTab(); });
  chrome.windows && chrome.windows.onFocusChanged && chrome.windows.onFocusChanged.addListener(() => loadTab());
  // Back from chrome://extensions (site access changed there): look at the tab again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadTab(); });
  chrome.runtime.onMessage.addListener(msg => {
    if (!tab) return;
    if (msg.type === 'session' && msg.tabId === tab.id) {
      session = msg.session;
      if (!session || session.status !== 'thinking') progress = null;
      render();
    }
    if (msg.type === 'progress' && msg.tabId === tab.id && session && session.status === 'thinking' && (!session.runId || session.runId === msg.runId)) {
      progress = msg; updateThinking();
    }
    if (msg.type === 'record:stop-request' && msg.tabId === tab.id) stopRecording();
    if (msg.type === 'learn' && msg.origin === tab.origin) {
      learn = msg.learn;
      if (learn && learn.status === 'writing') { const el = $('#learn-now'); if (el) el.textContent = learnText(); }
      if (learn && learn.status === 'done') loadPlaybooks().then(() => { renderPlaybooks(); render(); });
      if (view === 'pb') renderLearn();
    }
    if (msg.type === 'learn:progress' && msg.origin === tab.origin) {
      learnChars = msg.chars;
      const el = $('#learn-now'); if (el) el.textContent = learnText();
    }
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
    if (v === 'set') { renderKey(); renderUsage(); renderLimits(); }
    renderAccess();
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
    if (session && session.status === 'thinking') return;
    q.value = ''; autosize();
    await askQuestion(text);
  });
  async function askQuestion(text, force = false) {
    if (!tab) return;
    const tabId = tab.id;
    saving = false; progress = null;
    session = { question: text, status: 'thinking', steps: [], index: 0, startedAt: Date.now(), tabId };
    render();
    const res = await bg({ type: 'ask', tabId, question: text, force });
    // The user switched tabs, asked again or pressed Stop meanwhile: that state is already on screen.
    if (!tab || tab.id !== tabId || res.stale || res.aborted) return;
    if (res.error) {
      session = { question: text, status: 'error', error: res.error, errorCode: res.code || null, errorOrigin: res.origin || null, steps: [], tabId };
      if (res.code === 'access') pendingRetry = () => askQuestion(text, force);
    } else if (res.session) session = res.session;
    render();
  }

  // ---------- site access: Chrome's "on click" / "specific sites" settings, restricted pages ----------
  function needAccess(r, retry) {
    access = { ok: false, code: 'access', message: r.error || r.message, origin: r.origin || (tab && tab.origin) };
    pendingRetry = retry || null;
    renderAccess();
  }
  function renderAccess() {
    const box = $('#access');
    if (!box) return;
    const shownInFeed = view === 'ask' && session && session.status === 'error' && session.errorCode === 'access';
    const A = access && access.ok === false && ['access', 'restricted', 'file'].includes(access.code) ? access : null;
    if (!A || shownInFeed) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.classList.toggle('quiet', A.code !== 'access');
    box.innerHTML = A.code === 'access'
      ? `<b>Нет доступа к этому сайту</b><p>Chrome не даёт Scopos читать ${esc((tab && tab.host) || 'эту страницу')}: в настройках расширения доступ к сайтам стоит «по клику» или «на выбранных сайтах».</p>
        <div class="row"><button class="btn main" data-grant="${esc(A.origin || '')}">Разрешить доступ</button></div>`
      : `<b>${A.code === 'file' ? 'Нужен доступ к файлам' : 'Здесь Scopos не работает'}</b><p>${esc(A.message || '')}</p>`;
  }
  // chrome.permissions.request needs the click itself (a user gesture): it is the first thing the handler does.
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-grant]');
    if (!b) return;
    const origin = b.dataset.grant || (tab && tab.origin);
    if (!origin) return;
    let asked;
    try { asked = chrome.permissions.request({ origins: [origin + '/*'] }); } catch (err) { flash('Chrome не дал запросить доступ'); return; }
    Promise.resolve(asked).then(async ok => {
      if (!ok) { flash('Доступ не выдан'); return; }
      flash('Доступ разрешён');
      access = null;
      const retry = pendingRetry; pendingRetry = null;
      if (session && session.errorCode === 'access') session = null;
      await loadTab();
      if (retry) retry();
    }, () => flash('Chrome не дал запросить доступ'));
  });

  const secs = ms => (ms / 1000).toFixed(1).replace('.', ',') + ' с';
  function render() {
    if (view === 'pb') renderPlaybooks();
    renderAccess();
    const feed = $('#feed');
    const busy = !!(session && session.status === 'thinking');
    $('#composer').classList.toggle('busy', busy);
    $('#send').disabled = busy;
    clearInterval(thinkTimer);
    if (!session || session.status === 'recording') { feed.innerHTML = hello(); return; }
    if (busy) {
      feed.innerHTML = `<div class="q">${esc(session.question)}</div><div id="think"></div>`;
      updateThinking();
      thinkTimer = setInterval(updateThinking, 400);
      return;
    }
    if (session.status === 'error' && session.errorCode === 'access') {
      const origin = session.errorOrigin || (tab && tab.origin) || '';
      if (!pendingRetry && session.question) { const qq = session.question; pendingRetry = () => askQuestion(qq); }
      feed.innerHTML = `${session.question ? `<div class="q">${esc(session.question)}</div>` : ''}<div class="error"><b>Нет доступа к этому сайту</b><br>${esc(session.error || '')}
        <div class="row"><button class="btn main" data-grant="${esc(origin)}">Разрешить доступ</button><button class="btn ghost" data-act="new">Новый вопрос</button></div></div>`;
      return;
    }
    if (session.status === 'error') {
      const needKey = session.errorCode === 'key' || session.errorCode === 'budget' || (!session.errorCode && /ключ/i.test(session.error || ''));
      feed.innerHTML = `${session.question ? `<div class="q">${esc(session.question)}</div>` : ''}<div class="error">${esc(session.error || 'Что-то пошло не так.')}
        <div class="row">${needKey ? '<button class="btn main" data-act="open-settings">Открыть настройки</button>' : ''}${session.question ? `<button class="btn ${needKey ? 'ghost' : 'main'}" data-act="retry">Спросить ещё раз</button>` : ''}<button class="btn ghost" data-act="new">Новый вопрос</button></div></div>`;
      return;
    }
    if (session.status === 'suggest') {
      const list = session.suggestions || [];
      feed.innerHTML = `<div class="q">${esc(session.question)}</div><p class="answer">Возможно, вы про:</p>
        <div class="chips">${list.map(p => `<button class="chip pb" data-run="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>
        <div class="actions row"><button class="btn ghost" data-act="ask-anyway">Нет, спросить Claude</button></div>`;
      return;
    }
    const steps = session.steps || [];
    const idx = session.index || 0;
    const done = session.status === 'done';
    const fast = session.source === 'playbook';
    const cached = session.source === 'cache';
    const tag = fast ? '<span class="tag fast">Готовый гайд · мгновенно · 0 токенов</span>'
      : cached ? '<span class="tag fast">мгновенно · из кэша</span><button class="link" data-act="refresh" title="Забыть сохранённый ответ и спросить Claude">Спросить заново</button>'
      : `<span class="tag">Claude${session.source === 'map' ? ' · по карте продукта' : ''}${session.ms ? ' · ' + secs(session.ms) : ''}</span>`;
    feed.innerHTML = `
      <div class="q">${esc(session.question)}</div>
      ${session.answer ? `<p class="answer">${esc(session.answer)}</p>` : ''}
      ${steps.length ? `<ol class="steps">${steps.map((s, i) => `
        <li class="step ${i < idx || done ? 'done' : i === idx ? 'cur' : ''}" data-go="${i}">
          <span class="dot"><span>${i + 1}</span></span>
          <div class="txt">${esc(s.instruction)}${s.value ? `<br><span class="val">${esc(s.value)}</span>` : ''}</div>
        </li>`).join('')}</ol>` : ''}
      <div class="meta">${tag}${session.replanning ? '<span class="tag">уточняю шаги для этой страницы…</span>' : ''}</div>
      ${steps.length && !done ? `<div class="actions row"><button class="btn ghost" data-act="stop">Остановить</button>${idx > 0 ? '<button class="btn ghost" data-act="restart">С начала</button>' : ''}</div>` : ''}
      ${!steps.length ? '<div class="actions row"><button class="btn ghost" data-act="new">Новый вопрос</button></div>' : ''}
      ${done ? doneCard(fast) : ''}`;
    if (saving) { const f = $('#save-name'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
  }

  // The thinking line: reading, then planning, then the streamed answer as it is written. Always cancellable.
  function updateThinking() {
    const box = $('#think');
    if (!box || !session || session.status !== 'thinking') return;
    const t = Date.now() - (session.startedAt || Date.now());
    let line;
    if (progress && progress.chars) line = `Пишу шаги${progress.steps ? ' · ' + progress.steps : '…'}`;
    else line = t > 1400 ? 'Продумываю шаги' : 'Читаю страницу';
    const slow = t > 100e3;
    box.innerHTML = `<div class="thinking"><span class="spin"></span><span>${esc(slow ? 'Ответ задерживается' : line)}</span></div>
      ${progress && progress.answer ? `<p class="answer">${esc(progress.answer)}</p>` : ''}
      <div class="actions row"><button class="btn ghost" data-act="stop">Отменить</button>${slow ? '<button class="btn ghost" data-act="retry">Спросить ещё раз</button>' : ''}</div>`;
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
      <input class="field" id="save-name" value="${esc(saveName || session.question)}" aria-label="Название сценария">
      <div class="row"><button class="btn main" data-act="save">Сохранить</button><button class="btn ghost" data-act="cancel-save">Отмена</button></div></div>`;
    return `<div class="done-card"><b>Готово</b><p>Сохраните эти шаги как сценарий, чтобы коллеги проходили их без ожидания.</p><div class="row"><button class="btn soft" data-act="ask-save">Сохранить как сценарий</button><button class="btn ghost" data-act="new">Новый вопрос</button></div></div>`;
  }

  $('#feed').addEventListener('input', e => { if (e.target.id === 'save-name') saveName = e.target.value; });
  $('#feed').addEventListener('click', async e => {
    const a = e.target.closest('[data-act],[data-go],[data-run],[data-ask]');
    if (!a || !tab) return;
    if (a.dataset.ask) return askQuestion(a.dataset.ask);
    if (a.dataset.run) return runPlaybook(a.dataset.run);
    if (a.dataset.go != null && session && session.steps && session.steps.length) {
      const r = await bg({ type: 'go', tabId: tab.id, index: +a.dataset.go });
      if (r.error) flash(r.error);
      session = r.session || session; return render();
    }
    switch (a.dataset.act) {
      case 'open-settings': return setView('set');
      case 'retry': if (session && session.question) return askQuestion(session.question); return;
      case 'ask-anyway': if (session && session.question) return askQuestion(session.question, true); return;
      case 'refresh': {
        const question = session && session.question;
        await bg({ type: 'cache:drop', tabId: tab.id });
        if (question) return askQuestion(question, true);
        return;
      }
      case 'stop': case 'new': {
        const r = await bg({ type: 'stop', tabId: tab.id });
        session = r.error ? null : r.session || null; saving = false; progress = null; render(); q.focus();
        return;
      }
      case 'restart': { const r = await bg({ type: 'go', tabId: tab.id, index: 0 }); if (r.error) flash(r.error); session = r.session || session; return render(); }
      case 'ask-save': saving = true; saveName = session.question || ''; return render();
      case 'cancel-save': saving = false; return render();
      case 'save': {
        const name = (($('#save-name') && $('#save-name').value) || session.question || 'Мой сценарий').trim();
        const r = await bg({ type: 'playbook:save', origin: tab.origin, name, steps: session.steps });
        if (r.error) { flash(r.error); return; }
        saving = false; await loadPlaybooks();
        session = (await bg({ type: 'stop', tabId: tab.id })).session || null; render();
        flash(`Сценарий «${name}» сохранён`);
      }
    }
  });
  $('#feed').addEventListener('keydown', e => { if (e.target.id === 'save-name' && e.key === 'Enter') { e.preventDefault(); const b = $('[data-act="save"]'); if (b) b.click(); } });

  async function runPlaybook(id) {
    if (!tab) return;
    const tabId = tab.id;
    setView('ask');
    const res = await bg({ type: 'playbook:run', tabId, origin: tab.origin, id });
    if (!tab || tab.id !== tabId || res.stale) return;
    if (res.error) {
      if (res.code !== 'access') flash(res.error); else pendingRetry = () => runPlaybook(id);
      session = { question: '', status: 'error', error: res.error, errorCode: res.code || null, errorOrigin: res.origin || null, steps: [], tabId };
    }
    else session = res.session || session;
    render();
  }

  // ---------- playbooks view ----------
  const ruCount = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many}`; };
  function renderPlaybooks() {
    renderLearn();
    const recording = session && session.status === 'recording';
    $('#rec-start').hidden = !!recording;
    $('#pb-export').hidden = !playbooks.length || !!recording;
    const box = $('#rec-box');
    box.hidden = !recording;
    if (recording) {
      const steps = session.recorded || [];
      const name = $('#rec-name') ? $('#rec-name').value : '';
      box.innerHTML = `<div class="rec"><div class="live"><i></i>Запись идёт</div>
        <div class="muted">Пройдите действие на странице как обычно. Каждый клик и заполненное поле станут шагом. Текст, который вы вводите, не записывается.</div>
        ${steps.length ? `<ol>${steps.map((s, i) => `<li><input data-edit="${i}" value="${esc(recEdits[i] != null ? recEdits[i] : s.instruction)}" aria-label="Шаг ${i + 1}"></li>`).join('')}</ol>` : '<p class="faint small">Пока ни одного шага.</p>'}
        <input class="field" id="rec-name" placeholder="Название, например «Выставить счёт»" aria-label="Название сценария" value="${esc(name)}">
        <div class="row"><button class="btn main" data-act="rec-save" ${steps.length ? '' : 'disabled'}>Остановить и сохранить</button><button class="btn ghost" data-act="rec-cancel">Отменить</button></div></div>`;
    }
    $('#pb-list').innerHTML = playbooks.length ? playbooks.map(p => `
      <div class="pb"><b>${esc(p.name)}${p.learned ? '<span class="tagl">гайд</span>' : ''}</b>
        <small>${ruCount((p.steps || []).length, 'шаг', 'шага', 'шагов')}${p.runs ? ' · запускали ' + ruCount(p.runs, 'раз', 'раза', 'раз') : ''}${p.healed ? ' · сам обновился ' + ruCount(p.healed, 'раз', 'раза', 'раз') : ''}</small>
        <div class="row"><button class="icon play" data-run="${esc(p.id)}" title="Запустить" aria-label="Запустить">▶</button><button class="icon" data-del="${esc(p.id)}" title="Удалить" aria-label="Удалить">✕</button></div>
      </div>`).join('') : (recording ? '' : '<div class="empty">Здесь появятся сценарии: сохраните ответ Scopos или запишите свой.</div>');
  }
  $('#rec-start').addEventListener('click', async () => {
    if (!tab) return;
    const res = await bg({ type: 'record:start', tabId: tab.id });
    if (res.error) { flash(res.error); return; }
    recEdits = {};
    session = res.session || null; renderPlaybooks();
  });
  $('#view-pb').addEventListener('input', e => { if (e.target.dataset.edit != null) recEdits[e.target.dataset.edit] = e.target.value; });
  $('#view-pb').addEventListener('click', async e => {
    if (!tab) return;
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
    if (!tab) return;
    const name = ($('#rec-name') && $('#rec-name').value.trim()) || 'Мой сценарий';
    const res = await bg({ type: 'record:stop', tabId: tab.id });
    const steps = (res.steps || []).map((s, i) => (recEdits[i] ? { ...s, instruction: recEdits[i] } : s));
    recEdits = {};
    session = null;
    if (save && steps.length) {
      const r = await bg({ type: 'playbook:save', origin: tab.origin, name, steps });
      flash(r.error ? r.error : `Сценарий «${name}» сохранён`);
    }
    await loadPlaybooks(); renderPlaybooks();
  }

  // ---------- settings ----------
  async function renderKey() {
    let apiKey = '';
    try { apiKey = (await chrome.storage.local.get('apiKey')).apiKey || ''; } catch (e) { apiKey = ''; }
    $('#key').value = '';
    $('#key').placeholder = apiKey ? '••••••••' + apiKey.slice(-4) : 'sk-ant-…';
    if (apiKey) { $('#key-state').innerHTML = '<span class="pill ok">Ключ: свой ключ</span><button class="btn ghost" id="key-del">Удалить ключ</button>'; return; }
    $('#key-state').innerHTML = '<span class="faint">Проверяю локальный сервер…</span>';
    const k = await bg({ type: 'key:state', fresh: true });
    if (apiKey !== ((await chrome.storage.local.get('apiKey').catch(() => ({}))).apiKey || '')) return; // changed meanwhile
    $('#key-state').innerHTML = k.mode === 'proxy'
      ? `<span class="pill ok">Ключ: из локального сервера Scopos</span><span class="faint small">${esc(String(k.devServer || '').replace(/^https?:\/\//, ''))}</span>`
      : '<span class="pill need">Нужен ключ</span>';
  }
  $('#key-save').addEventListener('click', async () => {
    const v = $('#key').value.trim();
    if (!/^sk-ant-/.test(v)) { flash('Ключ начинается с sk-ant-'); return; }
    try { await chrome.storage.local.set({ apiKey: v }); flash('Ключ сохранён'); } catch (e) { flash('Не получилось сохранить ключ'); }
    renderKey();
  });
  $('#key').addEventListener('keydown', e => { if (e.key === 'Enter') $('#key-save').click(); });
  $('#key-state').addEventListener('click', async e => { if (e.target.id === 'key-del') { await chrome.storage.local.remove('apiKey').catch(() => {}); renderKey(); } });

  const money = c => '$' + (c > 0 && c < 0.01 ? c.toFixed(4) : c.toFixed(2));
  const dollars = n => '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const usageLine = u => `≈ ${Math.round(u.tokens || 0).toLocaleString('ru-RU')} токенов, ~${money(u.cost || 0)} · ${ruCount(u.calls || 0, 'запрос', 'запроса', 'запросов')}`;

  // ---------- monthly limit and auto-guides (chrome.storage.local: monthlyLimit, autoGuides) ----------
  async function renderLimits() {
    let s = {};
    try { s = await chrome.storage.local.get(['monthlyLimit', 'autoGuides']); } catch (e) { s = {}; }
    const lim = Number.isFinite(+s.monthlyLimit) && s.monthlyLimit !== '' && s.monthlyLimit != null && +s.monthlyLimit >= 0 ? +s.monthlyLimit : 2;
    if (document.activeElement !== $('#limit')) $('#limit').value = String(lim);
    $('#auto-guides').checked = s.autoGuides !== false;
  }
  $('#limit').addEventListener('change', async () => {
    const n = parseFloat(String($('#limit').value).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) { flash('Лимит: число от 0'); return renderLimits(); }
    const v = Math.round(n * 100) / 100;
    try { await chrome.storage.local.set({ monthlyLimit: v }); flash(`Лимит: ${dollars(v)} в месяц`); } catch (e) { flash('Не получилось сохранить лимит'); }
    renderLimits(); renderUsage();
  });
  $('#auto-guides').addEventListener('change', async e => {
    try { await chrome.storage.local.set({ autoGuides: !!e.target.checked }); } catch (x) { /* ignore */ }
    flash(e.target.checked ? 'Новые экраны превратятся в гайды сами' : 'Гайды дописываются только по кнопке');
  });

  async function renderUsage() {
    const box = $('#usage');
    if (!box) return;
    const r = await bg({ type: 'usage', origin: tab ? tab.origin : '' });
    const site = r.site, total = r.total || { tokens: 0, cost: 0, calls: 0 };
    if (r.month) {
      const m = $('#month');
      m.textContent = `В этом месяце: ${money(r.month.cost || 0).replace(/^\$0\.00$/, '$0')} из ${dollars(r.month.limit)}`;
      m.classList.toggle('over', (r.month.cost || 0) >= r.month.limit);
    }
    box.innerHTML = `${tab && tab.host ? `<p class="muted"><b>${esc(tab.host)}</b>: ${site ? usageLine(site) : 'пока ни одного запроса к Claude'}${site && site.cacheHits ? ` · ${ruCount(site.cacheHits, 'ответ', 'ответа', 'ответов')} из кэша бесплатно` : ''}</p>` : ''}
      <p class="muted">Всего: ${usageLine(total)}</p>
      <p class="faint small">Оценка по ценам Anthropic, точная сумма в console.anthropic.com. Готовые сценарии и ответы из кэша токенов не тратят.</p>
      ${total.calls ? '<button class="btn ghost" id="usage-reset">Сбросить счётчик</button>' : ''}`;
  }
  $('#view-set').addEventListener('click', async e => {
    if (e.target.id === 'usage-reset') { await bg({ type: 'usage:reset' }); renderUsage(); }
  });

  // ---------- toast ----------
  function flash(text) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text; t.classList.add('on');
    clearTimeout(flash.t); flash.t = setTimeout(() => t.classList.remove('on'), 2400);
  }

  try { $('#ver').textContent = 'Scopos ' + chrome.runtime.getManifest().version; } catch (e) { /* keep the static text */ }
  setView('ask');
  loadTab();
  q.focus();
})();
