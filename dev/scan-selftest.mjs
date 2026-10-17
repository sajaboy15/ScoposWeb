// Self-test for the pure parts of extension/core/scan.js (normalization, similarity, scoring).
// Runs without a DOM: the file is evaluated in a bare context and exposes S._test.
// node dev/scan-selftest.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'core', 'scan.js');
const sandbox = {};
vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
const S = sandbox.Scopos;
const { normText, textSim, scoreFeatures, lev, redact, stableId, stableClass, fpOf, rowSim, identityOK, accepts, pathKey } = S._test;

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; return; }
  failed++;
  console.log(`FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
}

// ---- normalization
check('ё folds to е', normText('Счёт') === normText('Счет'));
check('badge counter dropped', normText('Входящие (12)') === 'входящие' && normText('Входящие (13)') === normText('Входящие (12)'));
check('trailing count dropped', normText('Задачи 99+') === 'задачи');
check('digits become #', normText('Отчёт 2024 за май') === 'отчет # за май', normText('Отчёт 2024 за май'));
check('nbsp, zero-width, icon glyph', normText(' Новый счёт​ ') === 'новый счет', normText(' Новый счёт​ '));
check('punctuation stripped', normText('«Сохранить»!') === 'сохранить');
check('symbol-only label kept', normText('×') === '×' && normText('+') === '+');
check('number-only label kept', normText('2') === '#');
check('NFKC', normText('ｆｕｌｌ') === 'full');
check('keepDigits', normText('Заказ №12345, ООО «Ромашка»', true) === 'заказ no12345 ооо ромашка', normText('Заказ №12345, ООО «Ромашка»', true));

// ---- levenshtein and text similarity
check('lev basic', lev('kitten', 'sitting') === 3 && lev('', 'abc') === 3 && lev('abc', 'abc') === 0);
check('short labels exact only', textSim('Ок', 'Документы') === 0 && textSim('Да', 'Данные') === 0 && textSim('Ок', 'ОК') === 1);
check('exact', textSim('Сохранить', 'Сохранить') === 1);
check('stem-ish: Счета vs Счёт', textSim('Счета', 'Счёт') >= 0.7, textSim('Счета', 'Счёт'));
check('counter change still equal', textSim('Входящие (12)', 'Входящие (13)') === 1);
check('partial phrase is not a match', textSim('Открыть', 'Открыть счёт и пригласить') < 0.7, textSim('Открыть', 'Открыть счёт и пригласить'));
check('containment counts', textSim('Новый счёт', 'Создать новый счёт') >= 0.7, textSim('Новый счёт', 'Создать новый счёт'));
check('missing stored -> null', textSim('', 'x') === null);
check('missing candidate -> 0', textSim('Сохранить', '') === 0);

// ---- redaction
check('email redacted', redact('Иван ivan.petrov@mail.ru') === 'Иван …', redact('Иван ivan.petrov@mail.ru'));
check('phone redacted', redact('Позвонить +7 (999) 123-45-67') === 'Позвонить …', redact('Позвонить +7 (999) 123-45-67'));
check('short numbers kept', redact('Заказ 12345') === 'Заказ 12345');

// ---- stable ids and classes
for (const id of ['mui-7', ':r1:', 'react-select-2-input', 'headlessui-menu-button-5', 'ember42', 'a8f3k2x9', 'rc-tabs-0-tab-1', 'deal-12345', '3f2a9c1e-77aa'])
  check(`unstable id ${id}`, !stableId(id));
for (const id of ['saveButton', 'main-nav', 'search', 'invoice_form'])
  check(`stable id ${id}`, stableId(id));
check('css-in-js class dropped', stableClass('css-1x2y3z') === '' && stableClass('sc-bdVaJa') === '' && stableClass('jss12') === '');
check('semantic classes kept', stableClass('MuiButton-root') === 'MuiButton-root' && stableClass('btn-primary') === 'btn-primary');
check('css modules prefix kept', stableClass('Button_primary__x7Ab2') === 'Button_primary', stableClass('Button_primary__x7Ab2'));
check('state class dropped', stableClass('is-active') === '' && stableClass('menu-open') === '');

// ---- scoring
const n = s => normText(s);
const save = (form, heading) => ({ tag: 'button', role: 'button', type: 'submit', name: n('Сохранить'), container: { kind: 'form', name: n(form) }, heading: n(heading), classes: ['btn-primary'], ancestry: ['div', 'form'] });
const target = save('Пароль', 'Смена пароля');
const right = Object.assign(save('Пароль', 'Смена пароля'), { neighbors: [] });
const wrong = save('Профиль', 'Личные данные');
const sRight = scoreFeatures(target, right), sWrong = scoreFeatures(target, wrong);
check('identical candidate scores 1', Math.abs(sRight - 1) < 1e-9, sRight);
check('same label, other form: clear margin', sRight - sWrong >= 0.1, { sRight, sWrong });
// With the context a real describe() stores, the other form's button stays below the accept line
// even when the right one is missing (not rendered yet), and the unique-name rule stays off
// because the target had a same-named twin when it was recorded.
const realTarget = Object.assign(save('Пароль', 'Смена пароля'), { neighbors: ['текущий', 'пароль', 'новый'], twin: { index: 1, count: 2 } });
const realWrongAlone = Object.assign(save('Профиль', 'Личные данные'), { neighbors: ['имя', 'фамилия', 'почта'], twin: { index: 0, count: 1 } });
const sAlone = scoreFeatures(realTarget, realWrongAlone);
check('same label, other form, target missing: below accept', sAlone < 0.7, sAlone);
check('same label, other form, target missing: not accepted', accepts(realTarget, { s: sAlone, c: realWrongAlone }, 0, 0.7, 1) === '');

// The same screen for another record: context words differ, label is exact and unique.
const edit = (who, nb) => ({ tag: 'button', role: 'button', type: 'button', name: n('Изменить'), container: { kind: 'region', name: n(who) }, heading: n(who), neighbors: nb, classes: ['btn'], ancestry: ['div', 'section'] });
const recA = edit('Иван Петров', ['телефон', 'почта', 'иван', 'петров']);
const recB = edit('Анна Смирнова', ['телефон', 'почта', 'анна', 'смирнова']);
const sB = scoreFeatures(recA, recB);
check('other record: below the plain threshold', sB < 0.7, sB);
check('other record: accepted as unique exact name', accepts(recA, { s: sB, c: recB }, 0.2, 0.7, 1) === 'unique-name', sB);
check('other record: not when the label repeats', accepts(recA, { s: sB, c: recB }, 0.2, 0.7, 2) === '');
check('other page: unique-name rule off', accepts(recA, { s: sB, c: recB }, 0.2, 0.85, 1) === '');
check('accept needs margin', accepts(target, { s: 0.95, c: right }, 0.9, 0.7, 2) === '' && accepts(target, { s: 0.95, c: right }, 0.8, 0.7, 2) === 'scored');

const relabeled = Object.assign(save('Пароль', 'Смена пароля'), { name: n('Сохранить изменения') });
check('relabel keeps a decent score', scoreFeatures(target, relabeled) >= 0.7, scoreFeatures(target, relabeled));

const textbox = { tag: 'input', role: 'textbox', type: 'text', name: n('Сохранить') };
check('role family mismatch halves', scoreFeatures({ role: 'button', name: n('Сохранить') }, textbox) <= 0.5, scoreFeatures({ role: 'button', name: n('Сохранить') }, textbox));
check('missing candidate feature counts 0', scoreFeatures({ testid: 'save', name: n('Сохранить') }, { name: n('Сохранить') }) === 0.5);
check('cheap mode skips context', scoreFeatures({ name: n('Удалить'), row: { key: 'ромашка' } }, { name: n('Удалить') }, { cheap: true }) === 1);

// rows: same label in every row, the row key decides
const del = key => ({ role: 'button', name: n('Удалить'), row: { key: normText(key, true) } });
check('row key decides', scoreFeatures(del('ООО Ромашка 12 500'), del('ООО Ромашка 12 500')) - scoreFeatures(del('ООО Ромашка 12 500'), del('ИП Иванов 3 000')) >= 0.1);
const delWithTwin = Object.assign(del('Заказ 10232 ИП Иванов'), { twin: { index: 1, count: 3 }, container: { kind: 'main', name: 'настройки' } });
const otherRowSamePos = Object.assign(del('Заказ 10231 ООО Ромашка'), { twin: { index: 1, count: 3 }, selHit: 0, container: { kind: 'main', name: 'настройки' } });
const sameRowMoved = Object.assign(del('Заказ 10232 ИП Иванов'), { twin: { index: 0, count: 3 }, selHit: 0, container: { kind: 'main', name: 'настройки' } });
check('row: moved row beats same position', scoreFeatures(delWithTwin, sameRowMoved) - scoreFeatures(delWithTwin, otherRowSamePos) >= 0.1);
check('row: other record never accepted', scoreFeatures(delWithTwin, otherRowSamePos) < 0.7, scoreFeatures(delWithTwin, otherRowSamePos));
check('different order numbers never match', rowSim(normText('Заказ 10234 Ромашка', true), normText('Заказ 10235 Ромашка', true)) === 0);

// twins and selector votes
const twin = (i, c) => ({ role: 'button', name: n('Изменить'), twin: { index: i, count: c } });
check('twin ordinal breaks a tie', scoreFeatures(twin(1, 3), twin(1, 3)) > scoreFeatures(twin(1, 3), twin(0, 3)));
check('selHit counted when present', scoreFeatures({ name: n('Ок') }, { name: n('Ок'), selHit: 0 }) === 0.75);

// legacy descriptors
const legacy = fpOf({ sel: ['#x'], text: 'Очень длинная кнопка с подписью, которую обрезали на восьмидесяти символах и до…', role: 'div' });
check('legacy: ellipsis means truncated', legacy.trunc === true && !/…/.test(legacy.name));
check('legacy: tag-name role dropped', legacy.role === '');
check('legacy: truncated name still matches', scoreFeatures(legacy, { name: n('Очень длинная кнопка с подписью, которую обрезали на восьмидесяти символах и дописали хвост') }) >= 0.7);
check('legacy: v2 passes through', fpOf({ fp: { name: 'x' } }).name === 'x');
check('legacy: empty is null', fpOf({ text: '', sel: [] }) === null);

// identity gate: context alone never auto-accepts
check('identity gate blocks context-only match', !identityOK({ name: n('Сохранить') }, { name: n('Отмена') }));
check('identity gate passes on name', identityOK({ name: n('Сохранить') }, { name: n('Сохранить') }));
check('identity gate passes on testid', identityOK({ name: n('Сохранить'), testid: 'save' }, { name: n('Применить'), testid: 'save' }));
check('identity gate nameless target', identityOK({ role: 'button' }, { role: 'button' }));

// row controls: the generic label of a control repeated per row, and matching any row's label
{
  const { rowPattern, labelFits } = S._test;
  const act = rowPattern(['Actions for load 1066', 'Actions for load 1065', 'Actions for load 1040'], 'button');
  check('row: "Actions for load …"', act.label === 'Actions for load …' && act.pre === 'actions for load' && act.suf === '' && !act.data, act);
  check('row: any load fits, another action does not', labelFits(act, 'Actions for load 2207') && labelFits(act, 'Actions for load A-77') && !labelFits(act, 'Actions for invoice INV-1') && !labelFits(act, 'Delete'));
  const edit = rowPattern(['Edit Marcus Reed', 'Edit Ana Lopez', 'Edit Jamal Carter'], 'button');
  check('row: "Edit …"', edit.label === 'Edit …' && edit.pre === 'edit', edit);
  check('row: Edit fits any driver, not "Delete Ana"', labelFits(edit, 'Edit Zoe Park') && !labelFits(edit, 'Delete Ana Lopez'));
  const inv = rowPattern(['Actions for invoice INV-5020', 'Actions for invoice INV-5019'], 'button');
  check('row: invoice numbers are data', inv.label === 'Actions for invoice …' && labelFits(inv, 'Actions for invoice INV-9001'), inv);
  const id = rowPattern(['1066', '1065', '1064'], 'link');
  check('row: a record number link is data', id.data === true && labelFits(id, '77'), id);
  const names = rowPattern(['Summit Freight Brokerage', 'Lone Star Logistics', 'Great Lakes Freight'], 'link');
  check('row: company names are data', names.data === true, names);
  const llc = rowPattern(['Acme Trucking LLC', 'Bolt Hauling LLC'], 'link');
  check('row: a link with a shared suffix but mostly data is data', llc.data === true, llc);
  const same = rowPattern(['Dispatch', 'Dispatch', 'Dispatch'], 'button');
  check('row: the same label in every row', same.same === true && same.label === 'Dispatch' && labelFits(same, 'Dispatch') && !labelFits(same, 'Dispatch all'), same);
  const glyph = rowPattern(['⋯', '⋯'], 'button');
  check('row: a glyph label', glyph.same === true && labelFits(glyph, '⋯') && !labelFits(glyph, '+'), glyph);
  const view = rowPattern(['View invoice 12', 'View invoice 13'], 'link');
  check('row: a link with an action prefix keeps it', view.label === 'View invoice …' && !view.data, view);
  const ru = rowPattern(['Изменить груз 1066', 'Изменить груз 1065'], 'button');
  check('row: Russian', ru.label === 'Изменить груз …' && labelFits(ru, 'Изменить груз 7'), ru);
  const mid = rowPattern(['Send 1066 to driver', 'Send 1065 to driver'], 'button');
  check('row: data in the middle', mid.label === 'Send … to driver' && labelFits(mid, 'Send 9 to driver') && !labelFits(mid, 'Send 9 to broker'), mid);
}

// routes
check('route ids templated', pathKey('/deals/123') === pathKey('/deals/456/'));
check('non-route hash ignored', pathKey('/a#section') === pathKey('/a'));
check('hash route kept', pathKey('/#/deals/5?x=1') === '/#/deals/:id');
check('record detail after a row step: any load is the same screen', pathKey('/demo/tms/index.html#/loads/1066') === pathKey('http://localhost:4173/demo/tms/index.html#/loads/2207')
  && pathKey('/demo/tms/index.html#/loads/1066') === '/demo/tms/index.html#/loads/:id' && pathKey('/x#/billing/invoices/5020') === '/x#/billing/invoices/:id');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
