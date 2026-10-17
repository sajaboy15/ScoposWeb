// Automated drift and re-identification check for dev/stress.html.
// Load it in the stress page and run: await scoposStress()  -> table of results.
// For each case: is the control in the page map, does resolve(describe(el)) find it again,
// and after a disturbance (scroll, re-render) how far is the drawn frame from the real element.
window.scoposStress = async function () {
  const S = window.Scopos;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // Waits until the pointer has settled (shown or covered) instead of a fixed time, so a throttled
  // or slow tab (few frames per second) still gets a fair result. Returns how long it took.
  const settle = async (min, max = 9000) => {
    const t0 = performance.now();
    await wait(min);
    for (;;) {
      const m = S.pointer.debug();
      if (m && (m.state === 'shown' || m.state === 'covered')) return Math.round(performance.now() - t0);
      if (performance.now() - t0 > max) return null;
      await wait(100);
    }
  };
  const fps = await new Promise(r => { let n = 0; const f = () => { n++; requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => r(n), 1000); });
  const shadowBtn = () => document.getElementById('shadow-host').shadowRoot.getElementById('shadow-btn');
  const frameBtn = () => document.getElementById('frame').contentDocument.getElementById('frame-btn');
  const byText = (t, i = 0) => [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === t)[i];
  const cases = [
    { name: 'scroll container', el: () => document.getElementById('deep-btn'), disturb: async () => { document.getElementById('sc1').scrollTop += 60; } },
    { name: 'nested scroll', el: () => document.getElementById('nested-btn'), disturb: async () => { document.querySelector('.nested').scrollTop += 40; } },
    { name: 'scaled parent', el: () => document.getElementById('scaled-btn'), disturb: async () => { scrollBy(0, 30); } },
    { name: 'duplicate label #2', el: () => byText('Сохранить', 1), disturb: async () => {} },
    { name: 're-render', el: () => document.querySelector('[data-testid="rerender-btn"]'), disturb: async () => { await wait(1700); } },
    { name: 'clipped', el: () => document.getElementById('clipped-btn'), disturb: async () => {} },
    { name: 'covered', el: () => document.getElementById('covered-btn'), disturb: async () => {} },
    { name: 'shadow DOM', el: shadowBtn, disturb: async () => {} },
    { name: 'iframe', el: frameBtn, disturb: async () => {} },
    { name: 'list row #3', el: () => byText('Открыть', 2), disturb: async () => {} },
    { name: 'fixed', el: () => document.getElementById('fixed-btn'), disturb: async () => { scrollBy(0, 200); } },
    { name: 'sticky header', el: () => document.getElementById('hdr-help'), disturb: async () => { scrollBy(0, 300); } },
    { name: 'far below', el: () => document.getElementById('bottom-btn'), disturb: async () => {} },
    { name: 'icon only', el: () => document.getElementById('icon-btn'), disturb: async () => {} },
  ];
  const out = [];
  for (const c of cases) {
    scrollTo(0, 0);
    document.querySelectorAll('.scroller,.nested').forEach(s => { s.scrollTop = 0; });
    await wait(100);
    const el = c.el();
    const page = S.scan();
    const label = S.labelOf(el);
    const inMap = page.lines.some(l => l.includes(`"${label}"`));
    const d = S.describe(el);
    S.pointer.point(el, { step: 1, total: 1, instruction: c.name, onNext() {}, onBack() {}, onClose() {}, relocate: () => S.resolve(d) });
    const showMs = await settle(c.name === 're-render' ? 0 : 300);
    await c.disturb();
    await settle(450);
    const now = c.name === 're-render' ? document.querySelector('[data-testid="rerender-btn"]') : el;
    const again = S.resolve(d);
    const same = c.name === 're-render' ? again === now : again === el;
    const m = S.pointer.debug();
    let drift = null, visible = null;
    if (m) {
      // The frame is drawn around the visible part of the target (clipped targets are partly hidden).
      const want = m.visibleRect ? { x: m.visibleRect.x ?? m.visibleRect.left, y: m.visibleRect.y ?? m.visibleRect.top, w: m.visibleRect.w ?? m.visibleRect.width, h: m.visibleRect.h ?? m.visibleRect.height } : m.target;
      drift = m.frameOn ? Math.round(Math.max(Math.abs(m.frame.x - want.x), Math.abs(m.frame.y - want.y), Math.abs(m.frame.w - want.w), Math.abs(m.frame.h - want.h))) : null;
      const t = now.getBoundingClientRect();
      const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
      visible = !!hit && (hit === now || now.contains(hit));
    }
    out.push({ case: c.name, inMap, refound: same, driftPx: drift, frameShown: m ? m.frameOn : false, state: m && m.state, targetVisible: visible, showMs, fps });
  }
  S.pointer.hide();
  scrollTo(0, 0);
  console.table(out);
  return out;
};
