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
// tag[attr][attr=value]:not([attr=value]) … ; [attr*=x i] (substring, case-insensitive) too.
function matchesOne(el, sel) {
  const nots = [];
  const base = sel.trim().replace(/:not\((\[[^\]]+\])\)/g, (_, a) => { nots.push(a); return ''; });
  const m = /^([a-z0-9-]*)((?:\[[^\]]+\])*)$/i.exec(base);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const attrOk = a => {
    const [, name, op, value] = /^\[([^=\]*~^$|]+)(\*?)(?:=["']?([^"'\]]*?)["']?(?: i)?)?\]$/.exec(a) || [];
    if (!name || !el.hasAttribute(name)) return false;
    if (value === undefined) return true;
    return op === '*' ? el.getAttribute(name).toLowerCase().includes(value.toLowerCase()) : el.getAttribute(name) === value;
  };
  for (const a of m[2].match(/\[[^\]]+\]/g) || []) if (!attrOk(a)) return false;
  for (const a of nots) if (attrOk(a)) return false;
  return true;
}
const matches = (el, sel) => splitSel(sel).some(s => matchesOne(el, s));
const splitSel = sel => { const out = []; let depth = 0, cur = ''; for (const ch of sel) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };

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
    matches(sel) { return matches(e, sel); },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40 }),
    get previousElementSibling() { const p = e.parentElement; if (!p) return null; const i = p.children.indexOf(e); return i > 0 ? p.children[i - 1] : null; },
    get childElementCount() { return e.children.length; },
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

// ---------------- 10. form openers: only with writes blocked below the page; commits never ----------------
const T = S._exploreTest;
const pressKindOf = e => T.pressKind(e);
const OPENERS = ['Пригласить коллегу', 'Invite user', 'Dispatch', 'Edit', 'Изменить', 'Сменить тариф', 'Редактировать', 'Переименовать',
  'Настроить', 'Подключить интеграцию', 'Назначить водителя', 'Assign driver', 'Connect', 'Configure', 'Rename', 'Change password', '+',
  'Einladen', 'Invitar miembro', 'Inviter un membre', '邀请成员', 'Zaproś', 'Davet et', 'Modifier'];
const ALWAYS = ['New load', 'Add driver', 'Добавить клиента', 'Новый счёт', '+ New load']; // plain openers, pressable before too
// 10a. the switch
check('forms: vm (no extension runtime) is SDK mode: guard needed', T.setForms({}, false) === false && T.setForms({}, true) === true);
check('forms: SDK, guard confirmed, forms:false → off', T.setForms({ sdk: true, forms: false }, true) === false);
check('forms: SDK ignores netBlocked without the guard', T.setForms({ sdk: true, netBlocked: true }, false) === false);
check('forms: extension needs netBlocked', T.setForms({ sdk: false }, true) === false && T.setForms({ sdk: false, netBlocked: true }, false) === true);
check('forms: extension resume uses the value saved at start', T.setForms({ sdk: false }, false, true) === true && T.setForms({ sdk: false, netBlocked: false }, false, true) === false);
check('forms: extension forms:false → off', T.setForms({ sdk: false, netBlocked: true, forms: false }) === false);
// 10b. off: only the old allow-list
T.setForms({ sdk: false, netBlocked: false });
for (const t of OPENERS) check(`form opener NOT pressable without the net block: ${t}`, !S.explore.pressable(mk('button', { type: 'button' }, t)));
check('form opener NOT pressable without the net block: ⋯ (no name)', !S.explore.pressable(mk('button', { type: 'button' }, '⋯')));
for (const t of ALWAYS) check(`plain opener pressable without the net block: ${t}`, S.explore.pressable(mk('button', { type: 'button' }, t)));
// 10c. on
T.setForms({ sdk: false, netBlocked: true });
for (const t of OPENERS) check(`form opener pressable with the net block: ${t}`, S.explore.pressable(mk('button', { type: 'button' }, t)), pressKindOf(mk('button', { type: 'button' }, t)));
for (const t of ALWAYS) check(`plain opener pressable with the net block: ${t}`, S.explore.pressable(mk('button', { type: 'button' }, t)));
check('⋯ (aria-label More actions) pressable', S.explore.pressable(mk('button', { type: 'button', 'aria-label': 'More actions' }, '⋯')));
check('Ещё действия pressable', S.explore.pressable(mk('button', { type: 'button' }, 'Ещё действия')));
check('<a href="#">Edit</a> pressable as a form opener', pressKindOf(mk('a', { href: '#' }, 'Edit')) === 'form');
check('<a href="/loads/5/edit">Edit</a> is a link, not pressed', !S.explore.pressable(mk('a', { href: '/loads/5/edit' }, 'Edit')));
check('id="invite" and @click="openInviteModal()" still an opener', S.explore.pressable(mk('button', { type: 'button', id: 'invite', '@click': 'openInviteModal()' }, 'Пригласить коллегу')));
check('aria-haspopup=dialog «Пригласить коллегу» is a form opener', pressKindOf(mk('button', { type: 'button', 'aria-haspopup': 'dialog' }, 'Пригласить коллегу')) === 'form');
check('a role=button div opener', S.explore.pressable(mk('div', { role: 'button', tabindex: '0' }, 'Invite user')));
// commits and destructive verbs: never, even with the net block
const NEVER = ['Send invite', 'Save driver', 'Сохранить', 'Отправить приглашение', 'Пригласить и отправить', 'Add to cart', 'Добавить в корзину',
  'Submit', 'Pay', 'Pay now', 'Delete', 'Удалить', 'Publish', 'Log out', 'Approve', 'Archive', 'Cancel subscription', 'Transfer', 'Charge',
  'Refund', 'Import', 'Upload', 'Sync', 'Confirm', 'Apply', 'Create & send', 'Edit and publish', 'Disconnect', 'Unassign', 'Reassign and notify',
  'Add funds', 'Отключить', 'Подтвердить', 'Выставить счёт', 'Обновить тариф', 'Upgrade plan', 'Invite and send', 'Change and save'];
for (const t of NEVER) check(`commit/destructive never pressed with the net block: ${t}`, !S.explore.pressable(mk('button', { type: 'button' }, t)), pressKindOf(mk('button', { type: 'button' }, t)));
for (const t of NEVER) check(`commit/destructive never pressed as a menu trigger: ${t}`, !S.explore.pressable(mk('button', { type: 'button', 'aria-haspopup': 'dialog' }, t)));
check('opener with id="send-invite" refused (send)', !S.explore.pressable(mk('button', { type: 'button', id: 'send-invite' }, 'Invite user')));
check('opener with @click="sendInvite()" refused', !S.explore.pressable(mk('button', { type: 'button', '@click': 'sendInvite()' }, 'Invite user')));
check('opener with hx-post refused', !S.explore.pressable(mk('button', { type: 'button', 'hx-post': '/team/invite' }, 'Invite user')));
check('opener with class btn-danger refused', !S.explore.pressable(mk('button', { type: 'button', class: 'btn btn-danger' }, 'Edit')));
check('opener with data-method=post refused', !S.explore.pressable(mk('a', { href: '#', 'data-method': 'post' }, 'Edit')));
// context: inside a dialog or next to fields it is a commit
function dlgWith(btnAttrs, text, fields = true) {
  const kids = fields ? [el('input', { type: 'text', name: 'name' }, '', doc)] : [];
  const b = el('button', { type: 'button', ...btnAttrs }, text, doc);
  const d = el('div', { role: 'dialog' }, kids.concat([el('div', { class: 'footer' }, [b], doc)]), doc);
  d.parentElement = doc.body;
  return b;
}
function formWith(btnAttrs, text, { fields = true } = {}) {
  const kids = fields ? [el('input', { type: 'text', name: 'title' }, '', doc), el('select', { name: 'driver' }, '', doc)] : [];
  const b = el('button', btnAttrs, text, doc);
  const f = el('form', {}, kids.concat([el('div', {}, [b], doc)]), doc);
  f.parentElement = doc.body;
  return b;
}
function boxWith(btnAttrs, text) { // a React form: no <form>, fields in the same card
  const b = el('button', { type: 'button', ...btnAttrs }, text, doc);
  const card = el('div', { class: 'card' }, [el('input', { type: 'text', name: 'mc' }, '', doc), el('div', { class: 'actions' }, [b], doc)], doc);
  card.parentElement = doc.body;
  return b;
}
check('"Create load" in a dialog footer: not pressable', !S.explore.pressable(dlgWith({}, 'Create load')));
check('"Dispatch load" in a dialog footer: not pressable', !S.explore.pressable(dlgWith({}, 'Dispatch load')));
check('"Invite user" inside a dialog: not pressable', !S.explore.pressable(dlgWith({}, 'Invite user', false)));
check('"Create load" type=button in a form with fields: not pressable', !S.explore.pressable(formWith({ type: 'button' }, 'Create load')));
check('"Invite user" type=submit in a form: not pressable', !S.explore.pressable(formWith({ type: 'submit' }, 'Invite user', { fields: false })));
check('"Create load" next to fields (no <form>): not pressable', !S.explore.pressable(boxWith({}, 'Create load')));
check('"Edit" next to a search box only: pressable', (() => {
  const b = el('button', { type: 'button' }, 'Edit', doc);
  const bar = el('div', {}, [el('input', { type: 'search', name: 'q' }, '', doc), b], doc); bar.parentElement = doc.body;
  return S.explore.pressable(b);
})());
// pagination and load more: never
for (const t of ['Next', 'Previous', '2', 'Показать ещё', 'Load more', 'Show more', 'Далее', '»'])
  check(`pager never pressed: ${t}`, !S.explore.pressable(mk('button', { type: 'button' }, t)));
check('a record chip "↳ #1042" that opens a dialog is not a pager', S.explore.pressable(mk('button', { type: 'button', 'aria-haspopup': 'dialog', class: 'chip' }, '↳ #1042')));
// the corpus stays refused with the net block, except labels that start with an opener verb by design
const FORM_BY_DESIGN = new Set(['Пригласить', 'Пригласить?', 'Пригласить коллегу', 'Назначить', 'Сменить тариф', 'Invite', 'Assign', 'Einladen']);
let corpusForms = 0;
for (const [lang, labels] of Object.entries(CORPUS)) for (const label of labels) {
  const plain = S.explore.pressable(mk('button', { type: 'button' }, label));
  const menu = S.explore.pressable(mk('button', { type: 'button', 'aria-haspopup': 'menu' }, label));
  if (FORM_BY_DESIGN.has(label)) { corpusForms++; check(`corpus label is a form opener by design [${lang}] ${label}`, plain && menu); }
  else check(`corpus still refused with the net block [${lang}] ${label}`, !plain && !menu, { plain, menu });
}
// 10c'. dialog verbs: "Upload document", "Log fuel purchase", "Schedule service" open a dialog to record something.
// Page-level, with an object after the verb, and only with the net block; the bare verb and anything in a dialog
// or form stays a commit; "Log" is never "Log out / off / in".
{
  const DIALOG_OPENERS = ['Upload document', 'Log fuel purchase', 'Schedule service', 'Upload a file', 'Log expense', 'Log payment'];
  T.setForms({ sdk: false, netBlocked: false });
  for (const t of DIALOG_OPENERS) check(`dialog opener NOT pressable without the net block: ${t}`, !S.explore.pressable(mk('button', { type: 'button' }, t)));
  for (const t of DIALOG_OPENERS) check(`dialog opener is opener-like (unexplored until opened): ${t}`, T.openerLike(mk('button', { type: 'button' }, t)));
  T.setForms({ sdk: false, netBlocked: true });
  for (const t of DIALOG_OPENERS) check(`dialog opener pressable with the net block: ${t}`, pressKindOf(mk('button', { type: 'button' }, t)) === 'form', pressKindOf(mk('button', { type: 'button' }, t)));
  check('dialog opener with data-act="new-fuel" (fuel purchase) pressable', pressKindOf(mk('button', { type: 'button', 'data-act': 'new-fuel' }, 'Log fuel purchase')) === 'form');
  check('dialog opener with aria-haspopup=dialog pressable', S.explore.pressable(mk('button', { type: 'button', 'aria-haspopup': 'dialog' }, 'Upload document')));
  const SESSION = ['Log out', 'Log off', 'Log in', 'Log on', 'Logout', 'Log out of all devices', 'Log in with Google', 'Log into account'];
  for (const t of SESSION) {
    check(`"${t}" never a form opener`, T.formVerb(t) === null && !T.openerLike(mk('button', { type: 'button' }, t)));
    check(`"${t}" never pressed with the net block`, !S.explore.pressable(mk('button', { type: 'button' }, t)));
    // "Log out" / "Log off" are refused even as a menu trigger (a "Log in" menu trigger only opens its menu, as before).
    if (/out|off/i.test(t)) check(`"${t}" never pressed as a menu trigger`, !S.explore.pressable(mk('button', { type: 'button', 'aria-haspopup': 'menu' }, t)));
  }
  check('"Log in" in a login form is still a commit', T.commitOf(formWith({ type: 'button' }, 'Log in')));
  for (const t of ['Upload', 'Schedule', 'Log']) {
    check(`bare "${t}" is no opener`, T.formVerb(t) === null && !S.explore.pressable(mk('button', { type: 'button' }, t)));
    check(`bare "${t}" in a dialog is its commit`, T.commitOf(dlgWith({}, t)) && !S.explore.pressable(dlgWith({}, t)));
  }
  check('"Upload" submit in the upload dialog form is a commit', T.commitOf(formWith({ type: 'submit' }, 'Upload')) && !S.explore.pressable(formWith({ type: 'submit' }, 'Upload')));
  check('"Schedule service" submit in its dialog is a commit', T.commitOf(dlgWith({ type: 'submit' }, 'Schedule service')) && !S.explore.pressable(dlgWith({}, 'Schedule service')));
  check('"Save purchase" in the fuel dialog is a commit', T.commitOf(dlgWith({}, 'Save purchase')) && !S.explore.pressable(dlgWith({}, 'Save purchase')));
  check('"Schedule service" type=button next to fields is a commit', T.commitOf(boxWith({}, 'Schedule service')) && !S.explore.pressable(boxWith({}, 'Schedule service')));
  check('"Upload document" inside a dialog: not pressable', !S.explore.pressable(dlgWith({}, 'Upload document')));
  for (const t of ['Upload and send', 'Upload and publish', 'Log payment and send receipt', 'Schedule and notify driver', 'Log purchase and pay', 'Upload & delete'])
    check(`dialog verb with a write after it refused: ${t}`, !S.explore.pressable(mk('button', { type: 'button' }, t)), pressKindOf(mk('button', { type: 'button' }, t)));
  check('dialog opener with hx-post refused', !S.explore.pressable(mk('button', { type: 'button', 'hx-post': '/documents' }, 'Upload document')));
  check('dialog opener with @click="uploadNow()" ... still the opener verb only: refused for "submit"', !S.explore.pressable(mk('button', { type: 'button', '@click': 'submitUpload()' }, 'Upload document')));
  T.setForms({ sdk: false, netBlocked: false });
}
// 10d. commit and opener annotations (pure DOM)
check('commitOf: submit in a form', T.commitOf(formWith({ type: 'submit' }, 'Сохранить клиента')));
check('commitOf: default <button> in a form', T.commitOf(formWith({}, 'Отправить приглашение')));
check('commitOf: Отмена in a form is not a commit', !T.commitOf(formWith({ value: 'cancel' }, 'Отмена')));
check('commitOf: «Добавить» in a dialog footer', T.commitOf(dlgWith({}, 'Добавить')));
check('commitOf: "Delete" in a confirm dialog without fields', T.commitOf(dlgWith({}, 'Delete', false)));
check('commitOf: primary button in a dialog', T.commitOf(dlgWith({ class: 'btn btn-primary' }, 'Готово!')));
check('commitOf: "Save" next to fields (no <form>)', T.commitOf(boxWith({}, 'Save')));
check('commitOf: "Add line" type=button inside a form is not a commit', !T.commitOf(formWith({ type: 'button' }, 'Add line')));
check('commitOf: "+ Add line" next to fields (no <form>) is not a commit', !T.commitOf(boxWith({}, '+ Add line')));
check('commitOf: "Create load" next to fields (no <form>) is a commit', T.commitOf(boxWith({}, 'Create load')));
check('commitOf: "Clear filters" next to filter fields is not a commit', !T.commitOf(boxWith({}, 'Clear filters')));
check('commitOf: page-level «Новый счёт» is not a commit', !T.commitOf(mk('button', { type: 'button' }, 'Новый счёт')));
check('commitOf: a dialog trigger is not a commit', !T.commitOf(mk('button', { type: 'button', 'aria-haspopup': 'dialog' }, 'Пригласить коллегу')));
check('openerLike: «Пригласить коллегу»', T.openerLike(mk('button', { type: 'button' }, 'Пригласить коллегу')));
check('openerLike: aria-haspopup=dialog', T.openerLike(mk('button', { type: 'button', 'aria-haspopup': 'dialog' }, 'Команда')));
check('openerLike: «Отчёты» is not', !T.openerLike(mk('button', { type: 'button' }, 'Отчёты')));
check('formVerb: "+10%" is a number, not an opener', T.formVerb('+10%') === null && T.formVerb('+ 10') === null && T.formVerb('+') === 'make');
check('formVerb', T.formVerb('Send invite') === null && T.formVerb('+ New') === 'make' && T.formVerb('Подробнее') === 'nav' && T.formVerb('Invite user') === 'make' && T.formVerb('新建运单') === 'make');
check('maskForm keeps the rest', T.maskForm('Пригласить коллегу') === 'коллегу' && T.maskForm('Send invite') === 'send', [T.maskForm('Пригласить коллегу'), T.maskForm('Send invite')]);
// 10e. form pages at their own address
T.setForms({ sdk: false, netBlocked: true });
for (const u of ['/drivers/add', '/team/invite', '/loads/create', '/#/clients/add', '/loads/new'])
  check(`form route allowed with forms on: ${u}`, !T.unsafeAddress(u));
for (const u of ['/cart/add?id=5', '/wishlist/add/5', '/items/5/delete/add', '/invites/5/accept', '/tickets/5/close', '/logout', '/loads/add?copy=5'])
  check(`still refused with forms on: ${u}`, T.unsafeAddress(u));
T.setForms({ sdk: false, netBlocked: false });
check('form route refused with forms off: /drivers/add', T.unsafeAddress('/drivers/add'));
// 10f. map annotations
{
  const st0 = {
    origin: 'https://app.example.com', status: 'done', probes: 3,
    views: {
      '/clients': { id: 'V1', key: '/clients', url: 'u', kind: 'page', title: 'Клиенты', headings: [], captured: true, controls: [
        { ref: 'V1.1', role: 'button', name: 'Добавить клиента', ol: 1, probe: 'pressed', to: '/clients › Новый клиент' },
        { ref: 'V1.2', role: 'button', name: 'Импорт', ol: undefined, probe: 'skip' },
        { ref: 'V1.3', role: 'button', name: 'Пригласить', ol: 1, probe: 'skip' },
        { ref: 'V1.4', role: 'button', name: 'Изменить', ol: 1, probe: 'nothing' },
        { ref: 'V1.5', role: 'table', name: 'Клиенты', probe: 'skip', rg: 1, d: { sel: ['table'] } },
      ] },
      '/clients › Новый клиент': { id: 'V2', key: '/clients › Новый клиент', url: 'u', kind: 'dialog', parent: '/clients', opener: 'V1.1', title: 'Новый клиент', headings: [], captured: true, controls: [
        { ref: 'V2.1', role: 'textbox', name: 'Название', probe: 'skip' },
        { ref: 'V2.2', role: 'button', name: 'Сохранить клиента', commit: true, probe: 'skip' },
        { ref: 'V2.3', role: 'button', name: 'Отмена', probe: 'skip' },
      ] },
    },
  };
  const m = T.toMap(st0);
  const c = r => m.views.flatMap(v => v.controls).find(x => x.ref === r);
  check('map: opened opener has to and no unexplored', c('V1.1').to === 'V2' && !c('V1.1').unexplored);
  check('map: unpressed opener is unexplored', c('V1.3').unexplored === true);
  check('map: opener pressed with nothing visible is explored', !c('V1.4').unexplored);
  check('map: commit flag', c('V2.2').commit === true && !c('V2.3').commit);
  check('map: dialog with fields and a commit is a form', m.views[1].form === true && !m.views[0].form);
  check('map: region control kept with its descriptor', c('V1.5').role === 'table' && c('V1.5').d && c('V1.5').d.view === 'Клиенты');
  check('map: no internal flags leak', !('ol' in c('V1.3')) && !('probe' in c('V1.3')) && !('rg' in c('V1.5')));
}
// 10g. row controls: one representative per table place and label pattern, with row: true and the generic label
{
  const ro = { box: { tag: 'table', name: 'loads', head: ['load #', 'actions'] }, row: 'tr', col: 1, hcol: 'actions', nth: 0, role: 'button', pre: 'actions for load', suf: '', label: 'Actions for load …' };
  const rk = 'button|tr|loads|load #,actions|1|0|actions for load||0';
  const rowCtl = (i, id, extra) => ({ ref: `V1.${i}`, role: 'button', name: `Actions for load ${id}`, rk, tw: rk, rowLabel: ro.label, d: { sel: [], fp: { rowOf: ro } }, ...extra });
  const st0 = {
    origin: 'https://app.example.com', status: 'done', probes: 1,
    views: {
      '/loads': { id: 'V1', key: '/loads', url: 'u', kind: 'page', title: 'Loads', headings: [], captured: true, controls: [
        { ref: 'V1.1', role: 'link', name: 'Loads', probe: 'link' },
        rowCtl(2, 1066, { probe: 'twin' }), rowCtl(3, 1065, { probe: 'pressed', to: '/loads › Actions for load …', ol: 1 }), rowCtl(4, 1064, {}),
        { ref: 'V1.5', role: 'table', name: 'Loads', probe: 'skip', rg: 1, d: { sel: ['table'] } },
      ] },
      '/loads › Actions for load …': { id: 'V2', key: '/loads › Actions for load …', url: 'u', kind: 'panel', parent: '/loads', opener: 'V1.3', title: 'Actions for load …', headings: [], captured: true, controls: [
        { ref: 'V2.1', role: 'menuitem', name: 'Edit', probe: 'skip' },
      ] },
    },
  };
  const m = T.toMap(st0);
  const rows = m.views[0].controls.filter(c => c.row);
  check('map: a row control is listed once per view', rows.length === 1 && m.views[0].controls.length === 3, m.views[0].controls.map(c => c.ref));
  check('map: the representative is the pressed one, with where it led', rows[0] && rows[0].ref === 'V1.3' && rows[0].to === 'V2' && !rows[0].unexplored);
  check('map: row control has row: true and the generic label', rows[0] && rows[0].row === true && rows[0].rowLabel === 'Actions for load …' && rows[0].d.fp.rowOf.pre === 'actions for load');
  check('map: plain controls carry no row flag', !m.views[0].controls[0].row && !('rowLabel' in m.views[0].controls[0] && m.views[0].controls[0].rowLabel !== undefined));
  check('map: no internal row key leaks', !('rk' in rows[0]) && !('tw' in rows[0]));
}
T.setForms({ sdk: false, netBlocked: false });

console.log(`\nexplore safety: ${passed} passed, ${failed} failed (corpus: ${corpusN} labels, ${corpusForms} of them form openers by design; ${BAD_URLS.length} refused addresses, ${GOOD_URLS.length} allowed)`);
process.exit(failed ? 1 : 0);
