/*
 * Scopos guide runner and recorder.
 *
 * guide.start(steps, opts) walks the user through steps. A step advances by
 * itself when the user does the action on the highlighted control (click it,
 * fill it, pick an option), or by the card's "Далее". The new index is reported
 * through onChange before the page reacts, so a full page load resumes on the
 * right step.
 *
 * When a step's control is not on the page yet, the runner waits for it with a
 * MutationObserver that only lives while it waits, and after a short while asks
 * opts.onMissing() to re-locate it (the self-healing path for changed UIs).
 *
 * recorder.start(onStep) turns real clicks and field changes into steps. Typed
 * text is never recorded, only which field was filled.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});

  let run = null; // { steps, index, opts, el, cleanup: [] }

  function start(steps, opts = {}) {
    stop(false);
    run = { steps, index: Math.max(0, Math.min(opts.index || 0, steps.length - 1)), opts, el: null, cleanup: [], healed: new Set() };
    show();
  }

  function stop(notify = true, reason = 'closed') {
    if (!run) return;
    const r = run;
    run = null;
    r.cleanup.forEach(fn => fn());
    S.pointer.hide();
    if (notify && r.opts.onEnd) r.opts.onEnd(reason);
  }

  function go(i) {
    if (!run) return;
    if (i >= run.steps.length) { stop(true, 'done'); return; }
    run.index = Math.max(0, i);
    if (run.opts.onChange) run.opts.onChange({ index: run.index });
    show();
  }

  function clearWatch() {
    if (!run) return;
    run.cleanup.forEach(fn => fn());
    run.cleanup = [];
  }

  function show() {
    clearWatch();
    const step = run.steps[run.index];
    const el = step.target ? S.resolve(step.target) : null;
    run.el = el;
    draw(el, step, !!step.target && !el);
    if (el) arm(el, step);
    else if (step.target) wait(step);
  }

  function draw(el, step, waiting) {
    S.pointer.point(el, {
      step: run.index + 1, total: run.steps.length, instruction: step.instruction, value: step.value, waiting,
      autoAdvance: !!el && step.action !== 'look',
      onNext: () => go(run.index + 1),
      onBack: () => go(run.index - 1),
      onClose: () => stop(true, 'closed'),
    });
  }

  // Advance when the user performs the step on the highlighted control.
  function arm(el, step) {
    const at = run.index;
    const advance = (delay) => {
      if (!run || run.index !== at) return;
      // Report first: if this click navigates away, the next page resumes on the next step.
      const next = at + 1;
      if (run.opts.onChange) run.opts.onChange({ index: Math.min(next, run.steps.length) });
      setTimeout(() => { if (run && run.index === at) go(next); }, delay);
    };
    const inside = e => e.composedPath ? e.composedPath().includes(el) : el.contains(e.target);
    const onClick = e => { if (inside(e) && (step.action === 'click' || step.action === 'look')) advance(260); };
    const onChange = e => { if (inside(e) && (step.action === 'type' || step.action === 'select')) advance(120); };
    const onKey = e => { if (e.key === 'Enter' && inside(e) && step.action === 'type') advance(120); };
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKey, true);
    // The control can be replaced by a re-render: look for it again if it leaves the page.
    const mo = new MutationObserver(throttle(() => { if (run && run.index === at && !el.isConnected) show(); }, 300));
    mo.observe(document.body, { childList: true, subtree: true });
    run.cleanup.push(() => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('keydown', onKey, true);
      mo.disconnect();
    });
  }

  // The control isn't here yet (menu closed, page still loading, UI changed).
  function wait(step) {
    const at = run.index;
    const tryFind = () => {
      if (!run || run.index !== at) return;
      const el = S.resolve(step.target);
      if (el) { show(); }
    };
    const mo = new MutationObserver(throttle(tryFind, 250));
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-expanded', 'style'] });
    const onNav = () => setTimeout(tryFind, 60);
    addEventListener('hashchange', onNav);
    addEventListener('popstate', onNav);
    const heal = setTimeout(async () => {
      if (!run || run.index !== at || !run.opts.onMissing || run.healed.has(at)) return;
      run.healed.add(at);
      const found = await run.opts.onMissing(step, at).catch(() => null);
      if (found && run && run.index === at) { step.target = found; show(); }
    }, run.opts.missingDelay || 2500);
    run.cleanup.push(() => { mo.disconnect(); removeEventListener('hashchange', onNav); removeEventListener('popstate', onNav); clearTimeout(heal); });
  }

  function throttle(fn, ms) {
    let t = 0;
    return () => { if (t) return; t = setTimeout(() => { t = 0; fn(); }, ms); };
  }

  const state = () => (run ? { index: run.index, total: run.steps.length } : null);

  // ---------------- recorder ----------------
  const CLICKABLE = 'a[href],button,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=treeitem],input[type=checkbox],input[type=radio],input[type=submit],input[type=button]';
  let rec = null;

  function recStart(onStep) {
    recStop();
    const steps = [];
    const push = step => { steps.push(step); onStep(step, steps.length - 1); };
    const onClick = e => {
      if (S.pointer.isOurs(e.target)) return;
      const el = e.target.closest && e.target.closest(CLICKABLE);
      if (!el) return;
      const label = S.labelOf(el) || 'элемент';
      push({ instruction: `Нажмите «${label.slice(0, 60)}»`, target: S.describe(el), action: 'click', value: null });
    };
    const onChange = e => {
      const el = e.target;
      if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || /checkbox|radio|submit|button/.test(el.type || '')) return;
      const label = (S.labelOf(el) || 'поле').slice(0, 60);
      const target = S.describe(el);
      const last = steps[steps.length - 1];
      if (last && last.target && last.target.sel[0] === target.sel[0] && last.action !== 'click') return;
      if (el.tagName === 'SELECT') {
        const opt = el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : '';
        push({ instruction: `Выберите «${opt}» в списке «${label}»`, target, action: 'select', value: opt || null });
      } else {
        push({ instruction: `Заполните поле «${label}»`, target, action: 'type', value: null });
      }
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    rec = { steps, off: () => { document.removeEventListener('click', onClick, true); document.removeEventListener('change', onChange, true); } };
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
