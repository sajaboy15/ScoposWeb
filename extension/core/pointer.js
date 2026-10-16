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
