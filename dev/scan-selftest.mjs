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

// routes
check('route ids templated', pathKey('/deals/123') === pathKey('/deals/456/'));
check('non-route hash ignored', pathKey('/a#section') === pathKey('/a'));
check('hash route kept', pathKey('/#/deals/5?x=1') === '/#/deals/:id');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
