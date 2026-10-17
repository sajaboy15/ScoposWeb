// Regression test for the explorer's safety checks (extension/core/explore.js), after research/08.
// Loads explore.js in a bare vm with a tiny fake DOM and checks the deny-list, the link address check,
// framework action attributes, the dialog closer, iframes and the absence of a "neutral" press mode.
// node dev/explore-safety-test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'core', 'explore.js');

// ---------------- a minimal fake DOM ----------------
function matchesOne(el, sel) {
  const m = /^([a-z0-9-]*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const a of m[2].match(/\[[^\]]+\]/g) || []) {
    const [, name, value] = /^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(a);
    if (!el.hasAttribute(name)) return false;
    if (value !== undefined && el.getAttribute(name) !== value) return false;
  }
  return true;
}
const matches = (el, sel) => sel.split(',').some(s => matchesOne(el, s));

function makeDoc() {
  const doc = {
    byId: {},
    getElementById: id => doc.byId[id] || null,
    createTreeWalker(rootEl) {
      const nodes = [];
      (function walk(e) {
        if (e.ownText) nodes.push({ nodeValue: e.ownText, parentElement: e });
        e.children.forEach(walk);
      })(rootEl);
      let i = 0;
      return { nextNode: () => nodes[i++] || null };
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  doc.documentElement = el('html', {}, [], doc);
  doc.body = el('body', {}, [], doc);
  return doc;
}

function el(tag, attrs = {}, children = [], doc = null) {
  const T = tag.toUpperCase();
  const e = {
    nodeType: 1, tagName: T, isConnected: true, ownerDocument: doc, parentElement: null, children: [],
    ownText: typeof children === 'string' ? children : '',
    disabled: !!attrs.disabled, isContentEditable: false, className: attrs.class || '',
    getAttribute: n => (Object.prototype.hasOwnProperty.call(attrs, n) ? String(attrs[n]) : null),
    hasAttribute: n => Object.prototype.hasOwnProperty.call(attrs, n),
    get attributes() { return Object.entries(attrs).map(([name, value]) => ({ name, value: String(value) })); },
    get textContent() { return [e.ownText, ...e.children.map(c => c.textContent)].filter(Boolean).join(' '); },
    get innerText() { return e.textContent; },
    get id() { return attrs.id || ''; },
    get type() { return (attrs.type || (T === 'BUTTON' ? 'submit' : T === 'INPUT' ? 'text' : '')).toLowerCase(); },
    get value() { return attrs.value || ''; },
    get form() { return e.closest('form'); },
    closest(sel) { for (let n = e; n; n = n.parentElement) if (matches(n, sel)) return n; return null; },
    contains(o) { for (let n = o; n; n = n.parentElement) if (n === e) return true; return false; },
    querySelectorAll(sel) { const out = []; (function walk(x) { x.children.forEach(c => { if (matches(c, sel)) out.push(c); walk(c); }); })(e); return out; },
    querySelector(sel) { return e.querySelectorAll(sel)[0] || null; },
  };
  if (Array.isArray(children)) children.forEach(c => { c.parentElement = e; e.children.push(c); });
  return e;
}

const doc = makeDoc();
const otherDoc = makeDoc();
const sandbox = {
  URL, URLSearchParams, TextEncoder, console, setTimeout, clearTimeout,
  navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
  location: new URL('https://app.example.com/dashboard'),
  document: doc,
};
sandbox.window = sandbox;
vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
const S = sandbox.Scopos;
S.labelOf = e => e.getAttribute('aria-label') || e.textContent;
S.isVisible = () => true;
const { isDangerText, isDangerAddress, linkTextDanger, fwAttr, closerIn } = S._exploreTest;

// Builds a connected element in the main document (with an optional parent chain).
function mk(tag, attrs = {}, text = '', { parent, inDoc = doc } = {}) {
  const x = el(tag, attrs, text, inDoc);
  const p = parent || el('div', {}, [], inDoc);
  x.parentElement = p; p.children.push(x);
  if (!p.parentElement && p !== inDoc.body) { p.parentElement = inDoc.body; }
  inDoc.body.parentElement = inDoc.documentElement;
  return x;
}

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; return; }
  failed++;
  console.log(`FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
}

// ---------------- 1. the multilingual corpus: dangerous as button labels ----------------
const CORPUS = {
  RU: ['Удалить', 'Удалить счёт', 'Отправить', 'Отправить счёт', 'Оплатить', 'Подтвердить', 'Сохранить', 'Выйти', 'Архивировать',
    'Отключить', 'Экспорт', 'Скачать PDF', 'Опубликовать', 'Отменить подписку', 'Закрыть аккаунт', 'Дублировать', 'Выставить счёт',
    'Одобрить', 'Отклонить', 'Восстановить', 'Сбросить пароль', 'Пригласить', 'Пригласить?', 'Пригласить коллегу', 'Назначить',
    'Продлить', 'Пополнить', 'Заказать', 'Забронировать', 'Начать', 'Повторить', 'Откатить', 'Начислить', 'Готово', 'Взять в работу',
    'Скрыть', 'Обновить тариф', 'Сменить тариф', 'Отметить как оплаченный', 'Выполнить', 'Обновить'],
  EN: ['Delete', 'Remove', 'Send', 'Send invoice', 'Pay now', 'Pay', 'Approve', 'Reject', 'Archive', 'Duplicate', 'Publish', 'Unpublish',
    'Export', 'Download', 'Refund', 'Cancel order', 'Log out', 'Sign out', 'Exit', 'Quit', 'Close', 'Complete', 'Mark done',
    'Mark as paid', 'Capture', 'Invite', 'Redeploy', 'Re-deploy', 'Republish', 'Reactivate', 'Undelete', 'Undo', 'Unban', 'Lock',
    'Grant access', 'Promote', 'Rotate key', 'Flush cache', 'Turn off', 'Regenerate API key', 'Generate API key', 'Revoke',
    'Transfer funds', 'Subscribe', 'Unsubscribe', 'Upgrade plan', 'Deactivate', 'Disable', 'Enable', 'Restart', 'Resend', 'Retry',
    'Merge', 'Deploy', 'Impersonate', 'Confirm', 'Submit', 'Save', 'Apply', 'Add to cart', 'Place order', 'Renew', 'Book now',
    'Order now', 'Unarchive', 'Disapprove', 'Assign', 'Snooze', 'Dismiss', 'Escalate', 'Withdraw'],
  DE: ['Löschen', 'Entfernen', 'Senden', 'Bezahlen', 'Speichern', 'Bestätigen', 'Abmelden', 'Archivieren', 'Duplizieren',
    'Veröffentlichen', 'Exportieren', 'Herunterladen', 'Kündigen', 'Stornieren', 'Konto schließen', 'Widerrufen', 'Neu starten',
    'Überweisen', 'Erstatten', 'Einladen'],
  ES: ['Eliminar', 'Borrar', 'Enviar', 'Pagar', 'Guardar', 'Confirmar', 'Cerrar sesión', 'Archivar', 'Duplicar', 'Publicar',
    'Exportar', 'Descargar', 'Cancelar', 'Cerrar cuenta', 'Marcar como pagado', 'Generar clave API', 'Reembolsar', 'Aprobar'],
  PT: ['Excluir', 'Enviar fatura', 'Pagar agora', 'Salvar', 'Sair', 'Arquivar', 'Baixar', 'Aprovar', 'Encerrar conta', 'Revogar'],
  FR: ['Supprimer', 'Envoyer', 'Payer', 'Enregistrer', 'Valider', 'Déconnexion', 'Se déconnecter', 'Archiver', 'Dupliquer', 'Publier',
    'Exporter', 'Télécharger', 'Annuler', 'Fermer le compte', 'Marquer comme payé', 'Révoquer', 'Rembourser', 'Approuver'],
  IT: ['Elimina', 'Cancella', 'Invia', 'Paga', 'Salva', 'Conferma', 'Esci', 'Archivia', 'Duplica', 'Pubblica', 'Esporta', 'Scarica',
    'Annulla', 'Chiudi account', 'Rimborsa', 'Approva', 'Riavvia', 'Segna come pagato'],
  TR: ['Sil', 'Kaydı sil', 'Gönder', 'Öde', 'Ödeme yap', 'Onayla', 'Arşivle', 'Çoğalt', 'Kopyala', 'Yayınla', 'Dışa aktar', 'Çıkış yap',
    'ÇIKIŞ', 'İptal et', 'Kapat', 'Sıfırla', 'Yeniden başlat', 'Havale et', 'İade et', 'Devre dışı bırak', 'Kaydet', 'Hesabı kapat'],
  PL: ['Usuń', 'Wyślij', 'Zapłać', 'Zatwierdź', 'Archiwizuj', 'Duplikuj', 'Opublikuj', 'Eksportuj', 'Wyloguj', 'Anuluj', 'Zamknij konto',
    'Oznacz jako opłacone', 'Resetuj', 'Uruchom ponownie', 'Przelej', 'Zwróć pieniądze', 'Wygeneruj klucz', 'Unieważnij', 'Wyłącz',
    'Włącz', 'Zapisz', 'Kup teraz'],
  UZ: ["O'chirish", 'O’chirish', 'Oʻchirish', "To'lash", 'To’lash', 'Yuborish', 'Saqlash', 'Tasdiqlash', 'Chiqish', 'Bekor qilish',
    'Ўчириш', 'Тўлаш'],
  KZ: ['Жою', 'Жіберу', 'Төлеу', 'Сақтау', 'Растау', 'Шығу', 'Бас тарту', 'Жабу', 'Аудару', 'Бекіту', 'Жариялау'],
  ZH: ['删除', '刪除', '发送', '支付', '立即付款', '批准', '归档', '复制', '发布', '导出', '退出登录', '注销账户', '取消订阅', '标记为已付款',
    '生成API密钥', '撤销', '禁用', '提交', '確認', '保存', '轉帳', '退款', '重置密码'],
  JA_KO: ['削除', 'ログアウト', '삭제', '결제'],
};
let corpusN = 0;
for (const [lang, labels] of Object.entries(CORPUS)) {
  for (const label of labels) {
    corpusN++;
    check(`dangerous text [${lang}] ${label}`, isDangerText(label));
    // As a menu trigger (aria-haspopup) it must still not be pressed; as a plain button it is never an opener.
    const menu = mk('button', { type: 'button', 'aria-haspopup': 'menu' }, label);
    check(`menu trigger not pressable [${lang}] ${label}`, !S.explore.pressable(menu));
    const plain = mk('button', { type: 'button' }, label);
    check(`plain button not pressable [${lang}] ${label}`, !S.explore.pressable(plain));
  }
}
// Long harmless text followed by a dangerous verb (no 300-character cut any more).
check('long text then Delete', S.explore.isDangerous(mk('button', { type: 'button', 'aria-haspopup': 'menu' }, 'x'.repeat(320) + ' Delete')));
check('long data-* value then delete', S.explore.isDangerous(mk('button', { type: 'button', 'data-info': 'a '.repeat(150) + 'delete' }, 'More')));

// ---------------- 2. safe nouns and openers stay allowed ----------------
const SAFE_TEXT = ['Оплата', 'Billing', 'Payments', 'Платежи', 'Отправленные', 'Настройки', 'Новый счёт', 'Добавить клиента', 'Команда',
  'Settings', 'Reports', 'Clients', 'Invoices', 'Dashboard', 'Overview', 'Profile', 'Details', 'Design', 'Notifications',
  'Integrations', 'Team', 'Обзор', 'Счета', 'Клиенты', 'Отчёты', 'Заказы', 'Бронирования', 'Приглашения', 'Обновления', 'Closed',
  'Completed', 'Orders', 'Invitations', 'Sort order', 'General', 'Activity', 'Sender', 'Address book', 'More', 'New invoice'];
for (const t of SAFE_TEXT) check(`safe text ${t}`, !isDangerText(t));
for (const t of ['Новый счёт', 'Добавить клиента', 'Настройки', 'Settings', 'More', 'New invoice', 'Создать', 'Ещё']) {
  const b = mk('button', { type: 'button' }, t);
  check(`opener pressable ${t}`, S.explore.pressable(b));
}
for (const t of ['Оплата', 'Billing', 'Payments', 'Отправленные', 'Команда', 'Reports', 'Closed']) {
  check(`tab pressable ${t}`, S.explore.pressable(mk('button', { role: 'tab', type: 'button' }, t)));
}

// ---------------- 3. no neutral mode ----------------
doc.documentElement = el('html', { 'data-scopos-guard': 'on', 'data-scopos-guard-main': '1' }, [], doc);
S.guard = { active: () => true, on: () => Promise.resolve(true), off() {}, blocked: () => 0 };
for (const t of ['Пригласить коллегу', 'Watch', 'Following', 'Marcar como pagado', 'Okay', 'Continue', 'Сменить тариф']) {
  check(`neutral button not pressable even with the guard on: ${t}`, !S.explore.pressable(mk('button', { type: 'button' }, t)));
}
const card = el('div', { class: 'card' }, [], doc);
card.parentElement = doc.body;
check('card-grid button not pressable', !S.explore.pressable(mk('button', { type: 'button' }, 'Marcar como pagado', { parent: card })));

// ---------------- 4. link text: nouns allowed, acting words refused ----------------
for (const t of ['Оплата', 'Billing', 'Платежи', 'Отправленные', 'Payments', 'Settings', 'Reports', 'Подписка', 'Subscription',
  'Настройки', 'Invoices', 'Important', 'Команда', 'Sent'])
  check(`link text allowed ${t}`, !linkTextDanger(t));
for (const t of ['Выйти', 'Выход', 'Log out', 'Sign out', 'Удалить', 'Export', 'Экспорт', 'Скачать', 'Отписаться', 'Закрыть аккаунт',
  'Abmelden', 'Wyloguj', 'Çıkış', '退出', '退出登录', 'Cerrar sesión', 'Déconnexion', 'Esci', "O'chirish", 'Delete account',
  'Download CSV', 'Unsubscribe', 'Konto schließen'])
  check(`link text refused ${t}`, linkTextDanger(t));

// ---------------- 5. link addresses: GET actions refused (research/08 #5), screens allowed ----------------
const BAD_URLS = ['/tickets/5/close', '/items/5/approve', '/items/5/archive', '/posts/5/publish', '/invoices/5/send',
  '/payments/5/refund', '/orders/5/cancel', '/subscription/cancel', '/account/close', '/invoices/5/mark_paid', '/invoices/5/markAsPaid',
  '/tasks/5/complete', '/cart/add?id=5', '/wishlist/add/5', '/keys/generate', '/keys/5/rotate', '/admin/cache/flush',
  '/items/5/duplicate', '/items/5/toggle', '/votes/5/up', '/notifications/read_all', '/exit', '/quit', '/session/end', '/de/abmelden',
  '/tr/cikis', '/pl/wyloguj', '/items/5/sil', '/items/5/usun', '/items/5/löschen', '/items/5/l%C3%B6schen',
  // still blocked before
  '/logout', '/signout?x', '/api/delete', '/account/delete', '/items/5/delete?confirm=1', '/items?action=delete', '/users/5/impersonate',
  '/2fa/disable',
  // more
  '/deployments/5/redeploy', '/items/5/undelete', '/invoices/5/resend', '/items/5/restore', '/items/5/clone', '/invites/5/accept',
  '/invites/5/decline', '/team/leave', '/billing/checkout', '/subscription/renew', '/plan/upgrade', '/plan/downgrade',
  '/features/5/enable', '/features/5/disable', '/users/5/activate', '/users/5/deactivate', '/newsletter/subscribe',
  '/newsletter/unsubscribe', '/items/5/destroy', '/edits/5/undo', '/edits/5/redo', '/password/reset', '/posts/5/unpublish',
  '/jobs/5/retry', '/payments/5/void', '/items/5/remove', '/items/5/sign', '/orders/5/pay', '/items?do=archive', '/items?op=x',
  '/items?cmd=purge', '/items?confirm=1', '/ru/schet/5/udalit', '/счета/5/удалить', '/items/5/mark-read', '/approve_all',
  '/#/items/5/archive', '/#!/tickets/5/close', '/items/5?_method=delete', '/invoices/5/reactivate', '/es/items/5/eliminar',
  '/fr/items/5/supprimer', '/it/esci', '/items/5/o%CA%BBchirish', '/tickets/5/reopen', '/items/5/approveAll'];
for (const u of BAD_URLS) check(`address refused ${u}`, isDangerAddress(u));
const GOOD_URLS = ['/settings/billing', '/invoices', '/clients', '/invoices/new', '/invoices/5', '/invoices/5/edit', '/settings/team',
  '/reports?tab=sales', '/payments', '/mail/sent', '/billing/subscription', '/deployments', '/transfers', '/settings/notifications',
  '/design', '/dashboard', '/#/settings/billing', '/add-ons', '/settings/profile', '/clients/5', '/orders', '/orders/5', '/team',
  '/settings/security', '/settings/api-keys', '/billing/invoices', '/subscribers', '/uploads', '/settings/integrations',
  '/payments/history', '/inbox/sent', '/reports/sales?page=2', 'https://app.example.com/settings'];
for (const u of GOOD_URLS) check(`address allowed ${u}`, !isDangerAddress(u));

// ---------------- 6. framework action attributes ----------------
const fwDanger = [
  ['hx-get', '/items/5/delete?confirm=1'], ['hx-get', '/tickets/5/close'], ['phx-click', 'delete'], ['wire:click', 'delete(5)'],
  ['@click', 'removeItem(5)'], ['ng-click', 'vm.destroy()'], ['x-on:click', 'archive()'], ['v-on:click', 'sendInvoice()'],
  ['onclick', "location.href='/tickets/5/close'"], ['data-action', 'click->invoice#markPaid'], ['phx-click', 'cancel_order'],
  ['phx-click', 'cancel'], ['wire:click.prevent', 'approve(5)'], ['@click.prevent', "$dispatch('delete-item')"],
];
for (const [n, v] of fwDanger) check(`framework attr dangerous ${n}="${v}"`, fwAttr(n, v) === 'danger', fwAttr(n, v));
for (const n of ['hx-post', 'hx-put', 'hx-patch', 'hx-delete', 'data-hx-post', 'phx-submit', 'wire:submit', 'wire:submit.prevent'])
  check(`framework attr write ${n}`, fwAttr(n, '/x') === 'write');
check('data-turbo-method=delete is a write', fwAttr('data-turbo-method', 'delete') === 'write');
check('data-method=get is fine', fwAttr('data-method', 'get') === null);
const fwSafe = [['@click', 'open = !open'], ['x-on:click', 'toggle()'], ['data-action', 'click->dropdown#toggle'],
  ['@click.outside', 'close()'], ['hx-get', '/invoices?page=2'], ['ng-click', 'vm.showFilters()'], ['@click', 'showAddModal = true'],
  ['onclick', 'toggleMenu()'], ['@click', "$dispatch('close-dialog')"]];
for (const [n, v] of fwSafe) check(`framework attr safe ${n}="${v}"`, fwAttr(n, v) === null, fwAttr(n, v));
// element level
check('Готово with hx-get delete not pressable', !S.explore.pressable(mk('button', { type: 'button', 'aria-haspopup': 'menu', 'hx-get': '/items/5/delete?confirm=1' }, 'Готово')));
check('Okay with phx-click=delete not pressable', !S.explore.pressable(mk('button', { type: 'button', 'aria-expanded': 'false', 'phx-click': 'delete' }, 'Okay')));
check('opener with hx-post never pressed', !S.explore.pressable(mk('button', { type: 'button', 'hx-post': '/invoices' }, 'New invoice')));
check('opener with wire:submit never pressed', !S.explore.pressable(mk('button', { type: 'button', 'wire:submit': 'save' }, 'New invoice')));
check('opener with phx-submit never pressed', !S.explore.pressable(mk('button', { type: 'button', 'phx-submit': 'save' }, 'Create')));
const hxParent = el('div', { 'hx-post': '/items/5/archive' }, [], doc);
hxParent.parentElement = doc.body;
check('menu trigger under an hx-post ancestor not pressable', !S.explore.pressable(mk('button', { type: 'button', 'aria-haspopup': 'menu' }, 'More', { parent: hxParent })));
check('menu trigger with @click toggle stays pressable', S.explore.pressable(mk('button', { type: 'button', 'aria-haspopup': 'menu', '@click': 'open = !open' }, 'More')));

// ---------------- 7. iframes / other documents ----------------
check('opener in another document not pressable', !S.explore.pressable(mk('button', { type: 'button' }, 'New invoice', { inDoc: otherDoc })));
check('tab in another document not pressable', !S.explore.pressable(mk('button', { role: 'tab', type: 'button' }, 'Billing', { inDoc: otherDoc })));

// ---------------- 8. dialog closer ----------------
function dialog(title, buttons, extra = '') {
  const kids = [el('h2', {}, title, doc)];
  if (extra) kids.push(el('p', {}, extra, doc));
  const bs = buttons.map(([attrs, text]) => el('button', { type: 'button', ...attrs }, text, doc));
  const d = el('div', { role: 'dialog' }, kids.concat(bs), doc);
  d.parentElement = doc.body;
  return { d, bs };
}
{
  const { d } = dialog('Cancel this booking?', [[{}, 'Cancel'], [{}, 'Keep booking']]);
  check('"Cancel this booking?": Cancel is not pressed', closerIn(d) === null);
}
{
  const { d, bs } = dialog('Cancel this booking?', [[{}, 'Cancel'], [{}, 'Keep booking'], [{ 'aria-label': 'Close' }, '×']]);
  check('"Cancel this booking?": the × is used', closerIn(d) === bs[2]);
}
{
  const { d } = dialog('Отменить бронирование?', [[{}, 'Отмена'], [{}, 'Оставить']]);
  check('«Отменить бронирование?»: Отмена is not pressed', closerIn(d) === null);
}
{
  const { d } = dialog('Close this ticket?', [[{}, 'Close'], [{}, 'Keep open']]);
  check('"Close this ticket?": Close is not pressed', closerIn(d) === null);
}
{
  const { d } = dialog('Удалить счёт?', [[{ 'aria-label': 'Cancel' }, ''], [{}, 'Удалить']], 'Это действие нельзя отменить.');
  check('«Удалить счёт?»: aria-label Cancel is not pressed', closerIn(d) === null);
}
{
  const { d, bs } = dialog('Edit client', [[{}, 'Cancel'], [{}, 'Save']], 'Name');
  check('"Edit client": Cancel is pressed', closerIn(d) === bs[0]);
}
{
  const { d, bs } = dialog('Новый клиент', [[{}, 'Отмена'], [{}, 'Сохранить']]);
  check('«Новый клиент»: Отмена is pressed', closerIn(d) === bs[0]);
}
{
  const { d } = dialog('Edit client', [[{ name: 'delete' }, 'x']]);
  check('closer with name="delete" is not pressed', closerIn(d) === null);
}
{
  const { d } = dialog('Edit client', [[{ value: 'cancel_order' }, 'Cancel']]);
  check('closer with value="cancel_order" is not pressed', closerIn(d) === null);
}
{
  const { d } = dialog('Order 5', [[{ 'hx-post': '/orders/5/cancel' }, 'Cancel']]);
  check('closer with hx-post is not pressed', closerIn(d) === null);
}
{
  const { d } = dialog('Order 5', [[{ 'phx-click': 'cancel_order' }, 'Cancel']]);
  check('closer with phx-click=cancel_order is not pressed', closerIn(d) === null);
}
{
  const { d, bs } = dialog('Edit client', [[{ onclick: 'handleClose()' }, 'Close']]);
  check('closer with onclick=handleClose() is pressed', closerIn(d) === bs[0]);
}

// ---------------- 9. normalisation details ----------------
check("apostrophes join words (O'chirish → ochirish)", S._exploreTest.dnorm("O'chirish") === 'ochirish');
check('İptal folds to iptal', S._exploreTest.dnorm('İptal') === 'iptal');
check('camelCase splits', S._exploreTest.dnorm('markAsPaid') === 'mark as paid');

console.log(`\nexplore safety: ${passed} passed, ${failed} failed (corpus: ${corpusN} labels, ${BAD_URLS.length} refused addresses, ${GOOD_URLS.length} allowed)`);
process.exit(failed ? 1 : 0);
