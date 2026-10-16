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
