/*
 * Content script: the page side of the extension. It reads the page, draws the
 * pointer and runs the guide; the service worker owns state, the API key and
 * the Claude call. On every page load it asks whether a guide is running in this
 * tab and resumes it, which is how multi-page walkthroughs work.
 */
(() => {
  // After the extension is reloaded or updated, the old copy of this script keeps running in the page
  // with a dead runtime, and the worker injects a new one. A new copy replaces a dead one; next to a live
  // copy (a plain double injection) it stays out. `true` is what older versions stored: since this copy
  // is the current version, such a copy can only be an orphan.
  const prev = window.__scoposContent;
  if (prev && prev !== true && typeof prev.alive === 'function' && prev.alive()) return;
  if (prev && typeof prev.shutdown === 'function') { try { prev.shutdown(); } catch (e) { /* already half gone */ } }
  // Tell a copy in another isolated world (where window.__scoposContent is not visible) to check itself.
  try { document.dispatchEvent(new CustomEvent('scopos:content-takeover')); } catch (e) { /* ignore */ }

  const S = window.Scopos;
  const rt = chrome.runtime; // kept: after a reload this object's id turns undefined, the new copy has its own
  const alive = () => { try { return !!(rt && rt.id); } catch (e) { return false; } };
  let dead = false;
  const DEAD = /context invalidated/i; // not "Receiving end does not exist": a waking worker says that too
  const lost = e => { if (!alive() || DEAD.test(String((e && e.message) || e))) shutdown(); return null; };
  const send = msg => {
    if (dead) return Promise.resolve(null);
    if (!alive()) { shutdown(); return Promise.resolve(null); }
    try { return Promise.resolve(rt.sendMessage(msg)).catch(lost); } catch (e) { return Promise.resolve(lost(e)); } // throws synchronously once invalidated
  };

  // Once, when the extension behind this copy is gone: stop everything this copy started and let go of
  // the page, so the new injection is the only one with observers, timers and a pointer on screen.
  function shutdown() {
    if (dead) return;
    dead = true;
    const quiet = f => { try { const r = f(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) { /* half torn down */ } };
    quiet(() => rt.onMessage.removeListener(onMessage));
    document.removeEventListener('scopos:content-takeover', check);
    document.removeEventListener('visibilitychange', check);
    quiet(() => { clearInterval(routeTimer); clearTimeout(observeT); window.removeEventListener('popstate', routeTick); window.removeEventListener('hashchange', routeTick); });
    quiet(() => S.guide && S.guide.stop(false));
    quiet(() => S.recorder && S.recorder.active && S.recorder.active() && S.recorder.stop());
    quiet(() => S.pointer && S.pointer.recording && S.pointer.recording(false));
    quiet(() => S.explore && S.explore.running && S.explore.running() && S.explore.stop(true)); // its state went with the old worker
    quiet(() => S.pointer && S.pointer.hide());
    quiet(() => S.guard && S.guard.off());
    if (window.__scoposContent === me) window.__scoposContent = undefined;
  }
  // A guide waiting quietly sends nothing, so a dead context is also looked for when the tab comes back
  // into view and when a new copy announces itself.
  const check = () => { if (!alive()) shutdown(); };
  document.addEventListener('scopos:content-takeover', check);
  document.addEventListener('visibilitychange', check);
  const me = { alive: () => !dead && alive(), shutdown };
  window.__scoposContent = me;

  // "/a#" and "/a#/" are the same screen as "/a" in hash-routed apps.
  const here = () => location.pathname + (location.hash && location.hash !== '#' && location.hash !== '#/' ? location.hash : '');
  // The shared "same screen" rule from scan.js (record ids, route params and hash routes handled the same everywhere).
  const samePage = path => !path || (S.samePlace ? S.samePlace(path, location.pathname + location.search + location.hash) : S.pathKey ? S.pathKey(path) === S.pathKey(location.pathname + location.search + location.hash) : String(path).replace(/#\/?$/, '') === here());
  const scan = query => {
    try { return S.scan({ query }); } catch (e) { return S.scan(); }
  };

  // The guide's current steps (it may have grown during the run); guide.js provides steps() when it supports `more`.
  const guideSteps = () => { try { return S.guide.steps ? S.guide.steps() : null; } catch (e) { return null; } };
  let lastSteps = null;

  function startGuide(steps, index, missingDelay, { live = false, name = '' } = {}) {
    lastSteps = steps;
    S.guide.start(steps, {
      index,
      missingDelay,
      live: !!live,
      onChange: ({ index: i }) => send({ type: 'guide:change', index: i }),
      onEnd: reason => {
        const now = guideSteps() || lastSteps;
        send({ type: 'guide:end', reason, steps: Array.isArray(now) ? now : undefined });
      },
      // A live guide ran out of steps ('end'), or a step's control is not on this page ('missing'): the worker
      // asks Claude for the rest from this page (at most once per reason per run) and returns runnable steps or null.
      more: async ({ index: i, reason, done } = {}) => {
        const cur = guideSteps() || lastSteps || [];
        const doneList = Array.isArray(done) ? done : cur.slice(0, i).map(st => st && st.instruction).filter(Boolean);
        const query = [name, ...doneList.slice(-2)].filter(Boolean).join(' ');
        const res = await send({ type: 'guide:more', index: i, reason: reason === 'missing' ? 'missing' : 'end', done: doneList, page: scan(query), name });
        return res && Array.isArray(res.steps) ? res.steps : null;
      },
      // The whole list after `more` changed it: the worker keeps it, so a page load resumes on the longer guide.
      onSteps: steps => { if (Array.isArray(steps)) { lastSteps = steps; send({ type: 'guide:steps', steps }); } },
      onMissing: async (step, i) => {
        // A step whose control lives on another page is not "missing" here: the user just isn't there yet.
        if (step.target && step.target.path && !samePage(step.target.path)) return null;
        const query = [step.instruction, step.target && step.target.text].filter(Boolean).join(' ');
        const page = scan(query);
        let candidates = [];
        try { candidates = S.candidatesFor ? (S.candidatesFor(step.target, 8) || []).map(c => c.id).filter(Number.isInteger) : []; } catch (e) { candidates = []; }
        const res = await send({ type: 'guide:missing', step, index: i, page, candidates });
        if (!res || res.id == null) return null;
        const el = S.byId(res.id);
        const target = el ? S.describe(el) : null;
        if (target) send({ type: 'guide:healed', index: i, target });
        return target;
      },
    });
  }

  // While the explorer clicks around, a guard blocks submits, writes and dialogs. core/guard.js does it
  // (DOM guards here, plus a page-world patch it asks the worker to inject); without it, the worker's fallback patch.
  // on() resolves true once the page-world patch reported itself in place. The worker's network block
  // (declarativeNetRequest) is up either way, so a slow or failed patch only costs the in-page layer.
  const guardOn = async () => {
    if (!S.guard) return send({ type: 'guard:on' });
    const ok = await Promise.race([Promise.resolve(S.guard.on()).catch(() => false), new Promise(r => setTimeout(() => r(false), 2500))]);
    if (!ok) console.warn('[Scopos] page guard not confirmed; relying on the network block');
    return ok;
  };
  const guardOff = () => (S.guard ? Promise.resolve(S.guard.off()).catch(() => null) : send({ type: 'guard:off' }));

  // The explorer keeps its state in the service worker, so it survives full page loads.
  const exploreOpts = {
    store: {
      load: async () => ((await send({ type: 'explore:load' })) || {}).st || null,
      save: async st => {
        const r = await send({ type: 'explore:save', st });
        if (r && r.error) { S.explore.stop(); throw new Error(r.error); }
      },
    },
    onProgress: p => send({ type: 'explore:progress', p }),
    onDone: map => { guardOff(); send({ type: 'explore:done', map }); },
    // The walk stopped by itself (the tab left the product's site, or the user got logged out).
    onAbort: reason => { guardOff(); send({ type: 'explore:abort', reason }); },
    guard: { on: guardOn, off: guardOff },
  };

  // netBlocked: the worker's network-level write block is up for this tab (told on start and on every resume).
  async function startExplore(restart, net) {
    if (S.explore.running && S.explore.running()) {
      if (!restart) return;
      S.explore.stop();
      for (let i = 0; i < 30 && S.explore.running(); i++) await new Promise(r => setTimeout(r, 100));
    }
    await guardOn();
    S.explore.start({ ...exploreOpts, netBlocked: !!net });
  }

  // ---------- passive learning: on each screen the user opens, a 0-token snapshot grows the product map ----------
  // Only when the site has a map (the worker says so), never while a guide or the explorer runs, at most once per
  // screen in 10 minutes (the worker keeps the authoritative throttle across page loads).
  const OBSERVE_DELAY = 1500, OBSERVE_EVERY = 10 * 60 * 1000;
  const observedHere = new Map();
  let routeHref = '', observeT = 0;
  const screenKey = () => { try { return S.explore && S.explore.pageKey ? S.explore.pageKey() : location.pathname; } catch (e) { return location.pathname; } };
  const busyHere = () => { try { return !!((S.explore && S.explore.running && S.explore.running()) || (S.guide && S.guide.state && S.guide.state()) || (S.recorder && S.recorder.active && S.recorder.active())); } catch (e) { return true; } };
  async function observeScreen() {
    if (dead || document.hidden || !S.explore || typeof S.explore.snapshot !== 'function' || busyHere()) return;
    const key = screenKey();
    if (Date.now() - (observedHere.get(key) || 0) < OBSERVE_EVERY) return;
    const r = await send({ type: 'map:want', key });
    if (!r || !r.ok || busyHere() || screenKey() !== key) return;
    observedHere.set(key, Date.now());
    // A snapshot costs 50-250 ms of main thread on a big screen: only when the browser is idle.
    await new Promise(r => (typeof requestIdleCallback === 'function' ? requestIdleCallback(r, { timeout: 4000 }) : setTimeout(r, 200)));
    if (dead || busyHere() || screenKey() !== key) return;
    let view = null;
    try { view = await S.explore.snapshot(); } catch (e) { view = null; }
    if (view && Array.isArray(view.controls) && !dead) send({ type: 'map:observe', view });
  }
  function routeTick() {
    if (dead || location.href === routeHref) return;
    routeHref = location.href;
    clearTimeout(observeT);
    observeT = setTimeout(observeScreen, OBSERVE_DELAY);
  }
  const routeTimer = setInterval(routeTick, 1000);
  window.addEventListener('popstate', routeTick);
  window.addEventListener('hashchange', routeTick);

  function onMessage(msg, _sender, reply) {
    try {
      switch (msg.type) {
        case 'ping': reply({ ok: true }); break;
        case 'scan': reply(scan(msg.query || '')); break;
        case 'describe': reply((msg.ids || []).map(id => { if (id == null) return null; const el = S.byId(id); return el ? S.describe(el) : null; })); break;
        case 'guide:start': startGuide(msg.steps, msg.index || 0, msg.missingDelay, { live: msg.live, name: msg.name }); reply({ ok: true }); break;
        case 'guide:go': S.guide.go(msg.index); reply({ ok: true }); break;
        case 'guide:stop': S.guide.stop(false); reply({ ok: true }); break;
        case 'record:start':
          S.guide.stop(false);
          S.recorder.start(step => send({ type: 'record:step', step }));
          S.pointer.recording(true, { onStop: () => send({ type: 'record:stop-request' }) });
          reply({ ok: true });
          break;
        case 'record:stop':
          S.pointer.recording(false);
          reply({ steps: S.recorder.stop() });
          break;
        case 'explore:start': startExplore(!!msg.restart, !!msg.net); reply({ ok: true }); break;
        case 'explore:stop': S.explore.stop(); guardOff(); reply({ ok: true }); break; // "Хватит": guides from what was seen
        case 'explore:cancel': S.explore.stop(true); guardOff(); reply({ ok: true }); break; // "Отменить": nothing is written
        default: return false;
      }
    } catch (e) {
      reply({ error: (e && e.message) || String(e) });
    }
    return false;
  }
  rt.onMessage.addListener(onMessage);

  // A walk that was running before this page load continues here, with the guard back on first.
  (async () => {
    const res = (await send({ type: 'explore:load' })) || {};
    if (res.st && res.st.status === 'running') { await guardOn(); S.explore.resume({ ...exploreOpts, netBlocked: !!res.net }); }
  })();

  // Resume a walkthrough that continues on this page.
  send({ type: 'resume' }).then(res => {
    if (res && res.steps) startGuide(res.steps, res.index, res.missingDelay, { live: res.live, name: res.name });
    routeTick(); // this page load is a screen visit too (skipped while the guide runs)
  });
})();
