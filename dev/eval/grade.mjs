// Automatic grading of a map answer ({ answer, steps: [{ element_ref, action, ... }] }) against a task.
//
// Task fields (tasks-*.json):
//   q        the user's words
//   current  the view the user is on (default: the map's first page)
//   kind     form | row | nav | fact | impossible | vague | ru (for the report only)
//   paths    one or more expected paths; each is a list of control labels that must appear in order.
//            "A|B" = either label; a leading "!" marks a critical step (never allowed missing in "usable").
//            Matching is a case-insensitive substring of the control's label (a row control's generic label).
//   commit   label of the control the steps must end on (create/change tasks), or null
//   empty    true: the right answer has no steps (a question, or a task the product can't do)
//   answer   regex the answer must match (facts; for impossible tasks a default "not possible" regex is used)
//   lang     "ru" or "en": the language the instructions should be in (default: the language of q)
import { Brain } from './lib.mjs';

const norm = s => Brain.norm(s);
const CYR = /[а-яё]/i;
const NOT_POSSIBLE = /нельзя|невозможно|не поддерж|нет (такой|такого|функц|возможн|кноп|способ|опци|раздел|настро)|не умеет|не предусмотр|отсутств|not (possible|supported|available)|no (way|option|feature|such)|can(no|')t|does(n't| not) (have|support|offer)|isn't (possible|supported|available)|is not (possible|supported|available)|doesn't appear|do(es)? not show|doesn't show|has no |have no |there is no|there's no|unable|не (вижу|нашёл|нашел|нахожу|найд)|не (могу|получится)|couldn't find|could not find|(don't|do not) see|not (in|on) (the )?(map|product|app)|no (\w+ )?(setting|option|button|control) for/i;

export function indexMap(map) {
  const byRef = {}, viewOfRef = {};
  map.views.forEach(v => v.controls.forEach(c => { byRef[c.ref] = c; viewOfRef[c.ref] = v; }));
  return { byRef, viewOfRef };
}
const labelOf = c => (c.row && c.rowLabel ? c.rowLabel : c.name) || '';
const matches = (label, want) => want.replace(/^!/, '').split('|').some(w => norm(label).includes(norm(w)));

function gradePath(steps, path, byRef) {
  const labels = steps.map(s => (s.element_ref && byRef[s.element_ref] ? labelOf(byRef[s.element_ref]) : null));
  const used = new Set();
  let cur = 0;
  const missing = [];
  for (const want of path) {
    let hit = -1;
    for (let i = cur; i < steps.length; i++) if (labels[i] != null && matches(labels[i], want)) { hit = i; break; }
    if (hit < 0) missing.push(want); else { used.add(hit); cur = hit + 1; }
  }
  // Extras: steps that matched nothing. Harmless: a look, a navigation click (a link, a tab, a control that
  // opens a view), a field filled with no value. Harmful: any other click (a wrong button, another commit).
  let harmful = 0, extra = 0;
  steps.forEach((s, i) => {
    if (used.has(i)) return;
    extra++;
    const c = s.element_ref && byRef[s.element_ref];
    if (s.action === 'look') return;
    if ((s.action === 'type' || s.action === 'select')) return;
    if (s.action === 'click' && c && /^(radio|checkbox|switch)$/.test(c.role)) return; // a choice in a form is a field, not a press
    if (c && (c.to || /^(link|tab|menuitem|treeitem|option)$/.test(c.role)) && !c.commit) return;
    harmful++;
  });
  return { missing, critMissing: missing.filter(w => w.startsWith('!')), extra, harmful };
}

export function grade(task, out, map) {
  const { byRef } = indexMap(map);
  const steps = (out && Array.isArray(out.steps)) ? out.steps : [];
  const answer = (out && out.answer) || '';
  const invalid = steps.filter(s => s.element_ref != null && s.element_ref !== '' && !byRef[s.element_ref]).length;
  const nullRefs = steps.filter(s => (s.element_ref == null || s.element_ref === '') && s.action !== 'look').length;
  const wantLang = task.lang || (CYR.test(task.q) ? 'ru' : 'en');
  // Quoted control labels («Настройки», "Save") are as on screen in any language: only the rest is checked.
  const texts = [answer, ...steps.map(s => s.instruction || '')].map(t => t.replace(/«[^»]*»|"[^"]*"|“[^”]*”/g, ' ')).filter(t => /\p{L}/u.test(t));
  const langOk = texts.length ? texts.every(t => (wantLang === 'ru') === CYR.test(t)) : true;
  const r = { invalid, nullRefs, steps: steps.length, langOk };

  if (task.empty) {
    const re = task.answer ? new RegExp(task.answer, 'i') : (task.kind === 'impossible' ? NOT_POSSIBLE : null);
    const answerOk = re ? re.test(answer) : true;
    const looksOnly = steps.every(s => s.action === 'look');
    r.answerOk = answerOk;
    r.exact = steps.length === 0 && answerOk && invalid === 0;
    // Usable: the answer is right and at most one "look" step points at where it is shown.
    r.usable = answerOk && invalid === 0 && (steps.length === 0 || (looksOnly && steps.length <= 1 && task.kind === 'fact'));
    r.why = r.exact ? '' : [!answerOk && 'answer', steps.length && `${steps.length} steps`, invalid && `${invalid} invented refs`].filter(Boolean).join(', ');
    return r;
  }

  let best = null;
  for (const path of task.paths) {
    const g = gradePath(steps, path, byRef);
    if (!best || g.missing.length + g.harmful < best.missing.length + best.harmful) best = g;
  }
  const lastAct = [...steps].reverse().find(s => s.action !== 'look');
  const lastC = lastAct && lastAct.element_ref && byRef[lastAct.element_ref];
  const commitOk = !task.commit || !!(lastAct && lastAct.action === 'click' && lastC && matches(labelOf(lastC), task.commit));
  Object.assign(r, { missing: best.missing, extra: best.extra, harmful: best.harmful, commitOk });
  r.exact = steps.length > 0 && best.missing.length === 0 && best.harmful === 0 && commitOk && invalid === 0;
  r.usable = steps.length > 0 && best.critMissing.length === 0 && best.missing.length + best.harmful <= 1 && commitOk && invalid === 0;
  r.why = r.exact ? '' : [best.missing.length && 'missing ' + best.missing.join(', '), best.harmful && `${best.harmful} wrong clicks`, !commitOk && 'no commit at end', invalid && `${invalid} invented refs`, !steps.length && 'no steps'].filter(Boolean).join('; ');
  return r;
}

/**
 * A live guide (it stops at a control the explorer did not open and continues on the page from there) is not wrong
 * when what it has is the start of an expected path: the expected labels it has come first and in order, the ones it
 * lacks all come after them, and it presses nothing else (its last control must be one of the expected ones).
 */
export function gradeLive(task, out, map) {
  if (task.empty) return false;
  const { byRef } = indexMap(map);
  const steps = (out && Array.isArray(out.steps)) ? out.steps : [];
  if (!steps.length || steps.some(s => s.element_ref != null && s.element_ref !== '' && !byRef[s.element_ref])) return false;
  for (const path of task.paths) {
    const g = gradePath(steps, path, byRef);
    const k = path.length - g.missing.length;
    if (g.harmful || k < 1 || k === path.length) continue;
    if (g.missing.every((w, i) => w === path[k + i])) return true;
  }
  return false;
}

export const labelForRef = (map, ref) => { const c = indexMap(map).byRef[ref]; return c ? labelOf(c) : null; };
