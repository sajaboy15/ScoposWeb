/*
 * Scopos pointer: the on-page layer. A soft ring flies to the control, a frame
 * settles around it, and a small card says what to do.
 *
 * Everything lives in one closed shadow root inside a top-layer popover, so the
 * host page's CSS can't reach it and ours can't leak out.
 *
 * Keeping the frame glued to the control (research/02):
 * - updates are event driven: scroll/resize on every scroll ancestor (through
 *   shadow roots and same-origin iframes), visualViewport, a ResizeObserver,
 *   and an IntersectionObserver that fires when the control moves with no event
 *   at all (content inserted above, an accordion opening);
 * - after any trigger a bounded per-frame "settle" loop re-reads the rect and
 *   stops by itself once the rect has been still for 3 frames;
 * - each frame does all reads first, then all writes; moves are transform-only
 *   and rounded to device pixels; nothing runs while the tab is hidden;
 * - the frame is drawn on the visible part of the control (clipped by every
 *   overflow ancestor and the viewport) and hidden when that part is gone or
 *   covered by something else.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});
  if (S.pointer) return; // injected twice (the worker re-injects when a tab doesn't answer): keep the first
  const DOC = root.document;

  const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; direction: ltr;
  --paper: #fbfaf7; --paper-2: #f3efe8; --ink: #2b2825; --ink-2: #6d675f; --ink-3: #a39c92;
  --rule: #ebe6de; --accent: #c47f56; --accent-soft: rgba(196,127,86,.16);
  --shadow: 0 18px 48px rgba(60,45,30,.16), 0 2px 6px rgba(60,45,30,.06);
  font: 14px/1.45 "Onest", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
@media (prefers-color-scheme: dark) { .layer {
  --paper: #23201d; --paper-2: #2b2723; --ink: #efe9e1; --ink-2: #bdb4a9; --ink-3: #8b8278;
  --rule: #38332d; --accent: #e0a07a; --accent-soft: rgba(224,160,122,.18); --shadow: 0 18px 48px rgba(0,0,0,.45); } }

/* The cursor flies in an arc: X and Y ride two nested layers with different easing curves. */
.cursor { position: fixed; left: 0; top: 0; width: 0; height: 0;
  transform: translate3d(var(--x, 0), 0, 0); transition: transform .62s cubic-bezier(.33,.75,.25,1); }
.cy { transform: translate3d(0, var(--y, 0), 0); transition: transform .62s cubic-bezier(.6,.05,.3,1); }
/* will-change only while things move (flight, snap-follow): held for a whole step it pins 5–6 GPU layers. */
.cursor.flying, .cursor.flying .cy, .layer.snap .cursor.on, .layer.snap .cursor.on .cy { will-change: transform; }
.ring { position: absolute; left: -13px; top: -13px; width: 26px; height: 26px; border-radius: 50%;
  border: 2.5px solid var(--accent); background: var(--accent-soft); opacity: 0; transform: scale(.6);
  transition: opacity .25s ease, transform .35s cubic-bezier(.3,1.6,.5,1); }
.ring::before { content: ""; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%; background: var(--accent); }
.ring::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid var(--accent); opacity: 0; }
.cursor.on .ring { opacity: 1; transform: scale(1); }
.cursor.on.flying .ring { transform: scale(.82); }
/* A few pulses on landing, then still: an endless pulse keeps the GPU awake for as long as a step is shown. */
.cursor.on.landed .ring::after { animation: pulse 1.8s ease-out 3; }
.lite .cursor.on.landed .ring::after { animation-iteration-count: 2; }
@keyframes pulse { 0% { transform: scale(1); opacity: .5; } 100% { transform: scale(2.1); opacity: 0; } }

.frame { position: fixed; left: 0; top: 0; border-radius: 12px; border: 2px solid var(--accent);
  box-shadow: 0 0 0 6px var(--accent-soft); opacity: 0;
  transform: translate3d(var(--fx, 0), var(--fy, 0), 0) scale(.97); transition: opacity .22s ease, transform .3s cubic-bezier(.22,.9,.24,1); }
.frame.on { opacity: 1; transform: translate3d(var(--fx, 0), var(--fy, 0), 0) scale(1); }
.layer.snap .frame.on { will-change: transform; }

/* A hidden card must not eat clicks: opacity 0 alone still hit-tests, so it also goes visibility:hidden + pointer-events:none. */
.card { position: fixed; left: 0; top: 0; width: min(320px, calc(100vw - 24px)); pointer-events: none; visibility: hidden;
  background: var(--paper); border: 1px solid var(--rule); border-radius: 16px; box-shadow: var(--shadow);
  padding: 14px 16px 12px; opacity: 0;
  transform: translate3d(var(--cx, 0), calc(var(--cy, 0px) + 6px), 0);
  transition: opacity .22s ease, transform .38s cubic-bezier(.22,.9,.24,1), visibility 0s linear .22s; }
.card.on { opacity: 1; visibility: visible; pointer-events: auto; transition-delay: 0s;
  transform: translate3d(var(--cx, 0), var(--cy, 0), 0); }
.layer.snap .card.on { will-change: transform; }
.top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.mark { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--accent); display: grid; place-items: center; flex: none; }
.mark::after { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--accent); }
.count { font-size: 12px; color: var(--ink-3); letter-spacing: .02em; font-variant-numeric: tabular-nums; }
.x { margin-left: auto; width: 26px; height: 26px; border-radius: 8px; border: 0; background: transparent; color: var(--ink-3); cursor: pointer; font: inherit; font-size: 16px; line-height: 1; }
.x:hover { background: var(--paper-2); color: var(--ink); }
.text { font-size: 15px; color: var(--ink); text-wrap: pretty; }
.value { margin-top: 8px; display: inline-flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--ink-2); background: var(--paper-2); border-radius: 8px; padding: 4px 8px; max-width: 100%; }
.value b { font-weight: 500; color: var(--ink); overflow-wrap: anywhere; }
.wait, .status { margin-top: 8px; font-size: 12.5px; color: var(--ink-3); display: flex; align-items: center; gap: 8px; }
.status[hidden] { display: none; }
.dots { display: inline-flex; gap: 3px; }
.dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--ink-3); opacity: .6; }
/* Only a shown card blinks: a hidden one (and the SDK host without popover support) stays still. */
.card.on .dots i { animation: blink 1.2s ease-in-out infinite; }
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
.lite .rec .dot, .lite .card.on .dots i { animation-iteration-count: 3; }

/* While the page scrolls or the control moves, everything follows instantly so nothing trails behind; only fades stay animated.
   A ring in flight keeps its arc: the flight re-aims at the live target instead. */
.layer.snap .frame { transition: opacity .22s ease; }
.layer.snap .card { transition: opacity .22s ease, visibility 0s linear .22s; }
.layer.snap .card.on { transition: opacity .22s ease; }
.layer.snap .cursor:not(.flying), .layer.snap .cursor:not(.flying) .cy { transition: none; }
@media (prefers-reduced-motion: reduce) { .cursor, .cy, .frame, .card { transition: opacity .15s linear; } .ring::after, .dots i, .rec .dot { animation: none !important; } }
`;

  const PAD = 6;              // frame padding around the control
  const GAP = 14;             // card distance from the control
  const EDGE = 8;             // card distance from the visual viewport edge
  const FLY_MS = 620;         // matches the .62s cursor transition
  const SETTLE_MS = 600;      // per-frame checks after any trigger
  const SCROLL_MAX_MS = 1200; // give up waiting for a smooth scroll
  const LOST_MAX_MS = 30000;  // stop looking for a re-rendered control
  const REAIM_PX = 8;         // smaller moves in flight don't restart it: the ring snaps the rest once it lands
  const MOVING_MS = 2000;     // lite: a control moving longer than this (marquee, pulse) is followed at half rate
  const OVERFLOW = /(auto|scroll|overlay|hidden|clip)/, SCROLLY = /(auto|scroll|overlay)/;
  const STATUS = {
    lost: '<span class="dots"><i></i><i></i><i></i></span>ищу…',
    gone: 'Не нахожу этот элемент на странице',
    clipped: 'Прокрутите к элементу',
    covered: 'Элемент закрыт другим окном',
  };
  const now = () => performance.now();
  const IS_LITE = lite();

  let host, shadow, layer, cursor, cy, frameEl, card, statusEl, rec;
  let current = null, target = null;
  // Per target: [{doc, win, frame, fpad, clippers, scrollers, vscroll, pinned}], innermost document first.
  let levels = [], chainOk = false, pinned = false, rtl = false, above = false;
  let offs = [], moveOff = null, globalOffs = null;
  let raf = 0, phase = 'idle', state = 'hidden', stable = 0, settleUntil = 0, animUntil = 0, anims = 0, scrollActiveUntil = 0;
  let flyStart = 0, flyEnd = 0, movingSince = 0, restAt = 0, skipFrame = false, hiddenAt = 0, scrollTries = 0, scrollT0 = 0, scrollEnded = false, scrollMoved = false, scrollStill = 0, scrollLast = null;
  let lostSince = 0, lostTries = 0, nextRelocAt = 0, lostTimer = 0, lostMo = null, gaveUp = false;
  let occluded = false, occAt = 0;
  let cardDirty = true, cardW = 320, cardH = 140, cardAt = null, cardSide = '', statusKind = null;
  let z = 1, zDirty = true, snapOn = false, hideTimer = 0, ringAt = null, lastR = null, lastVis = null;
  let raiseLog = [];
  const written = {};

  function lite() {
    try { return (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4; } catch (e) { return false; }
  }
  const reducedMQ = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(reducedMQ && reducedMQ.matches);
  const is = (el, sel) => { try { return el.matches(sel); } catch (e) { return false; } };
  const isTop = n => is(n, ':modal') || is(n, ':popover-open');
  const ours = n => n === host || !!(n && n.closest && n.closest('[data-scopos-ui]'));

  // ---------- geometry helpers: rects are {x, y, w, h} in our window's viewport px ----------
  const R = (x, y, w, h) => ({ x, y, w: Math.max(0, w), h: Math.max(0, h) });
  const fromDOM = r => R(r.left, r.top, r.width, r.height);
  const area = r => (r ? r.w * r.h : 0);
  const map = (r, o) => R(o.x + r.x * o.s, o.y + r.y * o.s, r.w * o.s, r.h * o.s);
  function inter(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return R(x, y, Math.min(a.x + a.w, b.x + b.w) - x, Math.min(a.y + a.h, b.y + b.h) - y);
  }
  function same(a, b, eps = 0.5) {
    if (!a || !b) return a === b;
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps;
  }
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // Rounded to device pixels so the frame doesn't shimmer at fractional zoom; divided by the layer's CSS zoom.
  const css = v => { const d = root.devicePixelRatio || 1; return Math.round((v / z) * d) / d + 'px'; };

  // Composed parent: slot, then shadow root -> host, so scrollers around and inside web components are found.
  const up = n => n.assignedSlot || (n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode);
  function holds(a, b) { for (let n = b, i = 0; n && i < 512; n = up(n), i++) if (n === a) return true; return false; }

  function alive(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    try { return !el.checkVisibility || el.checkVisibility({ visibilityProperty: true }); } catch (e) { return true; }
  }

  // ---------- mount, top layer ----------
  function mount() {
    if (host) { if (!host.isConnected) DOC.documentElement.appendChild(host); return; }
    host = DOC.createElement('scopos-layer');
    host.setAttribute('data-scopos-ui', '');
    // A manual popover lives in the browser's top layer, so the pointer stays above the site's own layers.
    // Inline styles beat site rules that might hit the host element when it is moved into a site dialog.
    host.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;min-width:0;min-height:0;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483646;color-scheme:normal;transform:none;opacity:1;filter:none;clip-path:none;visibility:visible;contain:none';
    if ('popover' in HTMLElement.prototype) host.setAttribute('popover', 'manual');
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS_TEXT}</style><div class="layer${IS_LITE ? ' lite' : ''}"><div class="frame"></div><div class="cursor"><div class="cy"><div class="ring"></div></div></div><div class="card" role="dialog" aria-live="polite"></div></div>`;
    layer = shadow.querySelector('.layer');
    cursor = shadow.querySelector('.cursor');
    cy = shadow.querySelector('.cy');
    frameEl = shadow.querySelector('.frame');
    card = shadow.querySelector('.card');
    // Park the cursor in the lower right corner until the first flight.
    setRing(root.innerWidth - 40, root.innerHeight - 40);
    // <html>, not <body>: frameworks that wipe body children can't remove us, and body zoom doesn't apply.
    DOC.documentElement.appendChild(host);
    card.addEventListener('click', onCardClick);
    // Our clicks shouldn't reach the page's "click outside closes it" handlers (capture listeners still see them).
    for (const type of ['pointerdown', 'mousedown', 'click']) card.addEventListener(type, e => e.stopPropagation());
  }

  // Where the host must live: a modal dialog makes the rest of the page inert, our popover included, so the card
  // goes inside the dialog (or open popover) that holds the control; with another modal open, inside that one.
  function layerParent() {
    const anchor = target && chainOk && levels.length ? (levels.length > 1 ? levels[levels.length - 2].frame : target) : null;
    for (let n = anchor; n && n.nodeType === 1; n = up(n)) {
      if (n === host) break;
      if (isTop(n) || n.getAttribute('aria-modal') === 'true') return n;
    }
    const ds = DOC.querySelectorAll('dialog[open]');
    for (let i = ds.length - 1; i >= 0; i--) if (is(ds[i], ':modal')) return ds[i];
    return DOC.documentElement;
  }

  function reassertLayer(force) {
    if (!host) return;
    const want = layerParent();
    let moved = false;
    if (host.parentNode !== want) {
      try { want.appendChild(host); } catch (e) { DOC.documentElement.appendChild(host); }
      moved = true; zDirty = true; cardDirty = true;
    }
    if (!host.hasAttribute('popover')) return;
    const open = is(host, ':popover-open');
    if (open && !force) return;
    if (open) {
      // Re-adding to the top layer paints us above whatever opened after us ("most recent on top").
      // Skip while the user is inside our card so focus stays where it is, and rate-limit against
      // another script doing the same.
      if (is(host, ':focus-within')) return;
      const t = now();
      raiseLog = raiseLog.filter(x => t - x < 1000);
      if (raiseLog.length >= 6) return;
      raiseLog.push(t);
      try { host.hidePopover(); } catch (e) { /* not open after all */ }
    }
    try { host.showPopover(); } catch (e) { return; }
    // Resolve styles now, so the first flight after showing starts from where the ring was instead of jumping.
    void root.getComputedStyle(cy).transform;
    if (moved) settle();
  }

  // ---------- card ----------
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
      <div class="status" hidden></div>
      <div class="bar"><button class="btn" data-do="close">Остановить</button></div>
      <div class="hint">Нажимаю только то, что открывает экраны и окна. Ничего не сохраняю и не отправляю.</div>`;
    } else {
      card.innerHTML = `
      <div class="top"><span class="mark"></span><span class="count">${o.total > 1 ? `Шаг ${o.step} из ${o.total}` : 'Scopos'}</span><button class="x" data-do="close" aria-label="Закрыть подсказку">×</button></div>
      <div class="text">${esc(o.instruction)}</div>
      ${o.value ? `<div class="value">Введите: <b>${esc(o.value)}</b></div>` : ''}
      ${o.waiting ? `<div class="wait"><span class="dots"><i></i><i></i><i></i></span>Ищу этот элемент на странице</div>` : ''}
      <div class="status" hidden></div>
      <div class="bar">${o.step > 1 ? '<button class="btn" data-do="back">Назад</button>' : ''}<button class="btn main" data-do="next">${o.step >= o.total ? 'Готово' : 'Далее'}</button></div>
      ${o.autoAdvance && !o.waiting ? '<div class="hint">Сделайте это действие, и я покажу следующий шаг</div>' : ''}`;
    }
    statusEl = card.querySelector('.status');
    statusKind = null;
    cardDirty = true;
  }

  function setStatus(k) {
    if (k === statusKind || !statusEl) return false;
    statusKind = k;
    statusEl.innerHTML = k ? STATUS[k] : '';
    statusEl.hidden = !k;
    cardDirty = true; // its height changed: measure again before placing
    return true;
  }

  // Below, else above, else right/left (above first for dropdown triggers, so the list it opens stays visible),
  // clamped inside the visual viewport. None of these overlap the control; the corner fallback avoids it too.
  function placeCard(b, m) {
    const vv = m.vv, w = cardW, h = cardH;
    const minX = vv.x + EDGE, maxX = Math.max(minX, vv.x + vv.w - w - EDGE);
    const minY = vv.y + EDGE, maxY = Math.max(minY, vv.y + vv.h - h - EDGE);
    const cx = v => Math.max(minX, Math.min(maxX, v)), cyc = v => Math.max(minY, Math.min(maxY, v));
    const ax = cx(rtl ? b.x + b.w - w : b.x), ay = cyc(b.y);
    const cand = {
      below: { x: ax, y: b.y + b.h + GAP }, above: { x: ax, y: b.y - GAP - h },
      right: { x: b.x + b.w + GAP, y: ay }, left: { x: b.x - GAP - w, y: ay },
    };
    const fits = p => p.x >= minX - 0.5 && p.x <= maxX + 0.5 && p.y >= minY - 0.5 && p.y <= maxY + 0.5;
    const clear = p => !m.avoid || !overlap(R(p.x, p.y, w, h), m.avoid);
    const order = above ? ['above', 'below', 'right', 'left'] : ['below', 'above', 'right', 'left'];
    // Stay on the current side while it still fits, so the card doesn't flip back and forth during a scroll.
    if (cardSide) order.unshift(cardSide);
    for (const strict of [true, false]) {
      for (const s of order) { const p = cand[s]; if (fits(p) && (!strict || clear(p))) { cardSide = s; return p; } }
    }
    cardSide = '';
    const mid = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    let best = null, bd = -1;
    for (const p of [{ x: maxX, y: maxY }, { x: minX, y: maxY }, { x: maxX, y: minY }, { x: minX, y: minY }]) {
      if (overlap(R(p.x, p.y, w, h), b)) continue;
      const d = Math.hypot(p.x + w / 2 - mid.x, p.y + h / 2 - mid.y);
      if (d > bd) { bd = d; best = p; }
    }
    return best || { x: maxX, y: maxY };
  }

  const corner = m => ({ x: Math.max(m.vv.x + EDGE, m.vv.x + m.vv.w - cardW - 16), y: Math.max(m.vv.y + EDGE, m.vv.y + m.vv.h - cardH - 16) });

  // ---------- target chain: clippers, scrollers, iframes ----------
  // An element is a containing block for fixed/absolute descendants when it has any of these (Floating UI isContainingBlock).
  function containing(c) {
    const set = v => !!v && v !== 'none';
    return set(c.transform) || set(c.translate) || set(c.scale) || set(c.rotate) || set(c.perspective) || set(c.filter) || set(c.backdropFilter)
      || (!!c.containerType && c.containerType !== 'normal')
      || /transform|translate|scale|rotate|perspective|filter/.test(c.willChange || '') || /paint|layout|strict|content/.test(c.contain || '');
  }

  function walk(el, lv) {
    const win = lv.win, de = lv.doc.documentElement, body = lv.doc.body;
    const hs = win.getComputedStyle(de);
    // <body> only clips when <html> has its own overflow; otherwise body's overflow belongs to the viewport.
    const bodyClips = hs.overflowX !== 'visible' || hs.overflowY !== 'visible';
    const cs = win.getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') lv.pinned = true;
    let mode = isTop(el) ? 'top' : cs.position === 'fixed' ? 'fixed' : cs.position === 'absolute' ? 'abs' : 'flow';
    for (let n = up(el); n && n.nodeType === 1 && n !== de; n = up(n)) {
      const c = win.getComputedStyle(n);
      if (c.position === 'fixed' || c.position === 'sticky') lv.pinned = true;
      const cb = containing(c);
      const ov = !/^(inline|contents)$/.test(c.display) && OVERFLOW.test(c.overflowX + ' ' + c.overflowY);
      if (ov) { lv.scrollers.push(n); if (SCROLLY.test(c.overflowY)) lv.vscroll.push(n); }
      // A fixed box ignores ancestors up to the next containing block, an absolute one ignores static
      // ancestors, and nothing above a top-layer element clips it.
      const drop = mode === 'top' || (mode === 'fixed' && !cb) || (mode === 'abs' && c.position === 'static' && !cb);
      if (ov && !drop && (n !== body || bodyClips)) lv.clippers.push(n);
      if (mode !== 'top') {
        if (isTop(n)) mode = 'top';
        else if (!drop) mode = c.position === 'fixed' ? 'fixed' : c.position === 'absolute' ? 'abs' : 'flow';
      }
    }
  }

  function buildLevels(el) {
    const out = [];
    let node = el;
    for (let i = 0; node && i < 8; i++) {
      const doc = node.ownerDocument, win = doc && doc.defaultView;
      if (!win) break;
      const lv = { doc, win, frame: null, fpad: null, clippers: [], scrollers: [], vscroll: [], pinned: false };
      walk(node, lv);
      out.push(lv);
      if (win === root) break;
      let fe = null;
      try { fe = win.frameElement; } catch (e) { fe = null; }
      if (!fe) break; // cross-origin parent: the chain stops here
      const fcs = fe.ownerDocument.defaultView.getComputedStyle(fe);
      lv.frame = fe;
      lv.fpad = { l: fe.clientLeft + (parseFloat(fcs.paddingLeft) || 0), t: fe.clientTop + (parseFloat(fcs.paddingTop) || 0) };
      node = fe;
    }
    return out;
  }

  // Per level: how to map that document's viewport coords into ours (iframe position + border + padding, times its scale).
  function offsets() {
    const o = [];
    o[levels.length - 1] = { x: 0, y: 0, s: 1 };
    for (let i = levels.length - 2; i >= 0; i--) {
      const lv = levels[i], fe = lv.frame, b = fe.getBoundingClientRect(), s = (fe.offsetWidth && b.width / fe.offsetWidth) || 1, p = o[i + 1];
      o[i] = { x: p.x + (b.left + lv.fpad.l * s) * p.s, y: p.y + (b.top + lv.fpad.t * s) * p.s, s: s * p.s };
    }
    return o;
  }

  function viewportOf(doc, win) {
    const e = doc.compatMode === 'BackCompat' ? doc.body || doc.documentElement : doc.documentElement;
    return R(0, 0, e.clientWidth || win.innerWidth, e.clientHeight || win.innerHeight);
  }

  // Inner client rect (no borders or scrollbars), scaled by any ancestor transform.
  function inner(c) {
    const b = c.getBoundingClientRect(), sx = (c.offsetWidth && b.width / c.offsetWidth) || 1, sy = (c.offsetHeight && b.height / c.offsetHeight) || sx;
    return R(b.left + c.clientLeft * sx, b.top + c.clientTop * sy, c.clientWidth * sx, c.clientHeight * sy);
  }

  function targetRect(o) {
    if (typeof S.rectOf === 'function' && root === root.top) {
      try {
        const r = S.rectOf(target);
        if (r && r.width != null) return R(r.left != null ? r.left : r.x, r.top != null ? r.top : r.y, r.width, r.height);
      } catch (e) { /* fall back to our own walk */ }
    }
    return map(fromDOM(target.getBoundingClientRect()), o ? o[0] : { x: 0, y: 0, s: 1 });
  }

  const viewBox = () => {
    const v = root.visualViewport;
    return v ? R(v.offsetLeft, v.offsetTop, v.width, v.height) : R(0, 0, root.innerWidth, root.innerHeight);
  };

  function avoidBox() {
    let a = current && current.avoidRect;
    if (typeof a === 'function') { try { a = a(); } catch (e) { a = null; } }
    if (!a) return null;
    if (a.getBoundingClientRect) a = a.getBoundingClientRect();
    return R(a.left != null ? a.left : a.x, a.top != null ? a.top : a.y, a.width != null ? a.width : a.w, a.height != null ? a.height : a.h);
  }

  // ---------- hit testing ----------
  // Our layer is pointer-events:none except the card; card hits are looked through, not counted as covering.
  function hitAt(doc, x, y) {
    try {
      let e = doc.elementFromPoint(x, y);
      if (e && ours(e)) e = (doc.elementsFromPoint(x, y) || []).find(n => !ours(n)) || null;
      // Hits inside open shadow roots are retargeted to the host: dig in.
      for (let i = 0; e && e.shadowRoot && i < 8; i++) {
        const d = e.shadowRoot.elementFromPoint(x, y);
        if (!d || d === e || ours(d)) break;
        e = d;
      }
      return e;
    } catch (err) { return null; }
  }

  // Covered = none of the centre and 4 inset corners of the visible part hit the control (or its ancestors,
  // which is what a pointer-events:none control gives).
  function checkCovered(vis, o) {
    if (typeof S.isOccluded === 'function') {
      try { if (S.isOccluded(target) === false) return false; } catch (e) { /* use our probe */ }
    }
    const lv = levels[0], o0 = o[0], k = Math.min(4, vis.w / 3, vis.h / 3);
    const pts = [[vis.x + vis.w / 2, vis.y + vis.h / 2], [vis.x + k, vis.y + k], [vis.x + vis.w - k, vis.y + k], [vis.x + k, vis.y + vis.h - k], [vis.x + vis.w - k, vis.y + vis.h - k]];
    let seen = 0, good = 0;
    for (const [px, py] of pts) {
      const e = hitAt(lv.doc, (px - o0.x) / o0.s, (py - o0.y) / o0.s);
      if (!e) continue; // outside that viewport: unknown
      seen++;
      if (holds(target, e) || holds(e, target)) good++;
    }
    if (seen && !good) return true;
    // In an iframe the control can also be covered by something in the outer page.
    const mx = vis.x + vis.w / 2, my = vis.y + vis.h / 2;
    for (let i = 1; i < levels.length; i++) {
      const fe = levels[i - 1].frame, e = hitAt(levels[i].doc, (mx - o[i].x) / o[i].s, (my - o[i].y) / o[i].s);
      if (e && !holds(fe, e) && !holds(e, fe)) return true;
    }
    return false;
  }

  // Bottom edge (our coords) of a fixed/sticky bar covering the top quarter of the control, or 0.
  function headerOver(vis, o) {
    const lv = levels[0], o0 = o[0], x = vis.x + vis.w / 2;
    let bottom = 0;
    for (const py of [vis.y + 2, vis.y + vis.h * 0.25]) {
      const e = hitAt(lv.doc, (x - o0.x) / o0.s, (py - o0.y) / o0.s);
      if (!e || holds(target, e) || holds(e, target)) continue;
      for (let n = e, i = 0; n && n.nodeType === 1 && i < 16; n = up(n), i++) {
        const pos = lv.win.getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky') { const b = map(fromDOM(n.getBoundingClientRect()), o0); bottom = Math.max(bottom, b.y + b.h); break; }
      }
    }
    return bottom;
  }

  // Floating UI's layoutShift trick: an IntersectionObserver whose root margin is the element's own box,
  // so any movement changes the ratio and calls onMove, even when no scroll or resize event fires.
  function observeMove(el, onMove) {
    const doc = el.ownerDocument, win = doc && doc.defaultView, IO = win && win.IntersectionObserver;
    if (!IO) return () => {};
    const de = doc.documentElement;
    let io = null, timer = 0;
    const cleanup = () => { clearTimeout(timer); if (io) io.disconnect(); io = null; };
    function refresh(skip, threshold = 1) {
      cleanup();
      const r = el.getBoundingClientRect();
      if (!skip) onMove();
      if (!r.width || !r.height) return;
      const m = [Math.floor(r.top), Math.floor(de.clientWidth - r.right), Math.floor(de.clientHeight - r.bottom), Math.floor(r.left)];
      const opts = { rootMargin: m.map(v => -v + 'px').join(' '), threshold: Math.max(0, Math.min(1, threshold)) || 1 };
      let first = true;
      const handle = entries => {
        const ratio = entries[0].intersectionRatio;
        if (ratio !== threshold) {
          if (!first) return refresh();
          // Fully clipped in place: retry slowly instead of looping.
          if (!ratio) timer = setTimeout(() => refresh(false, 1e-7), 1000);
          else refresh(false, ratio);
        }
        // The entry is a snapshot; compare with a fresh rect.
        if (ratio === 1) { const f = el.getBoundingClientRect(); if (f.left !== r.left || f.top !== r.top || f.width !== r.width || f.height !== r.height) refresh(); }
        first = false;
      };
      try { io = new IO(handle, Object.assign({}, opts, { root: doc })); } catch (e) { io = new IO(handle, opts); }
      io.observe(el);
    }
    refresh(true);
    return cleanup;
  }

  // ---------- attach / detach update triggers ----------
  function on(t, type, fn, o) { t.addEventListener(type, fn, o); offs.push(() => t.removeEventListener(type, fn, o)); }

  function attach(el) {
    detach();
    target = el || null;
    occAt = 0; occluded = false; anims = 0; animUntil = 0; lastR = null; lastVis = null; movingSince = 0; restAt = 0;
    if (!target) return;
    try { levels = buildLevels(target); } catch (e) { levels = []; }
    chainOk = levels.length > 0 && levels[levels.length - 1].win === root;
    pinned = !!(levels[0] && levels[0].pinned);
    try { rtl = target.ownerDocument.defaultView.getComputedStyle(target).direction === 'rtl'; } catch (e) { rtl = false; }
    above = is(target, 'select, [role=combobox], [aria-haspopup]:not([aria-haspopup=false])');
    const passive = { passive: true }, cap = { capture: true, passive: true };
    for (const lv of levels) {
      // Direct listeners: scroll doesn't cross shadow roots or iframes, so the window catch-all misses those.
      for (const s of lv.scrollers) { on(s, 'scroll', onScroll, passive); on(s, 'scrollend', onScrollEnd, passive); }
      on(lv.doc, 'scrollend', onAnyScrollEnd, cap);
      for (const type of ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel']) on(lv.doc, type, onAnim, cap);
      if (lv.win !== root) { on(lv.win, 'scroll', onAnyScroll, cap); on(lv.win, 'resize', onResize, passive); }
    }
    // Each observer comes from the element's own window.
    const ros = new Map();
    const watchSize = n => {
      const w = n.ownerDocument.defaultView;
      if (!w || typeof w.ResizeObserver !== 'function') return;
      let ro = ros.get(w);
      if (!ro) { ro = new w.ResizeObserver(() => settle()); ros.set(w, ro); offs.push(() => ro.disconnect()); }
      ro.observe(n);
    };
    try { watchSize(target); levels.forEach(lv => lv.frame && watchSize(lv.frame)); } catch (e) { /* observers are a bonus */ }
    try { moveOff = observeMove(target, onMove); } catch (e) { moveOff = null; }
  }

  function detach() {
    for (const f of offs) { try { f(); } catch (e) { /* already gone */ } }
    offs = [];
    if (moveOff) { moveOff(); moveOff = null; }
    levels = [];
    chainOk = false;
  }

  function armGlobal() {
    if (globalOffs) return;
    globalOffs = [];
    const g = (t, type, fn, o) => { t.addEventListener(type, fn, o); globalOffs.push(() => t.removeEventListener(type, fn, o)); };
    g(root, 'scroll', onAnyScroll, { capture: true, passive: true }); // catch-all for light-DOM scrollers
    g(root, 'resize', onResize, { passive: true });
    if (root.visualViewport) { // pinch-zoom and the on-screen keyboard move the visible area with no window resize
      g(root.visualViewport, 'resize', onResize, { passive: true });
      g(root.visualViewport, 'scroll', onScroll, { passive: true });
    }
    g(DOC, 'visibilitychange', onVisibility);
    g(DOC, 'toggle', onToggle, true); // popovers (and newer dialogs) opening after ours
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(onDialogs);
      mo.observe(DOC.documentElement, { attributes: true, attributeFilter: ['open'], subtree: true });
      globalOffs.push(() => mo.disconnect());
    }
  }
  function disarmGlobal() { if (!globalOffs) return; globalOffs.forEach(f => f()); globalOffs = null; }

  const onScroll = () => { scrollActiveUntil = now() + 150; settle(); };
  const onScrollEnd = () => { scrollEnded = true; settle(); };
  // The capture catch-alls see every scroller on the page (carousels, tickers, chat lists): only a document
  // scroll or a scroller that holds the control (or its iframe) can move it, the rest must not wake the loop.
  function scrollMoves(t) {
    if (!t || t.nodeType === 9 || t === root || t.window === t) return true;
    const d = t.ownerDocument;
    if (d && (t === d.documentElement || t === d.body)) return true;
    if (!target || t.nodeType !== 1) return false;
    if (holds(t, target)) return true;
    for (const lv of levels) if (lv.frame && holds(t, lv.frame)) return true;
    return false;
  }
  const onAnyScroll = e => { if (scrollMoves(e && e.target)) onScroll(); };
  const onAnyScrollEnd = e => { if (scrollMoves(e && e.target)) onScrollEnd(); };
  const onMove = () => settle();
  function onResize() {
    zDirty = true; cardDirty = true;
    // The move observer's root margin is sized to the old viewport.
    if (target && moveOff) { moveOff(); try { moveOff = observeMove(target, onMove); } catch (e) { moveOff = null; } }
    settle();
  }
  // ResizeObserver doesn't see transforms: while a transition or animation runs on the control or an
  // ancestor, check every frame (capped, in case an end event never comes).
  function onAnim(e) {
    const tg = e.target;
    if (!target || !tg || tg.nodeType !== 1 || !holds(tg, target)) return;
    if (e.type === 'transitionrun' || e.type === 'animationstart') { anims++; animUntil = now() + 2000; schedule(); }
    else { anims = Math.max(0, anims - 1); if (!anims) animUntil = 0; settle(150); }
  }
  function onVisibility() {
    if (DOC.hidden) { hiddenAt = now(); if (raf) { cancelAnimationFrame(raf); raf = 0; } return; }
    // The lost-control clock counts visible time only: a user back from another tab still gets the search.
    if (hiddenAt && lostSince && !gaveUp) { const d = now() - hiddenAt; lostSince += d; nextRelocAt += d; }
    hiddenAt = 0;
    settle();
  }
  function onToggle(e) {
    if (!current && !rec) return;
    if (e.target === host || (e.target && e.target.localName === 'details')) return;
    reassertLayer(e.newState === 'open');
    settle();
  }
  function onDialogs(recs) {
    if (!current && !rec) return;
    for (const r of recs) if (r.target.localName === 'dialog') { reassertLayer(true); settle(); return; }
  }

  // ---------- lost control: re-resolve through o.relocate with backoff ----------
  function watchLost() {
    if (lostMo || typeof MutationObserver !== 'function') return;
    lostMo = new MutationObserver(() => { if (now() >= nextRelocAt) schedule(); });
    const opts = { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style', 'aria-hidden', 'open'] };
    lostMo.observe(DOC.documentElement, opts);
    const d = target && target.ownerDocument;
    if (d && d !== DOC && d.documentElement) { try { lostMo.observe(d.documentElement, opts); } catch (e) { /* frame gone */ } }
  }
  function unwatchLost() {
    if (lostMo) { lostMo.disconnect(); lostMo = null; }
    clearTimeout(lostTimer); lostTimer = 0;
  }

  function relocate(t) {
    if (!lostSince) { lostSince = t; lostTries = 0; nextRelocAt = t; }
    if (gaveUp || t < nextRelocAt) return;
    // Give up: release the observers and the detached node, so a removed route view isn't kept alive.
    // stateOf() still reports "gone" through current.relocate.
    if (t - lostSince > LOST_MAX_MS) { gaveUp = true; unwatchLost(); detach(); target = null; return; }
    lostTries++;
    nextRelocAt = t + Math.min(2000, 50 * 2 ** lostTries); // 100 ms, 200 ms ... 2 s
    let el = null;
    try { el = current.relocate(); } catch (e) { el = null; }
    if (el && el !== target && el.nodeType === 1 && alive(el)) {
      // Same control, new node (a re-render): re-attach in place. No flight from the corner, just a snap.
      attach(el);
      lostSince = 0; gaveUp = false; unwatchLost();
    }
  }

  function lost(t) {
    if (!lostSince) { lostSince = t; lostTries = 0; nextRelocAt = t; }
    if (!current.relocate || gaveUp) return;
    watchLost();
    if (!lostTimer) lostTimer = setTimeout(() => { lostTimer = 0; schedule(); }, Math.max(16, nextRelocAt - t));
  }

  // ---------- the frame loop ----------
  function schedule() { if (current && !raf && !DOC.hidden) raf = requestAnimationFrame(frame); }
  function settle(ms) { settleUntil = Math.max(settleUntil, now() + (ms || SETTLE_MS)); stable = 0; schedule(); }

  function frame() {
    raf = 0;
    if (!current || DOC.hidden) return;
    if (!host.isConnected) reassertLayer(true); // a framework replaced the node we lived in
    const t = now();
    // Lite: a landed control that keeps moving (marquee, pulsing CTA, live counter) is followed every 2nd frame.
    if (IS_LITE && phase === 'landed' && movingSince && t - movingSince > MOVING_MS && (skipFrame = !skipFrame)) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const m = measure(t);
    const moved = !same(m.r, lastR) || !same(m.vis, lastVis);
    lastR = m.r; lastVis = m.vis;
    stable = moved ? 0 : stable + 1;
    // Moving = followed since then; pauses under 0.5 s (a pulse's turning point, the loop resting a moment) don't count.
    if (moved && m.alive) { if (!movingSince || (restAt && t - restAt > 500)) movingSince = t; restAt = 0; }
    const again = write(m, t);
    const busy = again || (m.alive && phase === 'pending') || phase === 'scrolling' || phase === 'flying'
      || t < animUntil || (t < settleUntil && stable < 3);
    if (snapOn && !busy && stable >= 3) { layer.classList.remove('snap'); snapOn = false; }
    if (busy || snapOn) raf = requestAnimationFrame(frame);
    else if (!restAt) restAt = t; // the loop stops: it came to rest
  }

  // READ phase: no style writes in here.
  function measure(t) {
    const m = { t, alive: false, vv: viewBox(), r: null, vis: null, clip: null, o: null, fit: 0, avoid: null };
    if (zDirty) { z = (host && host.currentCSSZoom) || 1; zDirty = false; }
    if (cardDirty) { const b = card.getBoundingClientRect(); cardW = b.width || 320; cardH = b.height || 140; cardDirty = false; }
    if (current.relocate && (!target || !alive(target))) relocate(t);
    if (!target || !alive(target)) { if (target || current.relocate) lost(t); return m; }
    if (lostSince) { lostSince = 0; gaveUp = false; unwatchLost(); } // it came back by itself
    m.alive = true;

    const o = chainOk ? offsets() : null;
    const r = targetRect(o);
    let clip = viewportOf(DOC, root);
    if (o) {
      for (let i = 0; i < levels.length; i++) {
        const lv = levels[i];
        if (i < levels.length - 1) clip = inter(clip, map(viewportOf(lv.doc, lv.win), o[i]));
        for (const c of lv.clippers) clip = inter(clip, map(inner(c), o[i]));
      }
    }
    const vis = inter(r, clip);
    // How much of the control shows, against the most that could show in this clip (big panels never fit whole).
    const best = Math.min(r.w, clip.w) * Math.min(r.h, clip.h);
    m.r = r; m.clip = clip; m.vis = vis; m.o = o; m.fit = best > 0 ? area(vis) / best : 0;

    if (area(vis) > 0 && o && phase !== 'scrolling') {
      if (!occAt || t - occAt >= (IS_LITE ? 300 : 150)) { occAt = t; occluded = checkCovered(vis, o); }
    } else occluded = false;

    if (phase === 'scrolling') {
      if (same(r, scrollLast)) scrollStill++;
      else { scrollStill = 0; scrollMoved = true; scrollLast = r; }
      const dt = t - scrollT0;
      // Done on scrollend, or when the rect is still for 3 frames (no scrollend support, or nothing scrolled), or on timeout.
      m.scrollDone = dt > SCROLL_MAX_MS || (scrollEnded && scrollStill >= 1) || (scrollStill >= 3 && (scrollMoved || dt > 150));
    }
    if (phase === 'pending' || m.scrollDone) {
      m.fully = m.fit > 0.98;
      m.header = m.fully && !pinned && o ? headerOver(vis, o) : 0;
    }
    m.avoid = avoidBox();
    return m;
  }

  function stateOf(m, t) {
    if (!m.alive) return target || current.relocate ? (gaveUp ? 'gone' : 'lost') : 'none';
    if (phase === 'pending' || phase === 'scrolling') return phase;
    if (!area(m.vis)) return 'clipped';
    if (occluded) return 'covered';
    if (m.fit < 0.25 && t > scrollActiveUntil) return 'clipped';
    return phase === 'flying' ? 'flying' : 'shown';
  }

  function startScroll(m, t) {
    scrollTries++;
    const behavior = reduced() || IS_LITE ? 'auto' : 'smooth';
    try {
      if (m.fully && m.header) {
        // Visible but under a sticky/fixed bar: move it down just enough to clear the bar.
        const lv = levels[0];
        const sc = lv.vscroll.find(n => n.scrollHeight > n.clientHeight + 1) || lv.win;
        sc.scrollBy({ top: -(m.header + 12 - m.vis.y) / m.o[0].s, behavior });
      } else {
        target.scrollIntoView({ block: m.r.h > m.vv.h * 0.8 ? 'start' : 'center', inline: 'nearest', behavior });
      }
    } catch (e) { /* detached mid-way: the next frame sees it */ }
    phase = 'scrolling'; scrollT0 = t; scrollEnded = false; scrollMoved = false; scrollStill = 0; scrollLast = m.r;
    scrollActiveUntil = t + 150;
  }

  function fly(t) {
    if (reduced()) phase = 'landed'; // no flight, just a fade
    else { phase = 'flying'; flyStart = t; flyEnd = t + FLY_MS; }
  }

  function setXY(el, a, b, x, y, key) {
    const xs = css(x), ys = css(y), k = xs + ' ' + ys;
    if (written[key] === k) return false;
    written[key] = k;
    el.style.setProperty(a, xs); el.style.setProperty(b, ys);
    return true;
  }
  function setRing(x, y) {
    ringAt = { x, y };
    const xs = css(x), ys = css(y), k = xs + ' ' + ys;
    if (written.ring === k) return false;
    written.ring = k;
    cursor.style.setProperty('--x', xs); cy.style.setProperty('--y', ys);
    return true;
  }
  function setFrame(v) {
    const pos = setXY(frameEl, '--fx', '--fy', v.x - PAD, v.y - PAD, 'frame');
    const ws = css(v.w + PAD * 2), hs = css(v.h + PAD * 2), k = ws + ' ' + hs;
    if (written.fsize === k) return pos;
    written.fsize = k; frameEl.style.width = ws; frameEl.style.height = hs;
    return true;
  }

  // WRITE phase. Returns true when another frame is needed (the card's content changed and must be measured).
  function write(m, t) {
    let start = false;
    if (m.alive && phase === 'pending') {
      if (!pinned && m.o && (!m.fully || m.header)) startScroll(m, t); else { fly(t); start = true; }
    } else if (m.alive && phase === 'scrolling' && m.scrollDone) {
      if (!pinned && scrollTries < 2 && m.fully && m.header) startScroll(m, t); else { fly(t); start = true; }
    }
    if (phase === 'flying' && t >= flyEnd) phase = 'landed';
    const st = (state = stateOf(m, t));
    const geo = st === 'shown' || st === 'flying';
    let movedPos = false;

    // Card: shown in every state except while we scroll the page for it (it would flip around mid-scroll).
    const cardOn = st !== 'pending' && st !== 'scrolling';
    if (cardOn) {
      let p = null;
      if (geo) p = placeCard(m.vis, m);
      else if (st === 'none' || (!m.alive && !cardAt)) p = corner(m);
      else if (!cardAt && m.r) { const b = inter(m.r, m.vv); p = area(b) ? placeCard(b, m) : corner(m); }
      // Hidden states keep the card where it was, so it doesn't chase a control that scrolled away.
      if (p) { movedPos = setXY(card, '--cx', '--cy', p.x, p.y, 'card') || movedPos; cardAt = p; }
    }
    card.classList.toggle('on', cardOn);
    const sk = st === 'lost' ? (current.waiting ? null : 'lost') : st === 'gone' || st === 'clipped' || st === 'covered' ? st : null;
    const again = setStatus(sk);

    // Ring: top-right corner of the visible part (top-left in RTL), so it marks the control without hiding its label.
    if (geo) {
      const rx = rtl ? m.vis.x + 2 : m.vis.x + m.vis.w - 2, ry = m.vis.y + 2;
      if (phase === 'flying') {
        // Re-aim the CSS flight only when the destination jumps; the flight is capped at 1.5× so a control that
        // never stops moving still lands, and from then on it is followed without a flight (snap).
        if (!ringAt || Math.abs(rx - ringAt.x) > REAIM_PX || Math.abs(ry - ringAt.y) > REAIM_PX) {
          setRing(rx, ry);
          if (!start) flyEnd = Math.min(t + FLY_MS, flyStart + FLY_MS * 1.5);
        }
      } else movedPos = setRing(rx, ry) || movedPos;
    }
    cursor.classList.toggle('on', geo);
    cursor.classList.toggle('flying', phase === 'flying');
    cursor.classList.toggle('landed', geo && phase === 'landed');

    // Frame: around the visible part; it fades in during the last part of the flight.
    if (area(m.vis) > 0) movedPos = setFrame(m.vis) || movedPos;
    frameEl.classList.toggle('on', geo && (phase === 'landed' || t >= flyEnd - FLY_MS * 0.4));

    // Anything that moved outside a flight start follows without transitions until things are still again.
    if (movedPos && !start && !snapOn) { layer.classList.add('snap'); snapOn = true; }
    return again;
  }

  // ---------- public API ----------
  /** Shows a step. el may be null: then only the card is shown, parked in the corner (or, with o.relocate, searching). */
  function point(el, o) {
    mount();
    clearTimeout(hideTimer);
    const prev = current;
    current = o || {};
    armGlobal();
    renderCard(current);
    const next = el && el.nodeType === 1 && el.isConnected ? el : null;
    const keep = !!prev && !!next && next === target && (phase === 'landed' || phase === 'flying');
    if (!keep) {
      attach(next);
      phase = 'pending'; scrollTries = 0; cardSide = ''; cardAt = null;
      frameEl.classList.remove('on');
    }
    unwatchLost();
    lostSince = next || !current.relocate ? 0 : now(); lostTries = 0; nextRelocAt = 0; gaveUp = false;
    reassertLayer(true);
    settle();
  }

  function park() {
    if (current || rec || !host) return;
    try { if (is(host, ':popover-open')) host.hidePopover(); } catch (e) { /* already hidden */ }
    if (host.parentNode !== DOC.documentElement) DOC.documentElement.appendChild(host);
    // Nothing keeps animating in the parked card (where popover is missing, the host stays displayed).
    card.innerHTML = ''; statusEl = null; statusKind = null;
  }

  function hide() {
    current = null;
    detach(); target = null;
    unwatchLost(); lostSince = 0; gaveUp = false;
    phase = 'idle'; state = 'hidden';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!layer) return;
    cursor.classList.remove('on', 'landed', 'flying');
    frameEl.classList.remove('on');
    card.classList.remove('on'); // visibility:hidden + pointer-events:none right away
    if (snapOn) { layer.classList.remove('snap'); snapOn = false; }
    if (!rec) {
      disarmGlobal();
      // Leave the top layer once the fade-out is done.
      clearTimeout(hideTimer);
      hideTimer = setTimeout(park, 260);
    }
  }

  function recording(on, { onStop } = {}) {
    mount();
    if (rec) { rec.remove(); rec = null; }
    if (!on) { if (!current) { disarmGlobal(); park(); } return; }
    clearTimeout(hideTimer);
    rec = DOC.createElement('div');
    rec.className = 'rec';
    rec.innerHTML = '<span class="dot"></span><span>Scopos записывает шаги</span><button class="btn" style="height:28px">Стоп</button>';
    rec.querySelector('button').onclick = () => onStop && onStop();
    layer.appendChild(rec);
    armGlobal();
    reassertLayer(true);
  }

  // Measurements for automated drift checks (dev/stress.html): where the frame is drawn vs where the target is.
  // frame is the drawn frame minus its padding; visibleRect is the clipped part the frame is meant to cover.
  function debug() {
    if (!target || !frameEl) return null;
    let t = R(0, 0, 0, 0);
    try { t = targetRect(chainOk ? offsets() : null); } catch (e) { /* detached */ }
    const f = frameEl.getBoundingClientRect(), c = card.getBoundingClientRect(), v = lastVis;
    return {
      target: { x: t.x, y: t.y, w: t.w, h: t.h },
      frame: { x: f.left + PAD, y: f.top + PAD, w: f.width - PAD * 2, h: f.height - PAD * 2 },
      card: { x: c.left, y: c.top, w: c.width, h: c.height },
      frameOn: frameEl.classList.contains('on'),
      visibleRect: v ? { x: v.x, y: v.y, w: v.w, h: v.h } : null,
      state,
    };
  }

  // The card's instruction as shown (tests and the panel's mirror read it; the card lives in a closed shadow root).
  const cardText = () => { try { const t = card && card.querySelector('.text'); return t ? t.textContent : ''; } catch (e) { return ''; } };
  S.pointer = { point, hide, recording, debug, cardText, isOurs: el => !!(el && el.closest && (el.closest('scopos-layer') || el.closest('[data-scopos-ui]'))) };
})(typeof window !== 'undefined' ? window : globalThis);
