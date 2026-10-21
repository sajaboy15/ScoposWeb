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
 * Before any paid call, a control whose descriptor no longer matches is looked
 * for by its visible label (target.text, else the «…» label in the instruction):
 * fuzzy, role-aware, inside an open dialog first, and only an unambiguous best
 * match is taken (findLocal). A "look" step on a data area (table, list,
 * region) frames that area and never advances by itself.
 *
 * Live guides (opts.live) and dead ends: opts.more({ index, reason, done })
 * returns the remaining steps from the page the user is on (reason 'end': the
 * guide's steps ran out; 'missing': a step's control is not on this page after
 * the free search and onMissing). At most 3 per run.
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
  const DIALOG_MISSING = 1200; // a dialog just opened: its controls are there at once, so "missing" is decided sooner
  const MORE_AFTER = 6000, MORE_DIALOG = 2500; // visible ms on the right page before asking opts.more for a missing step
  const MAX_MORE = 3;   // opts.more calls per run
  const RESYNC_AFTER = 1200, RESYNC_TRIES = 3; // off the guide's page this long: look for the step that fits here
  const MAX_ADDED = 25; // steps taken from one opts.more answer
  let cost = 0;         // last measured S.resolve cost on this page, ms

  // ---------------- local fallback: find a control by its visible label, for free ----------------
  const FIELD_SEL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=file]),textarea,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=searchbox],[role=spinbutton],[role=combobox]';
  const PICK_SEL = 'select,[role=combobox],[role=listbox],[aria-haspopup=listbox],button[aria-haspopup],[role=radiogroup]';
  const CLICK_SEL = 'a[href],button,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=checkbox],[role=radio],[role=switch],[role=treeitem],input[type=submit],input[type=button],input[type=checkbox],input[type=radio]';
  const REGION_SEL = {
    table: 'table,[role=table],[role=grid],[role=treegrid]',
    list: 'ul,ol,[role=list],[role=feed]',
    region: 'section,[role=region],[role=tabpanel],form,[role=form],article',
    heading: 'h1,h2,h3,h4,h5,h6,[role=heading]',
  };
  const REGION_ANY = Object.values(REGION_SEL).join(',');
  const HEAD = 'h1,h2,h3,h4,h5,h6,[role=heading],caption,legend';
  const regionKind = role => {
    const r = String(role || '').toLowerCase();
    if (/^(table|grid|treegrid)$/.test(r)) return 'table';
    if (/^(list|feed)$/.test(r)) return 'list';
    if (/^(region|section|tabpanel|form|article)$/.test(r)) return 'region';
    return r === 'heading' ? 'heading' : null;
  };
  const isRegionEl = el => { try { return !!el && el.nodeType === 1 && el.matches(REGION_ANY); } catch (e) { return false; } };
  const isRegionStep = (step, el) => step.action === 'look' && (!!regionKind(step.target && step.target.role) || isRegionEl(el));
  // Loose text form for label matching: case, ё/е, punctuation and symbols ignored.
  const fz = s => String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const stem = w => w.slice(0, Math.max(4, Math.ceil(w.length * 0.7)));
  const wordHit = (w, words) => words.some(h => h === w || (w.length >= 4 && h.length >= 4 && (h.startsWith(stem(w)) || w.startsWith(stem(h)))));
  // 1 exact, 0.85 one label starts the other (a "*" or a counter added), 0.75 every word of the wanted label
  // is there (stems, so «Счёт»/«Счета»); loose (data areas) also accepts the reverse containment.
  function sim(want, have, loose) {
    if (!want || !have) return 0;
    if (want === have) return 1;
    const [a, b] = want.length <= have.length ? [want, have] : [have, want];
    if (a.length >= 3 && b.startsWith(a) && a.length / b.length >= 0.5) return 0.85;
    const ww = want.split(' '), hw = have.split(' ');
    if (ww.every(w => wordHit(w, hw)) && ww.length / hw.length >= 0.5) return 0.75;
    if (loose && hw.every(w => wordHit(w, ww))) return 0.7;
    return 0;
  }
  // The control's label in a step's instruction: «…» (the last one for fields: «Выберите «30 дней» в списке «Срок»»).
  function quoted(instruction, action) {
    const all = [...String(instruction || '').matchAll(/[«"“„]([^«»"“”„]{1,80})[»"”“]/g)].map(m => m[1].trim()).filter(Boolean);
    if (!all.length) return '';
    return action === 'type' || action === 'select' ? all[all.length - 1] : all[0];
  }
  const within = (box, el) => {
    for (let n = el, i = 0; n && i < 20; i++) {
      if (box === n || box.contains(n)) return true;
      const r = n.getRootNode ? n.getRootNode() : null;
      n = r && r.host;
    }
    return false;
  };
  function topDialog() {
    const list = S.deepQueryAll ? S.deepQueryAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]') : [];
    for (let i = list.length - 1; i >= 0; i--) if (!ours(list[i]) && shown(list[i])) return list[i];
    return null;
  }
  function namesOf(el) {
    const out = [];
    try { if (S.labelOf) out.push(S.labelOf(el)); } catch (e) { /* detached */ }
    for (const k of ['aria-label', 'placeholder', 'title']) { const v = el.getAttribute(k); if (v) out.push(v); }
    if (el.labels) for (const l of el.labels) out.push((l.textContent || '').slice(0, 120));
    if (!out.length) out.push((el.textContent || '').slice(0, 120));
    return [...new Set(out.map(fz).filter(Boolean))];
  }
  function regionNames(el) {
    const out = [el.getAttribute('aria-label') || ''];
    const by = el.getAttribute('aria-labelledby');
    if (by) by.split(/\s+/).forEach(id => { const n = el.ownerDocument.getElementById(id); if (n) out.push(n.textContent || ''); });
    if (el.matches(REGION_SEL.heading)) out.push(el.textContent || '');
    const own = el.querySelector && el.querySelector(':scope > caption, :scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > header h1, :scope > header h2');
    if (own) out.push(own.textContent || '');
    // The nearest heading before it: its previous siblings, then its parents' (two levels up).
    for (let n = el, up = 0; n && up < 3; up++, n = n.parentElement) {
      let p = n.previousElementSibling, found = false;
      for (let k = 0; p && k < 4 && !found; k++, p = p.previousElementSibling) {
        const h = p.matches(HEAD) ? p : p.querySelector && p.querySelector(HEAD);
        if (h) { out.push(h.textContent || ''); found = true; }
      }
      if (found) break;
    }
    return [...new Set(out.map(s => fz(String(s).slice(0, 120))).filter(Boolean))];
  }
  // Best of a scored list, or null when a different control comes too close (two «Сохранить»: no guess).
  function unambiguous(cands, modal) {
    if (modal) { const inside = cands.filter(c => within(modal, c.el)); if (inside.length) cands = inside; }
    cands.sort((a, b) => b.s - a.s);
    const best = cands[0];
    if (!best) return null;
    const rival = cands.find(c => c !== best && !best.el.contains(c.el) && !c.el.contains(best.el) && c.s >= best.s - 0.1);
    return rival ? null : best.el;
  }
  function findRegion(kind, labels) {
    let pool = S.deepQueryAll(REGION_SEL[kind]).filter(el => !ours(el) && !(kind === 'list' && el.closest(CHROME)) && shown(el));
    pool = pool.filter(el => !pool.some(o => o !== el && o.contains(el))); // outermost only (nested lists, a table in a table)
    if (!pool.length) return null;
    const modal = topDialog();
    if (labels.length) {
      const cands = [];
      for (const el of pool) {
        let s = 0;
        for (const n of regionNames(el)) for (const l of labels) s = Math.max(s, sim(l, n, true));
        if (s >= 0.7) cands.push({ el, s });
      }
      const hit = unambiguous(cands, modal);
      if (hit) return hit;
    }
    if (modal) { const inside = pool.filter(el => within(modal, el)); if (inside.length === 1) return inside[0]; }
    return pool.length === 1 ? pool[0] : null; // the only table on the page is the table
  }
  /**
   * The step's control found by its visible label alone, or null. Free: no model call. Used when the stored
   * descriptor no longer resolves (or the step has no descriptor). Wants the right kind of control for the
   * action, prefers an open dialog, and accepts only an unambiguous best match.
   */
  function findLocal(step) {
    if (!S.deepQueryAll || !step) return null;
    const d = step.target || {}, act = step.action || 'click';
    const labels = [...new Set([d.text, quoted(step.instruction, act)].map(fz).filter(Boolean))];
    const kind = regionKind(d.role);
    if (act === 'look') return kind ? findRegion(kind, labels) : null;
    if (!labels.length) return null;
    const fieldish = /^(textbox|searchbox|textarea|spinbutton)$/.test(String(d.role || ''));
    const sel = act === 'type' || fieldish ? FIELD_SEL : act === 'select' ? PICK_SEL : CLICK_SEL;
    // Cheap prefilter on raw text and attributes before any label or layout read.
    const probes = labels.map(l => l.split(' ').find(w => w.length >= 3) || l).map(w => w.slice(0, 5));
    const raw = el => fz([(el.textContent || '').slice(0, 300), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'),
      el.getAttribute('aria-labelledby') ? 'x' : '', el.labels && el.labels.length ? [...el.labels].map(l => (l.textContent || '').slice(0, 200)).join(' ') : ''].join(' '));
    const cands = [];
    for (const el of S.deepQueryAll(sel)) {
      if (ours(el)) continue;
      const r = raw(el);
      if (!el.getAttribute('aria-labelledby') && !probes.some(p => r.includes(p))) continue;
      let s = 0;
      for (const n of namesOf(el)) for (const l of labels) s = Math.max(s, sim(l, n));
      // A native list named after one of its options («Выберите «ИП Каримова»»).
      if (s < 0.7 && act === 'select' && el.tagName === 'SELECT') {
        for (const o of el.options) for (const l of labels) if (fz(o.textContent) === l) s = Math.max(s, 0.7);
      }
      if (s < 0.7 || !shown(el)) continue;
      cands.push({ el, s });
    }
    return unambiguous(cands, topDialog());
  }

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
  const ID_SEG = /\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,}|[A-Za-z]{1,8}[-_]?\d{3,}(?:[-_][A-Za-z0-9]+)*)(?=\/|$)/gi;
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
  const hereNow = () => location.pathname + location.search + location.hash;
  // The same screen, or the same record screen in another state (S.samePlace: a booked load's page and an assigned one's).
  const samePage = path => !path || (S.samePlace ? S.samePlace(path, hereNow()) : pathKey(path) === pathKey(hereNow()));
  // A record screen's title names the sample record the study saw ("Load / 15128819"): drop the words with digits.
  const pagePlace = d => {
    const rec = /(^|[/#]):id(?=$|[/?#])/.test(pathKey(d.path || ''));
    const view = d.view && rec ? String(d.view).split(/\s+/).filter(w => !/\d/.test(w)).join(' ').replace(/^[\s/·|:-]+|[\s/·|:-]+$/g, '') : d.view;
    if (view) return `${rec ? 'нужной записи ' : ''}«${String(view).slice(0, 60)}»`;
    return `«${String(d.path || '/').split('?')[0].replace(/#(?![!/]).*$/, '').slice(0, 60)}»`;
  };

  let run = null; // { steps, index, opts, el, cleanup: [], healed, advanced, mores, asked, asking }
  let lastSteps = [];
  const alive = (me, at) => run === me && (at === undefined || me.index === at);

  /**
   * opts: { index, missingDelay, onChange({index}), onEnd(reason), onMissing(step, i) → descriptor|null,
   *         live, more({ index, reason: 'end'|'missing', done: [instruction] }) → Step[]|null, onSteps(steps) }
   * live: when the steps run out, ask opts.more for the rest instead of ending. While it is asked the
   * reported index is steps.length; the guide really ends with onEnd('done').
   * onSteps: called with the whole new list whenever opts.more changed it (save it for a page-load resume).
   */
  function start(steps, opts = {}) {
    stop(false);
    if (!Array.isArray(steps) || !steps.length) return;
    const index = Math.max(0, Math.min(opts.index || 0, steps.length - 1));
    run = { steps: steps.slice(), index, opts, el: null, cleanup: [], healed: new Set(), advanced: -1, mores: 0, asked: new Set(), asking: null };
    lastSteps = run.steps;
    show();
  }

  function stop(notify = true, reason = 'closed') {
    if (!run) return;
    const r = run;
    run = null;
    lastSteps = r.steps;
    r.asking = null;
    r.cleanup.forEach(fn => call(fn));
    r.cleanup = [];
    unpend(r);
    S.pointer.hide();
    if (notify) call(r.opts.onEnd, reason);
  }

  function go(i) {
    if (!run) return;
    run.asking = null; // a pending opts.more answer is for where the user was
    if (i >= run.steps.length) { finish(run); return; }
    run.index = Math.max(0, i);
    run.advanced = -1;
    call(run.opts.onChange, { index: run.index });
    show();
  }

  // The last step is done: a live guide asks what comes next on this page, any other one ends.
  function finish(me) {
    if (me.opts.live && me.opts.more && me.mores < MAX_MORE) askMore(me, 'end', me.steps.length);
    else stop(true, 'done');
  }

  const cleanStep = s => ({
    instruction: String(s.instruction).slice(0, 200),
    action: ['click', 'type', 'select', 'look'].includes(s.action) ? s.action : 'click',
    value: s.value == null || s.value === '' ? null : String(s.value).slice(0, 200),
    target: s.target && typeof s.target === 'object' ? s.target : null,
  });

  /**
   * reason 'end': the steps ran out (live guide) → the answer is appended.
   * reason 'missing': step `at` is not on this page after the free search and onMissing → the answer
   * replaces the steps from `at` on. An empty answer ends the guide ('end') or leaves the step to the user.
   */
  async function askMore(me, reason, at) {
    if (run !== me || !me.opts.more || me.mores >= MAX_MORE || (reason === 'missing' && me.asked.has(at))) {
      if (reason === 'end' && run === me) stop(true, 'done');
      return;
    }
    me.mores++;
    if (reason === 'missing') me.asked.add(at);
    const tok = (me.asking = { reason, at });
    if (reason === 'end') { clearWatch(); me.el = null; }
    drawMore(me, reason === 'end' ? me.steps.length - 1 : at);
    const done = me.steps.slice(0, reason === 'end' ? me.steps.length : at).map(s => s.instruction);
    let res = null;
    try { res = await me.opts.more({ index: at, reason, done }); } catch (e) { res = null; }
    if (run !== me || me.asking !== tok) return; // closed, restarted, or the user moved on meanwhile
    me.asking = null;
    const add = (Array.isArray(res) ? res : []).filter(s => s && typeof s.instruction === 'string' && s.instruction.trim()).slice(0, MAX_ADDED).map(cleanStep);
    if (reason === 'end') {
      if (!add.length) { stop(true, 'done'); return; }
      const from = me.steps.length;
      me.steps = me.steps.concat(add);
      lastSteps = me.steps;
      call(me.opts.onSteps, me.steps.slice());
      go(from);
      return;
    }
    if (me.index !== at || (me.el && shown(me.el))) return; // the control turned up while we asked
    if (!add.length) { if (me.steps[at] && me.steps[at].target) draw(null, me.steps[at], { gaveUp: true }); return; }
    me.steps = me.steps.slice(0, at).concat(add);
    lastSteps = me.steps;
    me.healed = new Set([...me.healed].filter(i => i < at));
    me.asked = new Set([...me.asked].filter(i => i < at));
    call(me.opts.onSteps, me.steps.slice());
    go(at);
  }

  function drawMore(me, at) {
    S.pointer.point(null, {
      step: Math.min(at + 1, me.steps.length), total: me.steps.length, instruction: 'Смотрю, что дальше…', value: null, waiting: false, autoAdvance: false,
      onNext: () => { if (run === me) stop(true, 'done'); },
      onBack: () => { if (run === me) go(Math.min(at, me.steps.length - 1) - (me.asking && me.asking.reason === 'missing' ? 1 : 0)); },
      onClose: () => { if (run === me) stop(true, 'closed'); },
    });
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
    // A row step: the matching control in any row of its table (the row the user picked earlier first), on its page only.
    if (isRowStep(step)) {
      try {
        if (!samePage(d.path)) return null;
        const r = S.resolveRow(d, { prefer: run && run.pick });
        return r && r.el && !ours(r.el) ? r.el : null;
      } catch (e) { return null; } finally { cost = now() - t0; }
    }
    let el = null;
    try { el = S.resolve(d); } catch (e) { el = null; }
    try {
      if (el && ours(el)) el = null;
      // A step about a data area lands on a data area, never on a same-named link or tab.
      if (el && regionKind(d.role) && !isRegionEl(el)) el = null;
      if (el) {
        if (samePage(d.path)) return el;
        if (!el.closest(CHROME)) return null;
        if (S.resolveDetailed) {
          let r = null;
          try { r = S.resolveDetailed(d); } catch (e) { r = null; }
          if (!r || r.el !== el || r.ambiguous || r.score < 0.85) return null;
        }
        return el;
      }
      // Not found by its descriptor: by its visible label, on its own page only (free, no model call).
      if (!samePage(d.path)) return null;
      let loc = null;
      try { loc = findLocal(step); } catch (e) { loc = null; }
      return loc && !ours(loc) ? loc : null;
    } finally { cost = now() - t0; }
  }

  // A step on a control repeated once per row of a table or list (brain.refSteps sets row and rowOf): it means
  // "this, on the record you need", so any row's control is the step's control.
  const isRowStep = step => !!(step && step.target && step.target.row && (step.target.rowOf || (step.target.fp && step.target.fp.rowOf)) && S.resolveRow && S.matchRow);
  const ROW_HINT = /нужн|need|want|wish|any |любо|выбран|choose|pick|desired|the one/i;
  // The card for a row step says to pick the record, even if the written instruction forgot to.
  function rowInstruction(step) {
    const t = String(step.instruction || '');
    if (ROW_HINT.test(t)) return t;
    const ru = /[а-яё]/i.test(t);
    return `${t.replace(/[.\s]+$/, '')}${ru ? ' — у нужной записи' : ' — on the record you need'}`;
  }

  // A step with no control but a «label» in its instruction gets a label-only target, so it can still be
  // pointed at (found by findLocal). Not enumerable: it is not saved with the guide.
  // A "look" step without a control (old maps had no data areas) is framed on the table or list its label names,
  // only when one is on the page right now: a look step never waits or asks for more.
  function autoTarget(step) {
    if (step.target) return;
    const label = quoted(step.instruction, step.action);
    if (!label) return;
    let role = null;
    if (step.action === 'look') {
      if (!S.deepQueryAll) return;
      try { role = ['table', 'list'].find(k => findRegion(k, [fz(label)])) || null; } catch (e) { role = null; }
      if (!role) return;
    }
    try { Object.defineProperty(step, 'target', { value: { sel: [], text: label, role, auto: true }, writable: true, enumerable: false, configurable: true }); } catch (e) { /* frozen step */ }
  }

  // A step change draws at once and searches once, later: a burst of go() (mashing «Далее»/«Назад») costs one
  // resolve for the step it ends on, not one per click.
  function show() {
    if (!run) return;
    clearWatch();
    const me = run, step = me.steps[me.index];
    if (!step) { finish(me); return; }
    autoTarget(step);
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
    let instruction = isRowStep(step) ? rowInstruction(step) : step.instruction;
    if (f.away) instruction = `Перейдите на страницу ${pagePlace(step.target)}. Там: ${trim(instruction)}`;
    if (f.gaveUp) instruction = `${trim(instruction)}. Не вижу этот элемент на странице: сделайте шаг сами и нажмите «Далее».`;
    // Picked up again after the user left the way (resync).
    if (me.note && me.note.at === at && !f.away) instruction = `${me.note.back ? 'Вернёмся на путь' : 'Вы уже здесь, продолжаем'}: ${instruction}`;
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
    // A look at a data area (a table, a list) waits for «Далее»: a click inside it is the user reading, not done.
    const clicky = act === 'click' || (act === 'look' && !isRegionStep(step, me.el));
    const cur = () => me.el;
    const go2 = delay => advance(me, at, delay);
    // A row step advances on a click on the matching control in ANY row, not only the one pointed at.
    const rowStep = isRowStep(step);
    const rowHit = e => {
      if (!rowStep) return null;
      const t = targetOf(e);
      if (!t || t.nodeType !== 1 || ours(t) || !t.closest || !t.closest('tr,[role=row],li,[role=listitem]')) return null;
      return S.matchRow(step.target, t);
    };
    const valueOk = () => {
      if (!step.value) return true;
      const have = norm(textNow(cur())), want = norm(step.value);
      return !!have && (have === want || have.includes(want) || want.includes(have));
    };

    // A fresh copy rendered in place of ours (list refresh, keyed re-render) counts too. Cheap checks first:
    // these run on every key, click and input on the page, and a layout read there is a forced reflow.
    const sameControl = t => {
      if (rowStep || !step.target || !step.target.text) return false;
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
      if (rowStep) return !!rowHit(e);
      return sameControl(t);
    };

    // Menus (Radix, Headless) act on pointerdown/pointerup and unmount before "click":
    // remember a press that started on the control and count its release.
    let down = null, dirty = false;
    const onDown = e => {
      if (!alive(me, at) || e.button > 0) return;
      // The row the user works in: a later row step points into the same row.
      if (S.rowAt && !ours(targetOf(e))) { const r = S.rowAt(targetOf(e)); if (r) me.pick = r; }
      const hit = rowHit(e);
      down = hit ? { r: hit.getBoundingClientRect(), t: Date.now() } : inside(e) ? { r: cur().getBoundingClientRect(), t: Date.now() } : null;
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
    // The user went to another address on their own (back to where a later step is, or ahead of the guide):
    // go on from the nearest later step whose page this is and whose control is here. A few tries per address.
    const armHref = location.href;
    let seenHref = armHref, tries = 0;
    const ahead = () => {
      if (location.href === armHref || hidden() || !alive(me, at) || me.advanced === at) return false;
      if (location.href !== seenHref) { seenHref = location.href; tries = 0; }
      if (tries++ >= RESYNC_TRIES) return false;
      for (let j = at + 1; j < Math.min(me.steps.length, at + 7); j++) {
        const s = me.steps[j];
        if (s && s.target && s.target.path && !s.target.auto && samePage(s.target.path) && find(s)) {
          if (alive(me, at)) { me.note = { at: j, back: false }; go(j); }
          return true;
        }
      }
      return false;
    };
    const onNav = throttle(ahead, 400);
    addEventListener('hashchange', onNav);
    addEventListener('popstate', onNav);
    const mo = new MutationObserver(throttle(() => {
      if (hidden() || grace || !alive(me, at) || me.advanced === at) return;
      if (location.href !== armHref && ahead()) return;
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
      removeEventListener('hashchange', onNav);
      removeEventListener('popstate', onNav);
      mo.disconnect();
      clearTimeout(grace);
      if (amo) amo.disconnect();
      me.rewatch = null;
    });
  }

  /**
   * The user left the step's page. The step to go on from here: a later one whose page this is (they went ahead
   * on their own), else the nearest earlier one whose control is here (a menu item, the list they came from).
   * -1 when nothing fits: the card keeps asking them to go to the step's page.
   */
  function resync(me, at) {
    const fits = j => { const s = me.steps[j]; return !!(s && s.target && !s.target.auto && find(s)); };
    for (let j = at + 1; j < Math.min(me.steps.length, at + 6); j++) {
      const s = me.steps[j];
      if (s && s.target && s.target.path && samePage(s.target.path) && fits(j)) return j;
    }
    for (let j = at - 1; j >= 0; j--) if (fits(j)) return j;
    return -1;
  }

  // The control isn't here yet (menu closed, page still loading, UI changed, another page).
  function wait(step, away) {
    const me = run, at = me.index;
    const base = () => Math.max(250, cost * DUTY);
    // nextOk: show() searched just now, so the first check here is spaced from that search too.
    let delay = base(), pending = 0, idleH = null, done = false, healT = null, moreT = null, nextOk = now() + cost * DUTY, skipped = false;
    // follow: spaced re-checks after a relevant change. A control can become visible at the end of an
    // animation (opacity, a transform) with no further DOM change, so one check right after the change can miss it.
    let follow = 2;
    let href = location.href;
    // A dialog that is open (or opens while we wait) holds the step's control if it is anywhere: it is decided sooner.
    let dialog = !!topDialog(), since = now(), healed = false;
    let triedAt = '', tries = 0;
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
        since = now();
        if (!done && !me.asking) draw(null, step, away ? { away: true } : { waiting: true });
        armHeal();
      }
      // Off the way (a wrong click, a link elsewhere): pick the guide up from the step that fits this page,
      // ahead or back, for free. Only after a moment away, so a step whose click is still changing the
      // address is not taken back; a few tries per address, since the new page may still be rendering.
      let more = false;
      if (away && !me.asking) {
        if (location.href !== triedAt) { triedAt = location.href; tries = 0; }
        if (tries < RESYNC_TRIES) {
          if (now() - since >= RESYNC_AFTER) {
            tries++;
            const j = resync(me, at);
            if (j >= 0 && alive(me, at)) { me.note = { at: j, back: j < at }; go(j); return; }
          }
          more = tries < RESYNC_TRIES;
        }
      }
      // Back off: nothing changed that mattered. Never closer than DUTY × the measured cost.
      delay = Math.min(Math.max(Math.min(delay * 2, 2000), cost * DUTY), 10000);
      if (more) { delay = Math.min(delay, 1000); schedule(false); } else if (follow > 0) { follow--; schedule(false); }
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
    // A modal opened: <dialog open>, or an added node that is or holds one (first nodes of a batch only).
    const opened = muts => muts.some(m => (m.type === 'attributes'
      ? m.attributeName === 'open' && m.target.tagName === 'DIALOG' && m.target.open && !ours(m.target)
      : [...m.addedNodes].slice(0, 20).some(n => n.nodeType === 1 && !ours(n) && (n.matches(MODAL) || (n.firstElementChild && !!n.querySelector(MODAL))))));
    const mo = new MutationObserver(muts => {
      if (!dialog && opened(muts)) { dialog = true; if (!healed) armHeal(); }
      if (pending || idleH) return; // a check is queued already: it sees these changes too
      if (relevant(muts)) { follow = 2; schedule(false); } else skipped = true;
    });
    // No "style": animations write it every frame.
    const observe = () => mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'aria-expanded', 'aria-hidden'] });
    if (!hidden()) observe();
    schedule(false); // a few spaced checks even if nothing changes (a dialog still fading in)
    const nudge = setInterval(() => { if (skipped && !done) { skipped = false; schedule(false); } }, NUDGE);
    // A route change: the new screen often renders a moment later, so a few spaced checks follow the first one.
    const onNav = () => { follow = 3; schedule(true); };
    addEventListener('hashchange', onNav);
    addEventListener('popstate', onNav);
    // The end of an animation or transition on something that could be (or hold) the control: one more check.
    const onAnim = e => {
      if (done || pending || idleH || hidden() || !alive(me, at)) return;
      const t = targetOf(e);
      if (!t || t.nodeType !== 1 || ours(t)) return;
      if (could && !could(t) && !(t.closest && t.closest(MODAL))) return;
      follow = 1;
      schedule(false);
    };
    addEventListener('animationend', onAnim, true);
    addEventListener('transitionend', onAnim, true);

    // Still missing on the right page after the free search and the re-locate: ask opts.more for the way
    // on from here (it replaces the rest of the guide). Spaced so a slow page gets a fair chance first.
    const armMore = () => {
      if (moreT || !me.opts.more || me.asked.has(at) || me.mores >= MAX_MORE) return;
      const ms = Math.max(0, (dialog ? MORE_DIALOG : MORE_AFTER) - (now() - since));
      moreT = visTimeout(() => {
        moreT = null;
        if (alive(me, at) && !(me.el && shown(me.el)) && samePage(step.target.path)) askMore(me, 'missing', at);
      }, ms);
    };
    // Self-healing only makes sense on the right page.
    const heal = async () => {
      healed = true;
      if (!alive(me, at) || !samePage(step.target.path)) return;
      if (step.action === 'look' && step.target.auto) return; // a guessed data area: nothing to re-locate or re-plan
      if (me.opts.onMissing && !me.healed.has(at)) {
        me.healed.add(at);
        let found = null;
        try { found = await me.opts.onMissing(step, at); } catch (e) { found = null; }
        if (found && alive(me, at)) { step.target = found; show(); return; }
      }
      if (alive(me, at) && !(me.el && shown(me.el))) armMore();
    };
    const armHeal = () => {
      if (healT) healT.clear();
      const ms = dialog ? Math.min(me.opts.missingDelay || 2500, DIALOG_MISSING) : me.opts.missingDelay || 2500;
      healT = !away ? visTimeout(heal, Math.max(0, ms - (now() - since))) : null;
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
      if (!me.asking) draw(null, step, { gaveUp: true });
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
        if (moreT) moreT.pause();
      } else {
        if (!done) observe();
        giveUp.resume();
        if (healT) healT.resume();
        if (moreT) moreT.resume();
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
      removeEventListener('animationend', onAnim, true);
      removeEventListener('transitionend', onAnim, true);
      if (poke) POKES.forEach(t => removeEventListener(t, poke, true));
      clearTimeout(pending);
      unidle(idleH);
      if (healT) healT.clear();
      if (moreT) moreT.clear();
      giveUp.clear();
    });
  }

  function throttle(fn, ms) {
    let t = 0;
    return () => { if (t) return; t = setTimeout(() => { t = 0; fn(); }, ms); };
  }

  const state = () => (run ? { index: run.index, total: run.steps.length, asking: !!run.asking, mores: run.mores } : null);

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

  // The current run's steps (or the last run's, after it ended), with what opts.more added: save these
  // as the completed guide. Copies; label-only targets made up for this run are not included.
  const steps = () => (run ? run.steps : lastSteps).map(st => ({ ...st, target: st.target && st.target.auto ? null : st.target || null }));

  S.guide = { start, stop, go: i => go(i), state, steps, findLocal };
  S.recorder = { start: recStart, stop: recStop, active: () => !!rec };
})(typeof window !== 'undefined' ? window : globalThis);
