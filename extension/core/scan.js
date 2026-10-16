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

  function isOurs(el) { return !!(el.closest && el.closest('[data-scopos-ui]')); }

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
    if (el.labels && el.labels.length) { const t = clean([...el.labels].map(l => l.textContent).join(' ')); if (t) return t; }
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
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) out.push('current');
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
  S.byId = byId;
  S.describe = describe;
  S.resolve = resolve;
  S.labelOf = name;
})(typeof window !== 'undefined' ? window : globalThis);
