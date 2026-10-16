/*! Scopos SDK · AI-гид внутри вашего продукта · built 2026-10-16 */
// ---- extension/core/scan.js
/*
 * Scopos page reader.
 *
 * scan()     -> the text map Claude reads, plus id -> element for this snapshot.
 * describe() -> a durable descriptor of one element (selectors + label + role),
 *               stored in steps and playbooks.
 * resolve()  -> finds the element for a descriptor again: exact selectors first,
 *               then the label text, so guides survive navigations and releases.
 *
 * Reading is done on demand only (a question, a step change), never on a timer.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});

  const CONTROL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', 'label[for]',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]', '[role=option]',
    '[role=checkbox]', '[role=radio]', '[role=switch]', '[role=combobox]', '[role=textbox]', '[role=treeitem]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const MAX_LINES = 260;
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // Browser extensions inject their own buttons into pages (assistants, password managers, grammar checkers).
  // They are not part of the product, so they stay out of the map and out of answers.
  const FOREIGN_ID = /^(claude|grammarly|gr-|lastpass|lp-|1p-|onepassword|com-1password|bitwarden|dashlane|honey|loom|dark-?reader|monica|merlin|sider|maxai)/i;
  function foreign(el) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if ((n.id && FOREIGN_ID.test(n.id)) || /^(grammarly|loom|monica|sider)-/i.test(n.tagName)) return true;
      if (n.parentElement === document.body || n.parentElement === document.documentElement) {
        const cs = getComputedStyle(n);
        if (cs.position === 'fixed' && +cs.zIndex >= 2147480000) return true;
      }
    }
    return false;
  }

  function isOurs(el) { return !!(el.closest && el.closest('[data-scopos-ui]')) || foreign(el); }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
  }

  function role(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'select') return 'select';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', range: 'slider', file: 'file' }[type] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return t === 'button' || t === 'summary' ? 'button' : t;
  }

  function name(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(n => n.textContent).join(' ');
      if (clean(t)) return clean(t);
    }
    const a = el.getAttribute('aria-label');
    if (clean(a)) return clean(a);
    if (el.labels && el.labels.length) {
      // A label that wraps its control also contains the control's own text (a select's options): leave that out.
      const t = clean([...el.labels].map(l => {
        const copy = l.cloneNode(true);
        copy.querySelectorAll('select,textarea,input,option,button').forEach(n => n.remove());
        return copy.textContent;
      }).join(' '));
      if (t) return t;
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const t = clean(el.getAttribute('placeholder') || (el.type === 'submit' || el.type === 'button' ? el.value : '') || el.getAttribute('title') || el.getAttribute('name'));
      if (t) return t;
    }
    if (tag === 'SELECT') { const t = clean(el.getAttribute('title') || el.getAttribute('name')); if (t) return t; }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return clean(el.getAttribute('data-placeholder') || el.getAttribute('title'));
    const text = clean(el.innerText || el.textContent);
    if (text) return text;
    const img = el.querySelector && el.querySelector('img[alt],svg[aria-label],svg title');
    if (img) return clean(img.getAttribute('alt') || img.getAttribute('aria-label') || img.textContent);
    return clean(el.getAttribute('title'));
  }

  function section(el) {
    const box = el.closest('[aria-label],[role=dialog],[role=navigation],nav,header,aside,main,form,section,[role=tabpanel]');
    if (!box) return '';
    const label = box.getAttribute('aria-label');
    if (label) return clean(label);
    const h = box.querySelector('h1,h2,h3,legend,[role=heading]');
    if (h) return clean(h.textContent);
    return { NAV: 'navigation', HEADER: 'header', ASIDE: 'sidebar', MAIN: 'main', FORM: 'form' }[box.tagName] || '';
  }

  function state(el) {
    const out = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.getAttribute('aria-expanded') === 'true') out.push('expanded');
    const cur = el.getAttribute('aria-current');
    if (el.getAttribute('aria-selected') === 'true' || (cur && cur !== 'false')) out.push('current');
    if ('checked' in el && (el.type === 'checkbox' || el.type === 'radio')) out.push(el.checked ? 'checked' : 'unchecked');
    // What the user typed never leaves the page: only whether the field is filled.
    if ((el.tagName === 'INPUT' && !/checkbox|radio|submit|button/.test(el.type)) || el.tagName === 'TEXTAREA') out.push(el.value ? 'filled' : 'empty');
    if (el.tagName === 'SELECT' && el.selectedOptions[0]) out.push(`selected "${cut(clean(el.selectedOptions[0].textContent), 30)}"`);
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) out.push('offscreen');
    return out.join(', ');
  }

  // Skip wrappers whose only job is to hold another control we already list.
  function redundant(el) {
    if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return false;
    return !!el.querySelector('a[href],button,input,select,textarea');
  }

  let snapshot = new Map();

  function scan() {
    const all = [...document.querySelectorAll(CONTROL)].filter(el => !isOurs(el) && !redundant(el) && visible(el));
    // Controls in the viewport first, then the rest, so a long page still fits.
    all.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const va = ra.bottom > 0 && ra.top < innerHeight ? 0 : 1, vb = rb.bottom > 0 && rb.top < innerHeight ? 0 : 1;
      return va - vb || ra.top - rb.top || ra.left - rb.left;
    });
    snapshot = new Map();
    const lines = [];
    for (const el of all) {
      if (lines.length >= MAX_LINES) break;
      const n = cut(name(el));
      if (!n && role(el) !== 'textbox') continue;
      const id = lines.length + 1;
      snapshot.set(id, el);
      const sec = section(el), st = state(el);
      lines.push(`[${id}] ${role(el)} "${n}"${sec ? ' · ' + cut(sec, 40) : ''}${st ? ' · ' + st : ''}`);
    }
    const headings = [...document.querySelectorAll('h1,h2,h3')].filter(h => !isOurs(h) && visible(h)).slice(0, 12).map(h => cut(clean(h.textContent), 60));
    return { title: document.title, url: location.href, headings, lines };
  }

  const byId = id => snapshot.get(id) || null;

  /**
   * The whole control tree of the current view (or of one container, such as an open dialog),
   * in document order and not limited to the viewport. Used by the explorer to map the product once.
   */
  function inventory(container) {
    const scope = container || document;
    const out = [];
    for (const el of scope.querySelectorAll(CONTROL)) {
      if (out.length >= 400) break;
      if (isOurs(el) || redundant(el) || !visible(el)) continue;
      if (!container && el.closest('dialog[open],[role=dialog],[aria-modal=true]')) continue;
      const n = cut(name(el));
      if (!n && role(el) !== 'textbox') continue;
      const st = state(el).replace(/(^|, )offscreen/, '').replace(/^, /, '');
      const options = el.tagName === 'SELECT' ? [...el.options].slice(0, 15).map(o => cut(clean(o.textContent), 40)).filter(Boolean) : undefined;
      out.push({ el, role: role(el), name: n, section: cut(section(el), 40), state: st, options });
    }
    return out;
  }

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id && !/\d{3,}|[:.]/.test(n.id)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let part = n.tagName.toLowerCase();
      const sibs = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function describe(el) {
    if (!el) return null;
    const sel = [];
    const attr = (a) => el.getAttribute(a);
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) if (attr(a)) sel.push(`[${a}="${CSS.escape(attr(a))}"]`);
    if (el.id && !/\d{3,}|[:.]/.test(el.id)) sel.push('#' + CSS.escape(el.id));
    if (attr('name')) sel.push(`${el.tagName.toLowerCase()}[name="${CSS.escape(attr('name'))}"]`);
    if (attr('aria-label')) sel.push(`${el.tagName.toLowerCase()}[aria-label="${CSS.escape(attr('aria-label'))}"]`);
    sel.push(cssPath(el));
    return { sel, text: cut(name(el), 80), role: role(el), path: location.pathname + location.hash };
  }

  const norm = s => clean(s).toLowerCase().replace(/[«»"'“”.,:!?()]/g, '');

  /** Finds the element a descriptor (or a bare label) points at on the current page. */
  function resolve(d) {
    if (!d) return null;
    for (const s of d.sel || []) {
      try {
        const hits = [...document.querySelectorAll(s)].filter(el => !isOurs(el) && visible(el));
        if (hits.length === 1 && (!d.text || !name(hits[0]) || norm(name(hits[0])).includes(norm(d.text).slice(0, 12)))) return hits[0];
      } catch (e) { /* selector from another page version */ }
    }
    const want = norm(d.text);
    if (!want) return null;
    let best = null, bestScore = 0;
    for (const el of document.querySelectorAll(CONTROL)) {
      if (isOurs(el) || redundant(el) || !visible(el)) continue;
      const have = norm(name(el));
      if (!have) continue;
      let score = have === want ? 3 : have.startsWith(want) || want.startsWith(have) ? 2 : have.includes(want) || want.includes(have) ? 1 : 0;
      if (score && d.role && role(el) === d.role) score += 0.5;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return bestScore >= 1 ? best : null;
  }

  S.scan = scan;
  S.inventory = inventory;
  S.byId = byId;
  S.describe = describe;
  S.resolve = resolve;
  S.labelOf = name;
})(typeof window !== 'undefined' ? window : globalThis);

// ---- extension/core/pointer.js
/*
 * Scopos pointer: the on-page layer. A soft ring flies to the control, a frame
 * settles around it, and a small card says what to do.
 *
 * Everything lives in one closed shadow root, so the host page's CSS can't reach
 * it and ours can't leak out. Motion uses transform and opacity only (the GPU
 * composites them without repainting the page), positions are recomputed in one
 * requestAnimationFrame per scroll/resize burst, and nothing runs while hidden.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});

  const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
  --paper: #fbfaf7; --paper-2: #f3efe8; --ink: #2b2825; --ink-2: #6d675f; --ink-3: #a39c92;
  --rule: #ebe6de; --accent: #c47f56; --accent-soft: rgba(196,127,86,.16);
  --shadow: 0 18px 48px rgba(60,45,30,.16), 0 2px 6px rgba(60,45,30,.06);
  font: 14px/1.45 "Onest", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
@media (prefers-color-scheme: dark) { .layer {
  --paper: #23201d; --paper-2: #2b2723; --ink: #efe9e1; --ink-2: #bdb4a9; --ink-3: #8b8278;
  --rule: #38332d; --accent: #e0a07a; --accent-soft: rgba(224,160,122,.18); --shadow: 0 18px 48px rgba(0,0,0,.45); } }

/* The cursor flies in an arc: X and Y ride two nested layers with different easing curves. */
.cursor { position: fixed; left: 0; top: 0; width: 0; height: 0; will-change: transform;
  transform: translate3d(var(--x, 0), 0, 0); transition: transform .62s cubic-bezier(.33,.75,.25,1); }
.cy { will-change: transform; transform: translate3d(0, var(--y, 0), 0); transition: transform .62s cubic-bezier(.6,.05,.3,1); }
.cursor.snap, .cursor.snap .cy { transition: none; }
.ring { position: absolute; left: -13px; top: -13px; width: 26px; height: 26px; border-radius: 50%;
  border: 2.5px solid var(--accent); background: var(--accent-soft); opacity: 0; transform: scale(.6); will-change: transform, opacity;
  transition: opacity .25s ease, transform .35s cubic-bezier(.3,1.6,.5,1); }
.ring::before { content: ""; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%; background: var(--accent); }
.ring::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid var(--accent); opacity: 0; will-change: transform, opacity; }
.cursor.on .ring { opacity: 1; transform: scale(1); }
.cursor.on.flying .ring { transform: scale(.82); }
.cursor.on.landed .ring::after { animation: pulse 1.8s ease-out infinite; }
.lite .cursor.on.landed .ring::after { animation-iteration-count: 2; }
@keyframes pulse { 0% { transform: scale(1); opacity: .5; } 100% { transform: scale(2.1); opacity: 0; } }

.frame { position: fixed; left: 0; top: 0; border-radius: 12px; border: 2px solid var(--accent);
  box-shadow: 0 0 0 6px var(--accent-soft); opacity: 0; will-change: transform, opacity;
  transform: translate3d(var(--fx, 0), var(--fy, 0), 0) scale(.97); transition: opacity .22s ease, transform .3s cubic-bezier(.22,.9,.24,1); }
.frame.on { opacity: 1; transform: translate3d(var(--fx, 0), var(--fy, 0), 0) scale(1); }

.card { position: fixed; left: 0; top: 0; width: min(320px, calc(100vw - 24px)); pointer-events: auto;
  background: var(--paper); border: 1px solid var(--rule); border-radius: 16px; box-shadow: var(--shadow);
  padding: 14px 16px 12px; opacity: 0; will-change: transform, opacity;
  transform: translate3d(var(--cx, 0), calc(var(--cy, 0px) + 6px), 0);
  transition: opacity .22s ease, transform .38s cubic-bezier(.22,.9,.24,1); }
.card.on { opacity: 1; transform: translate3d(var(--cx, 0), var(--cy, 0), 0); }
.top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.mark { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--accent); display: grid; place-items: center; flex: none; }
.mark::after { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--accent); }
.count { font-size: 12px; color: var(--ink-3); letter-spacing: .02em; font-variant-numeric: tabular-nums; }
.x { margin-left: auto; width: 26px; height: 26px; border-radius: 8px; border: 0; background: transparent; color: var(--ink-3); cursor: pointer; font: inherit; font-size: 16px; line-height: 1; }
.x:hover { background: var(--paper-2); color: var(--ink); }
.text { font-size: 15px; color: var(--ink); text-wrap: pretty; }
.value { margin-top: 8px; display: inline-flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--ink-2); background: var(--paper-2); border-radius: 8px; padding: 4px 8px; max-width: 100%; }
.value b { font-weight: 500; color: var(--ink); overflow-wrap: anywhere; }
.wait { margin-top: 8px; font-size: 12.5px; color: var(--ink-3); display: flex; align-items: center; gap: 8px; }
.dots { display: inline-flex; gap: 3px; }
.dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--ink-3); animation: blink 1.2s ease-in-out infinite; }
.dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
@keyframes blink { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
.bar { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.btn { height: 32px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--rule); background: var(--paper); color: var(--ink); font: inherit; font-size: 13.5px; cursor: pointer; }
.btn:hover { background: var(--paper-2); }
.btn.main { background: var(--ink); border-color: var(--ink); color: var(--paper); }
.btn.main:hover { opacity: .9; }
.btn:focus-visible, .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hint { font-size: 11.5px; color: var(--ink-3); margin-top: 8px; }

.rec { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); pointer-events: auto; display: flex; align-items: center; gap: 10px;
  background: var(--paper); border: 1px solid var(--rule); border-radius: 999px; box-shadow: var(--shadow); padding: 6px 8px 6px 14px; font-size: 13px; }
.rec .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: blink 1.4s ease-in-out infinite; }
.lite .rec .dot, .lite .dots i { animation-iteration-count: 3; }
@media (prefers-reduced-motion: reduce) { .cursor, .cy, .frame, .card { transition: opacity .15s linear; } .ring::after, .dots i, .rec .dot { animation: none !important; } }
`;

  let host, shadow, layer, cursor, frame, card, rec;
  let target = null, ro = null, raf = 0, landedTimer = 0, current = null;

  function lite() {
    try { return (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4; } catch (e) { return false; }
  }

  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement('scopos-layer');
    host.setAttribute('data-scopos-ui', '');
    // A manual popover lives in the browser's top layer, so the pointer stays above the site's modal dialogs.
    host.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483646;color-scheme:normal';
    if ('popover' in HTMLElement.prototype) host.setAttribute('popover', 'manual');
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS_TEXT}</style><div class="layer${lite() ? ' lite' : ''}"><div class="frame"></div><div class="cursor"><div class="cy"><div class="ring"></div></div></div><div class="card" role="dialog" aria-live="polite"></div></div>`;
    layer = shadow.querySelector('.layer');
    cursor = shadow.querySelector('.cursor');
    frame = shadow.querySelector('.frame');
    card = shadow.querySelector('.card');
    // Park the cursor in the lower right corner until the first flight.
    cursor.style.setProperty('--x', innerWidth - 40 + 'px');
    cursor.querySelector('.cy').style.setProperty('--y', innerHeight - 40 + 'px');
    (document.body || document.documentElement).appendChild(host);
    addEventListener('scroll', schedule, { passive: true, capture: true });
    addEventListener('resize', schedule, { passive: true });
    card.addEventListener('click', onCardClick);
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function onCardClick(e) {
    const b = e.target.closest('[data-do]');
    if (!b || !current) return;
    const fn = { next: current.onNext, back: current.onBack, close: current.onClose }[b.dataset.do];
    if (fn) fn();
  }

  function renderCard(o) {
    if (o.explore) {
      card.innerHTML = `
      <div class="top"><span class="mark"></span><span class="count">Scopos изучает продукт · действие ${o.step}</span></div>
      <div class="text">${esc(o.instruction)}</div>
      <div class="bar"><button class="btn" data-do="close">Остановить</button></div>
      <div class="hint">Нажимаю только то, что открывает экраны и окна. Ничего не сохраняю и не отправляю.</div>`;
      return;
    }
    card.innerHTML = `
      <div class="top"><span class="mark"></span><span class="count">${o.total > 1 ? `Шаг ${o.step} из ${o.total}` : 'Scopos'}</span><button class="x" data-do="close" aria-label="Закрыть подсказку">×</button></div>
      <div class="text">${esc(o.instruction)}</div>
      ${o.value ? `<div class="value">Введите: <b>${esc(o.value)}</b></div>` : ''}
      ${o.waiting ? `<div class="wait"><span class="dots"><i></i><i></i><i></i></span>Ищу этот элемент на странице</div>` : ''}
      <div class="bar">${o.step > 1 ? '<button class="btn" data-do="back">Назад</button>' : ''}<button class="btn main" data-do="next">${o.step >= o.total ? 'Готово' : 'Далее'}</button></div>
      ${o.autoAdvance && !o.waiting ? '<div class="hint">Сделайте это действие, и я покажу следующий шаг</div>' : ''}`;
  }

  /** Shows a step. el may be null: then only the card is shown, parked in the corner. */
  function raise() {
    if (!host.hasAttribute('popover')) return;
    try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch (e) { /* not connected yet */ }
  }

  function point(el, o) {
    mount();
    raise();
    current = o;
    renderCard(o);
    if (ro) { ro.disconnect(); ro = null; }
    target = el && el.isConnected ? el : null;
    frame.classList.remove('on');
    cursor.classList.remove('landed');
    clearTimeout(landedTimer);
    if (target) {
      const r = target.getBoundingClientRect();
      if (r.top < 60 || r.bottom > innerHeight - 60) target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches || lite() ? 'auto' : 'smooth' });
      if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(schedule); ro.observe(target); }
    }
    place(true);
    cursor.classList.toggle('on', !!target);
    cursor.classList.toggle('flying', !!target);
    card.classList.add('on');
    if (target) landedTimer = setTimeout(() => { cursor.classList.remove('flying'); cursor.classList.add('landed'); frame.classList.add('on'); }, 600);
  }

  function schedule() {
    if (!current || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; place(false); });
  }

  function place(flying) {
    const vw = innerWidth, vh = innerHeight, cw = card.offsetWidth || 320, ch = card.offsetHeight || 140;
    if (!target || !target.isConnected) {
      card.style.setProperty('--cx', vw - cw - 16 + 'px');
      card.style.setProperty('--cy', vh - ch - 16 + 'px');
      return;
    }
    const r = target.getBoundingClientRect(), pad = 6;
    // The ring rests on the control's top-right corner, so it marks the control without covering its label.
    const px = r.right - 2, py = r.top + 2;
    if (!flying) cursor.classList.add('snap');
    cursor.style.setProperty('--x', px + 'px');
    cursor.querySelector('.cy').style.setProperty('--y', py + 'px');
    if (!flying) requestAnimationFrame(() => cursor.classList.remove('snap'));
    frame.style.width = r.width + pad * 2 + 'px';
    frame.style.height = r.height + pad * 2 + 'px';
    frame.style.setProperty('--fx', r.left - pad + 'px');
    frame.style.setProperty('--fy', r.top - pad + 'px');
    // Card below the control when it fits, otherwise above, clamped to the viewport.
    let cy = r.bottom + 14;
    if (cy + ch > vh - 12) cy = r.top - ch - 14;
    if (cy < 12) cy = Math.min(vh - ch - 12, Math.max(12, r.bottom + 14));
    const cx = Math.max(12, Math.min(vw - cw - 12, r.left));
    card.style.setProperty('--cx', cx + 'px');
    card.style.setProperty('--cy', cy + 'px');
  }

  function hide() {
    current = null; target = null;
    if (ro) { ro.disconnect(); ro = null; }
    clearTimeout(landedTimer);
    if (!layer) return;
    cursor.classList.remove('on', 'landed', 'flying');
    frame.classList.remove('on');
    card.classList.remove('on');
  }

  function recording(on, { onStop } = {}) {
    mount();
    raise();
    if (rec) { rec.remove(); rec = null; }
    if (!on) return;
    rec = document.createElement('div');
    rec.className = 'rec';
    rec.innerHTML = '<span class="dot"></span><span>Scopos записывает шаги</span><button class="btn" style="height:28px">Стоп</button>';
    rec.querySelector('button').onclick = () => onStop && onStop();
    layer.appendChild(rec);
  }

  S.pointer = { point, hide, recording, isOurs: el => !!(el && el.closest && el.closest('scopos-layer')) };
})(typeof window !== 'undefined' ? window : globalThis);

// ---- extension/core/guide.js
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

// ---- extension/core/explore.js
/*
 * Scopos explorer: learns a product once, the way a new employee would, by
 * walking through it. It visits every screen it can reach, records the full
 * control tree of each one, and presses the controls that only open things
 * (tabs, menus, "New …" buttons that show a form or a dialog) to see where they
 * lead. The result is a product map: screens, dialogs and the controls that
 * connect them. Guides are then written from the map, so answering a question
 * later needs no page reading and no guessing about other pages.
 *
 * Safety: it never types, never submits a form, never presses anything that
 * sounds like it changes data (delete, send, pay, save, confirm, log out …),
 * never leaves the site, and closes every dialog it opens. Use a test account
 * all the same, like you would for a new hire.
 *
 * The walk is a small state machine saved after every step through opts.store,
 * so a full page load in the middle of it simply resumes on the next page.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});

  const DANGER = /удал|стер|delete|remove|erase|отправ|send|submit|оплат|pay|купить|buy|purchase|подтверд|confirm|сохран|save|apply|применить|выйти|выход|log ?out|sign ?out|архив|archive|отключ|disable|deactivat|сброс|reset|очист|clear|импорт|import|экспорт|export|скача|download|опубликов|publish|отозв|revoke|заблок|block|отмен[аи]ть подписк|cancel (plan|subscription)|terminate|уволить|закрыть сч/i;
  const CLICKABLE_ROLES = /^(button|tab|menuitem|treeitem|summary|link)$/;
  const LIMITS = { views: 40, probes: 160, perView: 30, ms: 5 * 60 * 1000 };

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const lite = (() => { try { return (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4; } catch (e) { return false; } })();
  // "/", "/#" and "/#/" are the same screen in hash-routed apps.
  const pageKey = (u = location.href) => { const x = new URL(u, location.href); return x.pathname + (x.hash && x.hash !== '#' && x.hash !== '#/' ? x.hash : ''); };

  // Resolves when the DOM has been quiet for `quiet` ms (or after `max`).
  function settle(quiet = 280, max = 1800) {
    return new Promise(resolve => {
      let t = setTimeout(done, quiet);
      const hard = setTimeout(done, max);
      const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quiet); });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      function done() { mo.disconnect(); clearTimeout(t); clearTimeout(hard); resolve(); }
    });
  }

  function openDialogs() {
    return [...document.querySelectorAll('dialog[open],[role=dialog],[aria-modal=true]')].filter(d => !S.pointer.isOurs(d) && d.getBoundingClientRect().width > 0);
  }
  const dialogTitle = d => {
    const h = d.querySelector('h1,h2,h3,[role=heading],legend');
    return (d.getAttribute('aria-label') || (h && h.textContent) || 'диалог').replace(/\s+/g, ' ').trim().slice(0, 60);
  };

  async function closeDialog(d) {
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(120);
    if (!d.isConnected || !openDialogs().includes(d)) return;
    if (d.tagName === 'DIALOG' && d.open) { d.close(); await wait(60); return; }
    const x = [...d.querySelectorAll('button,[role=button]')].find(b => /^(×|✕|x)$|закры|отмен|close|cancel|dismiss/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
    if (x) { x.click(); await wait(150); }
  }

  function linkTarget(el) {
    if (el.tagName !== 'A' || !el.getAttribute('href')) return null;
    if (el.hasAttribute('download')) return null;
    let u;
    try { u = new URL(el.getAttribute('href'), location.href); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol) || u.origin !== location.origin) return null;
    return u.href;
  }

  // Can the explorer press this control to see what it opens?
  function pressable(c) {
    if (!CLICKABLE_ROLES.test(c.role) || DANGER.test(c.name) || /disabled/.test(c.state)) return false;
    const el = c.el;
    if (el.tagName === 'A') return false; // links are followed by address, never clicked
    // A <button> reports type "submit" by default; it only submits something inside a form.
    if ((el.type === 'submit' || el.type === 'reset') && (el.form || el.closest('form'))) return false;
    if (el.tagName === 'INPUT' && /submit|reset|image/.test(el.type)) return false;
    return true;
  }

  function captureView(v, container) {
    const list = S.inventory(container);
    v.title = container ? dialogTitle(container) : (document.querySelector('h1') || {}).textContent || document.title;
    v.title = String(v.title).replace(/\s+/g, ' ').trim().slice(0, 80);
    v.headings = [...(container || document).querySelectorAll('h1,h2,h3')].filter(h => !S.pointer.isOurs(h)).slice(0, 8).map(h => h.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
    v.controls = list.map((c, i) => {
      const href = linkTarget(c.el);
      return {
        ref: `${v.id}.${i + 1}`, role: c.role, name: c.name, section: c.section, state: c.state, options: c.options,
        d: S.describe(c.el),
        href: href || undefined,
        probe: href ? 'link' : container ? 'skip' : pressable(c) ? undefined : 'skip',
      };
    });
    v.captured = true;
  }

  let st = null, opts = null, stopping = false;

  function addView(key, url, kind = 'page', parent) {
    if (st.views[key]) return st.views[key];
    if (Object.keys(st.views).length >= LIMITS.views) return null;
    const v = { id: 'V' + (Object.keys(st.views).length + 1), key, url, kind, parent };
    st.views[key] = v;
    if (kind === 'page') st.queue.push(key);
    return v;
  }

  const save = () => opts.store.save(st);
  const progress = (label) => {
    const views = Object.values(st.views).filter(v => v.captured).length;
    if (opts.onProgress) opts.onProgress({ views, probes: st.probes, label });
  };

  async function goTo(url) {
    if (pageKey() === pageKey(url)) return true;
    const a = new URL(url, location.href), b = new URL(location.href);
    await save();
    if (a.origin + a.pathname + a.search === b.origin + b.pathname + b.search) {
      location.hash = a.hash; // same document: the SPA re-renders in place
      await settle();
      return true;
    }
    location.href = url; // full load: the explorer resumes on the next page
    return false;
  }

  function flash(el, label) {
    S.pointer.point(el, { step: st.probes + 1, total: 0, instruction: label, explore: true, onClose: () => { stopping = true; } });
  }

  async function loop() {
    while (!stopping) {
      if (st.probes >= LIMITS.probes || Date.now() - st.startedAt > LIMITS.ms) break;
      if (!st.cur) {
        const key = st.queue.shift();
        if (!key) break;
        st.cur = { key };
      }
      const v = st.views[st.cur.key];
      if (!(await goTo(v.url))) return; // page is reloading
      if (pageKey() !== v.key) { st.cur = null; continue; } // redirected elsewhere
      if (!v.captured) {
        await settle();
        captureView(v);
        for (const c of v.controls) if (c.href) { const t = addView(pageKey(c.href), c.href); c.to = t ? t.key : pageKey(c.href); }
        progress(`Экран «${v.title}»`);
        await save();
      }
      const next = v.controls.find(c => c.probe === undefined);
      if (!next || v.controls.filter(c => c.probe && c.probe !== 'skip' && c.probe !== 'link').length >= LIMITS.perView) { st.cur = null; await save(); continue; }
      const r = await probe(v, next);
      st.probes++;
      await save();
      if (r === 'reload') return;
      progress(`Нажал «${next.name}»`);
    }
    await finish(stopping ? 'stopped' : 'done');
  }

  async function probe(v, c) {
    const el = S.resolve(c.d);
    if (!el) { c.probe = 'missing'; return; }
    flash(el, `Изучаю: «${c.name}»`);
    await wait(lite ? 200 : 520); // let the ring land so the walk is watchable
    const beforeKey = pageKey(), beforeDialogs = openDialogs();
    const expandedBefore = el.getAttribute('aria-expanded');
    const before = new Set(S.inventory().map(x => x.el));
    c.probe = 'pressed';
    st.pending = { view: v.key, ref: c.ref };
    await save(); // if the click loads another page, resume() records where it led
    el.click();
    await settle();
    st.pending = null;
    const afterKey = pageKey();
    if (afterKey !== beforeKey) {
      const t = addView(afterKey, location.href);
      c.to = afterKey; c.kind = 'page';
      if (t && !t.captured) { /* captured when its turn comes */ }
      await goTo(v.url);
      return;
    }
    const dlg = openDialogs().find(d => !beforeDialogs.includes(d));
    if (dlg) {
      const key = `${v.key} › ${dialogTitle(dlg)}`;
      const dv = addView(key, v.url, 'dialog', v.key);
      if (dv && !dv.captured) { captureView(dv, dlg); dv.opener = c.ref; }
      c.to = key; c.kind = 'dialog';
      await closeDialog(dlg);
      await settle(150, 800);
      return;
    }
    // A menu, a disclosure or an inline form: controls that appeared after the click.
    const appeared = S.inventory().filter(x => !before.has(x.el));
    if (appeared.length || (expandedBefore === 'false' && el.getAttribute('aria-expanded') === 'true')) {
      const key = `${v.key} › ${c.name}`;
      const mv = addView(key, v.url, 'panel', v.key);
      if (mv && !mv.captured) {
        mv.title = c.name; mv.headings = []; mv.opener = c.ref; mv.captured = true;
        mv.controls = appeared.map((x, i) => ({ ref: `${mv.id}.${i + 1}`, role: x.role, name: x.name, section: x.section, state: x.state, options: x.options, d: S.describe(x.el), probe: 'skip' }));
      }
      c.to = key; c.kind = 'panel';
      // Put the screen back the way it was for the next probe: collapse, Escape, or as a last resort reload.
      if (el.isConnected && el.getAttribute('aria-expanded') === 'true') el.click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(150, 900);
      if (appeared.some(x => x.el.isConnected && x.el.getBoundingClientRect().width > 0)) { st.probes++; await save(); location.reload(); return 'reload'; }
      return;
    }
    c.probe = 'nothing';
  }

  async function finish(status) {
    st.status = status;
    st.finishedAt = Date.now();
    await save();
    S.pointer.hide();
    if (opts.onDone) opts.onDone(toMap(st));
  }

  /** The stored map: what guides and answers are written from. */
  function toMap(s) {
    const views = Object.values(s.views).filter(v => v.captured);
    return {
      origin: s.origin, learnedAt: new Date().toISOString(), status: s.status, probes: s.probes,
      views: views.map(v => ({ id: v.id, key: v.key, url: v.url, kind: v.kind, parent: v.parent ? s.views[v.parent] && s.views[v.parent].id : undefined, opener: v.opener, title: v.title, headings: v.headings,
        controls: v.controls.map(c => ({ ref: c.ref, role: c.role, name: c.name, section: c.section, state: c.state, options: c.options, d: c.d, to: c.to && s.views[c.to] ? s.views[c.to].id : undefined })) })),
    };
  }

  async function start(o) {
    opts = o; stopping = false;
    st = { status: 'running', origin: location.origin, startedAt: Date.now(), views: {}, queue: [], cur: null, probes: 0 };
    addView(pageKey(), location.href);
    await save();
    progress('Начинаю');
    return loop();
  }

  async function resume(o) {
    opts = o; stopping = false;
    st = await o.store.load();
    if (!st || st.status !== 'running') return false;
    await settle();
    if (st.pending) {
      // The last press loaded a new document: remember where it led.
      const v = st.views[st.pending.view], c = v && v.controls.find(x => x.ref === st.pending.ref);
      if (c && pageKey() !== v.key) { addView(pageKey(), location.href); c.to = pageKey(); c.kind = 'page'; }
      st.pending = null;
    }
    loop();
    return true;
  }

  S.explore = { start, resume, stop: () => { stopping = true; }, toMap, running: () => !!st && st.status === 'running' && !stopping };
})(typeof window !== 'undefined' ? window : globalThis);

// ---- sdk/widget.js
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
  let chat = []; // the last turns with Claude, for follow-up questions
  let state = null; // { question, answer, steps, index, source, status, error }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const save = () => { try { state ? sessionStorage.setItem(KEY, JSON.stringify(state)) : sessionStorage.removeItem(KEY); } catch (e) {} };
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };

  if (cfg.playbooksUrl) fetch(cfg.playbooksUrl).then(r => (r.ok ? r.json() : [])).then(list => { if (Array.isArray(list)) playbooks = list; }).catch(() => {});

  // Guides the explorer and Claude wrote for this product (see learn mode below).
  let learned = null; // { summary, guides, views, learnedAt }
  const addLearned = k => {
    learned = k && k.guides && k.guides.length ? k : null;
    if (!learned) return;
    const ids = new Set(learned.guides.map(g => g.id));
    playbooks = [...learned.guides, ...playbooks.filter(p => !ids.has(p.id))];
  };
  fetch(cfg.endpoint + '/knowledge').then(r => (r.ok ? r.json() : null)).then(k => { addLearned(k); render(); }).catch(() => {});

  // ---------- learn mode: the explorer walks the product once (open the page with ?scopos-learn=1) ----------
  const LEARN_KEY = 'scopos:explore';
  const exploreStore = {
    load: async () => { try { return JSON.parse(sessionStorage.getItem(LEARN_KEY) || 'null'); } catch (e) { return null; } },
    save: async st => { try { sessionStorage.setItem(LEARN_KEY, JSON.stringify(st)); } catch (e) {} },
  };
  let learning = null; // { views, probes, label } while exploring, { status:'writing'|'done'|'error', ... } after
  const learnOpts = {
    store: exploreStore,
    onProgress: p => { learning = { status: 'exploring', ...p }; render(); },
    onDone: async map => {
      learning = { status: 'writing', views: map.views.length, probes: map.probes };
      setOpen(true); render();
      try {
        const res = await fetch(cfg.endpoint + '/learn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ map, product: cfg.product }) });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'Не получилось');
        addLearned(out);
        learning = { status: 'done', views: map.views.length, probes: map.probes, guides: out.guides.length, summary: out.summary };
      } catch (e) {
        learning = { status: 'error', error: e.message };
      }
      try { sessionStorage.removeItem(LEARN_KEY); } catch (e) {}
      render();
    },
  };
  function startLearning() {
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
    if (launch) launch.innerHTML = `<span class="ring"></span>${learning && learning.status === 'exploring' ? `Изучаю · ${learning.views} экр.` : learning && learning.status === 'writing' ? 'Пишу гайды…' : state && state.status === 'running' && state.steps.length ? `Шаг ${Math.min((state.index || 0) + 1, state.steps.length)} из ${state.steps.length}` : esc(cfg.label)}`;
    if (learning && learning.status !== 'exploring') {
      body.innerHTML = learning.status === 'writing'
        ? `<div class="think"><span class="spin"></span>Изучил ${learning.views} экранов и окон. Пишу готовые гайды…</div>`
        : learning.status === 'error' ? `<div class="err">${esc(learning.error)}</div>`
        : `<p class="a">Изучил продукт: ${learning.views} экранов и окон, ${learning.probes} проверенных кнопок.</p><p class="hi">${esc(learning.summary || '')}</p>
           <div class="q">Готовые гайды · ${learning.guides}</div><div class="chips">${playbooks.filter(p => p.learned).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>`;
      return;
    }
    if (!state) {
      body.innerHTML = `<p class="hi">Спросите, как что-то сделать. Я покажу каждый шаг прямо здесь, на странице.</p>
        ${playbooks.length ? `${learned ? `<div class="q">Готовые гайды · изучено ${learned.views} экранов</div>` : ''}<div class="chips">${playbooks.slice(0, learned ? 8 : 4).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : ''}`;
      return;
    }
    if (state.status === 'thinking') { body.innerHTML = `<div class="q">${esc(state.question)}</div><div class="think"><span class="spin"></span>Читаю страницу и продумываю шаги</div>`; return; }
    if (state.status === 'error') { body.innerHTML = `<div class="q">${esc(state.question)}</div><div class="err">${esc(state.error)}</div>`; return; }
    const idx = state.index || 0, done = state.status === 'done';
    body.innerHTML = `<div class="q">${esc(state.question)}</div>${state.answer ? `<p class="a">${esc(state.answer)}</p>` : ''}
      ${state.steps.length ? `<ol>${state.steps.map((s, i) => `<li class="${i < idx || done ? 'done' : i === idx ? 'cur' : ''}"><i>${i + 1}</i><span>${esc(s.instruction)}</span></li>`).join('')}</ol>` : ''}
      <div class="meta">${state.source === 'playbook' ? 'Готовый гайд · мгновенно' : state.source === 'map' ? 'Claude · по карте продукта' : 'Ответ Claude'}${done ? ' · готово' : ''}</div>`;
  }

  function setOpen(on) { w.classList.toggle('open', on); if (on) setTimeout(() => input.focus(), 50); }

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-do],[data-pb]');
    if (!b) return;
    if (b.dataset.pb) { learning = null; const pb = playbooks.find(p => p.id === b.dataset.pb); if (pb) runSteps(pb.name, `Сценарий «${pb.name}»`, pb.steps, 'playbook'); return; }
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
    learning = null;
    const pb = matchPlaybook(question);
    if (pb) return runSteps(question, `Сценарий «${pb.name}»`, pb.steps, 'playbook');
    state = { question, status: 'thinking', steps: [] }; render();
    try {
      const page = S.scan();
      const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, page, history: chat, product: cfg.product }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Сервер ответил ошибкой ${res.status}`);
      chat = [...chat, { role: 'user', content: question }, { role: 'assistant', content: JSON.stringify(out) }].slice(-6);
      const steps = out.ready ? out.steps : toSteps(out.steps);
      runSteps(question, out.answer, steps, out.ready ? 'map' : 'claude');
    } catch (e) {
      state = { question, status: 'error', error: e.message || 'Не получилось ответить', steps: [] }; render();
    }
  }

  // Claude's ids point at this page's controls; steps for later pages carry only the label it expects.
  const toSteps = list => list.map(s => {
    const el = s.element_id != null ? S.byId(s.element_id) : null;
    return { instruction: s.instruction, action: s.action, value: s.value, target: el ? S.describe(el) : s.element_text ? { sel: [], text: s.element_text, role: null } : null };
  });

  // The user reached a page where the expected control isn't: plan the rest from what is on screen now.
  const replanned = new Set();
  async function replan(index) {
    if (!state || replanned.has(index)) return;
    replanned.add(index);
    const progress = state.steps.slice(0, index).map(s => s.instruction);
    try {
      const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: state.question, page: S.scan(), history: chat, progress, product: cfg.product }) });
      const out = res.ok ? await res.json() : null;
      if (!out || !state || state.index !== index) return;
      const rest = toSteps(out.steps || []);
      state.steps = state.steps.slice(0, index).concat(rest);
      if (!rest.length) { state.status = 'done'; state.index = index; S.guide.stop(false); save(); render(); return; }
      save(); render();
      start(index);
    } catch (e) { /* keep waiting; the card still shows the instruction */ }
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
      missingDelay: state.source === 'claude' ? 1200 : 2500,
      onMissing: async (step, i) => {
        if (state.source === 'claude') { replan(i); return null; }
        // Re-find a moved control through the vendor's server (one small request).
        const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locate: { instruction: step.instruction, oldText: step.target && step.target.text }, page: S.scan() }) }).catch(() => null);
        const out = res && res.ok ? await res.json() : null;
        const el = out && out.element_id != null ? S.byId(out.element_id) : null;
        return el ? S.describe(el) : null;
      },
    });
  }

  async function boot() {
    (document.body || document.documentElement).appendChild(host);
    state = load();
    render();
    if (await S.explore.resume(learnOpts)) { learning = { status: 'exploring', views: 0, probes: 0 }; render(); return; }
    if (new URLSearchParams(location.search).has('scopos-learn')) {
      const u = new URL(location.href); u.searchParams.delete('scopos-learn');
      window.history.replaceState(null, '', u.href);
      return startLearning();
    }
    if (state && state.status === 'running' && state.index < state.steps.length) start(state.index);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  S.widget = { open: () => setOpen(true), ask, learn: startLearning, cfg };
})();
