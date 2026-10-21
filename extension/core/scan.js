/*
 * Scopos page reader.
 *
 * scan()           -> the text map the model reads, with numeric ids that stay the same across
 *                     scans while a control keeps its role and name.
 * describe(el)     -> a durable fingerprint of one control: a few stable selectors plus a
 *                     Similo-style feature set (name, role, container, heading, neighbors, row...).
 * describeMany(els) -> the same for a whole view, with the page-wide parts computed once.
 * resolve(d)       -> finds that control again by scoring every visible control against the
 *                     fingerprint, and returns null rather than a weak guess (research/04).
 * candidatesFor(d) -> the closest few controls as map lines, for the self-heal model call.
 *
 * The DOM is read on demand only (a question, a step change), never on a timer. Reads made
 * during one task share a cache that is dropped at the next microtask, so a scan followed by
 * many describes does not walk the page or compute styles twice.
 * Open shadow roots and same-origin iframes are read too; our own UI never is.
 * Privacy: what the user typed is never read (only "filled"/"empty"), and emails and long digit
 * runs become "…" in everything that can reach the model.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});
  if (S.__scanV2) return; // injected twice: keep the first copy and its ids
  S.__scanV2 = true;
  const hasDOM = typeof document !== 'undefined';

  // =====================================================================================
  // Pure text and scoring helpers. No DOM access, so they can be tested in Node (S._test).
  // =====================================================================================

  // Icon-font glyphs (private use area), zero-width characters, NBSP-like spaces.
  const PUA = /[\uE000-\uF8FF]/g;
  const ZW = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
  const NBSP = /[\u00A0\u2007\u202F]/g;
  const clean = s => String(s == null ? '' : s).replace(PUA, '').replace(ZW, '').replace(NBSP, ' ').replace(/\s+/g, ' ').trim();
  const cut = (s, n = 70) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // Personal data that must not reach the model: emails, phone and account numbers (6+ digits).
  const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  const LONG_DIGITS = /\+?\d(?:[\s()-]{0,2}\d){5,}/g;
  const redactEmails = s => clean(s).replace(EMAIL, '…');
  const redact = s => redactEmails(s).replace(LONG_DIGITS, '…');

  /**
   * The one normalizer for every text comparison: NFKC, lowercase, ё -> е, trailing badge
   * counters dropped («Входящие (12)»), digits -> #, punctuation stripped.
   * keepDigits keeps numbers as they are (row keys: an order number is what identifies a row).
   */
  function normText(s, keepDigits) {
    let t = clean(s);
    if (!t) return '';
    try { t = t.normalize('NFKC'); } catch (e) { /* old engine */ }
    t = t.toLowerCase().replace(/ё/g, 'е');
    if (!keepDigits) {
      const stripped = t.replace(/\s*[(\[]\s*\d+\+?\s*[)\]]\s*$/, '').replace(/\s+\d+\+?$/, '');
      if (stripped.trim()) t = stripped;
      t = t.replace(/\d+(?:[.,]\d+)*/g, '#');
    }
    const words = t.replace(/[^\p{L}\p{N}#\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
    return words || t.replace(/\s+/g, ' ').trim(); // symbol-only labels («×», «+», «⋮») stay as they are
  }

  function lev(a, b) {
    if (a === b) return 0;
    a = a.slice(0, 160); b = b.slice(0, 160);
    if (a.length > b.length) { const t = a; a = b; b = t; }
    const row = new Array(a.length + 1);
    for (let i = 0; i <= a.length; i++) row[i] = i;
    for (let j = 1; j <= b.length; j++) {
      let diag = row[0];
      row[0] = j;
      for (let i = 1; i <= a.length; i++) {
        const up = row[i];
        row[i] = Math.min(up + 1, row[i - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = up;
      }
    }
    return row[a.length];
  }
  const levRatio = (a, b) => { const n = Math.max(a.length, b.length); return n ? 1 - lev(a, b) / n : 1; };

  /**
   * Similarity of two normalized strings, 0..1. a is the stored value, b the candidate's.
   * Stored value missing -> null (the feature is skipped); candidate value missing -> 0.
   * Labels under 4 characters («Ок», «Да», «×») match exactly or not at all.
   */
  function simN(a, b) {
    if (!a) return null;
    if (!b) return 0;
    if (a === b) return 1;
    const short = a.length <= b.length ? a : b, long = short === a ? b : a;
    if (short.length < 4) return 0;
    let best = 0;
    // levenshtein can only reach 0.7 when the lengths are close: skip the work otherwise
    if (short.length / long.length >= 0.7) { const r = levRatio(a, b); if (r >= 0.7) best = r; }
    const wa = new Set(a.split(' ')), wb = new Set(b.split(' '));
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter++;
    best = Math.max(best, inter / (wa.size + wb.size - inter));
    if ((' ' + long + ' ').includes(' ' + short + ' ')) best = Math.max(best, 0.5 + 0.4 * short.length / long.length);
    return best;
  }
  const textSim = (a, b) => simN(normText(a), normText(b));

  const eq = (a, b) => (!a ? null : a === b ? 1 : 0);
  const wordOverlap = (A, B) => {
    if (!A || !A.length) return null;
    if (!B || !B.length) return 0;
    const set = new Set(B);
    let n = 0;
    for (const w of new Set(A)) if (set.has(w)) n++;
    return n / Math.max(A.length, B.length);
  };
  const jaccard = (A, B) => {
    if (!A || !A.length) return null;
    if (!B || !B.length) return 0;
    const sa = new Set(A), sb = new Set(B);
    let n = 0;
    for (const x of sa) if (sb.has(x)) n++;
    return n / (sa.size + sb.size - n);
  };
  function lcsRatio(a, b) {
    if (!a.length || !b.length) return 0;
    const m = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = a[i - 1] === b[j - 1] ? m[i - 1][j - 1] + 1 : Math.max(m[i - 1][j], m[i][j - 1]);
    return m[a.length][b.length] / Math.max(a.length, b.length);
  }

  // Role families: a button that became a menu item is still "the same kind of thing"; a button
  // that became a text field is not (score x0.5).
  const FAMILY = {
    button: 'act', link: 'act', menuitem: 'act', tab: 'act', option: 'act', treeitem: 'act', gridcell: 'act',
    checkbox: 'toggle', radio: 'toggle', switch: 'toggle', menuitemcheckbox: 'toggle', menuitemradio: 'toggle',
    textbox: 'input', searchbox: 'input', combobox: 'input', spinbutton: 'input', select: 'input', listbox: 'input', file: 'input',
    slider: 'range',
  };
  const ROLE_PAIR = {
    'button|menuitem': 0.7, 'button|link': 0.5, 'button|tab': 0.5, 'link|menuitem': 0.6, 'link|tab': 0.5, 'menuitem|option': 0.6,
    'option|treeitem': 0.5, 'searchbox|textbox': 0.9, 'combobox|textbox': 0.6, 'combobox|searchbox': 0.6, 'combobox|select': 0.8,
    'listbox|select': 0.7, 'checkbox|switch': 0.7, 'checkbox|menuitemcheckbox': 0.7, 'menuitemradio|radio': 0.7,
  };
  function roleSim(a, b) {
    if (!a) return null;
    if (!b) return 0;
    if (a === b) return 1;
    const k = a < b ? a + '|' + b : b + '|' + a;
    if (ROLE_PAIR[k] !== undefined) return ROLE_PAIR[k];
    return FAMILY[a] && FAMILY[a] === FAMILY[b] ? 0.4 : 0;
  }
  const typeCat = t => (/^(text|email|tel|url|password|search|number)$/.test(t) ? 'text'
    : /^(date|datetime-local|month|week|time)$/.test(t) ? 'date' : /^(submit|button|reset|image)$/.test(t) ? 'button' : t);
  const CLICKY_TAGS = /^(a|button|div|span|li|input|summary|label)$/;
  const tagSim = (a, b) => (!a ? null : a === b ? 1 : CLICKY_TAGS.test(a) && CLICKY_TAGS.test(b || '') ? 0.4 : 0);

  function containerSim(a, b) {
    if (!b) return 0;
    const kind = a.kind === b.kind ? 1 : 0.4;
    if (!a.name) return b.name ? kind * 0.8 : kind;
    return kind * (simN(a.name, b.name || '') || 0);
  }
  // Row keys keep their numbers: a different order or account number is a different row, whatever the text says.
  function rowSim(a, b) {
    if (!a) return null;
    if (!b) return 0;
    if (a === b) return 1;
    const ids = s => (s.match(/\d{3,}/g) || []).sort().join(',');
    const ia = ids(a);
    if (ia && ia !== ids(b)) return 0;
    return simN(normText(a), normText(b)) || 0;
  }
  /**
   * The generic label of a control repeated once per row, from its labels in several rows (labels[0] is the
   * control's own). Words every label shares at the start and at the end stay, the rest is record data:
   * "Actions for load 1066" / "… 1065" → "Actions for load …"; "Edit Marcus Reed" / "Edit Ana Lopez" → "Edit …".
   * Same label in every row ("Dispatch", "⋯"): same, label as is. Nothing shared ("1066" / "1065", company names),
   * or a link whose shared words are fewer than its varying ones: data (the caller names it by its column).
   * pre / suf: the shared parts normalized, for labelFits(). Pure.
   */
  function rowPattern(labels, role) {
    const ws = labels.map(l => clean(l).split(' ').filter(Boolean));
    const k = w => normText(w, true);
    if (labels.every(l => normText(l, true) === normText(labels[0], true))) return { label: cut(clean(labels[0]), 70), pre: normText(labels[0]), suf: '', same: true };
    const min = Math.min(...ws.map(w => w.length));
    let pre = 0, suf = 0;
    while (pre < min && ws.every(w => k(w[pre]) === k(ws[0][pre]))) pre++;
    while (suf < min - pre && ws.every(w => k(w[w.length - 1 - suf]) === k(ws[0][ws[0].length - 1 - suf]))) suf++;
    const own = ws[0], varying = own.length - pre - suf;
    if ((!pre && !suf) || (role === 'link' && pre + suf < varying)) return { label: '', pre: '', suf: '', data: true };
    const P = own.slice(0, pre).join(' '), Q = own.slice(own.length - suf).join(' ');
    return { label: cut([P, '…', Q].filter(Boolean).join(' '), 70), pre: normText(P), suf: normText(Q) };
  }
  /** Does a label fit a row pattern (rowPattern's pre / suf, or a data column: any label)? Pure. */
  function labelFits(ro, name) {
    if (!ro || ro.data) return true;
    // The pattern was made from redacted labels (rowInfo: "DT-000172" → "DT-…"): compare like with like.
    const n = normText(redact(name));
    if (ro.same) return n === ro.pre;
    return (!ro.pre || n === ro.pre || n.startsWith(ro.pre + ' ')) && (!ro.suf || n === ro.suf || n.endsWith(' ' + ro.suf));
  }
  const twinSim = (a, b) => (a.index === b.index ? 1 : a.count - a.index === b.count - b.index ? 0.5 : 0);
  const nameSim = (fp, c) => simN(fp.name, fp.trunc ? (c.name || '').slice(0, fp.name.length + 2) : c.name);

  /**
   * Normalized weighted similarity (research/04 §4.4–5), 0..1. fp is the stored fingerprint,
   * c the candidate's features (same shape, plus twin and selHit computed at resolve time).
   * Features missing from fp are skipped; features fp has but c lacks count as 0.
   * opts.cheap skips the expensive context features (heading, neighbors, row) for a first pass.
   */
  function scoreFeatures(fp, c, opts) {
    const cheap = !!(opts && opts.cheap);
    const inRow = !!(fp.row && fp.row.key);
    let num = 0, den = 0;
    const add = (w, sim) => { if (sim === null || sim === undefined) return; num += w * sim; den += w; };
    add(3, eq(fp.testid, c.testid));
    add(3, fp.name ? nameSim(fp, c) : null);
    const row = !cheap && inRow ? rowSim(fp.row.key, c.row && c.row.key) : null;
    add(2.5, row);
    add(2, fp.container ? containerSim(fp.container, c.container) : null);
    add(1.5, roleSim(fp.role, c.role));
    add(1.5, eq(fp.type, c.type));
    add(1.5, eq(fp.nameAttr, c.nameAttr));
    if (!cheap) add(1.5, fp.heading ? simN(fp.heading, c.heading || '') || 0 : null);
    if (!cheap) add(1.5, fp.neighbors && fp.neighbors.length ? wordOverlap(fp.neighbors, c.neighbors) : null);
    add(1, fp.id ? (c.id === fp.id ? 1 : c.id && levRatio(fp.id, c.id) >= 0.8 ? 0.5 : 0) : null);
    add(1, simN(fp.ariaLabel, c.ariaLabel));
    add(1, simN(fp.placeholder, c.placeholder));
    add(1, eq(fp.autocomplete, c.autocomplete));
    add(1, simN(fp.ownText, c.ownText));
    add(1, eq(fp.icon, c.icon));
    add(1, fp.ancestry && fp.ancestry.length ? lcsRatio(fp.ancestry, c.ancestry || []) : null);
    // In a list the position says nothing (rows get sorted and inserted): the row key decides.
    add(1, !inRow && fp.twin && fp.twin.count > 1 && c.twin ? twinSim(fp.twin, c.twin) : null);
    add(1, typeof c.selHit === 'number' ? c.selHit : null);
    add(0.75, fp.classes && fp.classes.length ? jaccard(fp.classes, c.classes) : null);
    add(0.75, simN(fp.href, c.href));
    add(0.5, tagSim(fp.tag, c.tag));
    add(0.5, simN(fp.title, c.title));
    let s = den ? num / den : 0;
    if (fp.role && c.role && FAMILY[fp.role] && FAMILY[c.role] && FAMILY[fp.role] !== FAMILY[c.role]) s *= 0.5;
    if (fp.type && c.type && typeCat(fp.type) !== typeCat(c.type)) s *= 0.3;
    if (fp.testid && c.testid && fp.testid !== c.testid) s *= 0.6;
    // "Delete" in another record's row is the wrong record, however alike the rest is: never fall back to it.
    if (row !== null && row < 0.5) s *= 0.6;
    return s;
  }

  // Auto-accept needs evidence about the control itself, not only its surroundings: otherwise a
  // sibling in the same toolbar could win while the real target is still loading.
  function identityOK(fp, c) {
    if (fp.testid && c.testid === fp.testid) return true;
    if (fp.id && c.id === fp.id) return true;
    if (fp.nameAttr && c.nameAttr === fp.nameAttr) return true;
    if (c.selHit > 0) return true;
    if (!fp.name && !fp.ariaLabel && !fp.placeholder && !fp.href && !fp.icon) return true; // nothing to go by but context
    return [fp.name && nameSim(fp, c), simN(fp.ariaLabel, c.ariaLabel), simN(fp.placeholder, c.placeholder),
      simN(fp.href, c.href), fp.icon ? (fp.icon === c.icon ? 1 : 0) : null].some(v => v >= 0.6);
  }

  const T_ACCEPT = 0.7, MARGIN = 0.1, T_AMBIG = 0.45, T_OTHER_PAGE = 0.85, T_UNIQUE = 0.55;
  /**
   * The accept rule, given the best candidate {s, c}, the runner-up's score, the threshold for
   * this page and how many candidates share the best one's exact role and name.
   * Returns how it was accepted ('scored' | 'unique-name') or '' (not sure: return null).
   * 'unique-name' covers the same screen for another record (another client's card): the
   * context words differ, but the label is exact and the only one. It is off when the target
   * had a same-named twin when it was recorded, since then the label alone proves nothing.
   */
  function accepts(fp, best, secondScore, need, sameNameCount) {
    if (!best || best.s - secondScore < MARGIN || !identityOK(fp, best.c)) return '';
    if (best.s >= need) return 'scored';
    if (need === T_ACCEPT && best.s >= T_UNIQUE && fp.name && nameSim(fp, best.c) === 1 && fp.role && best.c.role === fp.role
      && !(fp.twin && fp.twin.count > 1) && sameNameCount === 1) return 'unique-name';
    return '';
  }

  // Ids and classes that are generated per render or per build carry no identity.
  function isGuidLike(id) {
    let last = '', transitions = 0;
    for (const ch of id) {
      if (ch === '-' || ch === '_') continue;
      const t = ch >= 'a' && ch <= 'z' ? 'l' : ch >= 'A' && ch <= 'Z' ? 'u' : ch >= '0' && ch <= '9' ? 'd' : 'o';
      if (t === 'l' && last === 'u') { last = t; continue; } // CamelCase is fine
      if (last && last !== t) transitions++;
      last = t;
    }
    return transitions >= id.length / 4;
  }
  function stableId(id) {
    if (!id || id.length > 64) return false;
    if (/\d{3,}|[:.\s]/.test(id)) return false; // React useId (:r1:), long numbers
    if (/(^|[-_])\d+($|[-_])/.test(id)) return false; // render counters: mui-7, rc-tabs-0-tab-1, react-select-2-input
    if (/^(ember|ext-gen|yui|j_id|gwt-uid|uid|cmp)[-_]?\d/i.test(id)) return false;
    if (/^[0-9a-f-]{8,}$/i.test(id)) return false;
    return !isGuidLike(id);
  }
  const STATE_CLASS = /(^|[-_])(active|hover|hovered|focus|focused|selected|disabled|open|opened|closed|expanded|collapsed|visible|hidden|show|shown|loading|checked|pressed|current|highlighted|entering|entered|leaving|exiting|animating|transition)($|[-_])/i;
  function wordLike(c) {
    if (!/^[a-z][a-z_-]{2,}$/i.test(c)) return false;
    const parts = c.split(/[-_]+|(?=[A-Z])/).filter(Boolean);
    return parts.every(p => p.length > 2 && !/[^aeiouy]{4,}/i.test(p));
  }
  function stableClass(c) {
    if (!c || c.length > 48) return '';
    if (/^(css|sc|jsx|svelte|emotion|jss)-/i.test(c) || /^jss\d+$/i.test(c) || /^makeStyles-/i.test(c)) return ''; // CSS-in-JS hashes
    c = c.replace(/_{2,3}[A-Za-z0-9-]{5,}$/, ''); // CSS modules: Button_primary__x7Ab2 -> Button_primary
    if (STATE_CLASS.test(c)) return '';
    return wordLike(c) ? c : '';
  }

  /** The fingerprint to compare with: v2 descriptors carry one; old {sel,text,role} ones get a minimal one. */
  function fpOf(d) {
    if (!d || typeof d !== 'object') return null;
    if (d.fp && typeof d.fp === 'object') return d.fp;
    const text = clean(d.text || '');
    const trunc = /…$/.test(text); // old descriptors cut long names with an ellipsis
    const name = normText(redact(text.replace(/…$/, '')));
    const role = d.role && FAMILY[d.role] ? d.role : ''; // old ones stored tag names (div, li) for generic controls
    if (!name && !role && !(Array.isArray(d.sel) && d.sel.length)) return null;
    return { name, trunc, role, legacy: true };
  }

  // The one "same screen" rule, shared by guide.js, explore.js, content.js, the widget and brain.js:
  // ids become :id ("/invoices/12" = "/invoices/7"), trailing slashes go, route-like query params stay
  // (?page=list), and only "#/" or "#!" hashes are routes ("#top" is not).
  const ROUTE_Q = /^(page|view|tab|section|module|route|p|screen)$/i;
  const ID_SEG = /\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,}|[A-Za-z]{1,8}[-_]?\d{3,}(?:[-_][A-Za-z0-9]+)*)(?=\/|$)/gi;
  // Parsed by hand (no URL object) so it behaves the same in pages, workers and tests.
  const pathKey = p => {
    let s = String(p || '/').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
    const hi = s.indexOf('#');
    const hash = hi >= 0 ? s.slice(hi) : '';
    if (hi >= 0) s = s.slice(0, hi);
    const qi = s.indexOf('?');
    const query = qi >= 0 ? s.slice(qi + 1) : '';
    const path = (qi >= 0 ? s.slice(0, qi) : s).replace(ID_SEG, '/:id').replace(/\/+$/, '') || '/';
    const q = query.split('&').filter(Boolean).map(kv => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; })
      .filter(([k, v]) => ROUTE_Q.test(k) && !/^\d*$/.test(v)).map(([k, v]) => `${k}=${v}`).sort().join('&');
    const h = /^#[!/]/.test(hash) ? hash.split('?')[0].replace(ID_SEG, '/:id').replace(/\/+$/, '') : '';
    return path + (q ? '?' + q : '') + (h.length > 2 ? h : '');
  };

  // The same record screen in another state counts as the same place: a guide recorded on a booked load
  // ("/loads/booked/:id") still runs on an assigned one ("/loads/assigned/:id"). One plain segment may differ.
  const sibling = (a, b) => {
    if (!a.includes(':id') || !b.includes(':id')) return false;
    const x = a.split('/'), y = b.split('/');
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && (x[i] === ':id' || y[i] === ':id' || ++diff > 1)) return false;
    return diff === 1;
  };
  const samePlace = (a, b) => { const x = pathKey(a), y = pathKey(b); return x === y || sibling(x, y); };

  S.pathKey = pathKey;
  S.samePlace = samePlace;
  S._test = { normText, textSim, simN, scoreFeatures, lev, levRatio, redact, stableId, stableClass, fpOf, rowSim, identityOK, accepts, pathKey, samePlace, rowPattern, labelFits };
  S.normText = normText;

  if (!hasDOM) return;

  // =====================================================================================
  // DOM side.
  // =====================================================================================

  const W = root;

  // ---------- one cache per task: dropped at the next microtask ----------
  let T = null;
  function tick() {
    if (!T) {
      T = { roots: new Map(), flags: new Map(), style: new Map(), rect: new Map(), pool: new Map(), feats: new Map(), cont: new Map(), modal: undefined, twins: null, twinsFor: null };
      Promise.resolve().then(() => { T = null; });
    }
    return T;
  }
  function styleOf(el) {
    const t = tick();
    let cs = t.style.get(el);
    if (!cs) {
      try { cs = (el.ownerDocument.defaultView || W).getComputedStyle(el); } catch (e) { cs = {}; }
      t.style.set(el, cs); // live object: always current even when cached
    }
    return cs;
  }

  // ---------- tree helpers: across shadow roots (and, when asked, iframes) ----------
  function parentOf(n, crossFrames) {
    if (n.parentElement) return n.parentElement;
    const p = n.parentNode;
    if (!p) return null;
    if (p.nodeType === 11 && p.host) return p.host;
    if (crossFrames && p.nodeType === 9 && p !== document) {
      try { return (p.defaultView && p.defaultView.frameElement) || null; } catch (e) { return null; }
    }
    return null;
  }
  function closestDeep(el, sel) {
    for (let n = el; n;) {
      const hit = n.closest && n.closest(sel);
      if (hit) return hit;
      const r = n.getRootNode && n.getRootNode();
      n = r && r.host ? r.host : null;
    }
    return null;
  }
  function containsDeep(a, b) {
    if (!a || !b) return false;
    if (a.contains(b)) return true;
    for (let n = b; n; n = parentOf(n, true)) if (n === a) return true;
    return false;
  }

  // ---------- ours / foreign / hidden, inherited down the tree (memoized per task) ----------
  const OURS = 1, FOREIGN = 2, HIDDEN = 4, BAD = OURS | FOREIGN;
  const OUR_TAG = /^scopos-(layer|widget)$/i;
  // Other extensions' UI (assistants, password managers, grammar checkers) is not the product.
  // Only exact prefixes followed by a dash: a bare "lp-" or "gr-" is often the site's own markup.
  const FOREIGN_ID = /^(claude|grammarly|lastpass|onepassword|1password|com-1password|bitwarden|dashlane|honey|loom|darkreader|dark-reader|monica|merlin|sider|maxai)[-_]/i;
  const FOREIGN_TAG = /^(grammarly|loom|monica|sider|merlin|maxai|com-1password|onepassword|bitwarden|lastpass|dashlane|honey|darkreader)-/i;
  function ownFlags(m) {
    if (m.nodeType !== 1) return 0;
    let f = 0;
    if (OUR_TAG.test(m.tagName) || m.hasAttribute('data-scopos-ui')) return OURS;
    if (m.hasAttribute('inert') || m.getAttribute('aria-hidden') === 'true') f |= HIDDEN;
    if ((m.id && FOREIGN_ID.test(m.id)) || FOREIGN_TAG.test(m.tagName)) f |= FOREIGN;
    else {
      const p = m.parentElement, d = m.ownerDocument;
      // An injected widget pinned above everything, at the top of <body>. Only custom elements and
      // shadow hosts: a site's own max-z-index modal root is a plain div.
      if (p && (p === d.body || p === d.documentElement) && (m.tagName.indexOf('-') > 0 || m.shadowRoot)) {
        const cs = styleOf(m);
        if (cs.position === 'fixed' && +cs.zIndex >= 2147480000) f |= FOREIGN;
      }
    }
    return f;
  }
  function flags(el) {
    const t = tick(), chain = [];
    let f = 0;
    for (let n = el; n; n = parentOf(n, true)) {
      const known = t.flags.get(n);
      if (known !== undefined) { f = known; break; }
      chain.push(n);
    }
    for (let i = chain.length - 1; i >= 0; i--) { f |= ownFlags(chain[i]); t.flags.set(chain[i], f); }
    return f;
  }
  const isOurs = el => !!el && (flags(el) & BAD) !== 0;

  // ---------- deep traversal ----------
  function closedOpener() {
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function') {
        return el => chrome.dom.openOrClosedShadowRoot(el);
      }
    } catch (e) { /* no extension API in the page */ }
    return null;
  }
  // Every root to query: the scope, open (and in the extension, closed) shadow roots, same-origin iframes.
  function rootsOf(scope) {
    const t = tick();
    let list = t.roots.get(scope);
    if (list) return list;
    list = [];
    const opener = closedOpener();
    let frames = 0;
    const visit = (node, depth) => {
      list.push(node);
      if (depth > 8 || list.length > 400) return;
      const consider = h => {
        if (OUR_TAG.test(h.tagName) || h.hasAttribute('data-scopos-ui')) return; // never look inside our own UI
        if (h.tagName === 'IFRAME' || h.tagName === 'FRAME') {
          let d = null;
          try { d = h.contentDocument; } catch (e) { /* cross-origin */ }
          if (d && d.documentElement && frames < 50) { frames++; visit(d, depth + 1); }
          return;
        }
        let sr = h.shadowRoot;
        // Closed roots are reachable only from the extension, and in practice only custom elements have them.
        if (!sr && opener && h.tagName.indexOf('-') > 0) { try { sr = opener(h); } catch (e) { sr = null; } }
        if (sr) visit(sr, depth + 1);
      };
      if (node.nodeType === 1) consider(node);
      const all = node.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) consider(all[i]);
    };
    visit(scope, 0);
    t.roots.set(scope, list);
    return list;
  }
  function queryAll(selector, scope) { // throws on a bad selector
    const out = [];
    for (const r of rootsOf(scope || document)) {
      const found = r.querySelectorAll(selector);
      for (let i = 0; i < found.length; i++) {
        const el = found[i];
        if (!(el.closest && el.closest('[data-scopos-ui],scopos-layer,scopos-widget'))) out.push(el);
      }
    }
    return out;
  }
  /** querySelectorAll through open shadow roots and same-origin iframes. Never returns our own UI. */
  function deepQueryAll(selector, scope) {
    try { return queryAll(selector, scope || document); } catch (e) { return []; }
  }

  // ---------- geometry and visibility ----------
  /** Bounding rect in the coordinates of the window this script runs in (iframe offsets added). */
  // getBoundingClientRect, cached for the task (internal use only: callers that scroll need fresh values).
  function box(el) {
    const t = tick();
    let r = t.rect.get(el);
    if (!r) { r = el.getBoundingClientRect(); t.rect.set(el, r); }
    return r;
  }
  function rectOf(el, cached) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = cached ? box(el) : el.getBoundingClientRect();
    let x = r.left, y = r.top, w = r.width, h = r.height;
    let doc = el.ownerDocument;
    for (let i = 0; i < 10 && doc && doc !== document; i++) {
      let fe = null;
      try { fe = doc.defaultView && doc.defaultView.frameElement; } catch (e) { fe = null; }
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      let pl = 0, pt = 0;
      try { const cs = (fe.ownerDocument.defaultView || W).getComputedStyle(fe); pl = parseFloat(cs.paddingLeft) || 0; pt = parseFloat(cs.paddingTop) || 0; } catch (e) { /* detached */ }
      // A transformed iframe scales its content: compare drawn size with layout size.
      const sx = fe.offsetWidth ? fr.width / fe.offsetWidth : 1, sy = fe.offsetHeight ? fr.height / fe.offsetHeight : 1;
      x = fr.left + (fe.clientLeft + pl) * sx + x * sx;
      y = fr.top + (fe.clientTop + pt) * sy + y * sy;
      w *= sx; h *= sy;
      doc = fe.ownerDocument;
    }
    return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y };
  }
  const inViewport = r => r.bottom > 0 && r.top < W.innerHeight && r.right > 0 && r.left < W.innerWidth;

  const CLIP_HIDDEN = /^rect\(\s*[01]px,?\s*[01]px,?\s*[01]px,?\s*[01]px\s*\)$/;
  /** Rendered, at least 3x3, not under inert or aria-hidden, not faded out or clipped away. */
  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    const r = box(el); // size and page position do not change with scrolling, so the task cache is safe here
    if (r.width < 3 || r.height < 3) return false;
    const win = el.ownerDocument.defaultView || W;
    // Pushed past the page's top or left edge (an off-canvas drawer): it can never be scrolled to.
    if (r.right + (win.scrollX || 0) <= 0 || r.bottom + (win.scrollY || 0) <= 0) return false;
    if (flags(el) & HIDDEN) return false;
    if (typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true, checkOpacity: true, checkVisibilityCSS: true })) return false;
    const cs = styleOf(el);
    if (cs.display === 'none' || (cs.visibility && cs.visibility !== 'visible') || +cs.opacity <= 0.05) return false;
    if (cs.clip && CLIP_HIDDEN.test(cs.clip)) return false;
    return true;
  }

  function deepHit(doc, x, y) {
    let h = doc.elementFromPoint(x, y);
    for (let i = 0; h && h.shadowRoot && i < 20; i++) {
      const inner = h.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === h) break;
      h = inner;
    }
    return h;
  }
  /**
   * Covered by something else at its center and at all four inset corners (Vimium's rule:
   * a point is fine when the hit is the element, inside it, or contains it). Our own UI never
   * counts as covering. Points outside the viewport are not tested; if none is left, not occluded.
   */
  function isOccluded(el) {
    if (!el || !el.isConnected) return false;
    const doc = el.ownerDocument, win = doc.defaultView || W;
    const r = el.getBoundingClientRect();
    const ix = Math.min(4, r.width / 4), iy = Math.min(4, r.height / 4);
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + ix, r.top + iy], [r.right - ix, r.top + iy], [r.left + ix, r.bottom - iy], [r.right - ix, r.bottom - iy]];
    let tested = 0;
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight) continue;
      tested++;
      const hit = deepHit(doc, x, y);
      if (!hit || hit === el || containsDeep(el, hit) || containsDeep(hit, el) || (flags(hit) & OURS)) return false;
    }
    return tested > 0;
  }

  // ---------- what counts as a control ----------
  const NATIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary';
  const ROLE_LIST = ['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch',
    'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem'];
  const ROLES = ROLE_LIST.map(r => `[role=${r}]`).join(',');
  const CONTROL = [NATIVE, 'details', 'label', ROLES, '[role=gridcell][tabindex]:not([tabindex="-1"])', '[role=gridcell][aria-selected]',
    '[contenteditable]:not([contenteditable=false])', '[onclick]', '[tabindex]:not([tabindex="-1"])', '[jsaction*="click"]', '[ng-click]',
    '[data-ng-click]', '[aria-haspopup]:not([aria-haspopup=false])'].join(',');
  // Click handlers attached from JS leave no trace in the markup; these few class-named boxes are
  // checked for cursor:pointer (outermost only), instead of reading the style of every div.
  const POINTERISH = 'div[class*="btn" i],span[class*="btn" i],li[class*="btn" i],div[class*="button" i],span[class*="button" i],li[class*="button" i],[class*="clickable" i]';
  const INNER = NATIVE + ',' + ROLES;
  const INTERACTIVE_ROLE = new RegExp(`^(${ROLE_LIST.join('|')}|gridcell)$`);
  // Composite widgets that legitimately contain other controls (a tab with a close button, a select with a hidden input).
  const KEEP_ROLES = /^(combobox|tab|option|treeitem|menuitem|menuitemcheckbox|menuitemradio|switch|checkbox|radio|slider|spinbutton|textbox|searchbox|gridcell|row)$/;
  const NAMELESS_OK = /^(textbox|searchbox|combobox|spinbutton|select|checkbox|radio|switch|slider|file)$/;
  const SVG_MAX = 12; // controls taken from inside one inline SVG drawing

  const explicitRole = el => (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
  function roleOf(el) {
    const r = explicitRole(el);
    if (r && r !== 'none' && r !== 'presentation' && r !== 'generic') return r;
    switch (el.tagName) {
      case 'A': return el.hasAttribute('href') ? 'link' : 'button';
      case 'BUTTON': case 'SUMMARY': case 'DETAILS': return 'button';
      case 'SELECT': return 'select';
      case 'TEXTAREA': return 'textbox';
      // Regions the explorer names in the map ("look at the list" steps point at them).
      case 'TABLE': return 'table';
      case 'UL': case 'OL': return 'list';
      case 'INPUT': {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', file: 'file', number: 'spinbutton', search: 'searchbox' }[type]
          || (el.hasAttribute('list') ? 'combobox' : 'textbox');
      }
      case 'LABEL': { const c = el.control; return c && c !== el ? roleOf(c) : 'button'; } // stands in for a hidden control
      default: return el.isContentEditable ? 'textbox' : 'button'; // a clickable div, span or li
    }
  }
  const typeOf = el => (el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName === 'BUTTON' ? (el.getAttribute('type') || 'submit').toLowerCase() : '');

  // Text fields of any kind: their content is what the user typed, so it is never read.
  function textboxLike(el) {
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return !/^(checkbox|radio|submit|button|reset|image|range|color|file)$/i.test(el.type || '');
    if (el.isContentEditable) return true;
    return /^(textbox|combobox|searchbox|spinbutton)$/.test(explicitRole(el));
  }
  const NO_CONTENT = /^(textbox|combobox|searchbox|spinbutton|listbox|slider|grid|tree|treegrid|menu|menubar|toolbar|tablist|radiogroup|group|dialog|alertdialog|region|navigation|progressbar|scrollbar|table|list)$/;
  const generic = el => !el.hasAttribute('role') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL|DETAILS)$/.test(el.tagName) && !el.isContentEditable;
  // "More than max characters of text", without building the subtree's string: Google-style apps put
  // click handlers on huge wrappers, and textContent of each one on every scan is O(nodes x depth).
  // Many children means a region, not a control; otherwise text nodes are summed until max is passed.
  function longText(el, max) {
    if (el.childElementCount > 30) return true;
    let n = 0, seen = 0;
    const w = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      n += t.data.length;
      if (n > max || ++seen > max) return true; // hundreds of text nodes: a region too
    }
    return false;
  }

  /** Visible controls in scope, after the duplicate and wrapper rules. Cached per task. */
  function controls(scope) {
    const t = tick(), key = scope || document;
    const cached = t.pool.get(key);
    if (cached) return cached;
    const raw = deepQueryAll(CONTROL + ',' + POINTERISH, key);
    const keep = [], set = new Set(), perSvg = new Map();
    for (const el of raw) {
      if (set.has(el) || (flags(el) & BAD)) continue;
      // Inside an inline SVG (a chart, a map with thousands of titled points): only an explicit button or link
      // counts, at most SVG_MAX per drawing. Every focusable dot read as a control froze a scan for seconds.
      if (el.ownerSVGElement) {
        if (!/^(button|link|tab|menuitem|checkbox|radio|switch)$/.test(explicitRole(el))) continue;
        let svg = el.ownerSVGElement;
        while (svg.ownerSVGElement) svg = svg.ownerSVGElement;
        const n = (perSvg.get(svg) || 0) + 1;
        perSvg.set(svg, n);
        if (n > SVG_MAX) continue;
      }
      const tag = el.tagName;
      if (tag === 'LABEL') {
        // A label is listed only for a control that is itself hidden (styled checkboxes and switches).
        const c = el.control;
        if (!c || c === el || isVisible(c)) continue;
      } else if (tag === 'DETAILS') {
        if (el.querySelector(':scope > summary')) continue;
      }
      if (!el.matches(CONTROL)) {
        if (styleOf(el).cursor !== 'pointer') continue;
        const p = parentOf(el, false);
        if (p && p.nodeType === 1 && styleOf(p).cursor === 'pointer') continue;
      }
      if (!isVisible(el)) continue;
      // can't be clicked: not interactive. Except a disabled control (UI kits set pointer-events: none on it): the form's
      // «Submit» or «Create batch» waits for a choice, and a guide must still know it is there (state "disabled").
      if (styleOf(el).pointerEvents === 'none' && !(el.disabled === true || el.getAttribute('aria-disabled') === 'true')) continue;
      if (generic(el) && longText(el, 200)) continue; // a focusable region or card, not a control
      set.add(el);
      keep.push(el);
    }
    const out = keep.filter(el => !nestedDuplicate(el, set) && !redundantWrapper(el, set));
    t.pool.set(key, out);
    return out;
  }
  // Something inside a link or button is the same click target, unless it is a control of its own.
  function nestedDuplicate(el, set) {
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) return false;
    if (el.hasAttribute('aria-label') || INTERACTIVE_ROLE.test(explicitRole(el))) return false;
    const p = parentOf(el, false);
    const anc = p && closestDeep(p, 'a[href],button,[role=button],[role=link],[role=combobox]');
    return !!anc && set.has(anc);
  }
  // A box whose only job is to hold another control we already list. Counted against visible
  // listed controls only (a hidden input inside a custom select does not make it a wrapper).
  function redundantWrapper(el, set) {
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName) || el.isContentEditable) return false;
    const role = explicitRole(el);
    if (KEEP_ROLES.test(role)) return false;
    const inner = [];
    for (const x of el.querySelectorAll(INNER)) if (x !== el && set.has(x)) { inner.push(x); if (inner.length > 1) break; }
    if (!inner.length) return false;
    if (el.tagName === 'LABEL') { const r = roleOf(el); return inner.some(x => roleOf(x) === r); }
    if (!role || role === 'none' || role === 'presentation' || role === 'group') return true;
    return inner.length === 1 && normText(rawName(inner[0])) === normText(rawName(el));
  }

  // Playwright-style retargeting: a click on the icon inside a button is a click on the button.
  const RETARGET = 'a[href],button,summary,label,' + ROLES;
  function retarget(el) {
    if (!el || el.nodeType !== 1) return null;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return el;
    if (el.isContentEditable) return closestDeep(el, '[contenteditable]:not([contenteditable=false])') || el;
    let t = closestDeep(el, RETARGET) || el;
    if (t.tagName === 'LABEL' && t.control && t.control !== t && isVisible(t.control)) t = t.control;
    return t;
  }

  // ---------- names (accname order, simplified) ----------
  function textOfNode(n) {
    if (!n || textboxLike(n)) return '';
    if (!n.querySelector || !n.querySelector('select,textarea,input,option,[contenteditable]:not([contenteditable=false])')) return n.textContent || '';
    const copy = n.cloneNode(true);
    copy.querySelectorAll('select,textarea,input,option,[contenteditable]:not([contenteditable=false])').forEach(x => x.remove());
    return copy.textContent || '';
  }
  // A label that wraps its control also contains the control's own text (a select's options): leave that out.
  function labelText(l) {
    if (!l.querySelector('select,textarea,input,option,button,[contenteditable]')) return l.textContent || '';
    const copy = l.cloneNode(true);
    copy.querySelectorAll('select,textarea,input,option,button,[contenteditable]').forEach(n => n.remove());
    return copy.textContent || '';
  }
  function contentText(el) {
    const tc = el.textContent || '';
    if (!tc.trim()) return '';
    if (el.childElementCount && el.querySelector('[contenteditable]:not([contenteditable=false]),textarea,select')) return textOfNode(el).slice(0, 400);
    // A tab or card with its own buttons inside («Вкладка ×»): those are controls of their own, not part of the name.
    if (el.childElementCount && tc.length <= 400 && el.querySelector('button,[role=button]')) {
      const copy = el.cloneNode(true);
      copy.querySelectorAll('button,[role=button]').forEach(n => n.remove());
      const t = clean(copy.textContent);
      if (t) return t;
    }
    // innerText leaves out hidden text (a closed dropdown inside a button) but costs layout: not for big subtrees.
    return tc.length > 400 || el.innerText === undefined ? tc.slice(0, 400) : el.innerText;
  }
  function iconHint(el) {
    const words = s => clean(String(s || '').replace(/^(icon|ic|svg|i)[-_]/i, '').replace(/[-_]+/g, ' ')).toLowerCase();
    const use = el.querySelector('use');
    const href = use && (use.getAttribute('href') || use.getAttribute('xlink:href'));
    if (href && href.indexOf('#') >= 0) return words(href.split('#').pop()).slice(0, 30);
    const di = el.hasAttribute('data-icon') ? el : el.querySelector('[data-icon]');
    if (di) return words(di.getAttribute('data-icon')).slice(0, 30);
    const ICON = '[class*="icon-"],[class*="fa-"],[class*="bi-"],[class*="mdi-"],[class*="lucide-"],[class*="ti-"]';
    const c = el.matches(ICON) ? el : el.querySelector(ICON);
    const m = c && String(c.getAttribute('class') || '').match(/(?:^|\s)(?:icon|fa|bi|mdi|lucide|ti|glyphicon)-([a-z][a-z0-9-]{1,30})/i);
    if (m && !/^(solid|regular|light|thin|duotone|brands|lg|sm|xs|[1-9]x|fw|spin|pulse|border|inverse|stack)$/i.test(m[1])) return words(m[1]);
    return '';
  }
  function byIds(el, attr) {
    const ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    const rn = el.getRootNode ? el.getRootNode() : el.ownerDocument;
    return clean(ids.map(id => {
      const n = (rn && rn.getElementById ? rn.getElementById(id) : null) || el.ownerDocument.getElementById(id);
      return n && n !== el ? textOfNode(n) : ''; // a combobox naming itself would read out its own value
    }).join(' '));
  }
  /** The accessible name, unredacted. Never the value or text of a text field. */
  function rawName(el) {
    const by = byIds(el, 'aria-labelledby');
    if (by) return by;
    const al = clean(el.getAttribute('aria-label'));
    if (al) return al;
    const tag = el.tagName;
    if (tag === 'LABEL') return clean(labelText(el));
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map(labelText).join(' '));
      if (t) return t;
    }
    if (tag === 'INPUT') {
      const type = (el.type || '').toLowerCase();
      if (/^(submit|button|reset)$/.test(type)) { const t = clean(el.value || el.getAttribute('value')); if (t) return t; } // a button's label, not user data
      if (type === 'image') { const t = clean(el.getAttribute('alt')); if (t) return t; }
    }
    if (tag === 'IMG' || tag === 'AREA') { const t = clean(el.getAttribute('alt')); if (t) return t; }
    if (tag === 'TABLE' && el.caption) { const t = clean(el.caption.textContent); if (t) return t; }
    // A table or a list is named by its caption or label, never by all the rows in it.
    const ownRole = explicitRole(el) || (tag === 'TABLE' ? 'table' : tag === 'UL' || tag === 'OL' ? 'list' : '');
    if (!textboxLike(el) && tag !== 'SELECT' && !NO_CONTENT.test(ownRole)) {
      const t = clean(contentText(el));
      if (t) return t;
      const img = el.querySelector('img[alt],svg[aria-label],[role=img][aria-label],svg title');
      if (img) { const s = clean(img.getAttribute('alt') || img.getAttribute('aria-label') || img.textContent); if (s) return s; }
    }
    const title = clean(el.getAttribute('title'));
    if (title) return title;
    const ph = clean(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder'));
    if (ph) return ph;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return clean(el.getAttribute('name')); // developer vocabulary, last resort
    return '';
  }
  /** The name as shown to the model and written into steps: personal data replaced with "…". */
  const labelOf = el => (el && el.nodeType === 1 ? redact(rawName(el)) : '');

  // ---------- context: container, heading, neighbors, row ----------
  const CONTAINER = 'dialog,[role=dialog],[role=alertdialog],form,[role=form],[role=search],fieldset,[role=group][aria-label],[role=group][aria-labelledby],'
    + 'section,[role=region],nav,[role=navigation],aside,[role=complementary],[role=tabpanel],[role=menu],[role=menubar],[role=listbox],[role=toolbar],'
    + '[role=tablist],header,[role=banner],footer,[role=contentinfo],main,[role=main]';
  const KIND = {
    dialog: 'dialog', alertdialog: 'dialog', form: 'form', search: 'form', fieldset: 'group', group: 'group', section: 'region', region: 'region',
    nav: 'nav', navigation: 'nav', aside: 'aside', complementary: 'aside', tabpanel: 'tabpanel', menu: 'menu', menubar: 'menu', listbox: 'listbox',
    toolbar: 'toolbar', tablist: 'tablist', header: 'header', banner: 'header', footer: 'footer', contentinfo: 'footer', main: 'main',
  };
  const KIND_LABEL = { nav: 'navigation', header: 'header', aside: 'sidebar', main: 'main', form: 'form', footer: 'footer', dialog: 'dialog', menu: 'menu', toolbar: 'toolbar', tablist: 'tabs' };
  const HEADING = 'h1,h2,h3,h4,h5,h6,[role=heading],legend';
  const ROW = 'tr,[role=row],li,[role=listitem]';
  function containerName(box) {
    const by = byIds(box, 'aria-labelledby');
    if (by) return by;
    const al = clean(box.getAttribute('aria-label'));
    if (al) return al;
    const h = box.querySelector(HEADING);
    return h ? clean((h.textContent || '').slice(0, 200)) : '';
  }
  // The closest region around the control (never the control's own aria-label). An unnamed
  // region (a bare form inside "Смена пароля") takes the name of the nearest named one around it.
  function containerOf(el) {
    const p = parentOf(el, false);
    const box = p && closestDeep(p, CONTAINER);
    if (!box) {
      // Inside a same-origin iframe: the region around the iframe.
      let fe = null;
      try { fe = el.ownerDocument !== document && el.ownerDocument.defaultView.frameElement; } catch (e) { fe = null; }
      return fe ? containerOf(fe) : null;
    }
    const t = tick();
    let c = t.cont.get(box);
    if (!c) {
      const kind = KIND[explicitRole(box)] || KIND[box.tagName.toLowerCase()] || 'region';
      let name = containerName(box);
      for (let up = box, i = 0; !name && i < 3; i++) {
        const q = parentOf(up, false);
        up = q && closestDeep(q, CONTAINER);
        if (!up) break;
        name = containerName(up);
      }
      name = redact(name);
      c = { el: box, kind, name: cut(name, 60), norm: normText(name).slice(0, 80) };
      t.cont.set(box, c);
    }
    return c;
  }
  const sectionOf = c => (c ? c.name || KIND_LABEL[c.kind] || '' : '');

  const headingText = h => normText(redact((h.textContent || '').slice(0, 200))).slice(0, 80);
  // Nearest heading before the control in reading order: previous siblings, then up the tree.
  // raw: its text as shown (redacted, not normalized).
  function headingBefore(el, raw) {
    const out = h => (raw ? cut(redact(clean((h.textContent || '').slice(0, 200))), 60) : headingText(h));
    let n = el;
    for (let up = 0; n && up < 8; up++) {
      let k = 0;
      for (let s = n.previousElementSibling; s && k < 25; s = s.previousElementSibling, k++) {
        if (s.matches(HEADING)) return out(s);
        if (s.childElementCount) { const hs = s.querySelectorAll(HEADING); if (hs.length) return out(hs[hs.length - 1]); }
      }
      n = parentOf(n, false);
      if (!n || n.tagName === 'BODY') break;
    }
    return '';
  }
  const SKIP_TEXT = /^(script|style|template|textarea|select|noscript|svg|input)$/i;
  function nodeText(node) {
    if (node.nodeType === 3) return node.data;
    if (node.nodeType !== 1 || SKIP_TEXT.test(node.tagName) || node.isContentEditable) return '';
    if (node.childElementCount && node.querySelector('[contenteditable]:not([contenteditable=false])')) return '';
    return (node.textContent || '').slice(0, 200);
  }
  // Similo's neighbor texts: words near the control, without its own words. Collected inside the
  // control's own region or row only, so the rest of the page does not blur them.
  function neighborsOf(el, ownName) {
    const p0 = parentOf(el, false);
    const boundary = p0 && closestDeep(p0, CONTAINER + ',' + ROW);
    const own = new Set((ownName || '').split(' '));
    const out = [], seen = new Set();
    const take = text => {
      for (const w of normText(redact(text)).split(' ')) {
        if (w.length < 2 || w === '#' || own.has(w) || seen.has(w)) continue;
        seen.add(w); out.push(w);
        if (out.length >= 20) return true;
      }
      return false;
    };
    let n = el;
    for (let up = 0; n && up < 3; up++) {
      let prev = n.previousSibling, next = n.nextSibling;
      for (let k = 0; k < 4 && (prev || next); k++) {
        if (prev) { if (take(nodeText(prev))) return out; prev = prev.previousSibling; }
        if (next) { if (take(nodeText(next))) return out; next = next.nextSibling; }
      }
      n = parentOf(n, false);
      if (!n || n === boundary || n.tagName === 'BODY') break;
    }
    return out;
  }
  function rowOf(el) {
    const p = parentOf(el, false);
    const row = p && closestDeep(p, ROW);
    const parent = row && row.parentElement;
    if (!parent) return null;
    let same = 0, index = -1;
    for (const s of parent.children) if (s.tagName === row.tagName) { if (s === row) index = same; same++; }
    if (same < 2) return null;
    const cells = row.children.length ? [...row.children].map(nodeText).join(' ') : nodeText(row);
    let text = clean(cells.slice(0, 400));
    const own = clean(el.textContent || '');
    if (own) text = text.replace(own, ' ');
    const key = normText(redactEmails(text), true).slice(0, 80);
    return key ? { key, index } : null;
  }

  // ---------- row controls: one per row of a data table or list ----------
  // "Actions for load 1066", "Edit Marcus Reed", a record link "1066": the same role at the same place in every
  // row, with a label that differs only by record data. A guide step on one means "this, on the record you need":
  // its descriptor carries fp.rowOf (rowInfo), resolveRow() finds it in ANY row of the same table, and matchRow()
  // tells whether a control the user clicked is one. The sample record the explorer saw is never required.
  const ROW_BOX = 'table,[role=table],[role=grid],[role=treegrid],ul,ol,[role=list],[role=feed]';
  // Navigation, menus, tabs and pagers are lists too, but not of records.
  const ROW_SKIP = 'nav,[role=navigation],[role=menubar],[role=menu],[role=listbox],[role=tablist],[role=tree],[role=toolbar],[role=banner],[aria-label*=breadcrumb i],[class*=pagination i],[class*=pager i]';
  const ROW_CTL = NATIVE + ',' + ROLES + ',[onclick],[tabindex]:not([tabindex="-1"])';
  const isCell = c => /^(TD|TH)$/.test(c.tagName) || /^(cell|gridcell|columnheader|rowheader)$/.test(explicitRole(c));
  const cellsOf = row => [...row.children].filter(isCell);
  const tableRow = row => row.tagName === 'TR' || explicitRole(row) === 'row';
  const rowSig = row => row.tagName.toLowerCase() + (explicitRole(row) ? '@' + explicitRole(row) : '');
  function headerRow(row) {
    if (row.closest('thead')) return true;
    const cs = cellsOf(row);
    return cs.length > 0 && cs.every(c => (c.tagName === 'TH' && c.getAttribute('scope') !== 'row') || explicitRole(c) === 'columnheader');
  }
  function rowBoxOf(row) { const p = row.parentElement; return (p && closestDeep(p, ROW_BOX)) || p; }
  function rowsIn(box, sig) {
    const out = [];
    for (const r of box.querySelectorAll(ROW)) if (rowSig(r) === sig && !headerRow(r) && rowBoxOf(r) === box) out.push(r);
    return out;
  }
  // Controls of one role in a cell or a row, outermost only (the <b> in a link is the link), in document order.
  function ctlsIn(scope, role) {
    const all = [...scope.querySelectorAll(ROW_CTL)].filter(x => !(flags(x) & BAD));
    const set = new Set(all);
    return all.filter(x => {
      if (!/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(x.tagName)) for (let p = x.parentElement; p && p !== scope; p = p.parentElement) if (set.has(p)) return false;
      return roleOf(x) === role;
    });
  }
  /** Where a control sits in its data row: { row, box, col (cell index, -1 in a list), nth (among its role there), role, sig }. */
  function rowPlace(el) {
    const p = parentOf(el, false);
    const row = p && closestDeep(p, ROW);
    if (!row || !row.parentElement || headerRow(row) || closestDeep(row, ROW_SKIP)) return null;
    const box = rowBoxOf(row);
    if (!box || box === document.body) return null;
    let scope = row, col = -1;
    if (tableRow(row)) {
      const cs = cellsOf(row);
      const i = cs.findIndex(c => c === el || c.contains(el));
      if (i >= 0) { scope = cs[i]; col = i; }
    }
    const role = roleOf(el);
    const nth = ctlsIn(scope, role).indexOf(el);
    return nth < 0 ? null : { row, box, col, nth, role, sig: rowSig(row) };
  }
  const boxHeads = box => { // header cells of a table or grid, as shown (redacted)
    const hr = [...box.querySelectorAll('tr,[role=row]')].find(r => headerRow(r) && rowBoxOf(r) === box);
    return hr ? cellsOf(hr).map(c => cut(redact(clean(c.textContent || '')), 40)) : [];
  };
  function boxName(box) {
    if (box.tagName === 'TABLE' && box.caption) { const t = clean(box.caption.textContent); if (t) return cut(redact(t), 60); }
    const n = byIds(box, 'aria-labelledby') || clean(box.getAttribute('aria-label'));
    return n ? cut(redact(n), 60) : headingBefore(box, true);
  }
  const rowText = row => clean((row.children.length ? [...row.children].map(nodeText).join(' ') : nodeText(row)).slice(0, 400));
  const ROW_SAMPLE = 40;
  /**
   * fp.rowOf for a control repeated per row, or null: { box: { tag, role, name, head, id, testid }, row, col, hcol,
   * nth, role, pre, suf, same?, data?, label }. label: the generic label shown in the map ("Actions for load …",
   * "Edit …"; a data column's header such as "Load #", else the table's name). Cached per table and place per task.
   */
  function rowInfo(el) {
    const pl = rowPlace(el);
    if (!pl) return null;
    const t = tick();
    if (!t.rowg) t.rowg = new Map();
    let byBox = t.rowg.get(pl.box);
    if (!byBox) t.rowg.set(pl.box, (byBox = new Map()));
    const gk = `${pl.sig}|${pl.col}|${pl.nth}|${pl.role}`;
    let g = byBox.get(gk);
    if (g === undefined) {
      g = null;
      const labels = [];
      let others = 0, extra = false;
      for (const r of rowsIn(pl.box, pl.sig).slice(0, ROW_SAMPLE)) {
        const scope = pl.col >= 0 ? cellsOf(r)[pl.col] : r;
        const x = scope && ctlsIn(scope, pl.role)[pl.nth];
        if (!x) continue;
        const name = redact(nameOf(x));
        if (r === pl.row) labels.unshift(name); else { labels.push(name); others++; }
        if (!extra && rowText(r).length > clean(name).length + 3) extra = true; // the row holds more than this control
      }
      if (others && labels.length >= 2) {
        const pat = rowPattern(labels.slice(0, 1 + others), pl.role);
        // A list whose rows are nothing but differently named links is a menu of screens, not of records.
        if (!(pat.data && !tableRow(pl.row) && !extra)) {
          const heads = boxHeads(pl.box), name = boxName(pl.box) || '';
          const tid = testIdOf(pl.box);
          // Record data under a header that is data too (a board's day columns: "Sat Oct 17"): any such column.
          const anyCol = !!(pat.data && pl.col >= 0 && /\d/.test(heads[pl.col] || ''));
          g = {
            box: { tag: pl.box.tagName.toLowerCase(), role: explicitRole(pl.box) || undefined, name: normText(name).slice(0, 60) || undefined,
              head: heads.length ? heads.slice(0, 16).map(h => normText(h).slice(0, 40)) : undefined,
              id: pl.box.id && stableId(pl.box.id) ? pl.box.id : undefined, testid: tid || undefined },
            row: pl.sig, col: anyCol ? -2 : pl.col, hcol: !anyCol && pl.col >= 0 && heads[pl.col] ? normText(heads[pl.col]).slice(0, 40) : undefined,
            nth: anyCol ? -1 : pl.nth, role: pl.role, pre: pat.pre, suf: pat.suf, same: pat.same || undefined, data: pat.data || undefined,
            label: pat.data ? (!anyCol && pl.col >= 0 && heads[pl.col]) || name || 'row' : pat.label || (pl.role === 'link' ? 'link' : 'button'),
          };
        }
      }
      byBox.set(gk, g);
    }
    return g ? JSON.parse(JSON.stringify(g)) : null; // a copy: callers keep it in descriptors
  }

  // ---------- finding a row control again, in any row ----------
  function boxScore(ro, box) {
    let num = 0, den = 0;
    const add = (w, s) => { if (s === null || s === undefined) return; num += w * s; den += w; };
    const b = ro.box || {};
    add(2, b.head && b.head.length ? jaccard(b.head.filter(Boolean), boxHeads(box).map(h => normText(h)).filter(Boolean)) || 0 : null);
    add(1.5, b.name ? simN(b.name, normText(boxName(box))) || 0 : null);
    add(0.5, b.tag ? (b.tag === box.tagName.toLowerCase() ? 1 : 0) : null);
    add(2, b.id ? (box.id === b.id ? 1 : 0) : null);
    add(2, b.testid ? (testIdOf(box) === b.testid ? 1 : 0) : null);
    return den ? num / den : 0;
  }
  /** Tables or lists on the page that are the one a row descriptor was made in, best first. Cached per task. */
  function boxesFor(ro) {
    const t = tick();
    if (!t.boxes) t.boxes = new Map();
    const memo = JSON.stringify([ro.box, ro.row]);
    if (t.boxes.has(memo)) return t.boxes.get(memo);
    const modal = topModal();
    let cands = deepQueryAll(ROW_BOX).filter(b => !(flags(b) & BAD) && (!modal || containsDeep(modal, b)) && !closestDeep(b, ROW_SKIP) && isVisible(b) && rowsIn(b, ro.row).length);
    let out = cands.map(b => ({ b, s: boxScore(ro, b) })).filter(x => x.s >= 0.6).sort((x, y) => y.s - x.s).map(x => x.b);
    if (!out.length && cands.length === 1 && !(ro.box && ro.box.head && ro.box.head.length)) out = cands; // the only list on the page
    t.boxes.set(memo, out);
    return out;
  }
  // The column in this table: by its header when the columns moved, else by position.
  function colIn(ro, box) {
    if (ro.col < 0) return -1;
    if (ro.hcol) { const i = boxHeads(box).map(h => normText(h)).indexOf(ro.hcol); if (i >= 0) return i; }
    return ro.col;
  }
  // The row control in one row: at its place (same cell, same rank among its role) with a fitting label; else
  // the only fitting one of its role in the cell or the row. A data column (any label) is taken by place only.
  function pickInRow(ro, row, col) {
    const fits = x => labelFits(ro, nameOf(x));
    const scope = col >= 0 ? cellsOf(row)[col] : row;
    if (scope) {
      const list = ctlsIn(scope, ro.role), x = list[ro.nth];
      if (x && fits(x)) return x;
      if (!ro.data) { const f = list.filter(fits); if (f.length === 1) return f[0]; }
    }
    if (!ro.data && scope !== row) { const f = ctlsIn(row, ro.role).filter(fits); if (f.length === 1) return f[0]; }
    return null;
  }
  // Every match in one row: an any-column descriptor (col -2) takes its role in every cell under a data header.
  function rowCands(ro, row, box, col) {
    if (ro.col !== -2) { const x = pickInRow(ro, row, col); return x ? [x] : []; }
    const heads = boxHeads(box), out = [];
    cellsOf(row).forEach((c, i) => { if (!heads.length || /\d/.test(heads[i] || '')) out.push(...ctlsIn(c, ro.role)); });
    return out;
  }
  const rowOfDesc = d => (d && d.fp && d.fp.rowOf) || (d && d.rowOf) || null;
  /** The data row around a node, for "the row the user picked": { row, key } or null. */
  function rowAt(node) {
    const n = node && node.nodeType === 1 ? node : node && node.parentElement;
    const row = n && closestDeep(n, ROW);
    if (!row || headerRow(row) || closestDeep(row, ROW_SKIP) || isOurs(row)) return null;
    return { row, key: normText(redactEmails(rowText(row)), true).slice(0, 80) };
  }
  /**
   * Every visible match of a row descriptor, in page order, from the best-matching table that has any: { el, els }.
   * el: the one to point at: in the row opts.prefer names ({ row } still on the page, or its { key }), else the first
   * in the viewport, else the first.
   */
  function resolveRow(d, opts) {
    const ro = rowOfDesc(d);
    if (!ro) return { el: null, els: [] };
    const els = [];
    for (const box of boxesFor(ro)) {
      const col = colIn(ro, box);
      for (const r of rowsIn(box, ro.row)) {
        for (const x of rowCands(ro, r, box, col)) if (!(flags(x) & BAD) && isVisible(x) && styleOf(x).pointerEvents !== 'none') els.push(x);
      }
      if (els.length) break;
    }
    const pref = opts && opts.prefer;
    let el = null;
    if (pref && pref.row && pref.row.isConnected) el = els.find(x => containsDeep(pref.row, x)) || null;
    if (!el && pref && pref.key) el = els.find(x => { const a = rowAt(x); return a && (a.key === pref.key || rowSim(pref.key, a.key) >= 0.8); }) || null;
    if (!el) el = els.find(x => inViewport(rectOf(x, true))) || els[0] || null;
    return { el, els };
  }
  /** The row control the user clicked, when node is (inside) one that matches the descriptor; else null. */
  function matchRow(d, node) {
    const ro = rowOfDesc(d);
    if (!ro || !node) return null;
    const el = retarget(node.nodeType === 1 ? node : node.parentElement);
    if (!el || (flags(el) & BAD)) return null;
    const pl = rowPlace(el);
    if (!pl || pl.sig !== ro.row || pl.role !== ro.role || !boxesFor(ro).includes(pl.box)) return null;
    return rowCands(ro, pl.row, pl.box, colIn(ro, pl.box)).includes(el) ? el : null;
  }

  // ---------- features of one element (cheap part cached per task, context added on demand) ----------
  const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
  function testIdOf(el) {
    for (const a of TESTID_ATTRS) { const v = el.getAttribute(a); if (v) return v; }
    return '';
  }
  function hrefOf(el) {
    if (el.tagName !== 'A') return '';
    const h = el.getAttribute('href');
    if (!h || /^(javascript:|mailto:|tel:|#$)/i.test(h)) return '';
    try {
      const u = new URL(h, el.baseURI);
      let p = u.origin === location.origin ? u.pathname : u.host + u.pathname;
      if (/^#[!/]/.test(u.hash)) p += u.hash.split('?')[0];
      return normText(redact(p)).slice(0, 120);
    } catch (e) { return ''; }
  }
  function classesOf(el) {
    const raw = String(el.getAttribute('class') || '').split(/\s+/);
    const out = new Set();
    for (const c of raw) { const s = stableClass(c); if (s) out.add(s); }
    return [...out].sort().slice(0, 8);
  }
  function ancestry(el) {
    const out = [];
    for (let p = parentOf(el, false); p && out.length < 6; p = parentOf(p, false)) {
      if (p.tagName === 'BODY' || p.tagName === 'HTML') break;
      const r = explicitRole(p), tid = testIdOf(p);
      out.push(p.tagName.toLowerCase() + (r ? '@' + r : '') + (p.id && stableId(p.id) ? '#' + p.id : '') + (tid ? '[' + tid + ']' : ''));
    }
    return out;
  }
  const normAttr = (el, a) => { const v = el.getAttribute(a); return v ? normText(redact(v)) : ''; };
  // Three levels, each computed once per task: base (what the map shows: role, name, section),
  // match attributes (what resolve compares), and context (heading, neighbors, row: the costly part).
  // Names survive between tasks while the element's own text and naming attributes are unchanged:
  // guide steps resolve again on every DOM change, and innerText is the costly part of a scan.
  const nameMemo = new WeakMap();
  function nameOf(el) {
    const tc = el.textContent || '';
    const sig = (el.getAttribute('aria-label') || '') + '\u0001' + (el.getAttribute('aria-labelledby') || '') + '\u0001' + (el.getAttribute('title') || '')
      + '\u0001' + (el.getAttribute('placeholder') || '') + '\u0001' + (tc.length > 300 ? tc.length + tc.slice(0, 300) : tc);
    const m = nameMemo.get(el);
    if (m && m.sig === sig && !(el.labels && el.labels.length)) return m.raw; // labelled controls: the <label> may change, read again
    const raw = rawName(el);
    nameMemo.set(el, { sig, raw });
    return raw;
  }
  function base(el) {
    const t = tick();
    let f = t.feats.get(el);
    if (!f) {
      const display = redact(nameOf(el)), name = normText(display);
      const cont = containerOf(el);
      f = {
        tag: el.tagName.toLowerCase(), role: roleOf(el), type: typeOf(el), name, display, icon: name ? '' : iconHint(el),
        container: cont ? { kind: cont.kind, name: cont.norm } : null, section: sectionOf(cont),
      };
      t.feats.set(el, f);
    }
    return f;
  }
  function feats(el, full) {
    const f = base(el);
    if (!f.attrs) {
      f.attrs = true;
      let ownText = '';
      if (!textboxLike(el) && f.tag !== 'select') {
        const ot = normText(redact((el.textContent || '').slice(0, 200))).slice(0, 120);
        if (ot && ot !== f.name) ownText = ot;
      }
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      Object.assign(f, {
        ownText, testid: testIdOf(el), id: el.id && stableId(el.id) ? el.id : '', nameAttr: el.getAttribute('name') || '',
        ariaLabel: normAttr(el, 'aria-label'), placeholder: normAttr(el, 'placeholder') || normAttr(el, 'aria-placeholder') || normAttr(el, 'data-placeholder'),
        autocomplete: ac === 'on' || ac === 'off' ? '' : ac, title: normAttr(el, 'title'),
        href: hrefOf(el), classes: classesOf(el), ancestry: ancestry(el),
      });
    }
    if (full && !f.full) {
      f.full = true;
      f.heading = headingBefore(el);
      f.neighbors = neighborsOf(el, f.name);
      f.row = rowOf(el);
    }
    return f;
  }
  // Ordinal among visible controls with the same role and name (Playwright's nth, as a last resort).
  // Only the group of the element asked about is built, and only same-role controls are named.
  const twinKey = f => f.role + '|' + (f.name || (f.icon ? 'icon:' + f.icon : ''));
  function twinOf(el, pool) {
    const t = tick(), f = base(el), key = twinKey(f);
    const gk = pool === t.twinsFor ? key : null;
    let g = gk && t.twins && t.twins.get(gk);
    if (!g) {
      g = [];
      for (const x of pool) if (x === el || (roleOf(x) === f.role && twinKey(base(x)) === key)) g.push(x);
      if (!g.includes(el)) return undefined;
      if (t.twinsFor !== pool) { t.twinsFor = pool; t.twins = new Map(); }
      t.twins.set(key, g);
    }
    const i = g.indexOf(el);
    return i < 0 ? undefined : { index: i, count: g.length };
  }

  // ---------- state words ----------
  function stateOf(el) {
    const out = [];
    const ctl = el.tagName === 'LABEL' && el.control ? el.control : el;
    if (ctl.disabled || el.getAttribute('aria-disabled') === 'true' || ctl.getAttribute('aria-disabled') === 'true') out.push('disabled');
    const ex = el.getAttribute('aria-expanded');
    if (ex === 'true') out.push('expanded'); else if (ex === 'false') out.push('collapsed');
    else if (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS') out.push(el.parentElement.open ? 'expanded' : 'collapsed');
    const cur = el.getAttribute('aria-current');
    if (el.getAttribute('aria-selected') === 'true' || (cur && cur !== 'false')) out.push('current');
    if (el.getAttribute('aria-pressed') === 'true') out.push('pressed');
    const ac = ctl.getAttribute('aria-checked');
    if (ctl.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(ctl.type)) out.push(ctl.checked ? 'checked' : 'unchecked');
    else if (ac === 'true') out.push('checked'); else if (ac === 'mixed') out.push('mixed'); else if (ac === 'false') out.push('unchecked');
    if (ctl.required || ctl.getAttribute('aria-required') === 'true') out.push('required');
    if (ctl.getAttribute('aria-invalid') === 'true') out.push('invalid');
    // What the user typed never leaves the page: only whether the field is filled.
    if (textboxLike(ctl)) {
      const v = ctl.tagName === 'INPUT' || ctl.tagName === 'TEXTAREA' ? ctl.value : ctl.isContentEditable ? ctl.textContent : null;
      if (v !== null && v !== undefined) out.push(String(v).trim() ? 'filled' : 'empty');
    }
    return out;
  }
  function selectInfo(el) {
    if (el.tagName !== 'SELECT') return null;
    const all = [...el.options].map(o => cut(redact(o.textContent), 30)).filter(Boolean);
    const so = el.selectedOptions && el.selectedOptions[0];
    return { cur: so ? cut(redact(so.textContent), 30) : '', count: el.options.length, all };
  }

  // ---------- open modal ----------
  function topModal() {
    const t = tick();
    if (t.modal !== undefined) return t.modal;
    let found = null;
    const list = deepQueryAll('dialog[open],[aria-modal="true"]');
    for (let i = list.length - 1; i >= 0 && !found; i--) {
      const d = list[i];
      if (flags(d) & BAD) continue;
      if (d.tagName === 'DIALOG' && d.getAttribute('aria-modal') !== 'true') {
        let modal = false;
        try { modal = d.matches(':modal'); } catch (e) { /* old engine */ }
        if (!modal) continue; // show(), not showModal(): the page stays usable
      }
      if (isVisible(d) && !isOccluded(d)) found = d;
    }
    return (t.modal = found);
  }
  // Inside the dialog, or drawn above it (a dropdown portalled out of the dialog).
  function inModalScope(el, modal) {
    if (containsDeep(modal, el)) return true;
    if (!inViewport(rectOf(el, true))) return false;
    // Inside an iframe the frame's own hit test cannot see the dialog's backdrop: test the iframe itself too.
    for (let n = el; n;) {
      if (isOccluded(n)) return false;
      if (n.ownerDocument === document) break;
      try { n = n.ownerDocument.defaultView.frameElement; } catch (e) { n = null; }
    }
    return true;
  }

  // ---------- stable ids ----------
  // Playwright's ref rule: an element keeps its id while its role and name stay the same; the counter never resets.
  const idMap = new WeakMap();
  let nextId = 0;
  const mkRef = typeof WeakRef === 'function' ? el => new WeakRef(el) : el => ({ deref: () => el });
  let snapshot = new Map();
  // Every id handed out lately, oldest first (a Map keeps insertion order): ids the model saw a few
  // scans ago still resolve, but virtualized lists that mint new ids on every scroll can't grow it forever.
  const everyId = new Map();
  const EVERY_MAX = 2000;
  const idKey = f => f.role + '|' + (f.name || f.icon);
  function idFor(el, f) {
    const key = idKey(f);
    const r = idMap.get(el);
    if (r && r.key === key) return r.id;
    if (r) everyId.delete(r.id); // relabeled (a recycled row): the old id must not lead here any more
    const id = ++nextId;
    idMap.set(el, { id, key });
    return id;
  }
  function remember(id, el) {
    const ref = mkRef(el);
    snapshot.set(id, ref);
    everyId.delete(id); // re-inserted at the end: recently seen ids are the last to go
    everyId.set(id, ref);
    if (everyId.size > EVERY_MAX) {
      for (const k of everyId.keys()) { everyId.delete(k); if (everyId.size <= EVERY_MAX * 0.9) break; }
    }
  }
  // The element still carries this id only while its role and name are what they were when the id was
  // given: a recycled row now showing another record is not the control the model picked.
  function byId(id) {
    id = Number(id);
    for (const m of [snapshot, everyId]) {
      const r = m.get(id), el = r && r.deref();
      if (!el || !el.isConnected) continue;
      const e = idMap.get(el);
      if (!e || e.id !== id) return null;
      let now = '';
      try { now = idKey(base(el)); } catch (err) { now = ''; }
      return now === e.key ? el : null;
    }
    return null;
  }

  // ---------- scan ----------
  const MAX_LINES = 260, MAX_CHARS = 12000;
  function pageUrl() {
    const keep = [...new URLSearchParams(location.search)].filter(([k]) => /^(page|view|tab|section|module|route|p)$/i.test(k));
    const q = keep.length ? '?' + keep.map(([k, v]) => `${k}=${encodeURIComponent(redact(v))}`).join('&') : '';
    const h = /^#[!/]/.test(location.hash) ? location.hash.split('?')[0] : '';
    return location.origin + location.pathname + q + h; // no tokens or emails from the query string
  }
  // Stored in descriptors already normalised: no record ids, tokens or e-mails from the address.
  const pathNow = () => pathKey(location.pathname + location.search + location.hash);

  function lineBody(el, f, offscreen) {
    const st = stateOf(el);
    if (offscreen) st.push('offscreen');
    let s = f.display ? `${f.role} "${cut(f.display, 70)}"` : f.icon ? `${f.role} (icon: ${f.icon})` : `${f.role} ""`;
    const sel = selectInfo(el);
    if (sel) s += `${sel.cur ? ` = "${sel.cur}"` : ''} · ${sel.count} options: ${sel.all.slice(0, 4).join(' | ')}${sel.count > 4 ? ' | …' : ''}`;
    return st.length ? `${s} · ${st.join(', ')}` : s;
  }
  // Words of the question and of a control, compared by their first 5 letters (Russian endings vary).
  const stems = s => new Set(normText(s).split(' ').filter(w => w.length > 2).map(w => w.slice(0, 5)));

  /**
   * The map of the page for the model. Controls in the viewport and one screen around it are
   * listed in full; past the budget, the rest are ranked by overlap with opts.query and the
   * remainder is summarized. With a modal dialog open, only the dialog (and what is drawn above
   * it) is listed.
   */
  function scan(opts) {
    const query = opts && opts.query ? String(opts.query) : '';
    const modal = topModal();
    const vw = W.innerWidth, vh = W.innerHeight;
    let pool = controls(null);
    if (modal) pool = pool.filter(el => inModalScope(el, modal));
    // Positions first (cheap); names only for what can make it into the budget, since a page
    // with thousands of rows would otherwise pay for names nobody reads.
    const items = pool.map(el => {
      const r = rectOf(el, true);
      return { el, f: null, r, inView: inViewport(r), near: r.bottom > -vh && r.top < 2 * vh && r.right > 0 && r.left < vw };
    });
    const named = x => {
      if (!x.f) x.f = base(x.el);
      return !!(x.f.display || x.f.icon || NAMELESS_OK.test(x.f.role));
    };
    const byPos = (a, b) => a.r.top - b.r.top || a.r.left - b.r.left;
    const near = items.filter(x => x.near).sort((a, b) => (b.inView - a.inView) || byPos(a, b));
    const q = stems(query);
    const far = items.filter(x => !x.near);
    for (const x of far) { x.rel = 0; if (q.size && named(x)) for (const w of stems(x.f.display + ' ' + x.f.section)) if (q.has(w)) x.rel++; }
    far.sort((a, b) => b.rel - a.rel || Math.abs(a.r.top - vh / 2) - Math.abs(b.r.top - vh / 2));

    const header = modal ? `(open dialog: ${cut(redact(containerName(modal)), 60) || 'untitled'})` : '';
    const chosen = [], sections = new Set();
    let lines = header ? 2 : 1, chars = header.length + 160; // room for the header and the summary line
    for (const x of near.concat(far)) {
      if (!named(x)) { x.skip = true; continue; }
      x.body = lineBody(x.el, x.f, !x.inView);
      const sec = x.f.section, newSec = !sections.has(sec);
      const add = x.body.length + 9 + (newSec ? cut(sec, 50).length + 4 : 0);
      if (lines + 1 + (newSec ? 1 : 0) > MAX_LINES || chars + add > MAX_CHARS) { if (lines >= MAX_LINES) break; continue; }
      if (newSec) sections.add(sec);
      lines += 1 + (newSec ? 1 : 0);
      chars += add;
      chosen.push(x);
    }

    // Print each section once, in page order, with its controls under it.
    chosen.sort(byPos);
    const groups = new Map();
    for (const x of chosen) { if (!groups.has(x.f.section)) groups.set(x.f.section, []); groups.get(x.f.section).push(x); }
    snapshot = new Map();
    const out = header ? [header] : [];
    for (const [sec, xs] of groups) {
      if (sec || groups.size > 1) out.push(`## ${sec ? cut(sec, 50) : '(page)'}`);
      for (const x of xs) {
        const id = idFor(x.el, x.f);
        remember(id, x.el);
        out.push(`[${id}] ${x.body}`);
      }
    }
    const taken = new Set(chosen);
    const rest = items.filter(x => !taken.has(x) && !x.skip);
    if (rest.length) {
      const below = rest.filter(x => x.r.top >= vh).length, above = rest.filter(x => x.r.bottom <= 0).length;
      const where = below === rest.length ? ' below' : above === rest.length ? ' above' : ` (${below} below, ${above} above)`;
      const sample = [];
      let looked = 0;
      for (const x of far) {
        if (sample.length >= 5 || looked >= 60) break;
        if (taken.has(x)) continue;
        looked++;
        if (named(x) && x.f.display && !sample.includes(`"${cut(x.f.display, 24)}"`)) sample.push(`"${cut(x.f.display, 24)}"`);
      }
      out.push(`… ${rest.length} more controls${where}${sample.length ? ': ' + sample.join(', ') + ', …' : ''}`);
    }

    const headings = deepQueryAll('h1,h2,h3', modal || document).filter(h => !(flags(h) & BAD) && isVisible(h))
      .slice(0, 12).map(h => cut(redact(h.textContent), 60)).filter(Boolean);
    const page = { title: cut(redact(document.title), 120), url: pageUrl(), headings, lines: out };
    if (modal) page.dialog = cut(redact(containerName(modal)), 60);
    return page;
  }

  /**
   * The whole control tree of the current view (or of one container, such as an open dialog),
   * in document order and not limited to the viewport. Used by the explorer to map the product once.
   */
  function inventory(container) {
    const out = [];
    for (const el of controls(container || null)) {
      if (out.length >= 400) break;
      if (!container && closestDeep(el, 'dialog[open],[role=dialog],[role=alertdialog],[aria-modal="true"]')) continue;
      const f = base(el);
      if (!f.display && !f.icon && !NAMELESS_OK.test(f.role)) continue;
      const sel = selectInfo(el), st = stateOf(el);
      if (sel && sel.cur) st.push(`selected "${sel.cur}"`);
      out.push({
        el, role: f.role, name: cut(f.display || (f.icon ? `icon: ${f.icon}` : ''), 70), section: cut(f.section, 40), state: st.join(', '),
        options: sel ? sel.all.slice(0, 15).map(o => cut(o, 40)) : undefined,
      });
    }
    return out;
  }

  // ---------- describe ----------
  const cssEscape = s => (W.CSS && W.CSS.escape ? W.CSS.escape(s) : String(s).replace(/[^\w-]/g, c => '\\' + c));
  const quote = v => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
  // Last-resort positional path, anchored on the nearest stable ancestor.
  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      const tid = n !== el && testIdOf(n);
      if (tid) { parts.unshift(`[${TESTID_ATTRS.find(a => n.getAttribute(a))}=${quote(tid)}]`); break; }
      if (n.id && stableId(n.id)) { parts.unshift('#' + cssEscape(n.id)); break; }
      let part = n.tagName.toLowerCase();
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter(c => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }
  // How many elements each stable selector hits, from ONE query over the page: a batch of describes
  // then looks uniqueness up instead of running a document-wide query per selector per control.
  // Keys are the exact selector strings selectorsFor() builds.
  function selectorCounts() {
    const counts = new Map();
    const bump = k => counts.set(k, (counts.get(k) || 0) + 1);
    for (const el of deepQueryAll(TESTID_ATTRS.concat(['id', 'name', 'aria-label']).map(a => `[${a}]`).join(','))) {
      const tag = el.tagName.toLowerCase();
      for (const a of TESTID_ATTRS) { const v = el.getAttribute(a); if (v) bump(`[${a}=${quote(v)}]`); }
      if (el.id) bump('#' + cssEscape(el.id));
      const nm = el.getAttribute('name');
      if (nm) bump(`${tag}[name=${quote(nm)}]`);
      const al = el.getAttribute('aria-label');
      if (al) bump(`${tag}[aria-label=${quote(al)}]`);
    }
    return counts;
  }
  function selectorsFor(el, f, memo) {
    const sel = [];
    for (const a of TESTID_ATTRS) { const v = el.getAttribute(a); if (v) { sel.push(`[${a}=${quote(v)}]`); break; } }
    if (f.id) sel.push('#' + cssEscape(f.id));
    if (f.nameAttr && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) sel.push(`${f.tag}[name=${quote(f.nameAttr)}]`);
    const al = el.getAttribute('aria-label');
    if (al && al.length <= 80 && !/[\d@]/.test(al)) sel.push(`${f.tag}[aria-label=${quote(al)}]`); // record data stays out of selectors
    const unique = memo ? s => (memo.counts || (memo.counts = selectorCounts())).get(s) === 1 : s => deepQueryAll(s).length === 1;
    // A positional path only when no stable selector pins the element down on its own.
    if (!sel.some(unique)) { const p = cssPath(el); if (p) sel.push(p); }
    return sel;
  }
  // twinOf() for a batch: the pool is grouped by role and name once per role, not scanned once per name.
  function twinIn(el, f, memo) {
    const groups = memo.twins || (memo.twins = new Map());
    let byKey = groups.get(f.role);
    if (!byKey) {
      byKey = new Map();
      for (const x of memo.pool) {
        if (roleOf(x) !== f.role) continue;
        const k = twinKey(base(x));
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(x);
      }
      groups.set(f.role, byKey);
    }
    const g = byKey.get(twinKey(f));
    const i = g ? g.indexOf(el) : -1;
    return i < 0 ? undefined : { index: i, count: g.length };
  }

  function describeWith(el0, memo) {
    if (!el0 || el0.nodeType !== 1) return null;
    const el = retarget(el0) || el0;
    const f = feats(el, true);
    const fp = { tag: f.tag, role: f.role };
    for (const k of ['type', 'name', 'ownText', 'icon', 'testid', 'id', 'nameAttr', 'ariaLabel', 'placeholder', 'autocomplete', 'title', 'href', 'heading']) if (f[k]) fp[k] = f[k];
    if (f.classes.length) fp.classes = f.classes;
    if (f.container) fp.container = f.container;
    if (f.neighbors.length) fp.neighbors = f.neighbors;
    if (f.row) fp.row = f.row;
    // Repeated once per row of a data table or list: how to find it in any row (see rowInfo).
    let ro = null;
    try { ro = rowInfo(el); } catch (e) { ro = null; }
    if (ro) fp.rowOf = ro;
    if (f.ancestry.length) fp.ancestry = f.ancestry;
    const tw = memo ? twinIn(el, f, memo) : twinOf(el, controls(null));
    if (tw && tw.count > 1) fp.twin = tw;
    return { v: 2, sel: selectorsFor(el, f, memo), text: f.display.slice(0, 80), role: f.role, path: pathNow(), fp };
  }
  /** A durable, JSON-serializable descriptor of one control (research/04 §4.1). */
  function describe(el0) { return describeWith(el0, null); }
  /**
   * describe() for many controls of one view: the control pool, the twin groups and the selector
   * counts are computed once and kept in memo. A caller that yields between chunks passes the same
   * memo to every chunk, so nothing page-wide is redone after a yield. Returns descriptors (or null) in order.
   */
  function describeMany(elements, memo) {
    memo = memo || {};
    if (!memo.pool) memo.pool = controls(null);
    return Array.from(elements || [], el => { try { return describeWith(el, memo); } catch (e) { return null; } });
  }

  // ---------- resolve ----------
  const lastFound = new WeakMap(); // descriptor object -> WeakRef of the element it resolved to
  const SIMPLE_SEL = s => !/[\s>~+]|:nth-/.test(s.replace(/"(?:[^"\\]|\\.)*"/g, '""'));

  function context(d, fp) {
    const modal = topModal();
    const all = controls(null);
    const scope = el => !modal || inModalScope(el, modal);
    // Old selectors vote for the elements they hit, moved to their interactive ancestor.
    const votes = new Map(), perSel = [];
    let valid = 0;
    const inRow = !!(fp.row && fp.row.key);
    for (const s of (Array.isArray(d.sel) ? d.sel : []).slice(0, 8)) {
      if (typeof s !== 'string' || !s) continue;
      if (inRow && !SIMPLE_SEL(s)) continue; // li:nth-of-type(2) is another record after a sort
      let hits;
      try { hits = queryAll(s, document); } catch (e) { continue; } // a selector from another page version
      valid++;
      const set = new Set();
      for (const h of hits) {
        const el = retarget(h);
        if (el && !set.has(el) && !(flags(el) & BAD) && isVisible(el)) set.add(el);
      }
      perSel.push({ s, set });
      for (const el of set) votes.set(el, (votes.get(el) || 0) + 1);
    }
    const needTwin = !!(fp.twin && fp.twin.count > 1 && !inRow);
    return { fp, modal, all, scope, votes, perSel, valid, inRow, needTwin };
  }
  function cand(ctx, el, full) {
    const f = feats(el, full);
    return Object.assign({}, f, { twin: ctx.needTwin ? twinOf(el, ctx.all) : undefined, selHit: ctx.valid ? (ctx.votes.get(el) || 0) / ctx.valid : undefined });
  }
  function rank(ctx) {
    const pool = new Set(ctx.all);
    for (const el of ctx.votes.keys()) pool.add(el);
    // On big pages, score only what could pass the identity gate, plus the target's own region
    // (a relabeled sibling there must still count as a runner-up).
    const fp = ctx.fp, big = pool.size > 300 && fp.name;
    const worth = el => {
      if (ctx.votes.has(el)) return true;
      const f = base(el);
      if ((nameSim(fp, f) || 0) > 0) return true;
      if (fp.container && f.container && f.container.kind === fp.container.kind && f.container.name === fp.container.name) return true;
      if (fp.testid && testIdOf(el) === fp.testid) return true;
      if (fp.id && el.id === fp.id) return true;
      if (fp.nameAttr && el.getAttribute('name') === fp.nameAttr) return true;
      return !!(fp.href && el.tagName === 'A');
    };
    const first = [];
    for (const el of pool) if ((!big || worth(el)) && ctx.scope(el)) first.push({ el, s: scoreFeatures(fp, cand(ctx, el, false), { cheap: true }) });
    first.sort((a, b) => b.s - a.s);
    // The expensive context (heading, neighbors, row) only for the 20 best, plus everything tied
    // with them when the target sits in a row: 50 rows of "Удалить" score the same until their row keys are read.
    const cutoff = ctx.inRow && first.length > 20 ? first[19].s - 0.02 : Infinity;
    let n = 20;
    while (n < first.length && n < 200 && first[n].s >= cutoff) n++;
    const top = first.slice(0, n).map(x => {
      const c = cand(ctx, x.el, true);
      let s = scoreFeatures(ctx.fp, c);
      const r = rectOf(x.el, true);
      if (inViewport(r) && isOccluded(x.el)) s *= 0.85; // covered right now: a worse bet than an uncovered twin
      return { el: x.el, s, c, inView: inViewport(r) };
    });
    top.sort((a, b) => b.s - a.s || b.inView - a.inView);
    return top;
  }

  /**
   * Finds a descriptor's element with a confidence report:
   * { el, score, margin, ambiguous, candidates: [{ el, score }], via }.
   * el is set only when the best candidate scores >= 0.70 and leads the runner-up by >= 0.10
   * (>= 0.85 when the descriptor was made on another page).
   */
  function resolveDetailed(d, opts) {
    const none = { el: null, score: 0, margin: 0, ambiguous: false, candidates: [], via: 'none' };
    const fp = fpOf(d);
    if (!fp) return none;
    // A guide step on a row control (d.row, set by brain.refSteps): any row of the same table, never the sample's.
    if (d.row && fp.rowOf) {
      const r = resolveRow(d, opts);
      return { el: r.el, score: r.el ? 1 : 0, margin: 1, ambiguous: false, candidates: r.els.slice(0, 8).map(el => ({ el, score: 1 })), via: r.el ? 'row' : 'none' };
    }
    const need = d.path && !samePlace(d.path, pathNow()) ? T_OTHER_PAGE : T_ACCEPT;

    // Re-render fast path: the element found last time is still here and still matches.
    const prevRef = lastFound.get(d), prev = prevRef && prevRef.deref();
    if (prev && prev.isConnected && !(flags(prev) & BAD) && isVisible(prev)) {
      const modal = topModal();
      if (!modal || inModalScope(prev, modal)) {
        const s = scoreFeatures(fp, feats(prev, true));
        if (s >= Math.max(need, T_ACCEPT)) return { el: prev, score: s, margin: 1, ambiguous: false, candidates: [{ el: prev, score: s }], via: 'cached' };
      }
    }
    const ctx = context(d, fp);
    // Fast path: a simple, stable selector (test id, id, name, aria-label) hits exactly one element that still looks right.
    for (const p of ctx.perSel) {
      if (!SIMPLE_SEL(p.s)) continue;
      const hits = [...p.set].filter(ctx.scope);
      if (hits.length !== 1) continue;
      const c = cand(ctx, hits[0], true), s = scoreFeatures(fp, c);
      if (s >= 0.5 && (need === T_ACCEPT || s >= need) && identityOK(fp, c)) {
        lastFound.set(d, mkRef(hits[0]));
        return { el: hits[0], score: s, margin: 1, ambiguous: false, candidates: [{ el: hits[0], score: s }], via: 'fast' };
      }
    }
    const top = rank(ctx);
    const best = top[0];
    if (!best) return none;
    // A wrapper and its inner control are one visual element: never each other's runner-up.
    const second = top.slice(1).find(x => !containsDeep(x.el, best.el) && !containsDeep(best.el, x.el));
    const margin = best.s - (second ? second.s : 0);
    const sameName = top.filter(x => x.c.role === best.c.role && x.c.name === best.c.name).length;
    const via = accepts(fp, best, second ? second.s : 0, need, sameName);
    if (via) lastFound.set(d, mkRef(best.el));
    const round = n => Math.round(n * 1000) / 1000;
    return {
      el: via ? best.el : null, score: round(best.s), margin: round(margin), ambiguous: !via && best.s >= T_AMBIG,
      candidates: top.slice(0, 8).map(x => ({ el: x.el, score: round(x.s) })), via: via || 'none',
    };
  }

  /**
   * The element a descriptor (or a bare {text}) points at, or null when not sure. A row step (d.row) resolves to
   * a matching control in any row; opts.prefer ({ row } or { key }, see rowAt) picks the row the user chose.
   */
  function resolve(d, opts) {
    try { return resolveDetailed(d, opts).el; } catch (e) { return null; }
  }

  /**
   * The closest controls to a descriptor, as map lines with ids from the current scan snapshot,
   * so a small model can pick one (self-heal): [{ id, line }].
   */
  function candidatesFor(d, n) {
    const fp = fpOf(d);
    if (!fp) return [];
    if (!snapshot.size) scan();
    const top = rank(context(d, fp)).slice(0, n || 8);
    return top.map(x => {
      const f = x.c, id = idFor(x.el, f);
      remember(id, x.el);
      let line = `[${id}] ${lineBody(x.el, f, !x.inView)}`;
      if (f.section) line += ` · in "${cut(f.section, 40)}"`;
      if (f.heading) line += ` · under "${cut(f.heading, 40)}"`;
      if (f.row && f.row.key) line += ` · row "${cut(redact(f.row.key), 50)}"`;
      return { id, line };
    });
  }

  S.scan = scan;
  S.inventory = inventory;
  S.byId = byId;
  S.describe = describe;
  S.describeMany = describeMany;
  S.resolve = resolve;
  S.resolveDetailed = resolveDetailed;
  S.candidatesFor = candidatesFor;
  S.rowInfo = el => { try { return el && el.nodeType === 1 ? rowInfo(retarget(el) || el) : null; } catch (e) { return null; } };
  S.resolveRow = (d, opts) => { try { return resolveRow(d, opts); } catch (e) { return { el: null, els: [] }; } };
  S.matchRow = (d, node) => { try { return matchRow(d, node); } catch (e) { return null; } };
  S.rowAt = node => { try { return rowAt(node); } catch (e) { return null; } };
  S.labelOf = labelOf;
  S.deepQueryAll = deepQueryAll;
  S.rectOf = rectOf;
  S.isVisible = isVisible;
  S.isOccluded = isOccluded;
  S.isForeignOrOurs = isOurs;
})(typeof window !== 'undefined' ? window : globalThis);
