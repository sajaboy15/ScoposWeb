/*
 * Scopos guide runner and recorder.
 *
 * guide.start(steps, opts) walks the user through steps. A step advances by
 * itself when the user does the action on the highlighted control (click it,
 * fill it, pick an option), or by the card's "Далее". The new index is reported
 * through onChange before the page reacts, so a full page load resumes on the
 * right step.
 *
 * Every callback carries the run it belongs to and the step it was armed for,
 * so a timer or a late onMissing answer from an earlier guide never moves a
 * newer one.
 *
 * When a step's control is not on the page yet, the runner waits for it: a
 * MutationObserver that only lives while it waits, checks spaced out from
 * 250 ms to 2 s and done when the browser is idle, and a give-up after 60 s.
 * After a short while it asks opts.onMissing() to re-locate the control (the
 * self-healing path for changed UIs). A step recorded on another page is never
 * pointed at a look-alike here: the card asks the user to go to that page.
 *
 * recorder.start(onStep) turns real clicks and field changes into steps. Typed
 * text is never recorded, only which field was filled.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});
  // Loaded twice (re-injection): keep the live runner instead of orphaning its listeners.
  if (S.guide) return;

  const GIVE_UP = 60000;
  const CHROME = 'nav,header,aside,[role=navigation],[role=banner],[role=menubar],[role=complementary]';
  const OPTION = '[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem],[role=gridcell],li';
  const CONTROL = 'a[href],button,summary,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=treeitem],[contenteditable=""],[contenteditable=true]';

  const norm = s => (S.normText ? S.normText(s) : String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim());
  const shown = el => {
    if (!el || !el.isConnected) return false;
    if (S.isVisible) return S.isVisible(el);
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const ours = n => !!(n && n.nodeType === 1 && ((S.pointer && S.pointer.isOurs && S.pointer.isOurs(n)) || (n.closest && n.closest('[data-scopos-ui],scopos-layer'))));
  const call = (fn, ...a) => { try { return fn ? fn(...a) : undefined; } catch (e) { return undefined; } };
  const idle = fn => (typeof requestIdleCallback === 'function' ? { i: requestIdleCallback(fn, { timeout: 500 }) } : { t: setTimeout(fn, 0) });
  const unidle = h => { if (h) { if (h.i != null) cancelIdleCallback(h.i); else clearTimeout(h.t); } };
  const targetOf = e => (e.composedPath && e.composedPath()[0]) || e.target;
  const modified = e => e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
  const now = () => performance.now();
  const hidden = () => !!document.hidden;
  const MODAL = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true]';
  const SLOW = 40;      // ms: a search slower than this gets the card drawn first, before it blocks the thread
  const DUTY = 10;      // searches keep the main thread at most 1/DUTY busy: next one waits cost × DUTY
  const NUDGE = 8000;   // timed re-check while waiting, only after mutations the cheap filter skipped
  let cost = 0;         // last measured S.resolve cost on this page, ms

  // A timeout that counts only visible time: paused while the tab is hidden, so a user who comes back after
  // a while finds the step still waiting instead of already given up.
  function visTimeout(fn, ms) {
    let left = ms, t0 = 0, h = 0;
    const resume = () => { if (h || left == null) return; t0 = now(); h = setTimeout(() => { h = 0; left = null; fn(); }, left); };
    const pause = () => { if (!h) return; clearTimeout(h); h = 0; left = Math.max(0, left - (now() - t0)); };
    if (!hidden()) resume();
    return { pause, resume, clear: () => { clearTimeout(h); h = 0; left = null; } };
  }

  // A cheap "could this subtree hold the step's control" test for mutation records, so a page that changes
  // all the time (chat, tickers, live tables) doesn't cost a full resolve per change. A middle-of-word probe
  // from the name (attribute [i] matching is ASCII-only, so the capital first letter is skipped) is looked
  // for in text and in aria-label/title/placeholder/alt/value; simple descriptor selectors are matched too.
  // A descriptor with nothing usable passes everything.
  function relevance(d) {
    const word = (norm(d && d.text).split(' ').find(w => w.length >= 3) || '');
    let probe = word.length >= 4 ? word.slice(1, 7) : word;
    const e = probe.indexOf('е'); // the page may spell it «ё»
    if (e >= 2) probe = probe.slice(0, e);
    if (probe.length < 2) probe = '';
    const sels = [];
    const scratch = document.createDocumentFragment();
    const ok = s => { try { scratch.querySelector(s); return true; } catch (err) { return false; } };
    for (const s of (d && Array.isArray(d.sel) ? d.sel : []).slice(0, 8)) {
      // Simple only: no combinators outside [attr] parts (a long CSS path matches too much of the page).
      if (typeof s === 'string' && s && !/[\s>+~]/.test(s.replace(/\[[^\]]*\]/g, '')) && ok(s)) sels.push(s);
    }
    if (probe && typeof CSS !== 'undefined' && CSS.escape) {
      const q = CSS.escape(probe);
      const attrs = ['aria-label', 'title', 'placeholder', 'alt', 'value'].map(a => `[${a}*="${q}" i]`).join(',');
      if (ok(attrs)) sels.push(attrs);
    }
    if (!probe && !sels.length) return null;
    const sel = sels.join(',');
    return n => {
      if (!n) return false;
      if (n.nodeType === 3) return !!probe && n.data.toLowerCase().includes(probe);
      if (n.nodeType !== 1 || ours(n)) return false;
      if (n === document.documentElement || n === document.body) return true; // page-wide state (theme, modal-open)
      if (probe && (n.textContent || '').toLowerCase().includes(probe)) return true;
      try { return !!sel && (n.matches(sel) || !!n.querySelector(sel)); } catch (err) { return true; }
    };
  }

  // "/invoices/12" and "/invoices/7" are the same screen; "#/x" is a route, "#top" is not.
  const ID_SEG = /\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,})(?=\/|$)/gi;
  // scan.js defines the shared rule (S.pathKey); this fallback only keeps guide.js usable on its own.
  function ownPathKey(p) {
    const s = String(p || '/');
    const i = s.indexOf('#');
    const path = (i < 0 ? s : s.slice(0, i)).split('?')[0].replace(ID_SEG, '/:id').replace(/\/+$/, '') || '/';
    const hash = i < 0 ? '' : s.slice(i);
    const h = /^#[!/]/.test(hash) ? hash.split('?')[0].replace(ID_SEG, '/:id').replace(/\/+$/, '') : '';
    return path + (h.length > 2 ? h : '');
  }
  if (!S.pathKey) S.pathKey = ownPathKey;
  const pathKey = p => S.pathKey(p);
  const samePage = path => !path || pathKey(path) === pathKey(location.pathname + location.search + location.hash);
  const pagePlace = d => (d.view ? `«${String(d.view).slice(0, 60)}»` : `«${String(d.path || '/').split('?')[0].replace(/#(?![!/]).*$/, '').slice(0, 60)}»`);

  let run = null; // { steps, index, opts, el, cleanup: [], healed, advanced }
  const alive = (me, at) => run === me && (at === undefined || me.index === at);

  function start(steps, opts = {}) {
    stop(false);
    if (!Array.isArray(steps) || !steps.length) return;
    const index = Math.max(0, Math.min(opts.index || 0, steps.length - 1));
    run = { steps, index, opts, el: null, cleanup: [], healed: new Set(), advanced: -1 };
    show();
  }

  function stop(notify = true, reason = 'closed') {
    if (!run) return;
    const r = run;
    run = null;
    r.cleanup.forEach(fn => call(fn));
    r.cleanup = [];
    unpend(r);
    S.pointer.hide();
    if (notify) call(r.opts.onEnd, reason);
  }

  function go(i) {
    if (!run) return;
    if (i >= run.steps.length) { stop(true, 'done'); return; }
    run.index = Math.max(0, i);
    run.advanced = -1;
    call(run.opts.onChange, { index: run.index });
    show();
  }

  function clearWatch() {
    if (!run) return;
    run.cleanup.forEach(fn => call(fn));
    run.cleanup = [];
  }

  // The step's control on this page, or null. On another page only the same global
  // control (a sidebar or header item) is accepted, never a same-named button elsewhere.
  function find(step) {
    const d = step.target;
    if (!d) return null;
    // Timed: on a big page one resolve is a long task, and every caller spaces its searches by this cost.
    const t0 = now();
    let el = null;
    try { el = S.resolve(d); } catch (e) { el = null; }
    try {
      if (!el || ours(el)) return null;
      if (samePage(d.path)) return el;
      if (!el.closest(CHROME)) return null;
      if (S.resolveDetailed) {
        let r = null;
        try { r = S.resolveDetailed(d); } catch (e) { r = null; }
        if (!r || r.el !== el || r.ambiguous || r.score < 0.85) return null;
      }
      return el;
    } finally { cost = now() - t0; }
  }

  // A step change draws at once and searches once, later: a burst of go() (mashing «Далее»/«Назад») costs one
  // resolve for the step it ends on, not one per click.
  function show() {
    if (!run) return;
    clearWatch();
    const me = run, step = me.steps[me.index];
    if (!step) { stop(true, 'done'); return; }
    if (!step.target) { me.el = null; draw(null, step, {}); return; }
    // On a heavy page put the new card up first (searching), so the click answers before the search blocks.
    const slow = cost > SLOW;
    if (slow) { me.el = null; draw(null, step, samePage(step.target.path) ? { waiting: true } : { away: true }); }
    if (me.pend) return; // already queued: it reads the latest index when it runs
    const p = (me.pend = {});
    const fire = () => {
      if (me.pend !== p) return;
      me.pend = null;
      if (run !== me) return;
      const s = me.steps[me.index];
      if (s && s.target) present(me, s, find(s));
    };
    // After a paint when the card was drawn first; rAF doesn't run in a hidden tab, so a plain timeout there.
    if (slow && !hidden() && typeof requestAnimationFrame === 'function') p.r = requestAnimationFrame(() => { p.t = setTimeout(fire, 0); });
    else p.t = setTimeout(fire, 0);
  }
  function unpend(me) {
    const p = me.pend;
    me.pend = null;
    if (p) { if (p.r) cancelAnimationFrame(p.r); clearTimeout(p.t); }
  }

  // Shows the step with its control (armed), or without it (waiting).
  function present(me, step, el) {
    if (run !== me) return;
    clearWatch();
    me.el = el;
    if (el) { draw(el, step, {}); arm(step); return; }
    const away = !samePage(step.target.path);
    draw(null, step, away ? { away: true } : { waiting: true });
    wait(step, away);
  }

  function draw(el, step, f) {
    const me = run, at = me.index;
    const trim = s => String(s || '').replace(/[.\s]+$/, '');
    let instruction = step.instruction;
    if (f.away) instruction = `Перейдите на страницу ${pagePlace(step.target)}. Там: ${trim(step.instruction)}`;
    if (f.gaveUp) instruction = `${trim(step.instruction)}. Не вижу этот элемент на странице: сделайте шаг сами и нажмите «Далее».`;
    S.pointer.point(el, {
      step: at + 1, total: me.steps.length, instruction, value: step.value, waiting: !!(f.waiting || f.away),
      autoAdvance: !!el && step.action !== 'look',
      // Bound to this step: a click on «Далее» right after an auto-advance must not skip a step.
      onNext: () => { if (alive(me, at)) go(at + 1); },
      onBack: () => { if (alive(me, at)) go(at - 1); },
      onClose: () => { if (run === me) stop(true, 'closed'); },
      relocate: el ? () => relocate(me, at, step) : undefined,
    });
  }

  // Called by the pointer when the control it follows leaves the page or hides (a re-render). The pointer owns
  // this search (its IO/RO see removal and hiding); arm() only watches, so the two never hunt at once.
  function relocate(me, at, step) {
    if (!alive(me, at)) return null;
    const el = find(step);
    if (el) {
      if (el !== me.el) { me.el = el; call(me.rewatch); }
      return el;
    }
    // Gone for good: go back to waiting once the pointer's call has returned. No second search here:
    // wait() starts with its own (cost-spaced) check.
    if (!me.lostT) {
      me.lostT = setTimeout(() => {
        me.lostT = 0;
        if (alive(me, at) && me.advanced !== at && !shown(me.el)) present(me, step, null);
      }, 0);
    }
    return null;
  }

  // Report first: if this action navigates away, the next page resumes on the next step.
  function advance(me, at, delay) {
    if (!alive(me, at) || me.advanced === at) return;
    me.advanced = at;
    const next = at + 1;
    call(me.opts.onChange, { index: Math.min(next, me.steps.length) });
    // Not in cleanup: a re-render during the delay must not cancel it; alive() guards a stopped or restarted run.
    setTimeout(() => { if (alive(me, at)) go(next); }, delay);
  }

  const isEditor = n => !!n && (n.tagName === 'TEXTAREA' || n.isContentEditable || (n.getAttribute && n.tagName !== 'INPUT' && /^(textbox|searchbox)$/.test(n.getAttribute('role') || '')));
  const isField = n => !!n && (/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) || n.isContentEditable);
  function textNow(el) {
    if (!el) return '';
    if (el.tagName === 'SELECT') return el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent : '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || '';
    const inner = el.querySelector && el.querySelector('input:not([type=hidden])');
    return String((inner && inner.value) || el.innerText || el.textContent || '').slice(0, 200);
  }

  // Advance when the user performs the step on the highlighted control.
  function arm(step) {
    const me = run, at = me.index, act = step.action || 'click';
    const clicky = act === 'click' || act === 'look';
    const cur = () => me.el;
    const go2 = delay => advance(me, at, delay);
    const valueOk = () => {
      if (!step.value) return true;
      const have = norm(textNow(cur())), want = norm(step.value);
      return !!have && (have === want || have.includes(want) || want.includes(have));
    };

    // A fresh copy rendered in place of ours (list refresh, keyed re-render) counts too. Cheap checks first:
    // these run on every key, click and input on the page, and a layout read there is a forced reflow.
    const sameControl = t => {
      if (!step.target || !step.target.text) return false;
      const c0 = cur();
      if (c0 && c0.isConnected) return false; // ours is still there: a look-alike elsewhere is another control
      const c = t && t.closest && t.closest(CONTROL);
      return !!c && !ours(c) && norm(S.labelOf(c)) === norm(step.target.text);
    };
    const inside = e => {
      const el = cur();
      if (!el) return false;
      const path = e.composedPath ? e.composedPath() : [];
      const t = targetOf(e);
      if (path.includes(el) || (t && t.nodeType === 1 && el.contains(t))) return true;
      // Its <label>, or the control of the label we point at.
      const lab = t && t.closest && t.closest('label');
      if (lab && (lab.control === el || (el.labels && [...el.labels].includes(lab)))) return true;
      if (el.tagName === 'LABEL' && el.control && path.includes(el.control)) return true;
      return sameControl(t);
    };

    // Menus (Radix, Headless) act on pointerdown/pointerup and unmount before "click":
    // remember a press that started on the control and count its release.
    let down = null, dirty = false;
    const onDown = e => {
      if (!alive(me, at) || e.button > 0) return;
      down = inside(e) ? { r: cur().getBoundingClientRect(), t: Date.now() } : null;
    };
    const onUp = e => {
      if (!alive(me, at)) return;
      if (act === 'select') return optionPicked(e);
      const d = down;
      down = null;
      if (!clicky || !d || modified(e) || Date.now() - d.t > 2000) return;
      const r = d.r, inRect = e.clientX >= r.left - 2 && e.clientX <= r.right + 2 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2;
      if (inRect || inside(e) || !shown(cur())) go2(260);
    };
    const onClick = e => {
      if (!alive(me, at)) return;
      if (act === 'select') return optionPicked(e);
      if (clicky && !modified(e) && inside(e)) go2(260);
    };
    // Custom selects: after an option is picked anywhere (often a portal), check what our control shows now.
    const before = act === 'select' ? textNow(cur()) : ''; // innerText is a layout read: only selects need it
    const optionPicked = e => {
      const t = targetOf(e);
      if (!t || !t.closest || !t.closest(OPTION) || ours(t)) return;
      setTimeout(() => { if (alive(me, at) && norm(textNow(cur())) !== norm(before) && valueOk()) go2(120); }, 250);
    };
    const onKey = e => {
      // Only Enter and Space ever advance: every other key returns before any lookup.
      if ((e.key !== 'Enter' && e.key !== ' ') || act === 'select' || !alive(me, at) || e.isComposing || e.repeat || !inside(e)) return;
      const t = targetOf(e);
      if (act === 'type') {
        // Enter in a textarea or a rich editor is a new line, not "done".
        if (e.key === 'Enter' && !e.shiftKey && !isEditor(t) && !(cur() && isEditor(cur()))) go2(120);
      } else if (clicky && !isField(t)) {
        // Keyboard activation: sites often handle Enter/Space on div[role=button] without a click.
        if (e.key === 'Enter' || (e.key === ' ' && !(t && t.closest && t.closest('a[href]')))) go2(260);
      }
    };
    const onChange = e => {
      if (!alive(me, at) || !inside(e)) return;
      if (act === 'type') go2(120);
      else if (act === 'select' && valueOk()) go2(120);
    };
    const onInput = e => { if (act === 'type' && alive(me, at) && inside(e)) dirty = true; };
    // Rich editors and comboboxes never fire "change": typing followed by leaving the field is the signal.
    const onFocusOut = e => {
      if (act !== 'type' || !dirty || !alive(me, at) || !inside(e)) return;
      const el = cur(), to = e.relatedTarget;
      if (el && to && el.contains(to)) return;
      if (norm(textNow(el))) go2(0);
    };

    const opts = { capture: true };
    const pairs = [['pointerdown', onDown], ['pointerup', onUp], ['click', onClick], ['keydown', onKey], ['change', onChange], ['input', onInput], ['focusout', onFocusOut]];
    pairs.forEach(([t, fn]) => addEventListener(t, fn, opts));

    // Custom select: advance when its popup closes (aria-expanded true → false) with a new value.
    let amo = null;
    const watchExpanded = () => {
      if (amo) amo.disconnect();
      amo = null;
      const el = cur();
      if (act !== 'select' || !el || el.tagName === 'SELECT' || typeof MutationObserver !== 'function') return;
      const isOpen = () => el.getAttribute('aria-expanded') === 'true' || !!el.querySelector('[aria-expanded=true]');
      let open = isOpen();
      amo = new MutationObserver(() => {
        const now = isOpen();
        if (open && !now) setTimeout(() => { if (alive(me, at) && norm(textNow(cur())) !== norm(before) && valueOk()) go2(120); }, 60);
        open = now;
      });
      amo.observe(el, { attributes: true, subtree: true, attributeFilter: ['aria-expanded'] });
    };
    watchExpanded();
    me.rewatch = watchExpanded;

    // The control can be replaced by a re-render or hidden (a menu closed). The pointer sees that (IO/RO) and
    // re-finds it through relocate(), which owns the search; this observer only notices a removal (no layout,
    // no resolve) and, if the pointer hasn't re-pointed us within a second, falls back to waiting.
    let grace = 0;
    const mo = new MutationObserver(throttle(() => {
      if (hidden() || grace || !alive(me, at) || me.advanced === at) return;
      const el = cur();
      if (el && el.isConnected) return;
      grace = setTimeout(() => {
        grace = 0;
        if (alive(me, at) && me.advanced !== at && me.el === el && !(el && el.isConnected)) show();
      }, 1000);
    }, 300));
    mo.observe(document.documentElement, { childList: true, subtree: true });

    me.cleanup.push(() => {
      pairs.forEach(([t, fn]) => removeEventListener(t, fn, opts));
      mo.disconnect();
      clearTimeout(grace);
      if (amo) amo.disconnect();
      me.rewatch = null;
    });
  }

  // The control isn't here yet (menu closed, page still loading, UI changed, another page).
  function wait(step, away) {
    const me = run, at = me.index;
    const base = () => Math.max(250, cost * DUTY);
    // nextOk: show() searched just now, so the first check here is spaced from that search too.
    let delay = base(), pending = 0, idleH = null, done = false, healT = null, nextOk = now() + cost * DUTY, skipped = false;
    let href = location.href;
    const check = () => {
      pending = 0;
      idleH = null;
      if (!alive(me, at) || hidden()) return;
      const el = find(step);
      // Spaced by what a search costs here, so a 300 ms resolve can't run more than ~1/DUTY of the time.
      nextOk = now() + cost * DUTY;
      if (el) { present(me, step, el); return; }
      const nowAway = !samePage(step.target.path);
      if (nowAway !== away) {
        away = nowAway;
        if (!done) draw(null, step, away ? { away: true } : { waiting: true });
        armHeal();
      }
      // Back off: nothing changed that mattered. Never closer than DUTY × the measured cost.
      delay = Math.min(Math.max(Math.min(delay * 2, 2000), cost * DUTY), 10000);
    };
    const schedule = urgent => {
      if (pending || idleH || hidden() || !alive(me, at)) return;
      if (urgent) delay = base();
      const ms = Math.max(urgent ? 60 : delay, nextOk - now());
      pending = setTimeout(() => { pending = 0; idleH = idle(check); }, ms);
    };
    // Only changes that could bring the control: a subtree with its name or selectors, a closed modal, a route
    // change. The rest only set a flag that a slow timed check picks up (for a renamed control, say).
    const could = relevance(step.target);
    const relevant = muts => {
      if (location.href !== href) { href = location.href; return true; } // SPA route change (pushState fires no event)
      if (!could) return muts.some(m => m.type === 'attributes' ? !ours(m.target) : [...m.addedNodes].some(n => n.nodeType === 1 && !ours(n)));
      const seen = new Set(); // one record per target is enough (a class toggled many times in one batch)
      for (const m of muts) {
        if (m.type === 'attributes') { if (!seen.has(m.target) && (seen.add(m.target), could(m.target))) return true; continue; }
        for (const n of m.addedNodes) if (could(n)) return true;
        for (const n of m.removedNodes) if (n.nodeType === 1 && !ours(n) && (n.matches(MODAL) || n.querySelector(MODAL))) return true;
      }
      return false;
    };
    const mo = new MutationObserver(muts => {
      if (pending || idleH) return; // a check is queued already: it sees these changes too
      if (relevant(muts)) schedule(false); else skipped = true;
    });
    // No "style": animations write it every frame.
    const observe = () => mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'aria-expanded', 'aria-hidden'] });
    if (!hidden()) observe();
    const nudge = setInterval(() => { if (skipped && !done) { skipped = false; schedule(false); } }, NUDGE);
    const onNav = () => schedule(true);
    addEventListener('hashchange', onNav);
    addEventListener('popstate', onNav);

    // Self-healing only makes sense on the right page.
    const heal = async () => {
      if (!alive(me, at) || !me.opts.onMissing || me.healed.has(at) || !samePage(step.target.path)) return;
      me.healed.add(at);
      let found = null;
      try { found = await me.opts.onMissing(step, at); } catch (e) { found = null; }
      if (found && alive(me, at)) { step.target = found; show(); }
    };
    const armHeal = () => {
      if (healT) healT.clear();
      healT = !away ? visTimeout(heal, me.opts.missingDelay || 2500) : null;
    };
    armHeal();

    // After a minute of visible time stop watching the page; the user's own clicks and focus moves still
    // trigger a check each. Not keys: typing in a field would run a full resolve every few hundred ms.
    let poke = null;
    const POKES = ['click', 'focusin'];
    const giveUp = visTimeout(() => {
      if (!alive(me, at)) return;
      done = true;
      mo.disconnect();
      clearInterval(nudge);
      draw(null, step, { gaveUp: true });
      if (!away) heal();
      poke = throttle(() => schedule(true), 400);
      POKES.forEach(t => addEventListener(t, poke, true));
    }, GIVE_UP);

    // A hidden tab does no waiting work: no observer, no checks, clocks stopped. Back in view, one check at once.
    const onVis = () => {
      if (hidden()) {
        mo.disconnect();
        clearTimeout(pending); pending = 0;
        unidle(idleH); idleH = null;
        giveUp.pause();
        if (healT) healT.pause();
      } else {
        if (!done) observe();
        giveUp.resume();
        if (healT) healT.resume();
        schedule(true);
      }
    };
    document.addEventListener('visibilitychange', onVis);

    me.cleanup.push(() => {
      mo.disconnect();
      clearInterval(nudge);
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('hashchange', onNav);
      removeEventListener('popstate', onNav);
      if (poke) POKES.forEach(t => removeEventListener(t, poke, true));
      clearTimeout(pending);
      unidle(idleH);
      if (healT) healT.clear();
      giveUp.clear();
    });
  }

  function throttle(fn, ms) {
    let t = 0;
    return () => { if (t) return; t = setTimeout(() => { t = 0; fn(); }, ms); };
  }

  const state = () => (run ? { index: run.index, total: run.steps.length } : null);

  // ---------------- recorder ----------------
  const CLICKABLE = 'a[href],button,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=treeitem],input[type=checkbox],input[type=radio],input[type=submit],input[type=button]';
  // Labels of list rows carry customer data: never write e-mails or long numbers into a step.
  const scrub = s => String(s || '').replace(/\S+@\S+/g, '…').replace(/\+?\d[\d\s()-]{3,}\d/g, '…').trim();
  const userData = s => /@|\d{4,}/.test(String(s || '').replace(/\s/g, ''));
  let rec = null;

  function recStart(onStep) {
    recStop();
    const steps = [];
    const push = step => { steps.push(step); call(onStep, step, steps.length - 1); };
    const sameAsLast = target => {
      const last = steps[steps.length - 1];
      return !!(last && last.target && target && last.action !== 'click' && last.target.sel && target.sel && last.target.sel[0] === target.sel[0]);
    };
    let lastClick = null;
    const onClick = e => {
      const t = targetOf(e);
      if (!t || t.nodeType !== 1 || ours(t) || ours(e.target)) return;
      const el = t.closest && t.closest(CLICKABLE);
      if (!el || ours(el)) return;
      // A click on a <label> is followed by the browser's click on its control: one step, not two.
      if (lastClick && Date.now() - lastClick.t < 500 && lastClick.el.tagName === 'LABEL' && lastClick.el.control === el) return;
      lastClick = { el, t: Date.now() };
      const label = scrub(S.labelOf(el)).slice(0, 60) || 'элемент';
      push({ instruction: `Нажмите «${label}»`, target: S.describe(el), action: 'click', value: null });
    };
    const filled = el => {
      const label = scrub(S.labelOf(el)).slice(0, 60) || 'поле';
      const target = S.describe(el);
      if (sameAsLast(target)) return;
      push({ instruction: `Заполните поле «${label}»`, target, action: 'type', value: null });
    };
    const onChange = e => {
      const el = targetOf(e);
      if (!el || ours(el) || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || /checkbox|radio|submit|button|hidden/.test(el.type || '')) return;
      if (el.tagName !== 'SELECT') { filled(el); return; }
      const label = scrub(S.labelOf(el)).slice(0, 60) || 'список';
      const target = S.describe(el);
      if (sameAsLast(target)) return;
      const opt = el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent.replace(/\s+/g, ' ').trim() : '';
      // Option text is kept only when it is part of the product (a status, a period), not someone's data.
      const keep = opt && opt.length <= 40 && !userData(opt) && el.options.length < 30;
      push(keep
        ? { instruction: `Выберите «${opt}» в списке «${label}»`, target, action: 'select', value: opt }
        : { instruction: `Выберите нужный вариант в списке «${label}»`, target, action: 'select', value: null });
    };
    // Rich editors fire no "change": a typed-in editor that loses focus is a filled field.
    let editing = null;
    const onInput = e => {
      const el = targetOf(e);
      if (el && el.nodeType === 1 && el.isContentEditable && !ours(el)) {
        let host = el;
        while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
        editing = host;
      }
    };
    const onFocusOut = e => {
      const el = targetOf(e);
      if (!editing || !el || !(editing === el || editing.contains(el))) return;
      if (e.relatedTarget && editing.contains(e.relatedTarget)) return;
      const host = editing;
      editing = null;
      filled(host);
    };
    const pairs = [['click', onClick], ['change', onChange], ['input', onInput], ['focusout', onFocusOut]];
    pairs.forEach(([t, fn]) => addEventListener(t, fn, true));
    rec = { steps, off: () => pairs.forEach(([t, fn]) => removeEventListener(t, fn, true)) };
    return steps;
  }

  function recStop() {
    if (!rec) return [];
    rec.off();
    const steps = rec.steps;
    rec = null;
    return steps;
  }

  S.guide = { start, stop, go: i => go(i), state };
  S.recorder = { start: recStart, stop: recStop, active: () => !!rec };
})(typeof window !== 'undefined' ? window : globalThis);
