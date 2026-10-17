/*! Scopos SDK · AI-гид внутри вашего продукта · built 2026-10-17 */
// ---- extension/core/scan.js
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
    const n = normText(name);
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
  const ID_SEG = /\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,})(?=\/|$)/gi;
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

  S.pathKey = pathKey;
  S._test = { normText, textSim, simN, scoreFeatures, lev, levRatio, redact, stableId, stableClass, fpOf, rowSim, identityOK, accepts, pathKey, rowPattern, labelFits };
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
    const keep = [], set = new Set();
    for (const el of raw) {
      if (set.has(el) || (flags(el) & BAD)) continue;
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
      if (styleOf(el).pointerEvents === 'none') continue; // can't be clicked: not interactive
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
    const need = d.path && pathKey(d.path) !== pathKey(pathNow()) ? T_OTHER_PAGE : T_ACCEPT;

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

// ---- extension/core/pointer.js
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

  S.pointer = { point, hide, recording, debug, isOurs: el => !!(el && el.closest && (el.closest('scopos-layer') || el.closest('[data-scopos-ui]'))) };
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
  const ID_SEG = /\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,})(?=\/|$)/gi;
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
  const samePage = path => !path || pathKey(path) === pathKey(location.pathname + location.search + location.hash);
  const pagePlace = d => (d.view ? `«${String(d.view).slice(0, 60)}»` : `«${String(d.path || '/').split('?')[0].replace(/#(?![!/]).*$/, '').slice(0, 60)}»`);

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
    const mo = new MutationObserver(throttle(() => {
      if (hidden() || grace || !alive(me, at) || me.advanced === at) return;
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
      mo.disconnect();
      clearTimeout(grace);
      if (amo) amo.disconnect();
      me.rewatch = null;
    });
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
      // Back off: nothing changed that mattered. Never closer than DUTY × the measured cost.
      delay = Math.min(Math.max(Math.min(delay * 2, 2000), cost * DUTY), 10000);
      if (follow > 0) { follow--; schedule(false); }
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
    const onNav = () => schedule(true);
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

// ---- extension/core/guard.js
/*
 * Scopos guard: the safety net under the explorer.
 *
 * The explorer only presses controls that look like they open something, but
 * labels lie: a «Создать» button can POST at once, a menu item can call
 * confirm() and then delete. While the guard is on, nothing the page does can
 * write: forms don't submit, confirm() answers "no", alert/prompt/print do
 * nothing, window.open is refused, non-GET fetch/XHR answer 403, sendBeacon and
 * WebSocket/WebTransport/RTCDataChannel sends are refused, and "leave site?"
 * prompts never show (they would hang the walk).
 *
 * Three layers:
 *  - in the extension, the service worker also blocks non-GET requests and
 *    every WebSocket/WebTransport for the tab at the network level
 *    (declarativeNetRequest session rules). That is the primary net: it also
 *    covers captured fetch references, workers, iframes and native form posts;
 *  - DOM guards installed from here (submit and risky link clicks are stopped
 *    in the capture phase; DOM events are shared between worlds);
 *  - pageMain(), the patch for the page's own world. The extension asks the
 *    service worker to run it with world:'MAIN' (inline <script> is blocked by
 *    CSP on many sites); the SDK already runs in the page's world and calls it
 *    directly.
 *
 * On/off in the page world: the patch keeps its state in a closure. It is
 * switched only by pageMain(nonce, 'on'|'off') with a random per-document nonce
 * that never appears in the DOM or in an event (in the extension it travels
 * content script -> worker -> chrome.scripting args). The <html> attribute
 * data-scopos-guard="on" is kept for the isolated world and can only turn the
 * page patch ON (so the patch is active the moment on() runs); a page that
 * removes the attribute cannot turn it off. data-scopos-guard-main="1" is set
 * only after every critical patch is verifiably in place; it is informational.
 *
 * This file must also load in the service worker (importScripts) so the
 * background can pass S.guard.pageMain to chrome.scripting: nothing here
 * touches the DOM until on() is called.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});
  if (S.guard) return;

  const FLAG = 'data-scopos-guard';
  let active = false, count = 0, last = '', nonce = '', observer = null;

  /**
   * The page-world patch. Self-contained on purpose: chrome.scripting serialises
   * the function, so it may not use anything from the surrounding scope.
   * @param {string} key  per-document secret; only a caller that knows it can switch the patch.
   * @param {string} cmd  'on' | 'off' | 'install'
   * @returns {'ok'|'partial'|'refused'|'none'} 'ok' when every critical patch is in place.
   */
  function pageMain(key, cmd) {
    key = String(key || '');
    if (key.length < 16) return 'refused';
    // The control slot is named after a hash of the key: the page can see the name, never the key.
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    const slot = '__scoposGuard_' + h.toString(36);
    const markMain = ok => { try { const d = document.documentElement; if (!d) return; if (ok) d.setAttribute('data-scopos-guard-main', '1'); else d.removeAttribute('data-scopos-guard-main'); } catch (e) { /* no document yet */ } };

    let existing = null;
    try { existing = Object.getOwnPropertyDescriptor(window, slot); } catch (e) { existing = null; }
    if (existing) {
      // Installed earlier in this document: just switch it.
      const res = typeof existing.value === 'function' ? existing.value(key, cmd) : 'refused';
      markMain(res === 'ok');
      return res;
    }
    if (cmd === 'off') return 'none'; // nothing installed in this document: nothing to switch off

    let state = cmd === 'on';
    const on = () => {
      if (state) return true;
      // The attribute can only add protection (it is set synchronously by the content world); removing it changes nothing.
      try { const d = document.documentElement; return !!d && d.getAttribute('data-scopos-guard') === 'on'; } catch (e) { return false; }
    };
    const report = what => { try { window.dispatchEvent(new CustomEvent('scopos:blocked', { detail: String(what).slice(0, 200) })); } catch (e) { /* ignore */ } };
    const SAFE = /^(GET|HEAD|OPTIONS)$/i;
    // Natives captured once, before any page code can trick the checks below.
    const OrigRequest = window.Request, OrigResponse = window.Response;
    const reqMethodGet = (() => { try { return Object.getOwnPropertyDescriptor(Request.prototype, 'method').get; } catch (e) { return null; } })();
    const reqUrlGet = (() => { try { return Object.getOwnPropertyDescriptor(Request.prototype, 'url').get; } catch (e) { return null; } })();
    const GQL_KEYS = new Set(['query', 'variables', 'operationName', 'extensions']);
    /**
     * GraphQL reads go out as POST. Only a plain JSON {query} (or a batch of them) whose every query
     * starts as a read and never mentions a mutation or subscription is let through; anything else is a write.
     */
    const readQuery = (body, url) => {
      if (typeof body !== 'string' || !/graph|gql/i.test(String(url || ''))) return false;
      if (/mutation|subscription/i.test(body)) return false;
      let ops;
      try { ops = [].concat(JSON.parse(body)); } catch (e) { return false; }
      return ops.length > 0 && ops.every(o => o && typeof o === 'object' && !Array.isArray(o)
        && Object.keys(o).every(k => GQL_KEYS.has(k))
        && typeof o.query === 'string'
        && /^\s*(query\b|\{)/.test(o.query)
        && !/mutation|subscription/i.test(o.query));
    };
    const urlOf = x => { try { return String(x && typeof x === 'object' && 'url' in x ? x.url : x); } catch (e) { return ''; } };
    /** Replaces obj[name]; true only when the replacement really took. */
    const wrap = (obj, name, make) => {
      try {
        const orig = obj[name];
        if (typeof orig !== 'function') return false;
        const next = make(orig);
        obj[name] = next;
        return obj[name] === next;
      } catch (e) { return false; /* read-only on this page */ }
    };
    const critical = [];
    const BLOCKED_BODY = '{"error":"blocked by Scopos while it explores the product"}';

    // ---- fetch: a definitive 403, never a network error (retry/offline layers would replay a network error later) ----
    if (typeof window.fetch === 'function' && OrigRequest && OrigResponse && reqMethodGet) {
      const denied = what => { report(what); return Promise.resolve(new OrigResponse(BLOCKED_BODY, { status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json' } })); };
      critical.push(wrap(window, 'fetch', orig => function fetch(input, init) {
        if (!on()) return orig.apply(this, arguments);
        // Normalise once with the native Request, read the method through the captured getter and send exactly
        // that Request: a method getter or toString that answers differently on each read can't slip through.
        let r;
        try { r = new OrigRequest(input, init); } catch (e) { return Promise.reject(e); }
        let m = '', url = '';
        try { m = String(reqMethodGet.call(r)); url = reqUrlGet ? String(reqUrlGet.call(r)) : urlOf(input); } catch (e) { m = ''; }
        if (SAFE.test(m)) return orig.call(this, r);
        const self = this;
        if (/graph|gql/i.test(url)) {
          // Possibly a GraphQL read: look at the body (a clone, so the real one is still sendable).
          let copy;
          try { copy = r.clone(); } catch (e) { return denied(`fetch ${m} ${url}`); }
          return copy.text().then(t => (on() && !readQuery(t, url) ? denied(`fetch ${m} ${url}`) : orig.call(self, r)), () => denied(`fetch ${m} ${url}`));
        }
        return denied(`fetch ${m || '?'} ${url}`);
      }));
    }

    // ---- XMLHttpRequest ----
    if (window.XMLHttpRequest) {
      const opened = new WeakMap(); // xhr -> { m, url } as passed to the native open
      const faked = new WeakSet(); // xhrs answered with a synthetic 403 (own props shadow the native getters)
      const FAKE_PROPS = ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL', 'getResponseHeader', 'getAllResponseHeaders'];
      const P = XMLHttpRequest.prototype;
      critical.push(wrap(P, 'open', orig => function open(method, url) {
        if (faked.has(this)) { faked.delete(this); FAKE_PROPS.forEach(k => { try { delete this[k]; } catch (e) { /* ignore */ } }); }
        // Stringify once and hand the native open exactly what was recorded.
        const args = Array.prototype.slice.call(arguments);
        const m = String(method);
        args[0] = m;
        if (args.length > 1) { try { args[1] = typeof url === 'string' ? url : String(url); } catch (e) { /* the native open will throw */ } }
        const res = orig.apply(this, args);
        opened.set(this, { m: m.toUpperCase(), url: args.length > 1 ? String(args[1]) : '' });
        return res;
      }));
      const fake403 = xhr => {
        let rt = '';
        try { rt = xhr.responseType || ''; } catch (e) { rt = ''; }
        let response = null;
        if (rt === '' || rt === 'text') response = BLOCKED_BODY;
        else if (rt === 'json') { try { response = JSON.parse(BLOCKED_BODY); } catch (e) { response = null; } }
        faked.add(xhr);
        const def = (k, v) => { try { Object.defineProperty(xhr, k, { configurable: true, get: () => v }); } catch (e) { /* ignore */ } };
        def('readyState', 4); def('status', 403); def('statusText', 'Forbidden');
        def('response', response); def('responseText', rt === '' || rt === 'text' ? BLOCKED_BODY : '');
        def('responseURL', (opened.get(xhr) || {}).url || '');
        try {
          Object.defineProperty(xhr, 'getResponseHeader', { configurable: true, value: n => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) });
          Object.defineProperty(xhr, 'getAllResponseHeaders', { configurable: true, value: () => 'content-type: application/json\r\n' });
        } catch (e) { /* ignore */ }
        const fire = (type, Ctor) => { try { xhr.dispatchEvent(new Ctor(type)); } catch (e) { /* ignore */ } };
        fire('readystatechange', Event);
        fire('load', ProgressEvent);
        fire('loadend', ProgressEvent);
      };
      critical.push(wrap(P, 'send', orig => function send(body) {
        if (!on()) return orig.apply(this, arguments);
        const rec = opened.get(this);
        let m;
        if (rec) m = rec.m;
        else {
          // open() ran without our wrapper (a natively captured open): the method is unknown, so it counts as a write.
          // Only an XHR that was never opened (readyState 0) is left to the native send, which throws.
          let rs = 0;
          try { rs = this.readyState; } catch (e) { rs = 1; }
          if (rs === 0) return orig.apply(this, arguments);
          m = '?';
        }
        if (SAFE.test(m) || readQuery(body, rec && rec.url)) return orig.apply(this, arguments);
        report(`xhr ${m} ${(rec && rec.url) || ''}`);
        const xhr = this;
        setTimeout(() => fake403(xhr), 0);
        return undefined;
      }));
    }

    // ---- WebSocket / WebTransport / RTCDataChannel: no new sockets and no sends while on ----
    if (typeof window.WebSocket === 'function') {
      critical.push(wrap(WebSocket.prototype, 'send', orig => function send() { if (on()) { report('websocket send'); return undefined; } return orig.apply(this, arguments); }));
      try {
        const WS = window.WebSocket;
        const guarded = new Proxy(WS, {
          construct(t, args, nt) {
            if (on()) { report('websocket ' + urlOf(args[0])); throw new DOMException('Blocked by Scopos while it explores the product', 'SecurityError'); }
            return Reflect.construct(t, args, nt);
          },
        });
        window.WebSocket = guarded;
        critical.push(window.WebSocket === guarded);
      } catch (e) { critical.push(false); }
    }
    if (typeof window.WebTransport === 'function') {
      try {
        const WT = window.WebTransport;
        window.WebTransport = new Proxy(WT, {
          construct(t, args, nt) {
            if (on()) { report('webtransport'); throw new DOMException('Blocked by Scopos while it explores the product', 'SecurityError'); }
            return Reflect.construct(t, args, nt);
          },
        });
      } catch (e) { /* ignore: the network rule blocks it in the extension */ }
    }
    if (window.RTCDataChannel) wrap(RTCDataChannel.prototype, 'send', orig => function send() { if (on()) { report('datachannel send'); return undefined; } return orig.apply(this, arguments); });

    if (navigator.sendBeacon) critical.push(wrap(navigator, 'sendBeacon', orig => function sendBeacon() { if (on()) { report('beacon'); return false; } return orig.apply(this, arguments); }));
    wrap(window, 'confirm', orig => function confirm() { if (on()) { report('confirm'); return false; } return orig.apply(this, arguments); });
    wrap(window, 'alert', orig => function alert() { if (on()) return undefined; return orig.apply(this, arguments); });
    wrap(window, 'prompt', orig => function prompt() { if (on()) { report('prompt'); return null; } return orig.apply(this, arguments); });
    wrap(window, 'print', orig => function print() { if (on()) { report('print'); return undefined; } return orig.apply(this, arguments); });
    wrap(window, 'open', orig => function open() { if (on()) { report('window.open'); return null; } return orig.apply(this, arguments); });
    if (window.HTMLFormElement) {
      critical.push(wrap(HTMLFormElement.prototype, 'submit', orig => function submit() { if (on()) { report('form.submit'); return undefined; } return orig.apply(this, arguments); }));
      if (typeof HTMLFormElement.prototype.requestSubmit === 'function') critical.push(wrap(HTMLFormElement.prototype, 'requestSubmit', orig => function requestSubmit() { if (on()) { report('form.requestSubmit'); return undefined; } return orig.apply(this, arguments); }));
    }

    // "Leave site?" prompts: defuse every way a page can ask for one, whatever order its listeners were added in.
    wrap(Event.prototype, 'preventDefault', orig => function preventDefault() { if (this.type === 'beforeunload' && on()) return undefined; return orig.apply(this, arguments); });
    try {
      const BE = window.BeforeUnloadEvent && BeforeUnloadEvent.prototype;
      const d = BE && Object.getOwnPropertyDescriptor(BE, 'returnValue');
      if (d && d.set && d.configurable) Object.defineProperty(BE, 'returnValue', { configurable: true, enumerable: d.enumerable, get: d.get, set(v) { if (on()) return; d.set.call(this, v); } });
    } catch (e) { /* ignore */ }
    try {
      let user = window.onbeforeunload;
      const guarded = function (e) { if (on()) return undefined; return typeof user === 'function' ? user.call(this, e) : undefined; };
      window.onbeforeunload = guarded;
      Object.defineProperty(window, 'onbeforeunload', { configurable: true, enumerable: true, get() { return user; }, set(fn) { user = fn; } });
    } catch (e) { /* ignore */ }

    const ok = critical.length > 0 && critical.every(Boolean);
    const status = ok ? 'ok' : 'partial';
    // The switch: only a caller holding the key can turn the patch on or off. Non-writable and
    // non-configurable, so the page can't swap it for a function that would record the key.
    const control = (k, c) => {
      if (k !== key) return 'refused';
      if (c === 'on') state = true;
      else if (c === 'off') state = false;
      return status;
    };
    try {
      Object.defineProperty(window, slot, { value: control, writable: false, configurable: false, enumerable: false });
    } catch (e) {
      // Without a switch the patch could never be turned off; fall back to the attribute alone.
      state = false;
      markMain(false);
      return 'partial';
    }
    // Last: the attribute appears only when the patch is really in place.
    markMain(ok);
    return status;
  }

  const inExtension = () => { try { return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  /** The per-document secret that switches the page-world patch. Lives only in this (content or SDK) closure. */
  function secret() {
    if (nonce) return nonce;
    try {
      const a = new Uint32Array(4);
      crypto.getRandomValues(a);
      nonce = Array.from(a, x => x.toString(36).padStart(7, '0')).join('');
    } catch (e) {
      nonce = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 9).padEnd(7, '0')).join('');
    }
    return nonce;
  }

  /**
   * Installs/switches pageMain in the page's own world. Resolves to true when the page patch confirmed
   * that every critical write path is covered.
   */
  function inject(cmd = 'on') {
    const key = secret();
    if (inExtension()) {
      try {
        const p = chrome.runtime.sendMessage({ type: cmd === 'off' ? 'guard:off' : 'guard:inject', nonce: key });
        return Promise.resolve(p).then(r => !!(r && r.main === 'ok'), () => false);
      } catch (e) { return Promise.resolve(false); /* extension reloaded */ }
    }
    try { return Promise.resolve(pageMain(key, cmd) === 'ok'); } catch (e) { return Promise.resolve(false); }
  }

  const NON_HTML = /\.(pdf|csv|tsv|xlsx?|ods|zip|gz|tgz|rar|7z|json|xml|txt|docx?|odt|pptx?|png|jpe?g|gif|webp|svg|mp[34]|mov|avi|wav|exe|msi|dmg|pkg|apk|ics|vcf)$/i;
  const ours = n => !!(n && n.closest && n.closest('[data-scopos-ui],scopos-layer')) || !!(S.pointer && S.pointer.isOurs && n && n.nodeType === 1 && S.pointer.isOurs(n));

  function riskyLink(a) {
    if (!a.hasAttribute('href')) return false;
    if (a.hasAttribute('download')) return true;
    const t = (a.getAttribute('target') || '').toLowerCase();
    if (t && t !== '_self' && t !== '_top' && t !== '_parent') return true;
    if (['data-method', 'data-turbo-method', 'data-confirm', 'data-turbo-confirm'].some(x => a.hasAttribute(x))) return true;
    let u;
    try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return true; }
    if (u.protocol === 'javascript:') return false; // the page's own handler; the page-world patch covers what it does
    if (!/^https?:$/.test(u.protocol) || u.origin !== location.origin) return true; // mailto:, tel:, other sites
    return NON_HTML.test(u.pathname);
  }

  function note(what) { count++; last = String(what || '').slice(0, 200); }
  const onSubmit = e => {
    if (!active || ours(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    note('submit');
  };
  const onClick = e => {
    if (!active) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    const a = path.find(n => n && n.tagName === 'A');
    if (!a || ours(a) || !riskyLink(a)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    note('link ' + a.getAttribute('href'));
  };
  const onBlocked = e => note(typeof e.detail === 'string' ? e.detail : 'write');
  // Morphing (Turbo/idiomorph), document.open() or a hostile page can drop the flag: put it back while active.
  const keepFlag = () => {
    const d = document.documentElement;
    if (active && d && d.getAttribute(FLAG) !== 'on') d.setAttribute(FLAG, 'on');
  };

  /** Turns the guard on. Resolves to true once the page-world patch confirmed it is fully in place. */
  function on() {
    if (typeof document === 'undefined' || !document.documentElement) return Promise.resolve(false);
    document.documentElement.setAttribute(FLAG, 'on');
    if (!active) {
      active = true;
      addEventListener('submit', onSubmit, true);
      addEventListener('click', onClick, true);
      addEventListener('scopos:blocked', onBlocked, true);
      try {
        observer = new MutationObserver(keepFlag);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: [FLAG] });
      } catch (e) { observer = null; }
    }
    return inject('on');
  }

  function off() {
    if (typeof document === 'undefined') return Promise.resolve(false);
    const wasActive = active;
    active = false;
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } observer = null; }
    if (document.documentElement) document.documentElement.removeAttribute(FLAG);
    if (wasActive) {
      removeEventListener('submit', onSubmit, true);
      removeEventListener('click', onClick, true);
      removeEventListener('scopos:blocked', onBlocked, true);
    }
    // The explicit off: the only thing that switches the page patch (and, in the extension, the network block) off.
    return wasActive || nonce ? inject('off') : Promise.resolve(false);
  }

  S.guard = {
    on, off, pageMain,
    inject: () => inject('on'),
    active: () => active,
    blocked: () => count, // how many writes/prompts were stopped so far (the explorer diffs it per press)
    last: () => last,
  };
})(typeof window !== 'undefined' ? window : globalThis);

// ---- extension/core/explore.js
/*
 * Scopos explorer: learns a product once, the way a new employee would, by
 * walking through it. It visits every screen it can reach, records the control
 * tree of each one, and presses the controls that only open things (tabs,
 * menus, disclosures, "New …" buttons that show a form or a dialog) to see
 * where they lead. The result is a product map: screens, dialogs and the
 * controls that connect them. Guides are then written from the map, so
 * answering a question later needs no page reading and no guessing.
 *
 * Safety, in layers:
 *  - allow-list: only tabs, menu/disclosure triggers and buttons whose name
 *    starts with an opener verb («Создать», «Ещё», New, More …) are pressed;
 *    toggles, form submits and everything else are skipped;
 *    there is no "neutral button" mode: a button that is not an opener is
 *    never pressed, whatever the guard says;
 *  - veto: a wide multilingual list of risky verbs (RU, EN, DE, ES, PT, FR,
 *    IT, TR, PL, UZ, KZ, ZH, JA, KO) is checked against all the text of the
 *    element (name, full inner text, title, data-* values, framework handlers
 *    such as hx-get / phx-click / @click); hx-post/put/patch/delete,
 *    phx-submit and wire:submit are never pressed;
 *  - links: the text may name a screen («Оплата», Billing, «Отправленные»),
 *    but the address is checked strictly: any segment or query part that is
 *    an action verb (/tickets/5/close, /cart/add?id=5) is never followed, and
 *    a page a press or redirect landed on at such an address is kept as a
 *    title only and never opened again;
 *  - re-check: right before a press the control is found again by its exact
 *    descriptor and checked again; a fuzzy look-alike is never pressed;
 *  - net: S.guard (guard.js) blocks submits, confirm(), print, window.open,
 *    leave-site prompts and every non-GET request while the walk runs;
 *    The first press waits for the page-world patch (up to 1.5 s);
 *  - fences: never leaves the origin it started on, never presses inside an
 *    iframe, never follows downloads or non-HTML links, closes dialogs only
 *    with an exact «Закрыть»/×/Cancel (only × when the dialog asks about an
 *    action: "Cancel this booking?"), and reloads the page rather than click
 *    behind a dialog it can't close.
 * Use a test account all the same, like you would for a new hire.
 *
 * Form openers («Добавить клиента», «Пригласить коллегу», «Сменить тариф», New load, Invite user, Edit, +, ⋯):
 *  - pressed ONLY when writes are blocked below the page: opts.netBlocked === true in the extension (the worker
 *    confirmed its declarativeNetRequest block for the tab), or, in SDK mode (no chrome.runtime.id, or
 *    opts.sdk === true), when S.guard.on() resolved true and opts.forms !== false. opts.forms === false turns
 *    them off everywhere. Without that they are only marked `unexplored` in the map;
 *  - the opener verb must START the label, and it is the only thing excused: the rest of the element's text,
 *    attributes and handlers still go through the full veto ("Send invite", "Пригласить и отправить" are refused);
 *  - context decides commit vs opener: inside a dialog, or next to editable fields (its form, fieldset or a
 *    box up to 3 levels up that holds fields), or type=submit in a form, it is a commit and never pressed;
 *    only page-level buttons are openers. A press that the guard (or opts.netBlocks()) saw write is marked
 *    commit and that control (role + name + section) is never pressed again anywhere;
 *  - one press per same-named control per view (row "Edit" ×50 → one), one per global header control per walk;
 *    pagination and "load more" are never pressed, sort and filter controls at most once per view;
 *  - a Navigation API fence cancels navigations to other origins, downloads and addresses that act.
 *
 * Map format (toMap(state) and snapshot()):
 *   { origin, learnedAt, status, probes, views: [View] }
 *   View    = { id: 'V3', key: '/invoices', url, kind: 'page'|'dialog'|'panel', parent?: 'V1', opener?: 'V1.4',
 *               title, headings: [..], facts?: [..], form?: true, controls: [Control] }
 *             form: true when the view has an editable field (textbox, select, combobox …) and a commit control.
 *   Control = { ref: 'V3.4', role, name, section, state, options?: [..], d: descriptor (with d.view = page title),
 *               to?: 'V7' (the view it opens), commit?: true, unexplored?: true }
 *             commit: it finishes a form or dialog (submit button, primary dialog-footer button, a save /
 *               create / send / apply / confirm-like button next to fields) or a press of it was seen writing;
 *             unexplored: it looks like it opens a form or dialog but was not opened (danger veto, limits, no
 *               network block): a guide must continue live from there;
 *             region controls (role 'table' | 'list' | 'region', ≤ 4 per view, named by caption, aria-label or
 *               the nearest heading) come after the other controls, so "look at the list" steps can point.
 *
 * S.explore.snapshot(): the current screen as ONE View in the format above, synchronous, presses nothing and
 * keeps no state. id 'P', refs 'P.1' …, kind 'dialog' when a dialog is open (then key '<page key> › <title>'),
 * else 'page'; no `to` (it knows no other views), openers are `unexplored`. Measured in headless Chrome:
 * 75–105 ms on the TMS dashboard (53 controls), 95–175 ms on a 308-control page, 250 ms on Tabler's dashboard,
 * mostly scan.js (inventory + descriptors); 45–60 ms when the scan cache of the same task is warm. Call it idle.
 *
 * The walk is a small state machine saved through opts.store, so a full page
 * load in the middle of it resumes on the next page. Stop is saved too.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});
  if (S.explore) return; // loaded twice: one walker per document

  // bytes: UTF-8 size of the saved walk state. It goes to chrome.storage.session (10 MB for the whole extension,
  // shared with the guide sessions) or the SDK's sessionStorage (~5 M characters), once per press.
  const LIMITS = { views: 150, extra: 250, probes: 700, perView: 30, controls: 150, regions: 4, ms: 15 * 60 * 1000, step: 8000, bytes: 4e6 };

  // ---------------- what is risky ----------------
  const B = '(?<![\\p{L}\\p{N}])'; // start of a word (\b does not work for Cyrillic)
  const E = '(?![\\p{L}\\p{N}])'; // end of a word
  const MAX_TEXT = 20000; // per text source; only a guard against megabyte-long nodes, not a truncation that matters
  const MAX_ATTR = 2000; // attribute values of any length are read, up to their first 2000 characters
  // Text as the veto reads it: NFKC, lower case, ё → е, Turkish İ/I → i, camelCase and snake_case split,
  // apostrophes dropped without splitting the word (Uzbek O'chirish / Oʻchirish / O’chirish → ochirish).
  const APOS = /['ʻʼ’‘`´]/g;
  const fold = s => {
    let t = String(s == null ? '' : s);
    try { t = t.normalize('NFKC'); } catch (e) { /* old engine */ }
    return t.replace(APOS, '').toLowerCase().replace(/̇/g, '').replace(/ı/g, 'i').replace(/ё/g, 'е');
  };
  function dnorm(s) {
    let t = String(s == null ? '' : s);
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT);
    t = t.replace(APOS, '').replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2');
    return fold(t).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  // Word starts: "удал" catches удалить/удаление, "delet" catches delete/deleted.
  // Verbs only where the noun is a screen: «оплати» (Оплатить), not «Оплата»; «отправи» (Отправить), not «Отправленные».
  const STEMS = [
    // RU
    'удал', 'стереть', 'сотри', 'очист', 'сброс', 'обнул', 'отправи', 'отправь', 'отправлят', 'пересла', 'оплати', 'заплат', 'купи', 'покупк', 'оформ',
    'подтверд', 'сохран', 'примен', 'выйти', 'выход', 'разлогин', 'архив', 'разархив', 'отключ', 'подключ', 'включ', 'выключ',
    'деактив', 'активир', 'импорт', 'экспорт', 'выгруз', 'загруз', 'скача', 'опубликов', 'публик', 'снять с публ', 'отозв',
    'заблок', 'разблок', 'отмен', 'уволь', 'уволит', 'закрыт', 'дублир', 'копи', 'клонир', 'перемест', 'перенес', 'перенест',
    'перевест', 'перевод', 'передат', 'передач', 'провест', 'провод', 'выстав', 'одобр', 'утверд', 'отклон', 'приня', 'убрат',
    'убер', 'корзин', 'восстанов', 'подпис', 'отпис', 'печат', 'распечат', 'возврат', 'вернуть', 'аннулир', 'сторн', 'списат',
    'перезапуст', 'перезагруз', 'запуст', 'останов', 'приостанов', 'возобнов', 'покину', 'исключ', 'сгенерир', 'генерир',
    'перегенерир', 'отмет', 'помет', 'заверш', 'синхрон', 'сменить тариф', 'повысить тариф', 'обновить тариф', 'в корзину',
    'пригласи', 'назначи', 'назначь', 'взять в работу', 'скрыть', 'скрой', 'продли', 'пополни', 'заказат', 'закажи', 'заброн',
    'зарезерв', 'повтори', 'откат', 'обнови', 'начисли', 'выдат', 'выдай', 'выполни', 'закрой', 'переотправ', 'восстанав',
    // EN
    'delet', 'remov', 'eras', 'destroy', 'trash', 'purg', 'archiv', 'unarchiv', 'duplicat', 'clon', 'submit', 'purchas',
    'checkout', 'check out', 'refund', 'transfer', 'approv', 'reject', 'confirm', 'accept', 'declin', 'publish', 'unpublish',
    'upload', 'download', 'restart', 'reboot', 'logout', 'log out', 'log off', 'logoff', 'signout', 'sign out', 'sign off',
    'disconnect', 'deactivat', 'disabl', 'enabl', 'activat', 'upgrad', 'downgrad', 'revok', 'terminat', 'unsubscrib',
    'subscrib', 'impersonat', 'merg', 'deploy', 'rollback', 'roll back', 'revert', 'discard', 'regenerat',
    'generat', 'resend', 'retry', 'rerun', 'restor', 'unlink', 'uninstall', 'install', 'suspend', 'unsuspend', 'cancel',
    'reset', 'mark as', 'mark all', 'mark read', 'add to cart', 'place order', 'order now', 'go live', 'empty trash',
    'close account', 'close period', 'close ticket', 'close issue', 'close order', 'close month', 'close the',
    'mark complet', 'mark paid', 'mark done', 'flush', 'rotat', 'escalat', 'impersonat', 'regenerat', 'reactivat', 'undelet',
    'grant access', 'turn off', 'turn on', 'opt out', 'opt in', 'top up', 'book now', 'order now', 'buy now',
    // DE
    'lösch', 'losch', 'entfern', 'absend', 'senden', 'bezahl', 'kaufen', 'speicher', 'bestätig', 'bestatig', 'abmeld',
    'ausloggen', 'archivier', 'duplizier', 'kopier', 'verschieb', 'veröffentlich', 'veroffentlich', 'exportier', 'importier',
    'herunterlad', 'hochlad', 'drucken', 'zurücksetz', 'zurucksetz', 'deaktivier', 'aktivier', 'kündig', 'kundig', 'stornier',
    'genehmig', 'ablehn', 'akzeptier', 'übertrag', 'ubertrag', 'erstatt', 'abonnier', 'verbind', 'trennen', 'einreich',
    'unterschreib', 'unterzeichn', 'leeren', 'schließ', 'schliess', 'neu starten', 'neustart', 'überweis', 'uberweis', 'widerruf',
    'generier', 'einladen', 'ausführ', 'zuweis', 'sperren', 'entsperr', 'freigeb', 'abschließ', 'verlänger', 'aufladen',
    // ES / PT
    'elimin', 'borr', 'quitar', 'enviar', 'envia', 'envío', 'envio', 'pagar', 'pague', 'comprar', 'guardar', 'aplicar',
    'cerrar sesi', 'archivar', 'duplicar', 'copiar', 'publicar', 'exportar', 'importar', 'descarg', 'imprimir', 'restablec',
    'desactiv', 'activar', 'cancelar', 'aprobar', 'rechaz', 'aceptar', 'transferir', 'reembols', 'suscrib', 'conectar',
    'desconect', 'firmar', 'vaciar', 'exclu', 'apag', 'salvar', 'arquivar', 'baixar', 'carregar', 'redefin', 'desativ',
    'ativar', 'aprovar', 'rejeitar', 'recusar', 'aceitar', 'assinar', 'limpar', 'cerrar', 'encerrar', 'terminar sess', 'reinici',
    'revoc', 'revog', 'generar', 'gerar', 'marcar', 'invitar', 'convidar', 'renovar', 'reservar', 'deshacer', 'desfazer',
    'transfira', 'reembolsar', 'publique', 'envie', 'confirmar',
    // FR
    'supprim', 'effac', 'envoy', 'soumet', 'payer', 'achet', 'enregistr', 'sauvegard', 'valider', 'appliqu', 'déconnex',
    'deconnex', 'déconnect', 'deconnect', 'archiver', 'dupliqu', 'copier', 'déplac', 'deplac', 'publier', 'exporter',
    'importer', 'télécharg', 'telecharg', 'imprim', 'réinitialis', 'reinitialis', 'désactiv', 'activer', 'annul',
    'approuv', 'rejet', 'refus', 'accepter', 'transférer', 'transferer', 'rembours', 'abonn', 'connecter', 'signer', 'vider',
    'fermer', 'redémarr', 'redemarr', 'révoqu', 'revoqu', 'générer', 'generer', 'virer', 'marquer', 'inviter',
    'renouvel', 'réserver', 'reserver', 'commander', 'quitter', 'confirmer',
    // IT
    'cancell', 'rimuov', 'invia', 'pagare', 'acquist', 'salvare', 'conferm', 'archivia', 'duplica', 'sposta', 'pubblica',
    'esporta', 'importare', 'scarica', 'carica', 'stampa', 'reimposta', 'disattiv', 'attiva', 'annulla', 'approva', 'rifiut',
    'accetta', 'trasferi', 'rimbors', 'abbona', 'connetti', 'disconnetti', 'firmare', 'svuota', 'chiud', 'riavvi', 'generare',
    'segna', 'rinnova',
    // TR (ı/İ are folded to i, so the stems are written the same way the text is read)
    'silin', 'silme', 'gönder', 'gonder', 'ödeyin', 'ödeme yap', 'onayla', 'arşivle', 'arsivle', 'çoğalt', 'cogalt', 'kopyala',
    'yayınla', 'yayinla', 'dışa aktar', 'disa aktar', 'çıkış', 'cikis', 'iptal', 'kapat', 'sıfırla', 'sifirla', 'yeniden başlat',
    'aktar', 'havale', 'iade', 'devre dışı', 'devre disi', 'işaretle', 'isaretle', 'etkinleştir', 'satın al', 'satin al',
    'abone ol', 'kaydet', 'uygula', 'reddet', 'kabul et', 'oturumu kapat', 'davet et', 'geri al', 'yükle',
    // PL
    'usu', 'wyślij', 'wyslij', 'wysłać', 'wyslac', 'wysyłaj', 'zapłać', 'zaplac', 'płać', 'zatwierdź', 'zatwierdz', 'archiwiz',
    'duplikuj', 'publikuj', 'opublikuj', 'eksport', 'wyloguj', 'anuluj', 'zamknij', 'oznacz', 'resetuj', 'uruchom', 'przelej',
    'wykonaj przelew', 'zwróć', 'zwroc', 'generuj', 'wygeneruj', 'unieważnij', 'uniewaznij', 'odwołaj', 'odwolaj', 'wyłącz',
    'wylacz', 'włącz', 'wlacz', 'zapisz', 'zastosuj', 'potwierdź', 'potwierdz', 'odrzuć', 'odrzuc', 'akceptuj', 'zaakceptuj',
    'przywróć', 'przywroc', 'subskrybuj', 'wypisz', 'zaproś', 'zapros', 'pobierz', 'kup teraz', 'zamów teraz', 'zamow teraz', 'przedłuż',
    // UZ (latin and cyrillic) / KZ; apostrophes are already dropped: O'chirish → ochirish, To'lash → tolash
    'ochir', 'yubor', 'tola', 'saqla', 'tasdiq', 'chiqish', 'arxiv', 'nusxa', 'yukla', 'bekor',
    'ўчир', 'юбор', 'тўла', 'сақла', 'тасдиқ', 'чиқиш', 'бекор', 'юкла',
    'жою', 'жойы', 'жібер', 'төле', 'сақта', 'раста', 'шығу', 'бас тарт', 'мұрағат', 'көшір', 'жүкте', 'өшір', 'тазала',
    'жабу', 'аудару', 'қайтару', 'бекіту', 'жариялау',
  ];
  // Whole words only: "pay" but not "Payments", "save" but not "Saved views", "close" but not "Closed".
  const WORDS = [
    'pay', 'pay now', 'send', 'send now', 'save', 'saving', 'apply', 'post', 'print', 'sync', 'copy', 'copy to', 'move',
    'move to', 'clear', 'run', 'start', 'stop', 'pause', 'buy', 'end', 'kick', 'ban', 'unban', 'leave', 'block', 'unblock', 'void',
    'charge', 'resolve', 'reopen', 'convert', 'import', 'export', 'join', 'follow', 'unfollow', 'like', 'unlike', 'vote', 'star',
    'unstar', 'pin', 'unpin', 'mute', 'unmute', 'flag', 'report', 'wipe', 'connect', 'close', 'complete', 'finish', 'done', 'mark',
    'capture', 'invite', 'undo', 'redo', 'lock', 'unlock', 'grant', 'promote', 'demote', 'rotate', 'exit', 'quit', 'assign',
    'unassign', 'snooze', 'dismiss', 'hide', 'unhide', 'notify', 'remind', '(?<!address )book', 'book a', 'book an', 'book this', 'book appointment', 'reserve', '(?<!sort )order', 'renew', 'verify',
    'withdraw', 'deposit', 'donate', 'kill', 'claim', 'trigger', 'execute', 'commit', 'retire', 'erase',
    'paga', 'salva', 'applica', 'copia', 'esci', 'salir', 'sair', 'mover', 'retirer', 'importa', 'genera', 'invita', 'prenota',
    'sil', 'öde', 'indir', 'kup', 'zamów', 'zamow',
    'готово', 'начать', 'начни', 'стоп', 'выдать',
  ];
  // "design" is not "de" + "sign": these take no prefix.
  const WORDS_NP = ['sign'];
  // English action stems matched anywhere inside a word: redeploy, undelete, reactivate, unarchive, disapprove …
  const INNER = [
    'delet', 'deploy', 'publish', 'activat', 'subscrib', 'archiv', 'approv', 'confirm', 'refund', 'destroy', 'remov', 'revok',
    'terminat', 'impersonat', 'duplicat', 'restor', 'purchas', 'checkout', 'logout', 'signout', 'upgrad', 'downgrad', 'rollback',
    'restart', 'reboot', 'enabl', 'disabl', 'install', 'suspend', 'cancel', 'resend',
  ];
  // Chinese (Simplified and Traditional), Japanese, Korean: no word boundaries, matched anywhere.
  const CJK = [
    '删除', '刪除', '移除', '发送', '發送', '支付', '付款', '批准', '审批', '審批', '归档', '歸檔', '复制', '複製', '发布', '發布', '發佈',
    '导出', '導出', '匯出', '退出', '登出', '注销', '註銷', '取消', '关闭', '關閉', '标记', '標記', '重置', '重启', '重啟', '转账', '轉賬',
    '轉帳', '退款', '生成', '撤销', '撤銷', '禁用', '启用', '啟用', '提交', '确认', '確認', '保存', '儲存', '清空', '清除', '购买', '購買',
    '结账', '結帳', '下单', '下單', '订阅', '訂閱', '退订', '退訂', '续费', '續費', '升级', '升級', '降级', '降級', '邀请', '邀請', '解绑',
    '解綁', '停用', '恢复', '恢復', '还原', '還原', '上传', '上傳', '下载', '下載', '打印', '列印', '同意', '拒绝', '拒絕', '撤回', '充值',
    '削除', '送信', '支払', 'ログアウト', '解約', 'キャンセル', '退会', '購入', '承認', '公開', '삭제', '전송', '결제', '로그아웃', '취소',
    '탈퇴', '구매', '승인', '발행',
  ];
  const alt = list => list.map(fold).join('|');
  const PRE = '(?:re|un|de|pre|dis|auto|bulk|mass|force)?';
  const DANGER = new RegExp(`${B}${PRE}(?:${alt(STEMS)})|${B}${PRE}(?:${alt(WORDS)})${E}|${B}(?:${alt(WORDS_NP)})${E}|(?:${alt(INNER)})|(?:${alt(CJK)})`, 'iu');
  /** Text that names an action anywhere in it (button labels, titles, handler names, data-* values …). */
  const isDangerText = s => DANGER.test(dnorm(s));
  const DANGER_CLASS = /danger|destruct|delete|remove|trash|logout|signout|sign-out|log-out/i;

  // Link TEXT: following a link only loads a page (GET), so nouns like «Оплата», «Billing», «Платежи»,
  // «Отправленные» are fine. Refused only for words that say the link itself acts (log out, delete, export …).
  const LINK_STEMS = [
    'выйти', 'выход', 'разлогин', 'удал', 'стереть', 'экспорт', 'выгруз', 'скача', 'печат', 'импорт', 'сброс', 'отключ', 'деактив',
    'отозв', 'отпис', 'закрыть аккаунт', 'закрыть сч', 'закрыть профил', 'отменить подписк', 'заблокир',
    'log out', 'logout', 'log off', 'logoff', 'sign out', 'signout', 'sign off', 'delet', 'remov', 'destroy', 'unsubscrib', 'export',
    'download', 'print', 'reset', 'deactivat', 'disabl', 'revok', 'impersonat', 'close account', 'close my account',
    'cancel subscription', 'cancel plan', 'cancel account', 'cancel membership', 'terminate account', 'delete account',
    'abmeld', 'ausloggen', 'lösch', 'losch', 'entfern', 'exportier', 'herunterlad', 'drucken', 'kündig', 'kundig', 'konto schließ',
    'konto schliess', 'zurücksetz',
    'cerrar sesi', 'eliminar', 'borrar', 'exportar', 'descarg', 'imprimir', 'darse de baja', 'cancelar suscrip', 'cerrar cuenta',
    'terminar sess', 'encerrar sess', 'excluir', 'baixar', 'cancelar assinatura', 'sair da conta',
    'déconnex', 'deconnex', 'se déconnect', 'se deconnect', 'supprim', 'exporter', 'télécharg', 'telecharg', 'désabonn',
    'desabonn', 'imprimer', 'fermer le compte',
    'disconnetti', 'elimina', 'cancella', 'esporta', 'scarica', 'annulla iscrizione', 'chiudi account',
    'çıkış', 'cikis', 'oturumu kapat', 'silin', 'dışa aktar', 'disa aktar', 'abonelikten çık', 'hesabı kapat', 'hesabı sil',
    'wyloguj', 'usuń', 'usun', 'eksport', 'pobierz', 'wypisz', 'zamknij konto', 'anuluj subskrypcj',
    'chiqish', 'ochir', 'yuklab ol', 'чиқиш', 'ўчир', 'шығу', 'жою', 'жойы',
  ];
  const LINK_WORDS = ['exit', 'quit', 'esci', 'salir', 'sair', 'sil', 'indir', 'import', 'erase', 'unlink'];
  const LINK_CJK = [
    '退出', '登出', '注销', '註銷', '删除', '刪除', '导出', '導出', '匯出', '下载', '下載', '取消订阅', '取消訂閱', '退订', '退訂',
    'ログアウト', '削除', 'エクスポート', 'ダウンロード', '退会', '解約', '로그아웃', '삭제', '내보내기', '다운로드', '탈퇴',
  ];
  const LINK_TEXT_DANGER = new RegExp(`${B}(?:${alt(LINK_STEMS)})|${B}(?:${alt(LINK_WORDS)})${E}|(?:${alt(LINK_CJK)})`, 'iu');
  const linkTextDanger = s => LINK_TEXT_DANGER.test(dnorm(s));

  // Link ADDRESS: checked strictly. A GET to /tickets/5/close or /cart/add?id=5 changes data just like a button.
  const BAD_HREF = /log-?out|log-?off|sign[-_]?out|sign[-_]?off|delete|destroy|remove|unsubscribe|revoke|export|download|impersonat|switch|locale|lang=|language=|theme=|token=|\/api\/|\/oauth|\/auth\/|\/sso\b/i;
  // Any path segment, query key or query value that is one of these words (after camelCase/snake_case splitting) acts.
  const ACTION = new Set([
    'close', 'approve', 'reject', 'cancel', 'archive', 'unarchive', 'restore', 'duplicate', 'clone', 'send', 'resend', 'confirm',
    'accept', 'decline', 'exit', 'quit', 'leave', 'logout', 'logoff', 'signout', 'signoff', 'sign', 'pay', 'checkout', 'renew',
    'upgrade', 'downgrade', 'toggle', 'enable', 'disable', 'activate', 'deactivate', 'reactivate', 'subscribe', 'unsubscribe',
    'delete', 'destroy', 'undelete', 'undo', 'redo', 'reset', 'publish', 'unpublish', 'republish', 'retry', 'deploy', 'redeploy',
    'refund', 'void', 'add', 'remove', 'rotate', 'generate', 'regenerate', 'flush', 'purge', 'complete', 'finish', 'done', 'end',
    'up', 'down', 'upvote', 'downvote', 'vote', 'like', 'unlike', 'follow', 'unfollow', 'star', 'unstar', 'pin', 'unpin', 'mute',
    'unmute', 'block', 'unblock', 'ban', 'unban', 'lock', 'unlock', 'submit', 'import', 'export', 'download', 'upload', 'print',
    'merge', 'revoke', 'grant', 'invite', 'assign', 'unassign', 'claim', 'reopen', 'resolve', 'dismiss', 'snooze', 'start', 'stop',
    'pause', 'unpause', 'restart', 'reboot', 'kill', 'terminate', 'suspend', 'unsuspend', 'impersonate', 'transfer', 'charge',
    'capture', 'reserve', 'buy', 'purchase', 'mark', 'apply', 'save', 'run', 'rerun', 'execute', 'trigger', 'sync', 'refresh',
    'commit', 'rollback', 'revert', 'promote', 'demote', 'escalate', 'notify', 'remind', 'trash', 'empty', 'clear', 'wipe', 'erase',
    'move', 'copy', 'verify', 'withdraw', 'deposit', 'join', 'readall', 'markread', 'markallread', 'approveall', 'acceptall',
    // RU (translit and Cyrillic)
    'udalit', 'otpravit', 'oplatit', 'vyiti', 'vyjti', 'viyti', 'vyhod', 'vykhod', 'otmenit', 'podtverdit', 'zakryt', 'sohranit',
    'sokhranit', 'kupit', 'arhivirovat', 'arkhivirovat', 'otpisatsya', 'otpisatsa', 'eksport', 'skachat', 'odobrit', 'otklonit',
    'prinyat', 'vosstanovit', 'kopirovat', 'prodlit', 'priglasit', 'oformit',
    'удалить', 'отправить', 'оплатить', 'выйти', 'выход', 'отменить', 'подтвердить', 'закрыть', 'сохранить', 'купить',
    'архивировать', 'отписаться', 'экспорт', 'скачать', 'одобрить', 'отклонить', 'принять', 'восстановить', 'копировать',
    'продлить', 'пригласить', 'оформить',
    // DE ES FR IT PT TR PL UZ
    'abmelden', 'loschen', 'löschen', 'loeschen', 'senden', 'bezahlen', 'kundigen', 'kündigen', 'kuendigen', 'stornieren',
    'eliminar', 'borrar', 'enviar', 'pagar', 'cancelar', 'salir', 'supprimer', 'envoyer', 'payer', 'annuler', 'deconnexion',
    'déconnexion', 'elimina', 'cancella', 'invia', 'paga', 'annulla', 'esci', 'excluir', 'sair', 'sil', 'gonder', 'gönder', 'ode',
    'öde', 'iptal', 'cikis', 'çıkış', 'usun', 'usuń', 'wyslij', 'wyślij', 'zaplac', 'zapłać', 'anuluj', 'wyloguj', 'ochirish',
    'chiqish',
  ].map(fold));
  const ACTION_PREFIX = /^(?:re|un|de|pre)(.{4,})$/; // reapprove, unarchive, deactivate …
  const NO_PREFIX = new Set(['sign']); // "design" is a page, not de + sign
  const ACTION_KEY = /^_?(?:action|do|op|cmd|command|method|verb|operation|act)$/i;
  const COMPOUND_OK = new Set(['add ons', 'addons']); // nouns built from a verb that are screens
  const NON_HTML = /\.(pdf|csv|tsv|xlsx?|ods|zip|gz|tgz|rar|7z|json|xml|txt|docx?|odt|pptx?|png|jpe?g|gif|webp|svg|mp[34]|mov|avi|wav|exe|msi|dmg|pkg|apk|ics|vcf)$/i;

  /** Does this one path segment / query part name an action? */
  function actionPart(part, skip) {
    const w = dnorm(part);
    if (!w || COMPOUND_OK.has(w)) return false;
    const joined = w.replace(/ /g, '');
    if (ACTION.has(joined) && !(skip && skip.has(joined))) return true; // mark_all_read, read-all, approveAll
    if (!skip && /^(?:mark|read ?all)(?: |$)/.test(w)) return true; // mark_paid, markAsPaid, mark-read
    for (const t of w.split(' ')) {
      if (skip && skip.has(t)) continue;
      if (ACTION.has(t)) return true;
      const m = ACTION_PREFIX.exec(t);
      if (m && ACTION.has(m[1]) && !NO_PREFIX.has(m[1]) && !(skip && skip.has(m[1]))) return true;
    }
    return false;
  }
  // Collection nouns (deployments, transfers, subscribers, uploads, publishing …) name screens; verbs in addresses are bare.
  const collection = t => t.length >= 5 && ((/s$/.test(t) && !/(?:ss|us|is)$/.test(t)) || /ing$/.test(t));

  /** Is following this address unsafe (it acts instead of showing a page)? Pure: no DOM needed. */
  function isDangerAddress(href) {
    let u;
    try { u = new URL(href, typeof location !== 'undefined' && location.href ? location.href : 'http://scopos.invalid/'); } catch (e) { return true; }
    let tail = u.pathname + u.search + u.hash;
    try { tail = decodeURIComponent(tail); } catch (e) { /* keep encoded */ }
    if (BAD_HREF.test(tail)) return true;
    const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
    const segs = u.pathname.split('/').filter(Boolean).map(dec);
    const q = [...u.searchParams];
    if (/^#[!/]/.test(u.hash)) {
      const [hp, hq] = u.hash.slice(2).split('?');
      segs.push(...hp.split('/').filter(Boolean).map(dec));
      if (hq) { try { q.push(...new URLSearchParams(hq)); } catch (e) { /* ignore */ } }
    }
    if (q.some(([k]) => ACTION_KEY.test(k))) return true;
    const parts = segs.concat(...q);
    if (parts.some(p => actionPart(p))) return true;
    // The full verb list over the words of the address, collection nouns aside.
    const ws = parts.map(p => dnorm(p).split(' ').filter(t => t && !/^\d+$/.test(t) && !collection(t)).join(' ')).filter(Boolean).join(' · ');
    return isDangerText(ws);
  }

  // Framework handlers act on click without a form or a link. Elements (or ancestors: clicks bubble) that write: never pressed.
  const FW_WRITE = /^(?:data-)?hx-(?:post|put|patch|delete)$|^phx-submit|^wire:submit/i;
  // Click handlers whose value is read: a «Готово» button with hx-get="/items/5/delete" or phx-click="delete" is a delete button.
  const FW_CLICK = /^(?:(?:data-)?hx-(?:get|vals|trigger)|phx-(?:click|capture-click|keydown|keyup|change|blur|focus|window-keydown|value-[\w-]+)|wire:(?:click|keydown|change)[\w.:-]*|x-on:(?:click|mousedown|mouseup|pointerdown|pointerup|keydown|submit)[\w.:-]*|@(?:click|mousedown|mouseup|pointerdown|pointerup|keydown|submit)[\w.:-]*|v-on:(?:click|mousedown|mouseup|pointerdown|pointerup|keydown|submit)[\w.:-]*|ng-(?:click|mousedown|submit)|data-action|data-turbo-method|data-method|on(?:click|mousedown|mouseup|pointerdown|pointerup|keydown|submit|touchstart|touchend))$/i;
  // Handler code made only of these words is UI, not a write: @click="toggle()", @click.outside="close()",
  // @click="showAddModal = true", data-action="click->dropdown#toggle", $dispatch('close-dialog').
  const UI_SAFE = new Set([
    'toggle', 'add', 'open', 'opened', 'show', 'hide', 'close', 'dismiss', 'expand', 'collapse', 'up', 'down', 'next', 'prev',
    'previous', 'select', 'focus', 'blur', 'scroll', 'copy', 'clipboard', 'true', 'false', 'null', 'undefined', 'this', 'event', 'e',
    'prevent', 'stop', 'away', 'outside', 'self', 'once', 'window', 'document', 'click', 'mousedown', 'keydown', 'enter', 'escape',
    'esc', 'modal', 'dialog', 'menu', 'dropdown', 'popup', 'popover', 'panel', 'sidebar', 'drawer', 'tab', 'tabs', 'accordion',
    'tooltip', 'dispatch', 'emit', 'set', 'is', 'value', 'active', 'visible', 'expanded', 'collapsed', 'state', 'vm', 'ctrl',
    'x', 'el', 'target', 'current', 'index', 'i', 'item', 'section', 'details', 'more', 'filter', 'filters', 'sort', 'search',
    'nav', 'navigation', 'go', 'to', 'view', 'page', 'route', 'router', 'push', 'navigate', 'href', 'location', 'new', 'create',
    'handle', 'on', 'button', 'btn', 'icon', 'closer',
  ]);
  /**
   * 'write' | 'danger' | null for one attribute. form: for a form opener, its opener words («invite» in
   * @click="openInviteModal()") are UI words too; writes (hx-post …) and every other verb still count.
   */
  function fwAttr(name, value, form) {
    if (FW_WRITE.test(name)) return 'write';
    if (/^data-(?:turbo-)?method$/i.test(name)) return /^\s*get\s*$/i.test(value || 'get') ? null : 'write';
    if (!FW_CLICK.test(name) || !value) return null;
    const v = String(value).slice(0, MAX_ATTR);
    if (/^(?:data-)?hx-get$/i.test(name)) return isDangerAddress(v) ? 'danger' : null;
    // Addresses inside handler code (location.href = '/items/5/archive') are checked like links.
    const URLS = /https?:\/\/[^\s'"`)]+|\/[\w./?=&%:-]+/g;
    for (const m of v.match(URLS) || []) if (m.length > 1 && isDangerAddress(m)) return 'danger';
    let code = v.replace(URLS, ' ');
    if (form) code = maskForm(code);
    const toks = dnorm(code).split(' ').filter(Boolean);
    if (!toks.length || toks.every(t => UI_SAFE.has(t) || /^\d+$/.test(t))) return null;
    if (isDangerText(code)) return 'danger';
    return actionPart(code, UI_SAFE) ? 'danger' : null;
  }
  /** The element (or an ancestor whose click handler it would trigger) writes or names an action. */
  function fwCheck(el, form) {
    let hit = null;
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 25; n = n.parentElement, depth++) {
      const attrs = n.attributes || [];
      for (let i = 0; i < attrs.length; i++) {
        const r = fwAttr(attrs[i].name, attrs[i].value, form);
        if (r === 'write') return 'write';
        if (r === 'danger') hit = 'danger';
      }
      if (hit) return hit;
      if (n.tagName === 'BODY') break;
    }
    return null;
  }

  // Names that only open something: «Создать …», «Ещё», «Настройки», New, More, Details …
  const OPENER = new RegExp(`^[^\\p{L}\\p{N}]*(?:(?:нов(?:ый|ая|ое|ые|ого|ую)|создать|добавить|открыть|показать|еще|меню|просмотр|посмотреть|развернуть|действия|new|create|add|open|show|more|details|view|settings|preferences|options|filters?|sort|menu|expand|actions|see)${E}|подробн|настройк|параметр|фильтр|сортир)`, 'iu');
  const TOGGLE_ROLE = /^(switch|checkbox|radio|menuitemcheckbox|menuitemradio|option|slider|spinbutton)$/;
  const CLOSE = new Set(['×', '✕', '✖', 'x', 'close', 'закрыть', 'cancel', 'отмена']);
  const CLOSE_ARIA = /^(close|закрыть)(?: (dialog|modal|window|popup|окно|диалог))?$/;
  const GENERIC = new Set(['x', 'close', 'closer', 'cancel', 'dismiss', 'закрыть', 'отмена', 'button', 'btn', 'icon', 'modal', 'dialog', 'popup', 'true', 'false', 'secondary', 'default', 'ghost', 'outline', 'link', 'sm', 'md', 'lg']);
  const CHROME = 'nav,header,aside,[role=navigation],[role=banner],[role=menubar],[role=complementary]';
  const ROWS = 'table,tbody,[role=grid],[role=table],[role=row],[role=rowgroup],[role=list],[role=listitem],ul,ol';
  const ROUTE_Q = /^(page|view|tab|section|module|route|p|screen)$/i;
  const DIALOG = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true]';

  // ---------------- form openers and commits ----------------
  // Verbs that open a form, a dialog or a record when they START a label. Whole words, folded like dnorm().
  // FORM_NAV: the ones that only show something; they never finish a form.
  const FORM_NAV = [
    'открыть', 'откройте', 'просмотр', 'просмотреть', 'посмотреть', 'подробнее', 'подробности', 'еще', 'действия',
    'open', 'view', 'details', 'detail', 'more', 'actions', 'see',
    'offnen', 'öffnen', 'anzeigen', 'details', 'mehr', 'abrir', 'ver', 'detalles', 'más', 'detalhes', 'mais', 'ouvrir', 'voir',
    'détails', 'apri', 'vedi', 'visualizza', 'dettagli', 'altro', 'aç', 'görüntüle', 'goruntule', 'detaylar', 'ayrıntılar',
    'otwórz', 'otworz', 'zobacz', 'pokaż', 'pokaz', 'szczegóły', 'szczegoly', 'więcej', 'wiecej', 'ochish', 'korish', 'batafsil',
    'ашу', 'көру', 'толығырақ',
  ];
  const FORM_MAKE = [
    // RU
    'создать', 'создайте', 'добавить', 'добавьте', 'новый', 'новая', 'новое', 'новые', 'нового', 'новую', 'пригласить', 'пригласите',
    'изменить', 'измените', 'редактировать', 'отредактировать', 'сменить', 'смените', 'переименовать', 'настроить', 'настройте',
    'подключить', 'подключите', 'назначить', 'назначьте', 'управлять',
    // EN
    'new', 'create', 'add', 'invite', 'edit', 'change', 'rename', 'configure', 'setup', 'connect', 'assign', 'dispatch', 'manage',
    'compose', 'customize', 'modify',
    // verbs that open a dialog to record something ("Upload document", "Log fuel purchase", "Schedule service"):
    // openers only with an object after them (DIALOG_VERB); the bare verb inside a dialog or form is its commit
    'upload', 'log', 'schedule',
    // DE ES PT FR IT
    'neu', 'neue', 'neuer', 'neues', 'neuen', 'erstellen', 'hinzufügen', 'hinzufugen', 'einladen', 'bearbeiten', 'ändern', 'andern',
    'umbenennen', 'konfigurieren', 'einrichten', 'verbinden', 'zuweisen', 'verwalten',
    'nuevo', 'nueva', 'crear', 'añadir', 'anadir', 'agregar', 'invitar', 'editar', 'cambiar', 'renombrar', 'configurar', 'conectar',
    'asignar', 'gestionar', 'novo', 'nova', 'criar', 'adicionar', 'convidar', 'alterar', 'mudar', 'renomear', 'atribuir', 'gerenciar',
    'nouveau', 'nouvelle', 'créer', 'creer', 'ajouter', 'inviter', 'modifier', 'changer', 'renommer', 'configurer', 'connecter',
    'assigner', 'attribuer', 'gérer', 'gerer', 'nuovo', 'nuova', 'crea', 'creare', 'aggiungi', 'invita', 'modifica', 'cambia',
    'rinomina', 'configura', 'connetti', 'assegna', 'gestisci',
    // TR PL UZ KZ
    'yeni', 'oluştur', 'olustur', 'ekle', 'davet', 'düzenle', 'duzenle', 'değiştir', 'degistir', 'yapılandır', 'yapilandir', 'bağla', 'bagla',
    'nowy', 'nowa', 'nowe', 'utwórz', 'utworz', 'dodaj', 'zaproś', 'zapros', 'edytuj', 'zmień', 'zmien', 'skonfiguruj', 'połącz', 'polacz',
    'przypisz', 'yangi', 'yaratish', 'qoshish', 'taklif', 'tahrirlash', 'ozgartirish', 'янги', 'қўшиш', 'таҳрирлаш',
    'жаңа', 'құру', 'қосу', 'шақыру', 'өңдеу', 'өзгерту',
  ];
  const FORM_WORDS = new Set([...FORM_NAV, ...FORM_MAKE].map(fold));
  // Opener verbs that finish a form when they sit inside one.
  const FORM_FINISH = new Set(['создать', 'создайте', 'пригласить', 'пригласите', 'назначить', 'назначьте', 'подключить', 'create', 'invite',
    'dispatch', 'assign', 'connect', 'upload', 'log', 'schedule', 'erstellen', 'einladen', 'zuweisen', 'crear', 'invitar', 'asignar', 'criar', 'convidar', 'atribuir', 'créer',
    'creer', 'inviter', 'assigner', 'crea', 'creare', 'invita', 'assegna', 'oluştur', 'olustur', 'davet', 'utwórz', 'utworz', 'zaproś', 'zapros',
    'przypisz', 'yaratish', 'taklif', 'құру', 'шақыру'].map(fold));
  const FORM_NAV_SET = new Set(FORM_NAV.map(fold));
  // Chinese, Japanese, Korean: no word boundaries; a label that starts with one of these.
  const FORM_CJK = ['新建', '新增', '创建', '創建', '添加', '邀请', '邀請', '编辑', '編輯', '修改', '更改', '重命名', '配置', '设置', '設定',
    '连接', '連接', '分配', '新規', '作成', '追加', '招待', '編集', '変更', '만들기', '추가', '초대', '편집', '수정', '변경', '새'];
  const FORM_CJK_NAV = ['打开', '打開', '查看', '详情', '詳情', '更多', '開く', '詳細', 'もっと見る', '열기', '보기', '상세', '더보기'];
  // Opener verb + object that is itself a write: the masked text would no longer show it.
  const FORM_VETO = /^(?:add to (?:cart|bag|basket|order|wishlist|favou?rites)|add (?:funds|money|credit|balance)|добавить в (?:корзину|избранное|заказ)|new session|connect wallet)(?: |$)/;
  // "+", "＋ New load", "⋯", "⋮", "…", "•••", "..." (icon buttons for more actions).
  const FORM_GLYPH = /^\s*(?:[+＋](?!\s*\d)|[⋯⋮…]|\.\.\.|•••|···)/; // "+10%" is a number
  // Dialog verbs: they open a form only with an object ("Upload document"); bare ("Upload") they are the commit.
  // "Log" is never "Log out / off / in / on".
  const DIALOG_VERB = new Set(['upload', 'log', 'schedule']);
  const LOG_SESSION = /^log ?(?:out|off|in|on|into)(?: |$)/;
  // What "Log …" records is a noun there, not a veto verb: "Log fuel purchase", "Log payment", "Log expense".
  const LOG_OBJECT = new Set(['purchase', 'purchases', 'payment', 'payments', 'expense', 'expenses', 'charge', 'charges', 'refund', 'refunds',
    'transfer', 'transfers', 'order', 'orders', 'sale', 'sales']);
  /** The opener words removed, so the rest of the text can go through the full veto. label: the control's own label. */
  function maskForm(s, label) {
    let t = String(s == null ? '' : s);
    for (const w of FORM_CJK.concat(FORM_CJK_NAV)) if (t.includes(w)) t = t.split(w).join(' ');
    const logs = /^log(?: |$)/.test(dnorm(label === undefined ? s : label));
    return dnorm(t).split(' ').filter(w => w && !FORM_WORDS.has(w) && !(logs && LOG_OBJECT.has(w))).join(' ');
  }
  // Veto phrases that start with an opener word are not excused by it: «Neu starten», "Add to cart" (the opener word
  // alone is harmless, so the phrase is what the veto saw). Except the plan form behind «Сменить тариф».
  const PHRASE_OK = /^(?:сменить тариф|изменить тариф|change plan|change your plan|davet et)(?: |$)/;
  /** May this label be pressed as a form opener? Only its opener words may explain a veto hit. */
  function formLabelOk(label) {
    const lab = dnorm(label);
    if (FORM_VETO.test(lab)) return false;
    if (!isDangerText(label)) return true;
    if (isDangerText(maskForm(label, label))) return false;
    if (PHRASE_OK.test(lab)) return true;
    return lab.split(' ').some(w => (FORM_WORDS.has(w) || (/^log /.test(lab) && LOG_OBJECT.has(w))) && isDangerText(w)) || FORM_CJK.some(w => String(label).includes(w) && isDangerText(w));
  }
  /** 'make' | 'nav' | null: does the label start with an opener verb (or an opener glyph)? */
  function formVerb(label) {
    const raw = String(label || '').trim();
    if (!raw) return null;
    if (FORM_GLYPH.test(raw)) return 'make';
    for (const w of FORM_CJK) if (raw.startsWith(w)) return 'make';
    for (const w of FORM_CJK_NAV) if (raw.startsWith(w)) return 'nav';
    const words = dnorm(raw).split(' '), first = words[0];
    if (!first || !FORM_WORDS.has(first)) return null;
    if (DIALOG_VERB.has(first) && (words.length < 2 || LOG_SESSION.test(words.join(' ')))) return null; // "Upload", "Log out"
    return FORM_NAV_SET.has(first) ? 'nav' : 'make';
  }

  // Pagination and "load more" are never pressed; sort and filter controls once per view.
  const PAGER = /^(?:next|prev|previous|first|last|older|newer|load more|show more|see more|view more|more results|next page|previous page|go to page \d+|page \d+|далее|вперед|назад|следующая|предыдущая|первая|последняя|показать еще|загрузить еще|еще \d+|страница \d+)$/;
  const PAGER_BOX = '[class*=pagination i],[class*=pager i],[aria-label*=pagination i],[aria-label*=пагинац i],[aria-label*=страниц i]';
  const LISTING = /^(?:filters?|фильтр\w*|sort\w*|сортир\w*|сортировка|order by|group by|группир\w*)(?: |$)/;
  // A bare page number ("2") is a pager; "↳ #1042" or "#1061 El Paso" is a record.
  const pagerLike = (el, label) => PAGER.test(dnorm(label)) || /^(?:[«»‹›<>←→]+|\d{1,4})$/.test(String(label || '').trim()) || !!el.closest(PAGER_BOX);
  // A status tab with a count («Available 3», "Inbox 12») filters the list it sits over: a filter chip, once per view.
  const listingLike = (el, label) => LISTING.test(dnorm(label)) || !!el.closest('th,[role=columnheader],[aria-sort]')
    || (!!el.closest('[class*=chip i]') && !el.hasAttribute('aria-haspopup'))
    || (roleOf(el) === 'tab' && /\s\(?\d[\d\s.,]*\)?$/.test(String(label || '').trim()));

  // Fields a user fills in. Search boxes and filters in a toolbar are not a form.
  const FIELD_SEL = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=search]),select,textarea,[contenteditable=""],[contenteditable=true],[role=textbox],[role=combobox],[role=spinbutton]';
  const SEARCHY = /search|query|filter|поиск|найти|фильтр|^q$/i;
  function isField(f) {
    if (ours(f) || !shown(f)) return false;
    if (f.closest('[role=search],[role=toolbar],search')) return false;
    return ![f.getAttribute('type'), f.getAttribute('name'), f.id, f.getAttribute('placeholder'), f.getAttribute('aria-label')].some(v => v && SEARCHY.test(v));
  }
  // Remembered for 400 ms: one capture asks about the same few boxes for every button in them.
  let fieldMemo = { at: 0, map: null };
  function hasFields(n) {
    const now = Date.now();
    if (!fieldMemo.map || now - fieldMemo.at > 400) fieldMemo = { at: now, map: new WeakMap() };
    const known = fieldMemo.map.get(n);
    if (known !== undefined) return known;
    let k = 0, found = false;
    for (const f of n.querySelectorAll(FIELD_SEL)) { if (++k > 40) break; if (isField(f)) { found = true; break; } }
    fieldMemo.map.set(n, found);
    return found;
  }
  // A <form> around the whole app (ASP.NET WebForms) is not "a form".
  const wrapperForm = f => !!f.querySelector('main,nav,aside,[role=main],[role=navigation]');
  const SCOPE_STOP = 'main,[role=main],body,html,[role=tabpanel],article';
  /** The form, fieldset or small box up to 3 levels up that holds fields next to this control; null at page level. */
  function fieldScope(el) {
    const form = (el.form && el.form.nodeType === 1 ? el.form : null) || el.closest('form,[role=form]');
    if (form && !wrapperForm(form)) return hasFields(form) ? form : null;
    const fs = el.closest('fieldset');
    if (fs && hasFields(fs)) return fs;
    for (let n = el.parentElement, i = 0; n && i < 3; n = n.parentElement, i++) {
      if (n.matches(SCOPE_STOP) || n.querySelector('h1')) return null;
      if (hasFields(n)) return n;
    }
    return null;
  }
  const PRIMARY = /primary|cta|submit|success|accent|main-action|btn-dark|is-info/i;
  // Commit-like words that are not in the veto list (it already holds save, send, apply, confirm …).
  const COMMIT_EXTRA = /^(?:ok|okay|ок|update|log ?in|sign ?in|sign ?up|register|войти|зарегистр\p{L}*|create account|готово)(?: |$)/u;
  const buttonLike = el => el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && /^(submit|button|image)$/i.test(el.type)) || roleOf(el) === 'button';
  const isCloser = label => { const l = low(label); return CLOSE.has(l) || CLOSE_ARIA.test(l) || GLYPH.test(l); };

  /** Does this control finish a form or dialog? Pure DOM, no state. label: its name when the caller has it. */
  function commitOf(el, name) {
    if (!el || el.nodeType !== 1 || ours(el) || !buttonLike(el)) return false;
    if (TOGGLE_ROLE.test(roleOf(el)) || el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked')) return false;
    const popup = el.getAttribute('aria-haspopup');
    if ((popup && popup !== 'false') || el.hasAttribute('aria-expanded')) return false; // a menu trigger
    const label = name !== undefined ? name : S.labelOf ? S.labelOf(el) : String(el.textContent || '');
    if (label && (isCloser(label) || pagerLike(el, label))) return false;
    const form = (el.form && el.form.nodeType === 1 ? el.form : null) || el.closest('form');
    const submit = (el.tagName === 'BUTTON' && el.type === 'submit') || (el.tagName === 'INPUT' && /^(submit|image)$/i.test(el.type));
    if (form && submit && !wrapperForm(form)) return true;
    if (!label) return false;
    const dlg = el.closest(DIALOG);
    if (!dlg && !fieldScope(el)) return false;
    if (/filter|фильтр|reset view/i.test(label)) return false; // "Clear filters" next to filter fields resets a list
    const verb = formVerb(label);
    const first = dnorm(label).split(' ')[0];
    // "+ Add stop" (a stop is a noun here) adds a row next to fields: an opener verb that does not finish a form
    // decides before the veto words, outside a dialog.
    if (verb === 'make' && !dlg && !FORM_FINISH.has(first)) return !form && PRIMARY.test(classOf(el));
    if (isDangerText(label) || COMMIT_EXTRA.test(dnorm(label))) return true;
    // «Добавить» in a dialog footer, "Create load" under fields; in a <form>, "Add line" adds a row but
    // "Create load" / "Invite" / "Dispatch" finish it.
    // "+ Add stop" under fields adds a row; outside a dialog only create/invite/dispatch-like verbs (or a primary
    // button) finish a form.
    // A bare dialog verb ("Upload", "Schedule", "Log") is the dialog's or the form's own commit.
    if ((verb === 'make' || (DIALOG_VERB.has(first) && !LOG_SESSION.test(dnorm(label)))) && (dlg || FORM_FINISH.has(first))) return true;
    return !!dlg && PRIMARY.test(classOf(el));
  }
  /** Looks like it opens a form, a dialog or a record: an opener verb, a glyph, or aria-haspopup="dialog". */
  function openerLike(el, name) {
    if (!el || el.nodeType !== 1) return false;
    const role = roleOf(el);
    if (!/^(button|link|menuitem)$/.test(role) && el.tagName !== 'SUMMARY') return false;
    if (el.getAttribute('aria-haspopup') === 'dialog') return true;
    const label = name !== undefined ? name : S.labelOf ? S.labelOf(el) : String(el.textContent || '');
    return !!formVerb(label) && !pagerLike(el, label);
  }
  // Page-level <a> that acts as a button: no address of its own.
  const buttonAnchor = el => {
    const raw = el.getAttribute('href');
    if (el.hasAttribute('download') || (el.getAttribute('target') || '').replace('_self', '')) return false;
    return !raw || (/^#/.test(raw) && !/^#[!/]/.test(raw)) || /^javascript:\s*(void|;|$)/i.test(raw);
  };

  // Set per walk (start/boot) and by snapshot()/tests: may form openers be pressed?
  let formsOn = false;
  const inExtension = () => { try { return typeof chrome !== 'undefined' && !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  /**
   * Form openers are pressed only when writes are blocked below the page:
   *  - extension: opts.netBlocked === true (on resume, the value saved at start when opts leaves it out);
   *  - SDK (opts.sdk === true, or no extension runtime): the page guard confirmed (guard.on() resolved true);
   *  - opts.forms === false: never.
   */
  function formsAllowed(o, guardOk, savedNet) {
    if (!o || o.forms === false) return false;
    const sdk = o.sdk === true || (o.sdk !== false && !inExtension());
    if (sdk) return guardOk === true;
    return (o.netBlocked !== undefined ? o.netBlocked : savedNet) === true;
  }

  /** A form opener the explorer may press (formsOn is checked by the caller). */
  function formKind(el, role) {
    const T = el.tagName;
    if (T === 'A' ? !buttonAnchor(el) : !/^(button|link|menuitem)$/.test(role)) return false;
    const label = S.labelOf ? S.labelOf(el) : String(el.textContent || '');
    if (!formVerb(label) || pagerLike(el, label) || !formLabelOk(label)) return false;
    if (el.closest(DIALOG) || fieldScope(el) || commitOf(el)) return false; // commit context
    // Only the opener verb is excused: everything else the element says goes through the full veto.
    if (isDangerText(maskForm(textOf(el), label)) || DANGER_CLASS.test(classOf(el)) || fwCheck(el, true)) return false;
    return true;
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));
  // One macrotask boundary, so input and rendering run between chunks of a long capture.
  // Not setTimeout: that is clamped to 1 s in background tabs, which would turn 15 yields into 15 s.
  const yieldTask = () => {
    try { if (typeof scheduler !== 'undefined' && scheduler && typeof scheduler.yield === 'function') return scheduler.yield(); } catch (e) { /* fall through */ }
    return new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
  };
  const CHUNK = 10; // controls described per task during a capture
  const lite = (() => { try { return (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4; } catch (e) { return false; } })();
  const norm = s => (S.normText ? S.normText(s) : String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim());
  const low = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
  const mask = s => String(s || '').replace(/\S+@\S+/g, '…').replace(/\d{4,}/g, '…');
  const ours = n => !!(n && n.nodeType === 1 && ((S.pointer && S.pointer.isOurs && S.pointer.isOurs(n)) || (n.closest && n.closest('[data-scopos-ui],scopos-layer'))));
  const shown = el => {
    if (!el || !el.isConnected) return false;
    if (S.isVisible) return S.isVisible(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
  };
  const inventory = container => { try { return S.inventory(container) || []; } catch (e) { return []; } };

  // Screens by address: record ids become ":id", query routes (?page=x) count, "#top" does not.
  const ID_SEG = /\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,})(?=\/|$)/gi;
  function pageKey(u = location.href) {
    const x = new URL(u, location.href);
    const path = x.pathname.replace(ID_SEG, '/:id').replace(/\/+$/, '') || '/';
    const q = [...x.searchParams].filter(([k, v]) => ROUTE_Q.test(k) && !/^\d*$/.test(v)).map(([k, v]) => `${k}=${v}`).sort().join('&');
    const h = /^#[!/]/.test(x.hash) ? x.hash.split('?')[0].replace(ID_SEG, '/:id').replace(/\/+$/, '') : '';
    return path + (q ? '?' + q : '') + (h.length > 2 ? h : '');
  }
  // The address we navigate to: no tokens, e-mails or tracking in the query, no "#access_token=…".
  function cleanUrl(h) {
    const u = new URL(h, location.href);
    const q = [...u.searchParams].filter(([k]) => ROUTE_Q.test(k));
    const search = q.length ? '?' + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    return u.origin + u.pathname + search + (/^#[!/]/.test(u.hash) ? u.hash : '');
  }

  function roleOf(el) {
    const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (r) return r.toLowerCase();
    const t = el.tagName;
    if (t === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'INPUT') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      return /^(submit|button|reset|image)$/.test(ty) ? 'button' : /^(checkbox|radio)$/.test(ty) ? ty : 'textbox';
    }
    if (t === 'SELECT') return 'select';
    return t.toLowerCase();
  }

  // Everything an element says about itself, not only its accessible name:
  // a button labelled «Действие» whose text is «Удалить» is still a delete button.
  // The whole text is read (no 300-character cut: a long harmless text followed by «Удалить» is still a delete button).
  const FW_ATTR = /^(?:data-|hx-|phx-|wire:|x-on:|@|v-on:|ng-|on[a-z]+$)/i;
  function textOf(el) {
    const a = n => el.getAttribute(n);
    const cap = (v, n = MAX_ATTR) => String(v == null ? '' : v).slice(0, n);
    const parts = [S.labelOf ? S.labelOf(el) : '', cap(el.innerText || el.textContent, MAX_TEXT), a('aria-label'), a('title'), el.id, a('name'), a('formaction'), a('href')].map(v => cap(v, MAX_TEXT));
    if ((el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) || el.tagName === 'BUTTON') parts.push(cap(el.value)); // set by the site, not typed
    const desc = a('aria-describedby');
    if (desc) desc.split(/\s+/).forEach(id => { const n = document.getElementById(id); if (n) parts.push(cap(n.textContent)); });
    // data-* values of any length, framework handlers (hx-*, phx-*, wire:*, @click, ng-click …) and on* handlers.
    for (const at of el.attributes || []) if (at.value && FW_ATTR.test(at.name) && !/^data-scopos/i.test(at.name)) parts.push(cap(at.value));
    return parts.filter(Boolean).join(' · ');
  }
  // What a link says to a reader (not its address, which is checked strictly on its own).
  const linkText = a => [S.labelOf ? S.labelOf(a) : '', String(a.innerText || a.textContent || '').slice(0, MAX_TEXT), a.getAttribute('aria-label'), a.getAttribute('title')].filter(Boolean).join(' · ');
  const classOf = el => String(el.className && typeof el.className === 'object' ? el.className.baseVal : el.className || '');
  const danger = el => isDangerText(textOf(el)) || DANGER_CLASS.test(classOf(el)) || !!fwCheck(el);
  // A control in another document (an iframe, same-origin or not) is out of reach of the guard and of our checks.
  const foreign = el => {
    try { return !el.ownerDocument || el.ownerDocument !== document; } catch (e) { return true; }
  };

  // In-page triggers built from <a> (Bootstrap tabs and dropdowns): href="#…" or none.
  function anchorTrigger(el) {
    const raw = el.getAttribute('href');
    if (el.hasAttribute('download') || (el.getAttribute('target') || '').replace('_self', '')) return false;
    if (raw && !/^#/.test(raw) && !/^javascript:\s*(void|;|$)/i.test(raw)) return false;
    return roleOf(el) === 'tab' || el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls') || el.hasAttribute('data-toggle') || el.hasAttribute('data-bs-toggle');
  }

  /** Can the explorer press this to see what it opens? Returns the kind, or null. Allow-list, then veto. */
  function pressKind(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected || ours(el)) return null;
    if (foreign(el)) return null; // inside an iframe: never pressed
    const role = roleOf(el), T = el.tagName;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert],fieldset[disabled]')) return null;
    // Toggles change a setting the moment they are pressed.
    if (TOGGLE_ROLE.test(role) || el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked')) return null;
    if ((T === 'INPUT' && !/^button$/i.test(el.type)) || T === 'SELECT' || T === 'TEXTAREA' || el.isContentEditable) return null;
    // A <button> is type "submit" by default; inside a form it would send it.
    if (T === 'BUTTON' && (el.type === 'submit' || el.type === 'reset') && (el.form || el.closest('form'))) return null;
    // Links are followed by address, never clicked; an <a href="#"> that acts as a button may be a form opener.
    const form = formsOn && formKind(el, role);
    if (T === 'A' && !anchorTrigger(el)) return form ? 'form' : null;
    if (T !== 'SUMMARY' && !/^(button|tab|menuitem|treeitem|link)$/.test(role)) return null;
    const label = S.labelOf ? S.labelOf(el) : el.textContent;
    if (pagerLike(el, label) || FORM_VETO.test(dnorm(label))) return null; // pagination, "load more"; "Add to cart", "Add funds"
    // hx-post/put/patch/delete, phx-submit, wire:submit, data-method="delete" (here or on an ancestor the click
    // bubbles to), a handler that names an action, or any risky word anywhere in the element: never pressed.
    // A form opener («Пригласить коллегу») passed the same veto with only its leading opener verb excused.
    if (danger(el)) return form ? 'form' : null;
    if (role === 'tab') return 'tab';
    if (T === 'SUMMARY') return 'disclosure';
    const popup = el.getAttribute('aria-haspopup');
    if (popup && popup !== 'false') return popup === 'dialog' && commitOf(el) ? null : 'menu';
    if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls')) return 'disclosure';
    if (role !== 'button') return form ? 'form' : null; // menu items and tree items act; only their submenus open
    if (OPENER.test(norm(label)) && !commitOf(el)) return 'opener';
    // Everything else («Пригласить коллегу», «Сменить тариф», Watch, Follow …) is pressed only as a form opener,
    // with writes blocked below the page; otherwise never. Commits («Сохранить», "Send invite") never.
    return form ? 'form' : null;
  }

  // ---------------- links ----------------
  /** The address a link leads to if following it only shows a page of this product; null otherwise. */
  function safeHref(a) {
    if (!st || a.tagName !== 'A' || foreign(a)) return null;
    const raw = a.getAttribute('href');
    if (!raw || (raw[0] === '#' && !/^#[!/]/.test(raw))) return null;
    if (a.hasAttribute('download') || ['data-method', 'data-turbo-method', 'data-confirm', 'data-turbo-confirm', 'data-remote'].some(x => a.hasAttribute(x))) return null;
    const tgt = (a.getAttribute('target') || '').toLowerCase();
    if (tgt && tgt !== '_self' && tgt !== '_top' && tgt !== '_parent') return null;
    if (/\bnofollow\b/i.test(a.getAttribute('rel') || '')) return null;
    const type = a.getAttribute('type');
    if (type && !/html/i.test(type)) return null;
    if (a.closest('footer,[role=contentinfo]')) return null;
    let u;
    try { u = new URL(raw, location.href); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol) || u.origin !== st.origin || u.origin !== location.origin) return null;
    if (u.pathname === location.pathname && u.search === location.search && u.hash && !/^#[!/]/.test(u.hash)) return null; // #section on this page
    if (NON_HTML.test(u.pathname)) return null;
    // The address strictly (every action verb, in any language); the text only for words that say the link acts.
    if (unsafeAddress(u.href)) return null;
    if (linkTextDanger(linkText(a)) || DANGER_CLASS.test(classOf(a))) return null;
    if (fwCheck(a)) return null; // hx-post / data-method / an onclick that names an action
    return u.href;
  }

  // Queue the page a link leads to. Record lists (/invoices/1, /invoices/2 …) give at most two samples per route.
  function linkView(a) {
    const href = safeHref(a);
    if (!href) return null;
    const key = pageKey(href);
    if (st.views[key]) return st.views[key];
    const hot = !!a.closest(CHROME);
    const last = (key.split(/[?#]/)[0].split('/').pop() || '');
    if (!hot && (/\d|:id/.test(last) || a.closest(ROWS))) {
      const shape = key.replace(/\/[^/?#]*(?=$|[?#])/, '/*');
      st.shapes[shape] = (st.shapes[shape] || 0) + 1;
      if (st.shapes[shape] > 2) return null;
    }
    return addView(key, cleanUrl(href), 'page', undefined, hot, href);
  }

  // ---------------- dialogs ----------------
  function openDialogs() {
    const all = [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')].filter(d => {
      if (ours(d) || !shown(d)) return false;
      // Cookie banners are dialogs too, but not part of the product.
      return !/cookie|куки|gdpr|consent/i.test(`${d.getAttribute('aria-label') || ''} ${d.id} ${classOf(d)}`);
    });
    return all.filter(d => !all.some(o => o !== d && o.contains(d)));
  }
  const dialogTitle = d => {
    const h = d.querySelector('h1,h2,h3,[role=heading],legend');
    return mask(d.getAttribute('aria-label') || (h && h.textContent) || 'диалог').replace(/\s+/g, ' ').trim().slice(0, 60);
  };

  // What the dialog asks, without its buttons: "Cancel this booking?", «Удалить счёт? Это нельзя отменить».
  function dialogQuestion(d) {
    const head = [d.getAttribute('aria-label')];
    const ids = `${d.getAttribute('aria-labelledby') || ''} ${d.getAttribute('aria-describedby') || ''}`.trim();
    if (ids) ids.split(/\s+/).forEach(id => { const n = document.getElementById(id); if (n) head.push(String(n.textContent || '').slice(0, MAX_ATTR)); });
    const h = d.querySelector('h1,h2,h3,h4,[role=heading],legend');
    if (h) head.push(h.textContent);
    let body = '';
    try {
      const w = document.createTreeWalker(d, 4 /* NodeFilter.SHOW_TEXT */);
      for (let n = w.nextNode(); n && body.length < MAX_ATTR; n = w.nextNode()) {
        const p = n.parentElement;
        if (p && p.closest('button,[role=button],input,select,textarea,option,script,style,template')) continue;
        body += ' ' + n.nodeValue;
      }
    } catch (e) { body = String(d.textContent || '').slice(0, MAX_ATTR); }
    return head.filter(Boolean).join(' · ') + ' · ' + body;
  }
  const GLYPH = /^[×✕✖x]$/;
  const CLOSER_SKIP = new Set([...GENERIC, ...UI_SAFE]);

  /**
   * Only an exact «Закрыть» / × / «Отмена» / Cancel, and nothing about it may sound like an action.
   * When the dialog itself asks about an action ("Cancel this booking?"), its Cancel/Отмена/Close may be the
   * confirmation: then only an icon × (or aria-label Close/Закрыть with no text) is accepted.
   */
  function closerIn(d) {
    let best = null, bestScore = 0;
    const asks = isDangerText(dialogQuestion(d));
    for (const b of d.querySelectorAll('button,[role=button],input[type=button]')) {
      if (ours(b) || foreign(b) || b.disabled || !shown(b)) continue;
      if (b.tagName === 'BUTTON' && b.type === 'submit' && b.form) continue;
      const aria = low(b.getAttribute('aria-label')), title = low(b.getAttribute('title'));
      const text = low(b.innerText || b.textContent), val = b.tagName === 'INPUT' ? low(b.value) : '';
      const labels = [aria, title, text, val].filter(Boolean);
      if (!labels.length || !labels.every(l => CLOSE.has(l) || CLOSE_ARIA.test(l))) continue;
      if (asks) {
        if ((text && !GLYPH.test(text)) || (val && !GLYPH.test(val))) continue; // a worded Cancel/Close: maybe the confirmation
        if ([aria, title].some(l => l && !GLYPH.test(l) && !CLOSE_ARIA.test(l))) continue; // aria-label="Cancel"
      }
      // data-testid="cancel-button" is fine, data-testid="cancel-order" is not; nor name="delete" or phx-click="cancel_order".
      const attrs = [b.id, b.getAttribute('name'), b.value, b.getAttribute('formaction'), ...[...(b.attributes || [])].filter(x => FW_ATTR.test(x.name) && !/^data-scopos/i.test(x.name)).map(x => x.value)]
        .map(v => (v == null ? '' : String(v).slice(0, MAX_ATTR)))
        .filter(v => v && !dnorm(v).split(' ').filter(Boolean).every(t => GENERIC.has(t) || UI_SAFE.has(t) || /^\d+$/.test(t)));
      if (attrs.some(v => isDangerText(v) || actionPart(v, CLOSER_SKIP)) || DANGER_CLASS.test(classOf(b))) continue;
      if (fwCheck(b) === 'write') continue; // hx-post="/orders/5/cancel", wire:submit …
      const score = CLOSE_ARIA.test(aria) ? 3 : labels.some(l => GLYPH.test(l)) ? 2 : 1;
      if (score > bestScore) { best = b; bestScore = score; }
    }
    return best;
  }

  function escape() {
    const a = document.activeElement;
    const t = a && a !== document.body && !ours(a) ? a : document.body || document.documentElement;
    for (const type of ['keydown', 'keyup']) t.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, composed: true }));
  }

  /** Escape, then an exact close button, then dialog.close(). Returns whether it is gone. */
  async function closeDialog(d) {
    const gone = () => !d.isConnected || !openDialogs().includes(d);
    try { const a = document.activeElement; if (a && a !== document.body && !ours(a) && !d.contains(a) && a.blur) a.blur(); } catch (e) { /* ignore */ }
    d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, composed: true }));
    escape();
    await wait(160);
    if (gone()) return true;
    const x = closerIn(d);
    if (x) { press(x); await wait(240); if (gone()) return true; }
    if (d.tagName === 'DIALOG' && d.open) { try { d.close(); } catch (e) { /* ignore */ } await wait(80); if (gone()) return true; }
    return false;
  }

  // ---------------- pressing ----------------
  /**
   * A press the way a mouse does it (pointer → mouse → click), so menus that open on
   * pointerdown work, and only when nothing covers the control.
   */
  function press(el) {
    if (!el || !el.isConnected || foreign(el)) return false; // never into an iframe or another document
    if (el.closest && el.closest('iframe,frame,object,embed')) return false;
    let r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      r = el.getBoundingClientRect();
    }
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top) return false; // off-screen even after scrolling: nothing to aim at
    if (!ours(top) && top !== el && !el.contains(top) && !top.contains(el)) return false; // covered (a modal, a sticky bar)
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
    const p = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const was = el.getAttribute('aria-expanded');
    try { el.dispatchEvent(new PointerEvent('pointerdown', { ...o, ...p })); } catch (e) { /* old engine */ }
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...o, ...p, buttons: 0 })); } catch (e) { /* old engine */ }
    el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
    // Opened on pointerdown already (Radix): a click would toggle it shut again.
    if (el.isConnected && !(was !== 'true' && el.getAttribute('aria-expanded') === 'true')) el.click();
    return true;
  }

  /** Re-find by the exact descriptor and re-check safety on what was found: { el, kind } or null. */
  function refind(c) {
    let el = null;
    try {
      if (S.resolveDetailed) {
        const r = S.resolveDetailed(c.d);
        if (r && r.el && !r.ambiguous && r.score >= 0.85) el = r.el;
      } else el = S.resolve(c.d);
    } catch (e) { el = null; }
    if (!el || ours(el)) return null;
    const want = norm(String(c.name || '').replace(/…$/, '')), have = norm(S.labelOf ? S.labelOf(el) : '');
    if (want && !(have === want || (/…$/.test(c.name || '') && have.startsWith(want)))) return null;
    const kind = pressKind(el); // computed once here and reused by the probe (danger() reads innerText)
    return kind ? { el, kind } : null;
  }

  // Resolves when the DOM has been quiet for `quiet` ms (or after `max`). Style-only changes (animations) don't count.
  function settle(quiet = 280, max = 1800) {
    return new Promise(resolve => {
      let t = setTimeout(done, quiet);
      const hard = setTimeout(done, max);
      const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quiet); });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'aria-expanded', 'aria-hidden', 'aria-modal', 'role'] });
      function done() { mo.disconnect(); clearTimeout(t); clearTimeout(hard); resolve(); }
    });
  }

  // Elements added or switched on while a press settles: where a menu or a panel shows up.
  function watchChanges() {
    const seen = new Set();
    const take = muts => {
      for (const m of muts) {
        if (m.type === 'childList') m.addedNodes.forEach(n => { if (n.nodeType === 1) seen.add(n); });
        else if (m.target.nodeType === 1) seen.add(m.target);
      }
    };
    const mo = new MutationObserver(take);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'aria-hidden', 'aria-expanded', 'style'] });
    return () => { take(mo.takeRecords()); mo.disconnect(); return seen; };
  }

  // Controls that appeared because of the press: inside new menus/panels, the aria-controls target,
  // or close to the control. Toasts and live regions are not panels.
  function appearedAfter(el, nodes, before) {
    const r0 = el.isConnected ? el.getBoundingClientRect() : null;
    const near = n => {
      if (!r0) return true;
      const r = n.getBoundingClientRect();
      return r.width > 0 && Math.abs((r.top + r.bottom) / 2 - (r0.top + r0.bottom) / 2) < 600 && Math.abs((r.left + r.right) / 2 - (r0.left + r0.right) / 2) < 900;
    };
    const ctlId = (el.getAttribute('aria-controls') || '').split(/\s+/)[0];
    const ctl = ctlId ? document.getElementById(ctlId) : null;
    const roots = [];
    for (const n of nodes) {
      if (!n.isConnected || ours(n) || n === document.body || n === document.documentElement || n === el) continue;
      if (n.closest('[role=status],[role=alert],[aria-live]')) continue;
      roots.push(n);
    }
    if (ctl && !roots.includes(ctl)) roots.push(ctl);
    const top = roots.filter(n => !roots.some(m => m !== n && m.contains(n)));
    const out = [], got = new Set();
    for (const rt of top) {
      const semantic = rt === ctl || (rt.matches && rt.matches('[role=menu],[role=listbox],[role=tabpanel],[role=tree],[role=dialog],details'));
      for (const x of inventory(rt)) {
        if (before.has(x.el) || x.el === el || got.has(x.el) || (!semantic && !near(x.el))) continue;
        got.add(x.el);
        out.push(x);
        if (out.length >= 60) return out;
      }
    }
    return out;
  }

  // ---------------- state ----------------
  let st = null, opts = null, stopping = false, gen = 0, looping = 0;
  const live = g => g === gen && !stopping && !!st && st.status === 'running' && !st.stopping;

  async function save() {
    if (!st || !opts || !opts.store) return;
    try { await opts.store.save(st); } catch (e) { st.saveError = String((e && e.message) || e); }
  }
  const progress = label => {
    if (!st || !opts || !opts.onProgress) return;
    const views = Object.values(st.views).filter(v => v.captured).length;
    try { opts.onProgress({ views, probes: st.probes, label }); } catch (e) { /* ignore */ }
  };
  /**
   * Turns the guard on and waits for the page-world patch: S.guard.on() may only send 'guard:inject' to the
   * extension and return. Resolves when <html data-scopos-guard-main="1"> appears (or on() confirms), or after
   * 1.5 s. The walk then goes on either way: only tabs, disclosures, menus and openers are ever pressed.
   * { ok, confirmed }: confirmed only when on() itself resolved true (the attribute can be written by any page
   * script); form openers in SDK mode need confirmed. Waits up to 2.5 s for on() to settle.
   */
  async function guardOn() {
    if (!S.guard || typeof S.guard.on !== 'function') return { ok: false, confirmed: false };
    let confirmed = false, settled = false, p = null;
    try { p = S.guard.on(); } catch (e) { p = null; }
    if (p && typeof p.then === 'function') p.then(ok => { confirmed = ok === true; settled = true; }, () => { settled = true; });
    else { confirmed = p === true; settled = true; }
    const main = () => { try { return document.documentElement.getAttribute('data-scopos-guard-main') === '1'; } catch (e) { return false; } };
    const t0 = Date.now();
    while (!settled && Date.now() - t0 < 2500) await wait(50);
    return { ok: confirmed || main(), confirmed };
  }
  const guardOff = () => { try { if (S.guard) S.guard.off(); } catch (e) { /* ignore */ } };
  const blockedCount = () => { try { return S.guard ? S.guard.blocked() : 0; } catch (e) { return 0; } };
  // Writes the network block stopped, when the host can tell (opts.netBlocks: () => number | Promise<number>).
  async function netCount() {
    if (!opts || typeof opts.netBlocks !== 'function') return 0;
    try { return Number(await Promise.race([Promise.resolve(opts.netBlocks()), wait(400).then(() => 0)])) || 0; } catch (e) { return 0; }
  }

  // Navigation fence (Navigation API): while the walk runs, a press may not take the tab to another origin,
  // start a download, post a form or open an address that acts. Our own goTo() navigations are let through.
  let fence = null, fenceNav = null, fenced = 0, navAllow = '';
  function fenceOn() {
    if (fence) return;
    let nav = null;
    try { nav = typeof navigation !== 'undefined' ? navigation : null; } catch (e) { nav = null; }
    if (!nav || typeof nav.addEventListener !== 'function') return;
    fence = e => {
      try {
        if (!st || st.status !== 'running' || !e.cancelable) return;
        if (e.navigationType === 'reload' || e.navigationType === 'traverse') return;
        const u = new URL(e.destination.url);
        if (navAllow && u.href === navAllow) return;
        const samePage = u.origin === location.origin && u.pathname === location.pathname && u.search === location.search && !/^#[!/]/.test(u.hash);
        const bad = !!e.downloadRequest || !!e.formData || u.origin !== st.origin || (!samePage && unsafeAddress(u.href));
        if (bad) { e.preventDefault(); fenced++; }
      } catch (x) { /* never break the page's own navigation on our error */ }
    };
    try { nav.addEventListener('navigate', fence); fenceNav = nav; } catch (e) { fence = null; }
  }
  function fenceOff() {
    try { if (fence && fenceNav) fenceNav.removeEventListener('navigate', fence); } catch (e) { /* ignore */ }
    fence = null; fenceNav = null;
  }

  // Form pages at their own address (/loads/new, /drivers/add, /team/invite): the last segment names the form,
  // there is no query, and the rest of the address is safe. Only while form openers are allowed: a GET to such an
  // address shows a form. /cart/add?id=5 and /wishlist/add/5 stay refused.
  const FORM_ROUTE = new Set(['add', 'new', 'create', 'invite', 'edit']);
  function formRoute(href) {
    if (!formsOn) return false;
    let u;
    try { u = new URL(href, typeof location !== 'undefined' && location.href ? location.href : 'http://scopos.invalid/'); } catch (e) { return false; }
    if (u.search) return false;
    let last, rest;
    if (/^#[!/]/.test(u.hash)) {
      const [hp, hq] = u.hash.slice(2).split('?');
      if (hq) return false;
      const hs = hp.split('/').filter(Boolean);
      last = hs.pop(); rest = `${u.origin}${u.pathname}#/${hs.join('/')}`;
    } else {
      const segs = u.pathname.split('/').filter(Boolean);
      last = segs.pop(); rest = `${u.origin}/${segs.join('/')}`;
    }
    let w = last || '';
    try { w = decodeURIComponent(w); } catch (e) { /* keep */ }
    return FORM_ROUTE.has(dnorm(w)) && !isDangerAddress(rest);
  }
  const unsafeAddress = h => isDangerAddress(h) && !formRoute(h);

  // A screen reached by a press or a redirect at an address that acts (/items/5/archive, /cart/add?id=5):
  // kept as a title only, never queued, never navigated to again.
  function unsafeView(key, kind, parent) {
    const here = (() => { try { return pageKey() === key; } catch (e) { return false; } })();
    const h1 = here ? document.querySelector('h1') : null;
    const title = here ? (h1 && !ours(h1) && h1.textContent) || document.title : key;
    const v = { id: 'V' + ++st.n.ids, key, url: '', kind, parent, status: 'unsafe', captured: true, headings: [], controls: [] };
    v.title = mask(title || key).replace(/\s+/g, ' ').trim().slice(0, 80);
    st.views[key] = v;
    return v;
  }

  /**
   * check: the full address to safety-check (before cleanUrl drops its query); false only for the start page,
   * which the user opened themselves.
   */
  function addView(key, url, kind = 'page', parent, hot, check) {
    if (st.views[key]) return st.views[key];
    if (kind === 'page') {
      let u;
      try { u = new URL(url, location.href); } catch (e) { return null; }
      if (u.origin !== st.origin) return null; // origin lock
      if (st.n.pages >= LIMITS.views) return null;
      st.n.pages++;
      if (check !== false && (unsafeAddress(check || url) || unsafeAddress(url))) return unsafeView(key, kind, parent);
    } else {
      if (st.n.extra >= LIMITS.extra) return null;
      st.n.extra++;
    }
    const v = { id: 'V' + ++st.n.ids, key, url, kind, parent };
    st.views[key] = v;
    if (kind === 'page') (hot ? st.hot : st.queue).push(key);
    return v;
  }

  // Descriptors are kept once per control and slim: two stable selectors, the brittle css path only as the last resort.
  function slim(d) {
    if (!d || !Array.isArray(d.sel)) return d;
    const sel = d.sel.filter(Boolean);
    const strong = sel.filter(s => !/ > |:nth-of-type/.test(s));
    return { ...d, sel: strong.length ? strong.slice(0, 2) : sel.slice(0, 1) };
  }

  // pressKind() per element, once per capture: pick() and control() both ask, and danger() reads innerText.
  const kindIn = (kinds, el) => {
    if (!kinds.has(el)) kinds.set(el, pressKind(el));
    return kinds.get(el);
  };

  /**
   * One control of a view. Kept in the walk state with short internal flags (toMap turns them into the map fields):
   * commit (finishes a form or dialog), ol (opener-like: unexplored unless it was opened), hot (global header or
   * navigation: pressed once per walk), ls (sort/filter: once per view). snap: for snapshot(), no links queued, no probe.
   */
  function control(v, x, i, inner, d, kinds, snap) {
    if (d === undefined) { try { d = S.describe(x.el); } catch (e) { d = null; } }
    d = d ? slim(d) : null;
    const c = { ref: `${v.id}.${i + 1}`, role: x.role, name: x.name, section: x.section, state: x.state, d };
    if (x.options !== undefined) c.options = x.options;
    try {
      const nm = /^icon: /.test(x.name || '') ? '' : String(x.name || '').replace(/…$/, ''); // the name the inventory already read
      if (commitOf(x.el, nm)) c.commit = true;
      else if (openerLike(x.el, nm)) c.ol = 1;
    } catch (e) { /* a detached node: no flags */ }
    // A row control (scan.js rowInfo: the same role at the same place in every row of a data table or list, the
    // label differing only by record data): one key per table, place and label pattern. The map keeps one of
    // them (row: true, rowLabel) and guides point at "the record you need", never at the sample's row.
    const ro = d && d.fp && d.fp.rowOf;
    if (ro) {
      c.rk = [x.role, ro.row, (ro.box && ro.box.name) || '', ((ro.box && ro.box.head) || []).join(','), ro.col, ro.nth, ro.pre, ro.suf, ro.data ? 1 : 0].join('|');
      c.rowLabel = ro.label;
    }
    if (snap) return c;
    if (globalControl(x.el)) c.hot = 1;
    if (listingLike(x.el, x.name)) c.ls = 1;
    // Twins: controls repeated per record (a row's "Edit Marcus Reed", "Actions for load 1040", a board card) share
    // one key per view: the row key above, else role, section and the leading opener word. Pressed once; the others
    // share where it led.
    if (c.rk) c.tw = c.rk;
    else if (x.el.closest(ROW_SEL + ',[draggable=true]')) {
      const first = dnorm(x.name).split(' ')[0] || '';
      c.tw = `${x.role}|${x.section || ''}|row|${FORM_WORDS.has(first) ? first : '#'}`;
    } else if (x.el.getAttribute('aria-haspopup') === 'dialog' && !formVerb(x.name)) {
      // Record cards that open a record dialog (a dispatch board's load chips): one per class of card.
      c.tw = `${x.role}|${x.section || ''}|card|${classOf(x.el).trim().split(/\s+/)[0] || ''}`;
    }
    if (x.el.tagName === 'A' && x.el.hasAttribute('href')) {
      const t = linkView(x.el);
      if (t) c.to = t.key;
      c.probe = !inner && kindIn(kinds, x.el) ? undefined : 'link';
    } else c.probe = !inner && !v.blocked && kindIn(kinds, x.el) ? undefined : 'skip';
    return c;
  }

  // The controls of one view, CHUNK at a time with a yield in between: a 150-control view on a big page
  // was one 0.5–1.5 s task. The first chunk runs in the caller's task, so it shares the control pool
  // that inventory() just built; one memo carries the page-wide parts (pool, twins, selector counts) across yields.
  async function controlsOf(v, list, inner, kinds) {
    const out = [], memo = {};
    for (let i = 0; i < list.length; i += CHUNK) {
      if (i) await yieldTask();
      const part = list.slice(i, i + CHUNK);
      let ds = null;
      try { ds = S.describeMany ? S.describeMany(part.map(x => x.el), memo) : null; } catch (e) { ds = null; }
      part.forEach((x, j) => out.push(control(v, x, i + j, inner, ds ? ds[j] : undefined, kinds)));
    }
    return out;
  }

  // Cap per view: navigation and header first, then what can be pressed or followed, then the rest.
  /**
   * On every page, not part of this screen: the header and navigation, a floating "Customize" or help button
   * (fixed or sticky), anything outside <main> when the page has one. Pressed once per walk.
   */
  function globalControl(el) {
    if (el.closest(CHROME) && !el.closest('main,[role=main],article,section,' + DIALOG)) return true;
    if (el.closest(DIALOG)) return false;
    const main = document.querySelector('main,[role=main]');
    if (main && !ours(main) && !main.contains(el)) return true;
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 4 && n !== document.body; n = n.parentElement, i++) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }

  // Navigation first, then the content in page order; a control repeated in rows (the 3rd "Edit", the 3rd record
  // link of a table) goes last, so a long list does not push the form fields and the Save button out.
  // kinds null (snapshot): no pressKind (it reads innerText).
  const ROW_SEL = 'tr,[role=row],li,[role=listitem]';
  function pick(list, kinds) {
    if (list.length <= LIMITS.controls) return list;
    const seen = {};
    const repeat = x => {
      if (!x.el.closest(ROW_SEL)) return false;
      const k = `${x.role}|${x.role === 'link' ? '*' : x.name}`;
      seen[k] = (seen[k] || 0) + 1;
      return seen[k] > 2;
    };
    const act = x => (kinds ? kindIn(kinds, x.el) : x.role === 'button' || x.role === 'tab');
    const rank = x => (x.el.closest(CHROME) && !x.el.closest('main,[role=main]') ? 0 : repeat(x) ? 3 : x.el.tagName === 'A' || act(x) || FIELD_ROLE.test(x.role) ? 1 : 2);
    const keep = new Set(list.map((x, i) => [rank(x), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, LIMITS.controls).map(p => p[1]));
    return list.filter((x, i) => keep.has(i));
  }

  // ---------------- facts: what a screen shows, not only what it does ----------------
  // Short static text of the screen, so «когда следующее списание?» is answered from the map:
  // «Текущий тариф: Команда», «Следующее списание 1 ноября». Never a field's value (fields are not read, and text
  // that repeats what is typed in one is dropped), never text inside a control, a table or a list (records, not
  // the screen), a toast, navigation or a region the site masks for session recorders. E-mails, phones, long
  // numbers, tokens and addresses are dropped, not masked. brain.js checks the same rules again when it renders them.
  const FACTS = { n: 12, len: 80, prose: 120, nodes: 1500 };
  const FACT_SKIP = [
    'script', 'style', 'template', 'noscript', 'svg', 'canvas', 'iframe', 'frame', 'object', 'embed', 'video', 'audio',
    'input', 'textarea', 'select', 'option', 'button', 'a', 'label', 'form', 'fieldset', 'h1', 'h2', 'h3', 'pre', 'code',
    'table', 'ul', 'ol', 'nav', 'aside', 'footer',
    '[hidden]', '[aria-hidden=true]', '[inert]', '[contenteditable]', '[role=status]', '[role=alert]', '[role=log]', '[role=marquee]',
    '[role=timer]', '[aria-live]', '[role=button]', '[role=link]', '[role=tab]', '[role=tablist]', '[role=menu]', '[role=menubar]',
    '[role=menuitem]', '[role=listbox]', '[role=option]', '[role=textbox]', '[role=searchbox]', '[role=combobox]', '[role=switch]',
    '[role=checkbox]', '[role=radio]', '[role=slider]', '[role=spinbutton]', '[role=grid]', '[role=treegrid]', '[role=table]',
    '[role=row]', '[role=list]', '[role=tree]', '[role=feed]', '[role=navigation]', '[role=banner]', '[role=contentinfo]',
    '[role=complementary]', '[role=tooltip]',
    // masks for session recorders (Hotjar, FullStory, PostHog, rrweb, Sentry …) and our own opt-out
    '[data-private]', '[data-sensitive]', '[data-hj-suppress]', '[data-sentry-mask]', '[data-scopos-private]', '.fs-mask',
    '.fs-exclude', '.ph-no-capture', '.rr-mask', '.rr-block', '.sentry-mask', '.private', '.sensitive',
  ].join(',');
  // Inline text formatting: a parent with its own text and only these children reads as one piece.
  const PHRASING = new Set(['B', 'STRONG', 'EM', 'I', 'U', 'S', 'SPAN', 'SMALL', 'MARK', 'ABBR', 'TIME', 'DATA', 'SUB', 'SUP', 'BR', 'WBR', 'Q', 'CITE', 'DFN', 'BDI', 'BDO', 'INS', 'DEL', 'OUTPUT', 'METER', 'VAR', 'KBD', 'SAMP']);
  // What a value looks like when it follows its label: «Текущий тариф» <b>Команда</b>.
  const VALUE_TAG = new Set(['B', 'STRONG', 'DD', 'OUTPUT', 'DATA', 'TIME', 'METER', 'MARK']);
  const VALUE_CLASS = /value|amount|price|total|stat|metric|count|number|figure|balance|plan|tier|date/i;
  const factClean = s => String(s == null ? '' : s).replace(/[-​-‍⁠﻿­]/g, '').replace(/[    ]/g, ' ').replace(/\s+/g, ' ').trim();
  const factKey = s => low(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // Personal data that is dropped (not masked) from facts.
  const FACT_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\p{L}\p{N}])@[\w.]{2,}/u;
  const FACT_URL = /\b(?:https?:\/\/|www\.)\S|\b[\w-]{2,}\.(?:com|ru|uz|kz|io|net|org|app|dev|co|me|info|biz)\b/i;
  const FACT_TOKEN = /(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[A-Za-z0-9_-]{16,}/; // keys, tokens, record ids
  const FACT_DATE = /(?<!\d)(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})(?!\d)/g; // 01.11.2026, 2026-11-01
  const FACT_RUN = /\+?\d(?:[\s().,\-–/]*\d)*/g; // a number with its separators: +7 (999) 123-45-67, 4242 4242 …
  const FACT_MONEY = /^\d{1,3}(?:[\s.,]\d{3})+(?:[.,]\d{1,2})?$/; // 1 234 567 ₽, 12,900.50
  /** May this piece of page text go into the map? Pure: no DOM needed. */
  function factOk(s) {
    s = factClean(s);
    if (!s || !/\p{L}/u.test(s)) return false;
    if (FACT_EMAIL.test(s) || FACT_URL.test(s) || FACT_TOKEN.test(s)) return false;
    for (const run of s.replace(FACT_DATE, ' ').match(FACT_RUN) || []) {
      const digits = run.replace(/\D/g, '').length;
      if (/^\+\d/.test(run) && digits >= 5) return false; // +7 999 …, +998 90 …
      if (digits >= 7 && !(digits <= 9 && FACT_MONEY.test(run))) return false; // phones, cards, accounts, INN
    }
    return true;
  }

  // What the user typed into the fields of this document: never read into the map, only used to drop text that repeats it.
  function typedValues() {
    const out = [];
    try {
      for (const f of document.querySelectorAll('input,textarea,[contenteditable]')) {
        if (ours(f) || out.length >= 200) continue;
        if (f.tagName === 'INPUT' && /^(button|submit|reset|image|checkbox|radio|range|color|file)$/i.test(f.type)) continue;
        const v = factKey(String(f.tagName === 'INPUT' || f.tagName === 'TEXTAREA' ? f.value : f.textContent || '').slice(0, 200));
        if (v.length >= 3) out.push(v);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  // The main content when there is one: the sidebar and the top bar are navigation, already in the controls.
  const factRoot = () => [...document.querySelectorAll('main,[role=main]')].find(m => !ours(m) && shown(m)) || document.body;
  // A <header> inside the content is a section header («3 участника»); a page-level one is the top bar.
  const IN_CONTENT = 'main,[role=main],article,section,dialog,[role=dialog],[role=alertdialog],[role=tabpanel],[role=region]';

  /** Text pieces of a container in document order: { el, text }. */
  function factPieces(root) {
    const out = [];
    let seen = 0;
    const skip = el => el.matches(FACT_SKIP) || ours(el) || (el.tagName === 'HEADER' && !(el.parentElement && el.parentElement.closest(IN_CONTENT)));
    const ownText = el => { let t = ''; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue; return factClean(t); };
    (function walk(el, top) {
      if (out.length >= 80 || ++seen > FACTS.nodes) return;
      if (!top && skip(el)) return;
      if (!shown(el)) return;
      const own = ownText(el), kids = [...el.children];
      if (own && kids.every(k => PHRASING.has(k.tagName) && !skip(k) && (k.tagName === 'BR' || k.tagName === 'WBR' || shown(k)))) {
        out.push({ el, text: factClean(el.textContent) }); // «Следующее списание <b>1 ноября</b>» is one piece
        return;
      }
      if (own) out.push({ el, text: own });
      for (const k of kids) walk(k, false);
    })(root, true);
    return out;
  }

  const LABEL_CLASS = /label|title|caption|name|key|term|hint/i; // "stat-label" is the label of a stat
  const isValue = el => VALUE_TAG.has(el.tagName) || (VALUE_CLASS.test(classOf(el)) && !LABEL_CLASS.test(classOf(el)));
  /**
   * Facts of one view: label/value pairs first, then short lone text, ≤ 12 × 80 characters.
   * known: text already in the map for this view (title, headings, the parent page's facts) is not repeated.
   */
  function factsOf(root, known = []) {
    if (!root) return [];
    let pieces;
    try { pieces = factPieces(root); } catch (e) { return []; }
    const typed = typedValues();
    const seen = new Set(known.map(factKey).filter(Boolean));
    const found = [];
    const add = (text, pair, at) => {
      text = factClean(text);
      const k = factKey(text);
      if (!k || seen.has(k) || text.length > FACTS.prose || !factOk(text)) return;
      if (typed.some(t => k.includes(t))) return; // repeats what is typed in a field
      seen.add(k);
      found.push({ text: text.length > FACTS.len ? text.slice(0, FACTS.len - 1) + '…' : text, pair, at });
    };
    for (let i = 0; i < pieces.length; i++) {
      const a = pieces[i], b = pieces[i + 1];
      const near = b && (b.el.parentElement === a.el.parentElement || b.el.parentElement === a.el || (a.el.tagName === 'DT' && b.el.tagName === 'DD'));
      const colon = /[:：]$/.test(a.text);
      if (b && near && a.text.length <= 40 && b.text.length <= 60 && !/[.!?]$/.test(a.text) && (colon || (isValue(b.el) && !isValue(a.el)))) {
        add(`${a.text.replace(/\s*[:：]$/, '')}: ${b.text}`, true, i);
        i++;
        continue;
      }
      if (!colon) add(a.text, false, i);
    }
    // Pairs and text with a number or a date say the most; the rest fills what is left, in page order.
    const rank = f => (f.pair ? 0 : /\d/.test(f.text) ? 1 : 2);
    return found.slice().sort((x, y) => rank(x) - rank(y) || x.at - y.at).slice(0, FACTS.n).sort((x, y) => x.at - y.at).map(f => f.text);
  }

  // The panel a tab or a disclosure showed: its aria-controls target, or the tab panel that changed.
  function panelRoot(el, nodes) {
    const id = (el.getAttribute('aria-controls') || '').split(/\s+/)[0];
    const ctl = id ? document.getElementById(id) : null;
    if (ctl && !ours(ctl) && shown(ctl)) return ctl;
    for (const n of nodes) {
      const p = n.isConnected && n.closest ? n.closest('[role=tabpanel],details') : null;
      if (p && !ours(p) && shown(p)) return p;
    }
    // The whole screen was re-rendered: the visible tab panel inside it.
    for (const n of nodes) {
      if (!n.isConnected || !n.querySelectorAll) continue;
      const p = [...n.querySelectorAll('[role=tabpanel]')].find(x => !ours(x) && shown(x));
      if (p) return p;
    }
    return null;
  }

  const pageTitle = () => { const h1 = document.querySelector('h1'); return mask((h1 && !ours(h1) && h1.textContent) || document.title).replace(/\s+/g, ' ').trim().slice(0, 80); };
  function viewHead(v, container) {
    v.title = container ? dialogTitle(container).slice(0, 80) : pageTitle();
    v.headings = [...(container || document).querySelectorAll('h1,h2,h3')].filter(h => !ours(h)).slice(0, 8).map(h => mask(h.textContent).replace(/\s+/g, ' ').trim().slice(0, 60));
    v.facts = factsOf(container || factRoot(), [v.title, ...v.headings]);
  }

  async function captureView(v, container) {
    const kinds = new Map();
    const list = pick(inventory(container), kinds);
    viewHead(v, container);
    v.controls = await controlsOf(v, list, !!container, kinds);
    v.controls.push(...regionControls(v, container || factRoot(), v.controls.length, !!container));
    v.captured = true;
  }

  // ---------------- regions: tables and lists a "look at …" step can point at ----------------
  const REGION_SEL = 'table,[role=table],[role=grid],[role=treegrid],[role=list],[role=feed],ul,ol,[role=region][aria-label],[role=region][aria-labelledby],section[aria-label],section[aria-labelledby]';
  const REGION_SKIP = `[role=menu],[role=menubar],[role=tablist],[role=listbox],[role=tree],nav,[role=navigation],${PAGER_BOX}`;
  const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role=heading],legend';
  // The nearest heading before the region in reading order (its previous siblings, then up six levels: a table in a
  // scroll box in a tab panel in a card is still named by the page heading above the card).
  function nearHeading(el) {
    for (let n = el, up = 0; n && up < 6 && n !== document.body; n = n.parentElement, up++) {
      let k = 0;
      for (let s = n.previousElementSibling; s && k < 8; s = s.previousElementSibling, k++) {
        if (ours(s)) continue;
        if (s.matches(HEADINGS)) return s.textContent;
        const hs = s.querySelectorAll(HEADINGS);
        if (hs.length) return hs[hs.length - 1].textContent;
      }
    }
    return '';
  }
  function regionName(el) {
    let n = el.tagName === 'TABLE' && el.caption ? el.caption.textContent : '';
    const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => { const x = document.getElementById(id); return x ? x.textContent : ''; }).join(' ');
    n = n || by || el.getAttribute('aria-label') || nearHeading(el);
    return mask(String(n || '')).replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  /** Up to LIMITS.regions named tables, lists and regions of the content: { el, role, name }. */
  function regionsIn(root, inDialog) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    let seen = 0;
    for (const el of root.querySelectorAll(REGION_SEL)) {
      if (out.length >= LIMITS.regions || ++seen > 300) break;
      if (ours(el) || foreign(el) || el.closest(REGION_SKIP)) continue;
      if (!inDialog && el.closest(DIALOG)) continue;
      if (el.closest(CHROME) && !el.closest('main,[role=main]')) continue; // navigation lists
      if (out.some(o => o.el.contains(el) || el.contains(o.el))) continue;
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 40) continue;
      const T = el.tagName, er = (el.getAttribute('role') || '').toLowerCase();
      const role = /^(table|grid|treegrid)$/.test(er) || (!er && T === 'TABLE') ? 'table' : /^(list|feed)$/.test(er) || (!er && (T === 'UL' || T === 'OL')) ? 'list' : 'region';
      if (role === 'list' && [...el.children].filter(shown).length < 2) continue;
      const name = regionName(el);
      if (name) out.push({ el, role, name });
    }
    return out;
  }
  function regionControls(v, root, start, inDialog) {
    let list = [];
    try { list = regionsIn(root, inDialog); } catch (e) { list = []; }
    return list.map((x, i) => {
      let d = null;
      try { d = S.describe(x.el); } catch (e) { d = null; }
      if (d) { d = slim(d); d.text = x.name; }
      return { ref: `${v.id}.${start + i + 1}`, role: x.role, name: x.name, section: '', state: '', d, probe: 'skip', rg: 1 };
    });
  }

  /**
   * The current screen as ONE view in the toMap format (see the top of this file). Synchronous, presses
   * nothing, keeps no state: the content script calls it on route changes to grow the map for free.
   */
  function snapshot() {
    const dlg = openDialogs().pop() || null;
    let key;
    try { key = pageKey(); } catch (e) { key = location.pathname || '/'; }
    const v = { id: 'P', kind: dlg ? 'dialog' : 'page' };
    try { v.url = cleanUrl(location.href); } catch (e) { v.url = ''; }
    const list = pick(inventory(dlg || undefined), null);
    viewHead(v, dlg);
    let ds = null;
    try { ds = S.describeMany ? S.describeMany(list.map(x => x.el), {}) : null; } catch (e) { ds = null; }
    v.controls = list.map((x, i) => control(v, x, i, true, ds ? ds[i] || null : undefined, null, true));
    v.controls.push(...regionControls(v, dlg || factRoot(), v.controls.length, !!dlg));
    v.key = dlg ? `${key} › ${v.title}` : key;
    return viewOut(v, dlg ? { title: pageTitle() } : v, () => undefined);
  }

  // Keep the saved state under ~1.5 MB: drop the least useful data first.
  // UTF-8 length without a regex match over the whole state (that built one string per Cyrillic letter: ~35 MB per call).
  const ENC = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  function bytes(s) {
    if (ENC) return ENC.encode(s).length;
    let n = 0;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 || (c >= 0xd800 && c < 0xe000) ? 2 : 3; }
    return n;
  }
  function size() {
    try { return bytes(JSON.stringify(st)); } catch (e) { return 0; }
  }
  function fit() {
    // Only new views make the state grow; measuring after every press would cost more than it saves.
    if (st.fitAt === st.n.ids) return;
    st.fitAt = st.n.ids;
    if (size() <= LIMITS.bytes) return;
    const views = Object.values(st.views).filter(v => v.controls);
    const cuts = [
      v => v.controls.forEach(c => { delete c.options; }),
      v => { if (v.facts) v.facts = v.facts.slice(0, 4); },
      v => { v.headings = (v.headings || []).slice(0, 2); },
      v => v.controls.forEach(c => { if (c.d && c.d.sel) c.d.sel = c.d.sel.slice(0, 1); }),
      v => { if (v.controls.length > 60) { const keep = v.controls.filter(c => c.to || c.probe === undefined || c.probe === 'pressed'); v.controls = keep.concat(v.controls.filter(c => !keep.includes(c)).slice(0, Math.max(0, 60 - keep.length))); } },
    ];
    for (const cut of cuts) { views.forEach(cut); if (size() <= LIMITS.bytes) return; }
  }

  // ---------------- navigation ----------------
  /** 'here' when on the view, 'leaving' when a full load started, 'skip' when it can't be reached. */
  // The page a view lives on (a tab panel: the page its tab is on).
  function homeKey(v) {
    let x = v;
    for (let i = 0; x && x.enter && i < 5; i++) x = st.views[x.enter.page];
    return x ? x.key : v.key;
  }
  /** A tab panel: go to its page, then press its tab (only when it is not selected already). */
  async function enterPanel(v) {
    const parent = st.views[v.enter.page];
    if (!parent || parent === v) return 'skip';
    const at = await goTo(parent);
    if (at !== 'here') return at;
    const c = (parent.controls || []).find(x => x.ref === v.enter.ref);
    const f = c ? refind(c) : null;
    if (!f || f.kind !== 'tab') return 'skip';
    if (f.el.getAttribute('aria-selected') !== 'true') {
      if (!press(f.el)) return 'skip';
      await settle();
    }
    return 'here';
  }

  async function goTo(v) {
    if (v.enter) return enterPanel(v);
    if (pageKey() === v.key) return 'here';
    if ((v.fails || 0) >= 2) return 'skip';
    let a;
    try { a = new URL(v.url, location.href); } catch (e) { return 'skip'; }
    if (a.origin !== st.origin) return 'skip';
    // Never (re)open an address that acts. The start view was opened by the user and is exempt.
    if (v.status === 'unsafe' || (!v.start && unsafeAddress(a.href))) { v.status = 'unsafe'; return 'skip'; }
    if (a.origin + a.pathname + a.search === location.origin + location.pathname + location.search && a.hash) {
      navAllow = a.href;
      location.hash = a.hash; // same document: the SPA re-renders in place
      await settle();
      return pageKey() === v.key ? 'here' : 'skip';
    }
    st.nav = { key: v.key, at: Date.now() };
    await save();
    navAllow = a.href;
    location.href = a.href; // full load: the explorer resumes on the next page
    navWatch(v);
    return 'leaving';
  }

  // Still here after 8 s: the address served a download, a 204 or a blocked load. Skip it and go on.
  function navWatch(v) {
    const g = gen;
    setTimeout(async () => {
      if (g !== gen || !st || st.status !== 'running' || !st.nav || st.nav.key !== v.key || looping) return;
      v.fails = 2;
      v.status = 'unreachable';
      st.nav = null;
      if (st.cur && st.cur.key === v.key) st.cur = null;
      await save();
      if (g !== gen || looping || stopping || st.stopping) return;
      current = loop(++gen);
    }, LIMITS.step);
  }

  function flash(el, label) {
    const r = el.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 60) el.scrollIntoView({ block: 'center', behavior: 'auto' }); // no smooth scroll mid-walk
    S.pointer.point(el, { step: st.probes + 1, total: 0, instruction: label, explore: true, onClose: () => { stop(true); } });
  }

  const sigOf = c => `${c.role}|${c.name}|${c.section || ''}`;
  /**
   * The next control to press on this view. Never a commit, nor a control already seen writing anywhere.
   * Same-named controls (a row "Edit" ×50, "⋯" per row) are pressed once per view and share where it led;
   * global header/navigation controls once per walk; sort/filter controls once per view.
   */
  function nextProbe(v) {
    if ((v.pressed || 0) >= LIMITS.perView || v.blocked) return null;
    v.done = v.done || {};
    for (const c of v.controls) {
      if (c.probe !== undefined) continue;
      const sig = sigOf(c), twin = c.tw || `${c.role}|${c.name}`;
      if (c.commit || st.commits[sig]) { c.probe = 'commit'; c.commit = true; continue; }
      if (v.done[twin]) {
        c.probe = 'twin';
        const first = v.controls.find(x => x.ref === v.done[twin]);
        if (first && first.to) c.to = first.to;
        continue;
      }
      if (c.hot && Object.prototype.hasOwnProperty.call(st.seen, sig)) { c.probe = 'twin'; if (st.seen[sig]) c.to = st.seen[sig]; continue; }
      if (c.ls && (v.lists || 0) >= 1) { c.probe = 'skip'; continue; }
      return c;
    }
    return null;
  }

  // ---------------- the walk ----------------
  async function loop(g) {
    looping = g;
    let status = 'done';
    try {
      while (true) {
        if (!live(g)) { status = 'stopped'; break; }
        if (st.probes >= LIMITS.probes || Date.now() - st.startedAt > LIMITS.ms) break;
        if (!st.cur) {
          const key = st.hot.shift() || st.queue.shift();
          if (!key) break;
          st.cur = { key };
        }
        const v = st.views[st.cur.key];
        if (!v || v.status) { st.cur = null; continue; }
        const at = await goTo(v);
        if (at === 'leaving') return; // the next document's resume() continues
        if (!live(g)) continue;
        // Saving costs a full serialization (up to 1.5 MB, through a message or sessionStorage), so the
        // state is written only where a page can go away next: before a press, before navigating or
        // reloading, and at the end. Results in between ride along with the next of those saves.
        if (at === 'skip' || pageKey() !== homeKey(v)) { v.status = v.status || 'unreachable'; st.cur = null; continue; }
        if (!v.captured) {
          await settle();
          if (!live(g)) continue;
          // A dialog already open on arrival (onboarding, "what's new"): close it, or leave this screen unpressed.
          for (const d of openDialogs()) if (!(await closeDialog(d))) v.blocked = true;
          await captureView(v);
          if (!live(g)) continue;
          fit();
          progress(`Экран «${v.title}»`);
        }
        const c = nextProbe(v);
        if (!c) { st.cur = null; continue; }
        // Watchdog: one press may take 8 s at most, whatever the page does.
        const ctx = { ok: true };
        let timer = 0;
        const r = await Promise.race([
          probe(v, c, ctx, g).catch(() => { c.probe = 'error'; st.pending = null; }),
          new Promise(res => { timer = setTimeout(() => { ctx.ok = false; res('timeout'); }, LIMITS.step); }),
        ]);
        clearTimeout(timer);
        if (r === 'leaving') return;
        if (r === 'timeout') { if (c.probe === 'pressed') c.probe = 'timeout'; st.pending = null; }
        fit(); // saved with the next press, navigation or finish
        if (c.probe !== 'missing' && c.probe !== 'covered') {
          const t = c.to && st.views[c.to];
          progress(t && t.title ? `«${c.name}» → ${t.kind === 'dialog' ? 'окно' : t.kind === 'panel' ? 'панель' : 'экран'} «${t.title}»` : c.commit ? `«${c.name}» сохраняет данные: не нажимаю` : `Нажал «${c.name}»`);
        }
      }
    } catch (e) {
      if (st) st.error = String((e && e.message) || e).slice(0, 200);
      status = 'stopped';
    } finally {
      if (looping === g) looping = 0;
    }
    if (g === gen && st && st.status === 'running') await finish(stopping || st.stopping ? 'stopped' : status);
  }

  async function probe(v, c, ctx, g) {
    const ok = () => ctx.ok && live(g);
    const found = refind(c);
    if (!found) { c.probe = 'missing'; return; }
    const { el, kind } = found;
    flash(el, `Изучаю: «${c.name}»`);
    await wait(lite ? 200 : 520); // let the ring land so the walk is watchable
    if (!ok()) return;
    // Asked once more on purpose: the page had half a second to change the control (disable it, relabel it).
    if (!el.isConnected || !pressKind(el)) { c.probe = 'missing'; return; }
    const beforeKey = pageKey(), beforeDialogs = openDialogs();
    const expandedBefore = el.getAttribute('aria-expanded');
    const tablist = kind === 'tab' ? el.closest('[role=tablist]') : null;
    const tabBefore = tablist ? [...tablist.querySelectorAll('[role=tab]')].find(t => t.getAttribute('aria-selected') === 'true') : null;
    const before = new Set(inventory().map(x => x.el));
    const blocked0 = blockedCount(), fenced0 = fenced;
    const net0 = kind === 'form' ? await netCount() : 0;
    if (!ok()) return;
    c.probe = 'pressed';
    c.kind = kind;
    // Counted before the press: if it loads another page, the count is already saved.
    v.pressed = (v.pressed || 0) + 1;
    st.probes++;
    v.done = v.done || {};
    v.done[c.tw || `${c.role}|${c.name}`] = c.ref;
    if (c.ls) v.lists = (v.lists || 0) + 1;
    st.pending = { view: v.key, ref: c.ref };
    // The one save per probe, and it has to be the whole state: if the press loads another page,
    // resume() records where it led and must not press this control again.
    await save();
    if (!ok()) { st.pending = null; return; }
    const changes = watchChanges();
    if (!press(el)) { changes(); c.probe = 'covered'; st.pending = null; return; }
    await settle();
    const nodes = changes();
    st.pending = null;
    if (!ctx.ok) return;
    // The guard (or the network block) stopped a write or a prompt: the label lied. Remember it so guides warn
    // about this control; with nothing else visible it is a commit, never pressed again (see the end).
    const wrote = blockedCount() > blocked0 || (kind === 'form' && (await netCount()) > net0);
    if (wrote) { c.probe = 'mutating'; c.state = c.state ? `${c.state}, changes data` : 'changes data'; }
    if (!live(g)) return;
    const r = await outcome(v, c, el, kind, ctx, { beforeKey, beforeDialogs, expandedBefore, tabBefore, before, nodes });
    if (c.hot) st.seen[sigOf(c)] = c.to || null;
    if (r) return r;
    if (!c.to && c.kind !== 'page' && fenced > fenced0) { c.probe = 'external'; return; } // tried to leave: cancelled
    if (!c.to && c.probe === 'mutating') { c.commit = true; st.commits[sigOf(c)] = 1; }
  }

  /** What a press did: a new page, a dialog, a panel or nothing. Returns 'leaving' when the document goes away. */
  async function outcome(v, c, el, kind, ctx, { beforeKey, beforeDialogs, expandedBefore, tabBefore, before, nodes }) {
    const afterKey = pageKey();
    if (afterKey !== beforeKey) {
      const t = location.origin === st.origin ? addView(afterKey, cleanUrl(location.href), 'page', undefined, false, location.href) : null;
      if (t) c.to = t.key;
      c.kind = 'page';
      return (await goTo(v)) === 'leaving' ? 'leaving' : undefined;
    }

    const dlg = openDialogs().find(d => !beforeDialogs.includes(d));
    if (dlg) {
      const key = `${homeKey(v)} › ${dialogTitle(dlg)}`; // one per page, whichever of its panels opened it
      const dv = addView(key, v.url, 'dialog', v.key);
      if (dv && !dv.captured) { dv.opener = c.ref; await captureView(dv, dlg); }
      if (dv) c.to = key;
      c.kind = 'dialog';
      if (!(await closeDialog(dlg))) return ctx.ok ? stuck(c) : undefined;
      await settle(150, 800);
      return;
    }

    // A menu, a disclosure, a tab panel or an inline form: controls that appeared after the press.
    // Apps that re-render the whole screen on a tab switch bring back the header, the tabs and the toolbar as
    // "new" nodes: controls the view (or the views it hangs under) already has are not part of the panel.
    const known = new Set();
    for (let x = v, i = 0; x && i < 5; x = st.views[x.parent], i++) (x.controls || []).forEach(k => known.add(`${k.role}|${k.name}`));
    const tablist = el.closest('[role=tablist]');
    const appeared = appearedAfter(el, nodes, before).filter(x => !known.has(`${x.role}|${x.name}`) && !(tablist && tablist.contains(x.el)));
    // A tab that switched (re-rendered or not) shows a panel even with no new controls: its facts and tables count.
    const tabSwitched = kind === 'tab' && tabBefore !== el && !(el.isConnected && el.getAttribute('aria-selected') === 'false');
    if (appeared.length || tabSwitched || (expandedBefore !== 'true' && el.getAttribute('aria-expanded') === 'true')) {
      // A tab panel is a screen of its own («Users & Roles» → "Invite user"): its controls are probed later,
      // after pressing the tab again (mv.enter). Menus, popovers and disclosures stay look-only.
      // Tab panels are keyed by their page, so the same tab reached from another panel is the same view.
      const isTab = kind === 'tab' && !(el.tagName === 'A' && safeHref(el));
      const key = `${isTab ? homeKey(v) : v.key} › ${mask(c.name)}`;
      const mv = addView(key, v.url, 'panel', v.key);
      if (mv && !mv.captured) {
        mv.title = mask(c.name).slice(0, 80); mv.headings = []; mv.opener = c.ref;
        mv.facts = factsOf(panelRoot(el, nodes), [mv.title, v.title, ...(v.headings || []), ...(v.facts || [])]);
        mv.controls = await controlsOf(mv, appeared.slice(0, LIMITS.controls), !isTab, new Map());
        const root = isTab ? panelRoot(el, nodes) : null;
        if (root) mv.controls.push(...regionControls(mv, root, mv.controls.length, true));
        mv.captured = true;
        if (isTab && mv.controls.some(x => x.probe === undefined)) { mv.enter = { page: v.key, ref: c.ref }; st.queue.push(key); }
      }
      if (mv) c.to = key;
      c.kind = 'panel';
      // Put the screen back for the next probe: the previous tab, collapse, or Escape.
      let back = tabBefore && tabBefore !== el && tabBefore.isConnected ? tabBefore : null;
      if (!back && tabBefore && tabBefore !== el) { // re-rendered: the tab that was selected, found again
        const was = (v.controls || []).find(x => x.role === 'tab' && /(^|, )current(,|$)/.test(x.state || '') && x.ref !== c.ref);
        const f = was ? refind(was) : null;
        back = f && f.kind === 'tab' ? f.el : null;
      }
      if (back && pressKind(back) === 'tab') press(back);
      else if (el.isConnected && el.getAttribute('aria-expanded') === 'true') press(el);
      else if (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.open) press(el);
      else escape();
      await settle(150, 900);
      if (!ctx.ok) return;
      // A dialog that the press opened late, or a panel that would not fold: start this screen clean.
      const late = openDialogs().find(d => !beforeDialogs.includes(d));
      if (late && !(await closeDialog(late))) return ctx.ok ? stuck(c) : undefined;
      if (ctx.ok && appeared.some(x => x.el.isConnected && shown(x.el))) return reload();
      return;
    }
    c.probe = c.probe === 'mutating' ? 'mutating' : 'nothing';
  }

  // A dialog that would not close: never click behind it. Save, mark the opener, start the page clean.
  async function stuck(c) {
    c.probe = 'stuck';
    return reload();
  }
  async function reload() {
    st.pending = null;
    await save();
    location.reload();
    return 'leaving';
  }

  async function finish(status, notify = true) {
    if (!st || st.status !== 'running') return;
    gen++; // any loop or watchdog still around is now stale
    st.status = status;
    st.stopping = false;
    st.pending = null;
    st.nav = null;
    st.finishedAt = Date.now();
    await save();
    guardOff();
    fenceOff();
    formsOn = false;
    S.pointer.hide();
    if (notify && opts) {
      const reason = st.cancelled ? 'cancelled' : st.stopReason === 'redirect' ? 'redirect' : null;
      try {
        if (reason && opts.onAbort) opts.onAbort(reason, toMap(st));
        else if (opts.onDone) opts.onDone(toMap(st));
      } catch (e) { /* ignore */ }
    }
  }

  // Fields a user fills in, by map role (a search box alone is not a form).
  const FIELD_ROLE = /^(textbox|combobox|select|spinbutton|file|slider|checkbox|radio|switch|listbox)$/;
  // Where the press led, as far as the guide writer cares: explored controls are not "unexplored".
  const EXPLORED = new Set(['nothing', 'mutating', 'twin', 'commit']);

  /** One control in the map format. */
  function controlOut(c, page, idOf, twin) {
    // A twin that was never reached (the view's press limit) shares what its pressed twin found.
    if (twin && twin !== c && c.probe === undefined) c = { ...c, to: c.to || twin.to, probe: 'twin' };
    const to = idOf(c.to);
    return {
      ref: c.ref, role: c.role, name: c.name, section: c.section, state: c.state, options: c.options,
      // Which screen the control lives on, so a guide can say «Перейдите на страницу …».
      d: c.d ? { ...c.d, view: page.title } : c.d,
      to,
      commit: c.commit ? true : undefined,
      unexplored: c.ol && !c.commit && !to && !EXPLORED.has(c.probe) ? true : undefined,
      // One per row of a table or list: rowLabel is the label without the record data ("Actions for load …").
      row: c.rk ? true : undefined,
      rowLabel: c.rk ? c.rowLabel || undefined : undefined,
    };
  }
  /** One view in the map format (toMap and snapshot share it). */
  function viewOut(v, page, idOf, parentId) {
    const pressed = {};
    for (const c of v.controls || []) if (c.tw && !pressed[c.tw] && (c.to || EXPLORED.has(c.probe) || c.probe === 'pressed')) pressed[c.tw] = c;
    // A row control is listed once per view (the one that led somewhere, else the pressed one), not once per row.
    const rep = {}, worth = c => (c.to ? 2 : 0) + (c.probe === 'pressed' || c.probe === 'mutating' ? 1 : 0);
    for (const c of v.controls || []) if (c.rk && (!rep[c.rk] || worth(c) > worth(rep[c.rk]))) rep[c.rk] = c;
    const controls = (v.controls || []).filter(c => !c.rk || rep[c.rk] === c).map(c => controlOut(c, page, idOf, c.tw && pressed[c.tw]));
    const form = controls.some(c => FIELD_ROLE.test(c.role)) && controls.some(c => c.commit);
    return {
      id: v.id, key: v.key, url: v.url, kind: v.kind, parent: parentId, opener: v.opener,
      title: v.title, headings: v.headings, facts: v.facts && v.facts.length ? v.facts : undefined,
      form: form || undefined,
      controls,
    };
  }

  /** The stored map: what guides and answers are written from. */
  function toMap(s) {
    const all = (s && s.views) || {};
    const views = Object.values(all).filter(v => v.captured);
    const idOf = k => (k && all[k] && all[k].captured ? all[k].id : undefined);
    return {
      origin: s.origin, learnedAt: new Date().toISOString(), status: s.status, probes: s.probes,
      views: views.map(v => viewOut(v, v.kind === 'page' ? v : all[v.parent] || v, idOf, v.parent && all[v.parent] ? all[v.parent].id : undefined)),
    };
  }

  let booting = null, current = null;

  async function start(o) {
    // A resume() still reading its state, or a walk that is winding down after «Остановить»: let it end first.
    if (booting) await booting.catch(() => {});
    if (current && (stopping || (st && st.stopping))) await current.catch(() => {});
    if (looping) return false; // one walk at a time
    const g = ++gen;
    looping = g;
    opts = o; stopping = false;
    st = {
      v: 2, status: 'running', stopping: false, origin: location.origin, startedAt: Date.now(),
      views: {}, hot: [], queue: [], cur: null, probes: 0, pending: null, nav: null,
      n: { ids: 0, pages: 0, extra: 0 }, shapes: {}, redirects: {},
      // netBlocked: what the host said at start (kept for resumes); commits: role|name|section of controls seen
      // writing; seen: global header controls already pressed (→ the view key they opened, or null).
      netBlocked: o.netBlocked === true, forms: false, commits: {}, seen: {},
    };
    const first = addView(pageKey(), cleanUrl(location.href), 'page', undefined, true, false);
    if (first) first.start = true;
    // Nothing is pressed before the page-world guard has landed (or 2.5 s went by).
    const gd = await guardOn();
    st.guardMain = gd.ok;
    formsOn = st.forms = formsAllowed(o, gd.confirmed, st.netBlocked);
    fenceOn();
    if (g !== gen) { if (looping === g) looping = 0; return false; }
    await save();
    progress('Начинаю');
    if (g !== gen) { if (looping === g) looping = 0; return false; }
    current = loop(g);
    return current;
  }

  function resume(o) {
    if (looping) return Promise.resolve(running());
    booting = boot(o).finally(() => { booting = null; });
    return booting;
  }

  async function boot(o) {
    const g = ++gen;
    looping = g;
    const quit = r => { if (looping === g) looping = 0; return r; };
    let s = null;
    try { s = await o.store.load(); } catch (e) { s = null; }
    if (g !== gen) return quit(false);
    if (!s || s.status !== 'running' || !s.views) return quit(false);
    opts = o; st = s;
    st.n = st.n || { ids: Object.keys(st.views).length, pages: 0, extra: 0 };
    st.hot = st.hot || []; st.queue = st.queue || []; st.shapes = st.shapes || {}; st.redirects = st.redirects || {};
    st.commits = st.commits || {}; st.seen = st.seen || {};
    // Origin lock: the press led off-site (OAuth, checkout) or the user went elsewhere. Leave the tab alone:
    // no navigating back, and no onDone (the map belongs to the other origin); onAbort tells the app.
    if (location.origin !== st.origin) {
      if (st.pending) {
        const v = st.views[st.pending.view], c = v && v.controls && v.controls.find(x => x.ref === st.pending.ref);
        if (c) { c.probe = 'external'; c.to = undefined; }
      }
      st.stopReason = 'origin';
      quit();
      await finish('stopped', false);
      if (o.onAbort) { try { o.onAbort('origin', toMap(st)); } catch (e) { /* ignore */ } }
      return false;
    }
    // «Остановить» was pressed while a page was loading: finish instead of walking on.
    if (st.stopping || stopping) { quit(); await finish('stopped'); return false; }
    // A new document: the page-world patch has to land again before the first press.
    const gd = await guardOn();
    st.guardMain = gd.ok;
    // Form openers again only if writes are still blocked below the page (opts first, else what start was told).
    formsOn = st.forms = formsAllowed(o, gd.confirmed, st.netBlocked);
    fenceOn();
    if (g !== gen) return quit(false);
    await settle();
    if (g !== gen) return quit(false);
    const here = pageKey();
    if (st.pending) {
      // The last press loaded a new document: remember where it led (an address that acts: as a title only).
      const v = st.views[st.pending.view], c = v && v.controls && v.controls.find(x => x.ref === st.pending.ref);
      if (c && v.key !== here) { const t = addView(here, cleanUrl(location.href), 'page', undefined, false, location.href); c.to = t ? t.key : undefined; c.kind = 'page'; }
      st.pending = null; // counted when it was pressed
    }
    if (st.nav) {
      const v = st.views[st.nav.key];
      if (v && v.key !== here) {
        // Redirected (/reports → /reports/overview, or → /login). Twice and the screen is skipped.
        v.fails = (v.fails || 0) + 1;
        if (v.fails >= 2) { v.status = 'redirected'; if (st.cur && st.cur.key === v.key) st.cur = null; }
        addView(here, cleanUrl(location.href), 'page', undefined, false, location.href);
        st.redirects[here] = (st.redirects[here] || 0) + 1;
      }
      st.nav = null;
      // Everything lands on the same page (logged out, no access): stop instead of reloading for minutes.
      if (st.redirects[here] >= 3) { st.stopReason = 'redirect'; quit(); await finish('stopped'); return false; }
    }
    if (stopping) { quit(); await finish('stopped'); return false; }
    await save();
    if (g !== gen) return quit(false);
    current = loop(g);
    return true;
  }

  /** cancel: the user called it off, so nothing is written from this walk (onAbort('cancelled') instead of onDone). */
  async function stop(cancel = false) {
    stopping = true;
    if (!st || st.status !== 'running') return; // a resume() still loading sees `stopping` when it gets there
    // Saved, so a page load in between does not resume the walk.
    st.stopping = true;
    if (cancel) st.cancelled = true;
    if (looping) { await save(); return; } // the loop (or resume) notices and finishes
    await finish('stopped');
  }

  const running = () => !!st && st.status === 'running' && !stopping && !st.stopping;

  S.explore = { start, resume, stop, toMap, snapshot, running, pageKey, pressable: el => !!pressKind(el), isDangerous: el => danger(el), forms: () => formsOn };
  // Pure helpers for dev/explore-safety-test.mjs (no DOM needed except for the element-level ones).
  S._exploreTest = {
    isDangerText, isDangerAddress, linkTextDanger, dnorm, fwAttr, fwCheck, pressKind, closerIn, dialogQuestion, factOk, factsOf, toMap,
    formVerb, maskForm, commitOf, openerLike, fieldScope, formsAllowed, formRoute, unsafeAddress, regionsIn, viewOut,
    // Sets the form-opener switch the way start() would: setForms({ netBlocked: true }) or setForms({ sdk: true, forms: true }, true).
    setForms: (o, guardOk, savedNet) => { formsOn = formsAllowed(o, guardOk, savedNet); return formsOn; },
  };
})(typeof window !== 'undefined' ? window : globalThis);

// ---- sdk/widget.js
/*
 * Scopos SDK widget: what a software vendor embeds for its own customers.
 *
 *   <script src="https://cdn.example.com/scopos.js"
 *           data-endpoint="/api/scopos"           // the vendor's server; it holds the Claude key
 *           data-product="Ledgerly, счета и платежи"
 *           data-playbooks="/scopos-playbooks.json" // optional: scenarios recorded with the extension
 *           data-learn                              // optional: allow learn mode (localhost, or with data-learn-token)
 *           async></script>
 *
 * A small launcher sits in the corner; the panel takes a question, answers with
 * steps and runs them on the page with the same pointer as the extension. The
 * running walkthrough is kept in sessionStorage so it continues after page loads.
 * Saved scenarios run instantly and never reach the server; the server caches
 * answers for everyone, so a repeated question costs nothing either.
 */
(function () {
  const S = window.Scopos;
  if (!S || S.widget) return;
  const me = document.currentScript || document.querySelector('script[data-endpoint][src*="scopos"]');
  const data = (me && me.dataset) || {};
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/i.test(location.hostname);
  const cfg = {
    endpoint: data.endpoint || '/api/scopos',
    product: data.product || '',
    playbooksUrl: data.playbooks,
    label: data.label || 'Спросить',
    learnToken: data.learnToken || '',
  };
  // Learn mode clicks through the product on the current account, so the integrator has to turn it on
  // explicitly, and it only works on a developer's machine or with the vendor's learn token.
  cfg.learn = data.learn != null && !/^(false|off|0|no)$/i.test(data.learn) && (localHost || !!cfg.learnToken);

  const KEY = 'scopos:run';
  const CHAT_KEY = 'scopos:chat';
  let playbooks = Array.isArray(window.ScoposPlaybooks) ? window.ScoposPlaybooks : [];
  let state = null; // { runId, question, answer, steps, index, source, status, error, suggestions, replanned }
  let chat = [];    // the last turns, short text only: the question and the one-sentence answer
  let current = null; // { runId, ctl } of the request in flight
  let progress = null; // { chars, steps } while the server streams an answer

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const save = () => {
    try {
      state ? sessionStorage.setItem(KEY, JSON.stringify(state)) : sessionStorage.removeItem(KEY);
      sessionStorage.setItem(CHAT_KEY, JSON.stringify(chat));
    } catch (e) { /* storage full or blocked: the walkthrough still runs on this page */ }
  };
  const load = () => {
    try { chat = JSON.parse(sessionStorage.getItem(CHAT_KEY) || '[]') || []; } catch (e) { chat = []; }
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  };
  const newRun = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

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

  // ---------- requests to the vendor's server ----------
  /** POSTs JSON. With onProgress, asks for a streamed reply (NDJSON progress lines, then the result). */
  async function post(path, body, { signal, onProgress, headers } = {}) {
    const res = await fetch(cfg.endpoint + path, {
      method: 'POST', signal, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(onProgress ? { accept: 'application/x-ndjson, application/json' } : {}), ...(headers || {}) },
      body: JSON.stringify(body),
    });
    if (onProgress && /ndjson/.test(res.headers.get('content-type') || '') && res.body) {
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '', last = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.type === 'progress') onProgress(ev); else last = ev;
        }
      }
      if (buf.trim()) { try { last = JSON.parse(buf.trim()); } catch (e) { /* cut off */ } }
      if (!last) throw new Error('Сервер оборвал ответ. Попробуйте ещё раз.');
      if (last.type === 'error') throw new Error(last.error || 'Не получилось ответить');
      return last;
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `Сервер ответил ошибкой ${res.status}`);
    return out;
  }
  const deadline = (ctl, ms) => { const t = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), ms); return () => clearTimeout(t); };

  // ---------- learn mode ----------
  const LEARN_KEY = 'scopos:explore';
  const exploreStore = {
    load: async () => { try { return JSON.parse(sessionStorage.getItem(LEARN_KEY) || 'null'); } catch (e) { return null; } },
    save: async st => {
      try { sessionStorage.setItem(LEARN_KEY, JSON.stringify(st)); } catch (e) {
        // Out of room: stop rather than restart from stale state after the next page load.
        S.explore.stop();
        learning = { status: 'error', error: 'Карта не поместилась в память вкладки. Изучение остановлено.' };
        render();
        throw e;
      }
    },
  };
  const learnHeaders = () => (cfg.learnToken ? { 'x-scopos-learn-token': cfg.learnToken } : {});
  let learning = null; // { status: 'confirm'|'exploring'|'writing'|'done'|'error', ... }
  let learnTimer = 0;
  const LEARN_MS = 180e3;
  const learnOpts = {
    store: exploreStore,
    onProgress: p => { learning = { status: 'exploring', ...p }; render(); },
    onAbort: reason => {
      try { sessionStorage.removeItem(LEARN_KEY); } catch (e) { /* ignore */ }
      if (reason === 'cancelled') { learning = null; render(); return; } // the user called it off: back to normal
      learning = { status: 'error', error: reason === 'origin' ? 'Изучение остановлено: вкладка ушла на другой сайт.' : reason === 'redirect' ? 'Изучение остановлено: продукт перенаправляет на вход. Войдите и запустите снова.' : 'Изучение остановлено.' };
      render();
    },
    onDone: async map => {
      try { sessionStorage.removeItem(LEARN_KEY); } catch (e) { /* ignore */ }
      if (!map || !map.views || !map.views.length) { learning = { status: 'error', error: 'Не нашёл ни одного экрана.' }; render(); return; }
      learning = { status: 'writing', views: map.views.length, probes: map.probes, startedAt: Date.now() };
      setOpen(true); render();
      clearInterval(learnTimer);
      learnTimer = setInterval(() => { if (learning && learning.status === 'writing') render(); else clearInterval(learnTimer); }, 1000);
      // Writing guides takes a minute or two; a request that hangs past 3 minutes is reported, not waited on forever.
      const ctl = new AbortController(), clear = deadline(ctl, LEARN_MS);
      try {
        const out = await post('/learn', { map, product: cfg.product }, { headers: learnHeaders(), signal: ctl.signal });
        addLearned(out);
        learning = { status: 'done', views: map.views.length, probes: map.probes, guides: (out.guides || []).length, summary: out.summary };
      } catch (e) {
        const late = ctl.signal.aborted && ctl.signal.reason && ctl.signal.reason.name === 'TimeoutError';
        learning = { status: 'error', error: late ? 'Сервер не ответил за 3 минуты: гайды не написаны. Попробуйте изучить ещё раз.' : (e && e.message) || 'Не получилось' };
      } finally {
        clear();
        clearInterval(learnTimer); // the 1 s re-render runs only while writing
        learnTimer = 0;
      }
      render();
    },
  };
  function confirmLearning() {
    if (!cfg.learn) return;
    learning = { status: 'confirm' };
    setOpen(true); render();
  }
  async function startLearning() {
    if (!cfg.learn) return;
    const ctl = new AbortController(), clear = deadline(ctl, 30000);
    try {
      const ok = await post('/learn', { check: true }, { headers: learnHeaders(), signal: ctl.signal });
      if (ok && ok.key === false) { learning = { status: 'error', error: 'На сервере не подключён ключ Claude: откройте /setup. Без него гайды не написать.' }; render(); return; }
    } catch (e) {
      learning = { status: 'error', error: ctl.signal.aborted ? 'Сервер не ответил. Попробуйте ещё раз.' : e.message || 'Сервер не разрешил изучение.' }; render(); return;
    } finally { clear(); }
    stopAsk();
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
  opacity: 0; transform: translateY(10px) scale(.98); transform-origin: 100% 100%; pointer-events: none;
  visibility: hidden; transition: opacity .2s ease, transform .3s cubic-bezier(.22,.9,.24,1), visibility 0s linear .3s; }
/* Closed is hidden, not only transparent: nothing animates or paints in it, and its buttons leave the tab order. */
.open .panel { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition-delay: 0s; }
.head { display: flex; align-items: center; gap: 9px; padding: 14px 16px 6px; font-weight: 600; }
.head small { font-weight: 400; color: var(--ink-3); margin-left: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.x { margin-left: auto; border: 0; background: none; color: var(--ink-3); width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 17px; flex: none; }
.x:hover { background: var(--paper-2); color: var(--ink); }
.body { padding: 6px 16px 10px; overflow-y: auto; }
.hi { color: var(--ink-2); margin: 4px 0 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 0; background: var(--accent-soft); color: var(--accent-ink); border-radius: 999px; padding: 5px 11px; font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.q { color: var(--ink-3); font-size: 12.5px; margin: 6px 0 4px; }
.a { font-size: 15px; margin: 0 0 10px; }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
li { display: grid; grid-template-columns: 20px 1fr; gap: 10px; padding: 5px 0; color: var(--ink-2); font-size: 13.5px; }
li i { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--rule); display: grid; place-items: center; font-style: normal; font-size: 10.5px; color: var(--ink-3); }
li.done i { background: var(--accent); border-color: var(--accent); color: var(--paper); }
li.cur { color: var(--ink); font-weight: 500; }
li.cur i { border-color: var(--accent); color: var(--accent-ink); box-shadow: 0 0 0 4px var(--accent-soft); }
.meta { font-size: 11.5px; color: var(--ink-3); margin-top: 8px; }
.meta .fast { color: var(--accent-ink); }
.err { background: rgba(181,88,76,.1); border-radius: 12px; padding: 10px 12px; font-size: 13px; }
.think { display: flex; gap: 10px; align-items: center; color: var(--ink-2); padding: 8px 0; }
.spin { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--accent-soft); border-top-color: var(--accent); flex: none; }
/* Spins only while someone can see it; on weak machines (.lite) a few turns, then the elapsed time carries on alone. */
.open .spin { animation: spin .9s linear infinite; }
.lite.open .spin { animation-iteration-count: 8; }
@keyframes spin { to { transform: rotate(360deg); } }
.row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.btn { border: 1px solid var(--rule); background: var(--paper); color: var(--ink); border-radius: 999px; padding: 6px 13px; font: inherit; font-size: 13px; cursor: pointer; }
.btn:hover { background: var(--paper-2); }
.btn.main { background: var(--ink); border-color: var(--ink); color: var(--paper); }
.note { font-size: 12.5px; color: var(--ink-3); margin: 8px 0 0; }
form { display: flex; gap: 8px; align-items: center; margin: 4px 10px 10px; padding: 4px 4px 4px 12px; border: 1px solid var(--rule); border-radius: 16px; }
form:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; color: var(--ink); height: 34px; outline: none; }
.go { width: 34px; height: 34px; border-radius: 50%; border: 0; background: var(--ink); cursor: pointer; display: grid; place-items: center; }
.go .ring { border-color: var(--paper); width: 14px; height: 14px; } .go .ring::after { background: var(--paper); width: 4px; height: 4px; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:focus-visible { outline: none; }
@media (prefers-reduced-motion: reduce) { .launch { transition: opacity .15s linear; } .panel { transition: opacity .15s linear, visibility 0s linear .15s; } .open .spin { animation: none; } }
`;

  const host = document.createElement('scopos-widget');
  host.setAttribute('data-scopos-ui', '');
  const root = host.attachShadow({ mode: 'closed' });
  // The same weak-machine rule as the pointer: 4 cores or 4 GB or less gets finite animations.
  const lite = (() => { try { return (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4; } catch (e) { return false; } })();
  root.innerHTML = `<style>${CSS_TEXT}</style><div class="w${lite ? ' lite' : ''}">
    <div class="panel" role="dialog" aria-label="Scopos">
      <div class="head"><span class="ring"></span>Scopos ${cfg.product ? `<small>${esc(cfg.product)}</small>` : ''}<button class="x" data-do="close" aria-label="Свернуть">×</button></div>
      <div class="body" aria-live="polite"></div>
      <form><input placeholder="Как это сделать?" aria-label="Вопрос" maxlength="600"><button class="go" aria-label="Спросить"><span class="ring"></span></button></form>
    </div>
    <button class="launch" data-do="toggle"><span class="ring"></span>${esc(cfg.label)}</button>
  </div>`;
  const w = root.querySelector('.w'), body = root.querySelector('.body'), input = root.querySelector('input');

  function launchText() {
    if (learning && learning.status === 'exploring') return `Изучаю · ${learning.views || 0} экр.`;
    if (learning && learning.status === 'writing') return 'Пишу гайды…';
    if (state && state.status === 'running' && state.steps.length) return `Шаг ${Math.min((state.index || 0) + 1, state.steps.length)} из ${state.steps.length}`;
    return esc(cfg.label);
  }
  function renderLearning() {
    const L = learning;
    if (L.status === 'confirm') {
      return `<p class="a">Изучить продукт?</p><p class="hi">Scopos пройдёт по экранам и нажмёт кнопки, которые открывают окна, вкладки и меню, и запомнит каждую кнопку. Потом Claude напишет готовые гайды.</p>
        <p class="note">Он ничего не заполняет и не отправляет: пока он ходит, отправка форм и запросов на запись заблокирована. Всё равно лучше запускать под тестовым аккаунтом.</p>
        <div class="row"><button class="btn main" data-do="learn-go">Начать изучение</button><button class="btn" data-do="learn-cancel">Отмена</button></div>`;
    }
    if (L.status === 'writing') {
      const s = Math.round((Date.now() - (L.startedAt || Date.now())) / 1000);
      return waiting(`learn:${L.startedAt}`, `Изучил ${L.views} экранов и окон. Claude пишет гайды${s > 2 ? ` · ${s} с` : '…'}`, '', '<p class="note">Обычно это минута-две.</p>');
    }
    if (L.status === 'error') return `<div class="err">${esc(L.error)}</div><div class="row">${cfg.learn ? '<button class="btn main" data-do="learn-again">Изучить заново</button>' : ''}<button class="btn" data-do="learn-cancel">Закрыть</button></div>`;
    return `<p class="a">Изучил продукт: ${L.views} экранов и окон, ${L.probes || 0} проверенных кнопок.</p><p class="hi">${esc(L.summary || '')}</p>
      <div class="q">Готовые гайды · ${L.guides || 0}</div><div class="chips">${playbooks.filter(p => p.learned).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>`;
  }

  // Progress lines arrive 4×/s and the learn timer ticks every second: write only what changed.
  let bodyHTML = null, launchHTML = null;
  const setBody = html => { if (html !== bodyHTML) { bodyHTML = html; body.innerHTML = html; } };
  /**
   * A spinner with a status line. While the same wait (key) goes on, only the line's text node is
   * updated and null is returned, so the spinner is never rebuilt and its animation never restarts.
   */
  function waiting(key, text, before, after) {
    const t = body.querySelector('.think');
    if (t && t.dataset.k === key) {
      const say = t.querySelector('.say');
      if (say && say.textContent !== text) { say.textContent = text; bodyHTML = null; }
      return null;
    }
    return `${before}<div class="think" data-k="${esc(key)}"><span class="spin"></span><span class="say">${esc(text)}</span></div>${after}`;
  }

  function render() {
    const launch = root.querySelector('.launch');
    const lh = `<span class="ring"></span>${launchText()}`;
    if (launch && lh !== launchHTML) { launchHTML = lh; launch.innerHTML = lh; }
    if (learning && learning.status !== 'exploring') { const h = renderLearning(); if (h !== null) setBody(h); return; }
    if (!state) {
      setBody(`<p class="hi">Спросите, как что-то сделать. Я покажу каждый шаг прямо здесь, на странице.</p>
        ${playbooks.length ? `${learned ? `<div class="q">Готовые гайды · изучено ${learned.views} экранов</div>` : ''}<div class="chips">${playbooks.slice(0, learned ? 8 : 4).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : ''}`);
      return;
    }
    if (state.status === 'thinking') {
      const line = progress && progress.chars ? `Пишу шаги${progress.steps ? ' · ' + progress.steps : '…'}` : 'Читаю страницу и продумываю шаги';
      const h = waiting(`ask:${state.runId}`, line, `<div class="q">${esc(state.question)}</div>`, '<div class="row"><button class="btn" data-do="cancel">Отменить</button></div>');
      if (h !== null) setBody(h);
      return;
    }
    if (state.status === 'error') {
      setBody(`<div class="q">${esc(state.question)}</div><div class="err">${esc(state.error)}</div><div class="row"><button class="btn main" data-do="retry">Спросить ещё раз</button><button class="btn" data-do="reset">Новый вопрос</button></div>`);
      return;
    }
    if (state.status === 'suggest') {
      setBody(`<div class="q">${esc(state.question)}</div><p class="a">Возможно, вы про:</p>
        <div class="chips">${(state.suggestions || []).map(p => `<button class="chip" data-pb="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>
        <div class="row"><button class="btn" data-do="ask-anyway">Нет, спросить Claude</button></div>`);
      return;
    }
    const idx = state.index || 0, done = state.status === 'done';
    const tag = state.source === 'playbook' ? '<span class="fast">Готовый гайд · мгновенно</span>'
      : state.source === 'cache' ? '<span class="fast">мгновенно · из кэша</span>'
      : state.source === 'map' ? 'Claude · по карте продукта' : 'Ответ Claude';
    setBody(`<div class="q">${esc(state.question)}</div>${state.answer ? `<p class="a">${esc(state.answer)}</p>` : ''}
      ${state.steps.length ? `<ol>${state.steps.map((s, i) => `<li class="${i < idx || done ? 'done' : i === idx ? 'cur' : ''}"><i>${i + 1}</i><span>${esc(s.instruction)}</span></li>`).join('')}</ol>` : ''}
      <div class="meta">${tag}${done ? ' · готово' : ''}</div>
      ${done || !state.steps.length ? '<div class="row"><button class="btn" data-do="reset">Новый вопрос</button></div>' : ''}`);
  }

  function setOpen(on) { w.classList.toggle('open', on); if (on) setTimeout(() => input.focus(), 50); }

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-do],[data-pb]');
    if (!b) return;
    if (b.dataset.pb) { learning = null; const pb = playbooks.find(p => p.id === b.dataset.pb); if (pb) { stopAsk(); runSteps(newRun(), pb.name, `Сценарий «${pb.name}»`, pb.steps, 'playbook', !!pb.live); } return; }
    const act = b.dataset.do;
    if (act === 'toggle') setOpen(!w.classList.contains('open'));
    if (act === 'close') setOpen(false);
    if (act === 'cancel') { stopAsk(); state = null; save(); render(); input.focus(); }
    if (act === 'retry' && state) ask(state.question);
    if (act === 'ask-anyway' && state) ask(state.question, { force: true });
    if (act === 'reset') { stopAsk(); S.guide.stop(false); state = null; save(); render(); input.focus(); }
    if (act === 'learn-go') startLearning();
    if (act === 'learn-again') confirmLearning();
    if (act === 'learn-cancel') { learning = null; render(); }
  });
  root.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const t = input.value.trim(); if (t) { input.value = ''; ask(t); } });

  // ---------- local intent matcher: a question that names a guide runs it with 0 tokens ----------
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(['как', 'где', 'мне', 'можно', 'сделать', 'это', 'хочу', 'нужно', 'надо', 'что', 'чтобы', 'свой', 'свою', 'мой', 'мою', 'пожалуйста', 'how', 'the', 'can', 'where', 'what', 'and', 'want', 'need']);
  const ACTION = ['отмен', 'удал', 'измен', 'выключ', 'отключ', 'убра', 'убер', 'смен', 'помен', 'cancel', 'delet', 'remov', 'edit', 'chang', 'disabl', 'turn off'];
  const stems = s => norm(s).split(' ').filter(x => x.length > 2 && !STOP.has(x))
    .map(x => { let y = x; for (let i = 0; i < 2 && y.length > 4 && /[аеиоуыэюяйь]$/.test(y); i++) y = y.slice(0, -1); return y.slice(0, 6); });
  const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  const coverage = (from, to) => (from.length ? from.filter(x => to.some(t => same(x, t))).length / from.length : 0);
  const actions = s => { const n = ' ' + norm(s) + ' '; return new Set(ACTION.filter(a => n.includes(' ' + a))); };
  function matchGuides(question) {
    const q = stems(question), qa = actions(question);
    const scored = [];
    for (const pb of playbooks) {
      const n = stems(pb.name);
      if (!n.length || !q.length) continue;
      const toQ = coverage(n, q), toN = coverage(q, n), na = actions(pb.name);
      const clash = [...qa].some(a => !na.has(a)) || [...na].some(a => !qa.has(a));
      scored.push({ pb, score: (toQ + toN) / 2, sure: toQ >= 0.75 && toN >= 0.6 && !clash });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].sure) return { run: scored[0].pb, suggest: [] };
    return { run: null, suggest: scored.filter(s => s.score >= 0.4 || s.sure).slice(0, 3).map(s => s.pb) };
  }

  // ---------- asking ----------
  function stopAsk() { if (current) { current.ctl.abort(); current = null; } progress = null; }
  const scan = query => { try { return S.scan({ query }); } catch (e) { return S.scan(); } };
  const remember = (question, answer) => { chat = [...chat, { role: 'user', content: question.slice(0, 600) }, { role: 'assistant', content: String(answer || '').slice(0, 600) }].slice(-6); };

  async function ask(question, { force = false } = {}) {
    stopAsk();
    S.guide.stop(false);
    learning = null;
    const runId = newRun();
    if (!force) {
      const m = matchGuides(question);
      if (m.run) return runSteps(runId, question, `Сценарий «${m.run.name}»`, m.run.steps, 'playbook', !!m.run.live);
      if (m.suggest.length) {
        state = { runId, question, status: 'suggest', steps: [], suggestions: m.suggest.map(p => ({ id: p.id, name: p.name })) };
        save(); render(); setOpen(true); return;
      }
    }
    const ctl = new AbortController();
    current = { runId, ctl };
    const clear = deadline(ctl, 75000);
    state = { runId, question, status: 'thinking', steps: [] }; save(); render();
    try {
      const out = await post('', { question, page: scan(question), history: chat, product: cfg.product }, {
        signal: ctl.signal,
        onProgress: p => { if (current && current.runId === runId) { progress = p; render(); } },
      });
      if (!state || state.runId !== runId) return; // asked again or cancelled meanwhile
      remember(question, out.answer);
      const steps = out.ready ? out.steps || [] : toSteps(out.steps || []);
      runSteps(runId, question, out.answer, steps, out.source || (out.ready ? 'map' : 'claude'));
    } catch (e) {
      if (!state || state.runId !== runId) return;
      if (ctl.signal.aborted) {
        // Cancelled by the user stays quiet; our own deadline becomes a readable error.
        if (ctl.signal.reason && ctl.signal.reason.name === 'TimeoutError') { state = { runId, question, status: 'error', error: 'Сервер не ответил вовремя. Попробуйте ещё раз.', steps: [] }; save(); render(); }
        return;
      }
      state = { runId, question, status: 'error', error: (e && e.message) || 'Не получилось ответить', steps: [] }; save(); render();
    } finally {
      clear();
      if (current && current.runId === runId) current = null;
      progress = null;
    }
  }

  // Claude's ids point at this page's controls; steps for later pages carry only the label it expects.
  const toSteps = list => list.map(s => {
    const el = s.element_id != null ? S.byId(s.element_id) : null;
    return { instruction: s.instruction, action: s.action, value: s.value, target: el ? S.describe(el) : s.element_text ? { sel: [], text: s.element_text, role: null } : null };
  });

  // The user reached a page where the expected control isn't: plan the rest from what is on screen now.
  async function replan(index) {
    if (!state || state.status !== 'running') return;
    const runId = state.runId;
    state.replanned = state.replanned || [];
    if (state.replanned.includes(index) || state.replanned.length >= 2) return;
    state.replanned.push(index); save();
    const progressDone = state.steps.slice(0, index).map(s => s.instruction);
    const ctl = new AbortController();
    const clear = deadline(ctl, 75000);
    try {
      const out = await post('', { question: state.question, page: scan(state.question), history: chat.slice(0, -2), progress: progressDone, product: cfg.product }, { signal: ctl.signal });
      if (!state || state.runId !== runId || state.index !== index) return;
      const rest = toSteps(out.steps || []);
      state.steps = state.steps.slice(0, index).concat(rest);
      if (!rest.length) { state.status = 'done'; state.index = index; S.guide.stop(false); save(); render(); return; }
      save(); render();
      start(index);
    } catch (e) { /* keep waiting; the card still shows the instruction */ } finally { clear(); }
  }

  const here = () => location.pathname + (location.hash && location.hash !== '#' && location.hash !== '#/' ? location.hash : '');
  const samePage = path => !path || (S.pathKey ? S.pathKey(path) === S.pathKey(location.pathname + location.search + location.hash) : String(path).replace(/#\/?$/, '') === here());

  // live: the guide stops where the learned map stopped (a form the explorer did not open); at its end the
  // rest is planned once from the page the user is on.
  function runSteps(runId, question, answer, steps, source, live = false) {
    progress = null;
    state = { runId, question, answer, steps, source, live: !!live, index: 0, status: steps.length ? 'running' : 'answered', replanned: [], heals: 0, mores: 0 };
    save(); render();
    // Step aside so the page is visible; the pointer card carries the walkthrough from here.
    if (steps.length) { start(0); setTimeout(() => setOpen(false), 450); } else setOpen(true);
  }

  function start(index) {
    const runId = state.runId;
    const mine = () => state && state.runId === runId;
    S.guide.start(state.steps, {
      index,
      onChange: ({ index: i }) => { if (!mine()) return; state.index = Math.min(i, state.steps.length); if (i >= state.steps.length && !state.live) state.status = 'done'; save(); render(); },
      live: !!state.live,
      // The end of a live guide, or a step that is not on the page: one small request plans the rest from here.
      more: async ({ index: i, done }) => {
        if (!mine() || (state.mores || 0) >= 2) return null;
        state.mores = (state.mores || 0) + 1; save();
        const ctl = new AbortController();
        const clear = deadline(ctl, 60000);
        try {
          const out = await post('', { question: state.question, page: scan(state.question), progress: (done || state.steps.slice(0, i).map(s => s.instruction)).slice(0, 20), product: cfg.product }, { signal: ctl.signal });
          return mine() ? toSteps(out.steps || []) : null;
        } catch (e) { return null; } finally { clear(); }
      },
      onSteps: list => { if (!mine() || !Array.isArray(list)) return; state.steps = list; save(); render(); },
      onEnd: reason => { if (!mine()) return; state.status = reason === 'done' ? 'done' : 'answered'; if (reason === 'done') state.index = state.steps.length; save(); render(); },
      missingDelay: state.source === 'claude' ? 1200 : 2500,
      onMissing: async (step, i) => {
        if (!mine()) return null;
        if (state.source === 'claude') { replan(i); return null; }
        // A saved step's control is on another page: the user just isn't there yet.
        if (step.target && step.target.path && !samePage(step.target.path)) return null;
        if ((state.heals || 0) >= 3) return null;
        state.heals = (state.heals || 0) + 1;
        // Re-find a moved control through the vendor's server (one small Haiku request), for this run only.
        let candidates = [];
        try { candidates = S.candidatesFor ? (S.candidatesFor(step.target, 8) || []).map(c => c.id).filter(Number.isInteger) : []; } catch (e) { candidates = []; }
        const query = [step.instruction, step.target && step.target.text].filter(Boolean).join(' ');
        const ctl = new AbortController();
        const clear = deadline(ctl, 30000);
        try {
          const out = await post('', { locate: { instruction: step.instruction, oldText: step.target && step.target.text }, page: scan(query), candidates }, { signal: ctl.signal });
          if (!mine()) return null;
          const el = out && out.element_id != null ? S.byId(out.element_id) : null;
          return el ? S.describe(el) : null;
        } catch (e) { return null; } finally { clear(); }
      },
    });
  }

  async function boot() {
    (document.body || document.documentElement).appendChild(host);
    state = load();
    // A request that was in flight when the page unloaded is gone: don't show a spinner forever.
    if (state && state.status === 'thinking') state = { ...state, status: 'error', error: 'Ответ прервался при переходе. Спросите ещё раз.' };
    render();
    if (cfg.learn) {
      if (await S.explore.resume(learnOpts)) { learning = { status: 'exploring', views: 0, probes: 0 }; render(); return; }
    } else {
      try { sessionStorage.removeItem(LEARN_KEY); } catch (e) { /* ignore */ }
    }
    if (new URLSearchParams(location.search).has('scopos-learn')) {
      const u = new URL(location.href); u.searchParams.delete('scopos-learn');
      window.history.replaceState(window.history.state, '', u.href);
      if (cfg.learn) return confirmLearning();
      console.warn('[Scopos] режим изучения выключен: добавьте data-learn к тегу <script> (работает на localhost или с data-learn-token).');
    }
    if (state && state.status === 'running' && (state.index < state.steps.length || state.live)) start(state.index);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  S.widget = { open: () => setOpen(true), ask, cfg: { endpoint: cfg.endpoint, product: cfg.product, learn: cfg.learn } };
  if (cfg.learn) S.widget.learn = confirmLearning;
})();
