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
  const LIMITS = { views: 150, extra: 250, probes: 700, perView: 30, controls: 150, regions: 4, ms: 15 * 60 * 1000, step: 8000, bytes: 3e6 };

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

  // Verbs that, in an SPA route, name the screen that shows a record or a form, never the act itself:
  // /load-management/create-load/booked/4/DT-000004, /hr-management/edit-driver/23/detail, /batches/create-batch.
  // Allowed in page addresses only while writes are blocked below the page (form openers on).
  const VIEW_VERBS = new Set(['create', 'new', 'add', 'edit', 'view', 'open', 'show', 'detail', 'details', 'preview']);
  /** Is following this address unsafe (it acts instead of showing a page)? Pure: no DOM needed. allow: verbs to accept. */
  function isDangerAddress(href, allow) {
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
    // A view verb counts as a screen name only inside a compound segment (create-load, edit-driver, view-batch):
    // a bare /add/5 or /wishlist/add acts on GET in many shops.
    // The noun after the verb must name a record or a screen: add-to-cart, new-like, create-and-send act.
    const ACTS = /^(?:to|and|cart|basket|bag|wishlist|favou?rites?|fav|likes?|vote|follow|subscribe|bookmark|star|order|checkout|payment|pay|send|delete|remove|post|publish|approve|accept|reject|confirm|submit)$/;
    const own = p => {
      if (!allow) return null;
      const t = dnorm(p).split(' ').filter(Boolean);
      return t.length >= 2 && allow.has(t[0]) && !t.slice(1).some(x => ACTS.test(x)) ? allow : null;
    };
    if (parts.some(p => actionPart(p, own(p)))) return true;
    // The full verb list over the words of the address, collection nouns (and allowed view verbs) aside.
    const ws = parts.map(p => dnorm(p).split(' ').filter(t => t && !/^\d+$/.test(t) && !collection(t) && !(own(p) && own(p).has(t))).join(' ')).filter(Boolean).join(' · ');
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
    // A row's selection checkbox (or "select all" in the header) picks records for the toolbar: Sort, Copy and
    // Export next to it do not finish a form.
    if ((/^(checkbox|radio)$/i.test(f.getAttribute('type') || '') || /^(checkbox|radio)$/.test(f.getAttribute('role') || '')) && f.closest('tr,[role=row],thead,th,[role=columnheader],[role=gridcell]')) return false;
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
    if (roleOf(el) === 'tab') return false; // «Assign Driver» tab in a dialog switches its panel
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
    // «Clear MC number»: the × of one field empties it; it finishes nothing.
    const clr = /^(?:clear|очистить)\s+(.+)$/i.exec(String(label).trim());
    if (clr) { const box = dlg || fieldScope(el); if (box && [...box.querySelectorAll(FIELD_SEL)].some(f => isField(f) && norm(S.labelOf ? S.labelOf(f) : '').replace(/\s*\*$/, '') === norm(clr[1]))) return false; }
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

  // A label that names making something: it starts with a make verb («Создать грузовик», "Create Truck") or has
  // one among its first words ("More ways to create a load"), and the veto excuses nothing else in it.
  const FORM_MAKE_SET = new Set(FORM_MAKE.map(fold));
  function makeLabel(label) {
    const words = dnorm(label).split(' ').filter(Boolean);
    if (!words.length || !formLabelOk(label)) return false;
    return formVerb(label) === 'make' || words.slice(0, 5).some(w => FORM_MAKE_SET.has(w) && !FORM_NAV_SET.has(w) && !DIALOG_VERB.has(w));
  }
  // The control that opened this menu: the one that points at it, else the only expanded popup trigger.
  function menuTrigger(menu) {
    const id = menu.id;
    if (id) for (const t of document.querySelectorAll('[aria-controls],[aria-owns]')) if (`${t.getAttribute('aria-controls') || ''} ${t.getAttribute('aria-owns') || ''}`.split(/\s+/).includes(id)) return t;
    const by = (menu.getAttribute('aria-labelledby') || '').split(/\s+/)[0];
    const lb = by ? document.getElementById(by) : null;
    if (lb && lb !== menu && !menu.contains(lb)) return lb;
    const open = [...document.querySelectorAll('[aria-expanded=true][aria-haspopup]:not([aria-haspopup=false])')].filter(x => !ours(x) && !menu.contains(x));
    return open.length === 1 ? open[0] : null;
  }
  /**
   * An item of a menu that makes something ("Create Truck ▾" → "Manual entry", "Create new" → "New load"): pressed
   * like a form opener, only while writes are blocked below the page (the caller checks formsOn). The menu (its
   * own label, or its trigger's) must name making something; the item's whole text, attributes and handlers went
   * through the full veto already, with nothing excused ("Upload Truck registration", "Import CSV" stay unpressed).
   */
  function makeMenuItem(el) {
    if (el.tagName === 'A' && el.hasAttribute('href') && !buttonAnchor(el)) return false; // a link: followed by address
    const menu = el.closest('[role=menu]');
    if (!menu || el.closest(DIALOG) || el.hasAttribute('aria-haspopup') || commitOf(el) || fwCheck(el, true)) return false;
    if (makeLabel(menu.getAttribute('aria-label') || '')) return true;
    const t = menuTrigger(menu);
    return !!t && makeLabel(S.labelOf ? S.labelOf(t) : t.textContent);
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
    if (role === 'menuitem' && !form && formsOn && makeMenuItem(el)) return 'form'; // "Create Truck ▾ → Manual entry"
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

  // Queue the page a link leads to. Record lists (/invoices/1, /invoices/2 …) give at most two samples per route:
  // the first one early (rec 1: its forms are what guides need), the second at the end (rec 2, st.later).
  // from: the view the link is on; a tab link of a record page (a driver's «Documents» tab) is entered early too.
  function linkView(a, from) {
    const href = safeHref(a);
    if (!href) return null;
    const key = pageKey(href);
    if (st.views[key]) return st.views[key];
    const hot = !!a.closest(CHROME);
    const last = (key.split(/[?#]/)[0].split('/').pop() || '');
    let rec = 0;
    if (!hot && (/\d|:id/.test(last) || a.closest(ROWS))) {
      // The record's own segment becomes *: the last one of the hash route when there is one (#/loads/:id/DT-1),
      // else of the path. One shape per kind of record page, two samples each.
      const hi = key.indexOf('#');
      const shape = hi >= 0 ? key.slice(0, hi) + key.slice(hi).replace(/\/[^/?#]*(?=$|\?)/, '/*') : key.replace(/\/[^/?#]*(?=$|[?#])/, '/*');
      st.shapes[shape] = (st.shapes[shape] || 0) + 1;
      if (st.shapes[shape] > 2) return null;
      rec = st.shapes[shape];
    }
    const rtab = !hot && !rec && from && from.kind === 'page' && (from.rec === 1 || from.rtab) && roleOf(a) === 'tab';
    const v = addView(key, cleanUrl(href), 'page', undefined, rec === 2 ? 'later' : hot, href);
    if (v && rec) v.rec = rec;
    if (v && rtab) v.rtab = 1;
    return v;
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
  const unsafeAddress = h => isDangerAddress(h, formsOn ? VIEW_VERBS : null) && !formRoute(h);

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
   * which the user opened themselves. hot: true (navigation: st.hot), 'later' (a second record sample: st.later),
   * else the content queue.
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
    if (kind === 'page') (hot === 'later' ? st.later : hot ? st.hot : st.queue).push(key);
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
    // Every control of a view is described at the same address: it is kept once on the view (v.dpath) and put back
    // in the map (controlOut). A tenth of the walk state on a big product.
    if (d && d.path) { if (v.dpath === undefined) v.dpath = d.path; if (d.path === v.dpath) delete d.path; }
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
    else if (x.el.closest(ROW_SEL + ',[draggable=true]') && !x.el.closest('[role=menu],[role=menubar]')) { // a menu's items are not records
      const first = dnorm(x.name).split(' ')[0] || '';
      c.tw = `${x.role}|${x.section || ''}|row|${FORM_WORDS.has(first) ? first : '#'}`;
    } else if (x.el.getAttribute('aria-haspopup') === 'dialog' && !formVerb(x.name) && /[0-9]|…/.test(x.name || '')) {
      // Record cards that open a record dialog (a dispatch board's load chips): one per class of card.
      c.tw = `${x.role}|${x.section || ''}|card|${classOf(x.el).trim().split(/\s+/)[0] || ''}`;
    }
    if (x.el.tagName === 'A' && x.el.hasAttribute('href')) {
      const t = linkView(x.el, v);
      if (t) c.to = t.key;
      c.probe = !inner && kindIn(kinds, x.el) ? undefined : 'link';
    } else {
      // Inside a dialog only its tabs are pressed («Create New Load» → «Manual entry»): the dialog is entered again
      // for them (enterPanel), and what a tab shows is captured, never pressed.
      const tabIn = inner && v.kind === 'dialog' && x.role === 'tab' && x.el.getAttribute('aria-selected') !== 'true';
      const k = (!inner || tabIn) && !v.blocked && kindIn(kinds, x.el);
      c.probe = k && (!inner || k === 'tab') ? undefined : 'skip';
    }
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
    // Counted per table or list: the sidebar's <li> links must not use up the record links of the data table.
    const boxes = new Map();
    const boxOf = el => { const b = el.closest('table,[role=grid],[role=table],[role=treegrid],ul,ol,[role=list],[role=listbox]') || el.closest(ROW_SEL).parentElement; if (!boxes.has(b)) boxes.set(b, boxes.size); return boxes.get(b); };
    const repeat = x => {
      if (!x.el.closest(ROW_SEL)) return false;
      const k = `${boxOf(x.el)}|${x.role}|${x.role === 'link' ? '*' : x.name}`;
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
    const fpCut = (c, f) => { if (c.d && c.d.fp) f(c.d.fp); };
    // The header and navigation repeat on every screen with the same descriptor: their context features are kept
    // on the first screen only (the locator scores what is there and skips what is missing).
    const firstHot = new Set();
    // What guides are written from is cut last: fields, commits, openers and controls that lead somewhere.
    // Sort and filter headers and row repeats are cut first, even when not pressed yet (they wait for phase 2); a
    // record's own buttons («Mark as In-Transit», «Sync») stay: users ask for them.
    const needed = c => c.commit || c.to || c.probe === 'pressed' || FIELD_ROLE.test(c.role) || c.rg || (!c.ls && !c.tw && (c.ol || c.probe === undefined || /^(button|menuitem|tab)$/.test(c.role)));
    const cuts = [
      // The header and navigation on every screen have one descriptor (but for the address, kept per view in dpath):
      // it is stored once (st.hotD) and put back in the map by toMap. Only for copies the walk will not press.
      v => v.controls.forEach(c => {
        if (!c.hot || !c.d || (c.probe !== 'twin' && c.probe !== 'link')) return;
        const k = sigOf(c);
        st.hotD = st.hotD || {};
        if (!st.hotD[k]) { const { path, ...d } = c.d; st.hotD[k] = d; return; }
        c.dref = k; delete c.d;
      }),
      // Row repeats beyond two per twin key (the map lists a row control once anyway): the pressed one, else the one
      // that leads somewhere, else the first, and one not yet pressed.
      v => {
        const by = new Map();
        for (const c of v.controls) { const k = c.rk || c.tw; if (k) { if (!by.has(k)) by.set(k, []); by.get(k).push(c); } }
        const drop = new Set();
        for (const g of by.values()) {
          if (g.length <= 2) continue;
          const a = g.find(c => c.probe === 'pressed' || c.probe === 'mutating') || g.find(c => c.to) || g[0];
          const b = g.find(c => c !== a && c.probe === undefined) || g.find(c => c !== a);
          g.forEach(c => { if (c !== a && c !== b) drop.add(c); });
        }
        if (drop.size) v.controls = v.controls.filter(c => !drop.has(c));
      },
      v => v.controls.forEach(c => fpCut(c, fp => { if (fp.neighbors) fp.neighbors = fp.neighbors.slice(0, 4); if (fp.ancestry) fp.ancestry = fp.ancestry.slice(0, 3); })),
      v => v.controls.forEach(c => { if (c.hot) { const k = `${c.role}|${c.name}`; if (firstHot.has(k)) fpCut(c, fp => { delete fp.neighbors; delete fp.ancestry; delete fp.classes; delete fp.container; }); else firstHot.add(k); } }),
      v => v.controls.forEach(c => { if (c.options && c.options.length > 8) c.options = c.options.slice(0, 8); }),
      v => { if (v.facts) v.facts = v.facts.slice(0, 4); },
      v => { v.headings = (v.headings || []).slice(0, 2); },
      v => v.controls.forEach(c => { if (c.d && c.d.sel) c.d.sel = c.d.sel.slice(0, 1); }),
      v => v.controls.forEach(c => fpCut(c, fp => { delete fp.neighbors; delete fp.ancestry; })),
      // Long lists: sort and filter headers, row repeats and plain text controls go first.
      v => {
        if (v.controls.length <= 60) return;
        const keep = v.controls.filter(needed);
        const more = v.controls.filter(c => !needed(c) && !c.ls && !c.tw).slice(0, Math.max(0, 60 - keep.length));
        const left = new Set(keep.concat(more));
        v.controls = v.controls.filter(c => left.has(c));
      },
      v => v.controls.forEach(c => { delete c.options; }),
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
  // The open dialog a dialog view was captured from (same title), or null.
  const dialogOf = v => openDialogs().find(d => dialogTitle(d).slice(0, 80) === v.title) || null;
  /**
   * A view entered again by pressing what opened it on its parent view (v.enter = { page: parent key, ref }):
   *  - a tab panel: press its tab, only when it is not selected already;
   *  - a dialog with tabs (enter.dialog): press its opener again, unless that dialog is open already;
   *  - a menu that makes something (enter.menu): open it, unless it is open already.
   * The control found again goes through refind() and pressKind() like any press.
   */
  async function enterPanel(v) {
    const parent = st.views[v.enter.page];
    if (!parent || parent === v) return 'skip';
    if (v.enter.dialog && dialogOf(v)) return 'here';
    // Another dialog left open would cover the opener.
    for (const d of openDialogs()) if (!(await closeDialog(d))) return 'skip';
    const at = await goTo(parent);
    if (at !== 'here') return at;
    const c = (parent.controls || []).find(x => x.ref === v.enter.ref);
    const f = c ? refind(c) : null;
    if (!f) return 'skip';
    if (v.enter.dialog) {
      if (f.kind === 'tab' || !press(f.el)) return 'skip';
      await settle();
      return dialogOf(v) ? 'here' : 'skip';
    }
    if (v.enter.menu) {
      if (f.el.getAttribute('aria-expanded') !== 'true') {
        if (!press(f.el)) return 'skip';
        await settle(150, 900);
      }
      return 'here';
    }
    if (f.kind !== 'tab') return 'skip';
    if (f.el.getAttribute('aria-selected') !== 'true') {
      if (!press(f.el)) return 'skip';
      await settle();
    }
    return 'here';
  }
  // Leaving an entered dialog or menu: put the screen back, so the next view starts clean.
  async function leaveView(v) {
    if (!v || !v.enter || !(v.enter.dialog || v.enter.menu)) return;
    for (const d of openDialogs()) await closeDialog(d);
    if (v.enter.menu) {
      const parent = st.views[v.enter.page];
      const c = parent && (parent.controls || []).find(x => x.ref === v.enter.ref);
      const f = c ? refind(c) : null;
      if (f && f.el.getAttribute('aria-expanded') === 'true') press(f.el);
      else escape();
      await settle(150, 600);
    }
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
    let best = null, bestRank = 9;
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
      // A record page of another status (a booked and a dispatched load) or another tab of the same record shows the
      // same «Add tag», «Share load», «More actions»: what one of them opened is shared, not pressed again.
      if (recordLike(v) && st.recSeen[sig]) { c.probe = 'twin'; c.to = st.recSeen[sig]; continue; }
      if (c.ls && (v.lists || 0) >= 1) { c.probe = 'skip'; continue; }
      const rank = probeRank(c);
      if (rank < bestRank) { best = c; bestRank = rank; }
    }
    // Only sort, filter and table settings are left: they wait for the end of the walk (phase 2).
    if (best && bestRank === LOW && st.phase !== 2) {
      if (!v.deferred) { v.deferred = true; st.later.push(v.key); }
      return null;
    }
    return best;
  }
  // A record page (a sample of a record template, or one of its tabs), or a panel on one.
  const recordLike = v => { const h = st.views[homeKey(v)]; return !!h && !!(h.rec || h.rtab); };
  // What a probe is worth to a guide: openers of forms, dialogs and records first, then tabs, then menus and the
  // rest, then the header (once per walk). Sort and filter controls and table settings (Columns, Density) are LOW:
  // put off until the queue is empty, they rarely lead to a task.
  const LOW = 5;
  const TABLE_TOOL = /^(?:columns?|колонки|столбцы|density|плотность|customi[sz]e columns|show columns|view options)(?: |$)/;
  function probeRank(c) {
    if (c.ls || TABLE_TOOL.test(dnorm(c.name))) return LOW;
    if (c.hot) return 3;
    if (c.ol) return 0;
    if (c.role === 'tab') return 1;
    return 2;
  }

  // The next view to open. Forms are what guides need, so the urgent ones come first: tab panels, dialogs and menus
  // entered again, the first sample of each record page and that record's tabs. Navigation pages at least every
  // fourth pick, so a stream of record links never starves the menu (nor the menu the records). Then the rest of the
  // content queue; then st.later (second record samples, views whose low-value probes were put off) in phase 2.
  function nextKey() {
    const urgent = k => { const v = st.views[k]; return !!v && (!!v.enter || v.rec === 1 || !!v.rtab); };
    if (!((st.streak || 0) >= 3 && st.hot.length)) {
      const i = st.queue.findIndex(urgent);
      if (i >= 0) { st.streak = (st.streak || 0) + 1; return st.queue.splice(i, 1)[0]; }
    }
    st.streak = 0;
    if (st.hot.length) return st.hot.shift();
    if (st.queue.length) return st.queue.shift();
    if (st.later.length) { st.phase = 2; return st.later.shift(); }
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
          const key = nextKey();
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
        if (!c) { await leaveView(v); st.cur = null; continue; }
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
      try { console.warn('[Scopos] the walk stopped on an error:', (e && e.stack) || e); } catch (x) { /* no console */ }
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
    await wait(lite ? 200 : 360); // let the ring land so the walk is watchable
    if (!ok()) return;
    // Asked once more on purpose: the page had half a second to change the control (disable it, relabel it).
    if (!el.isConnected || !pressKind(el)) { c.probe = 'missing'; return; }
    const beforeKey = pageKey(), beforeDialogs = openDialogs();
    const expandedBefore = el.getAttribute('aria-expanded');
    const tablist = kind === 'tab' ? el.closest('[role=tablist]') : null;
    const tabBefore = tablist ? [...tablist.querySelectorAll('[role=tab]')].find(t => t.getAttribute('aria-selected') === 'true') : null;
    const before = new Set(inventory().map(x => x.el));
    const rect0 = el.getBoundingClientRect();
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
    const r = await outcome(v, c, el, kind, ctx, { beforeKey, beforeDialogs, expandedBefore, tabBefore, before, nodes, rect0 });
    if (c.hot) st.seen[sigOf(c)] = c.to || null;
    if (recordLike(v) && c.to && st.views[c.to] && st.views[c.to].kind !== 'page') st.recSeen[sigOf(c)] = c.to;
    if (r) return r;
    if (!c.to && c.kind !== 'page' && fenced > fenced0) { c.probe = 'external'; return; } // tried to leave: cancelled
    if (!c.to && c.probe === 'mutating') { c.commit = true; st.commits[sigOf(c)] = 1; }
  }

  /**
   * The press re-rendered its own control: put the screen back without reloading the page. The re-rendered copy of
   * the control (self, or the same control found again by its descriptor) is pressed again: an in-place toggle
   * folds back. Else (a record's «Edit load» became «Cancel» and «Save load») an exact «Cancel» / «Close» / × that
   * appeared, checked like a dialog's closer against the text of its own box.
   */
  function restoreInPlace(c, appeared, self) {
    if (self && self.isConnected && pressKind(self)) return press(self);
    const f = refind(c);
    if (f) return press(f.el);
    for (const x of appeared) {
      if (x.role !== 'button' || !x.el.isConnected || !isCloser(x.name)) continue;
      const box = x.el.parentElement;
      if (box && !box.matches('main,[role=main],body') && closerIn(box) === x.el) return press(x.el);
    }
    return false;
  }

  // An inline form a press showed (a record's «Edit load» turns its details into fields, «Save load» above them):
  // the commit is not next to the fields, so a button that saves is marked as the panel's commit (never pressed).
  const SAVE_LIKE = /^(?:save|update|apply|submit|done|confirm|сохранить|применить|готово|подтвердить|обновить)(?: |$)/;
  function inlineCommits(v) {
    const cs = v.controls || [];
    if (!cs.some(c => FIELD_ROLE.test(c.role))) return;
    for (const c of cs) {
      if (c.role !== 'button' || c.commit || !SAVE_LIKE.test(dnorm(c.name))) continue;
      c.commit = true;
      delete c.ol;
      if (c.probe === undefined) c.probe = 'commit';
    }
  }

  /** What a press did: a new page, a dialog, a panel or nothing. Returns 'leaving' when the document goes away. */
  async function outcome(v, c, el, kind, ctx, { beforeKey, beforeDialogs, expandedBefore, tabBefore, before, nodes, rect0 }) {
    const afterKey = pageKey();
    if (afterKey !== beforeKey) {
      const t = location.origin === st.origin ? addView(afterKey, cleanUrl(location.href), 'page', undefined, false, location.href) : null;
      if (t) c.to = t.key;
      c.kind = 'page';
      return (await goTo(v)) === 'leaving' ? 'leaving' : undefined;
    }

    const dlg = openDialogs().find(d => !beforeDialogs.includes(d));
    if (dlg) {
      let key = `${homeKey(v)} › ${dialogTitle(dlg)}`; // one per page, whichever of its panels opened it
      if (st.views[key] && st.views[key].kind !== 'dialog') key += ' ‹dialog›'; // a menu «Create Truck» and its dialog «Create Truck»
      const dv = addView(key, v.url, 'dialog', v.key);
      if (dv && !dv.captured) {
        dv.opener = c.ref;
        await captureView(dv, dlg);
        // Tabs inside the dialog («Manual entry» in «Create New Load»): the dialog is entered again for them.
        // The same dialog on another page («Create New Load» from the header, the board and the trips list): its tabs
        // once per walk.
        const sig = `${dv.title}¦${dv.controls.map(x => `${x.role}:${x.name}`).join('|')}`;
        if (dv.controls.some(x => x.probe === undefined) && !st.dlgSeen[sig]) { st.dlgSeen[sig] = 1; dv.enter = { page: v.key, ref: c.ref, dialog: true }; st.queue.push(key); }
      }
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
    // The press re-rendered its own control (an in-place toggle: same place, same role, its label may change): that
    // copy is the control itself, not something the press showed. Never a control that saves or acts.
    let self = null;
    if (!el.isConnected && rect0) {
      const cx = rect0.left + rect0.width / 2, cy = rect0.top + rect0.height / 2;
      const i = appeared.findIndex(x => {
        if (x.role !== c.role || !x.el.isConnected || isDangerText(textOf(x.el)) || commitOf(x.el, x.name)) return false;
        const r = x.el.getBoundingClientRect();
        return Math.abs(r.left + r.width / 2 - cx) < 12 && Math.abs(r.top + r.height / 2 - cy) < 12;
      });
      if (i >= 0) { self = appeared[i].el; appeared.splice(i, 1); }
    }
    // A tab that switched (re-rendered or not) shows a panel even with no new controls: its facts and tables count.
    const tabSwitched = kind === 'tab' && tabBefore !== el && !(el.isConnected && el.getAttribute('aria-selected') === 'false');
    if (appeared.length || tabSwitched || (expandedBefore !== 'true' && el.getAttribute('aria-expanded') === 'true')) {
      // A tab panel is a screen of its own («Users & Roles» → "Invite user"): its controls are probed later,
      // after pressing the tab again (mv.enter). Menus, popovers and disclosures stay look-only.
      // Tab panels are keyed by their page, so the same tab reached from another panel is the same view.
      const isTab = kind === 'tab' && !(el.tagName === 'A' && safeHref(el));
      const inDialog = v.kind === 'dialog';
      const key = `${isTab && !inDialog ? homeKey(v) : v.key} › ${mask(c.name)}`;
      // A menu that makes something ("Create Truck ▾"): its items are pressed like form openers, one per visit
      // (the menu is opened again for each, enterPanel). Only with writes blocked below the page.
      const makeMenu = !isTab && !inDialog && formsOn && (kind === 'menu' || kind === 'disclosure') && makeLabel(c.name);
      const mv = addView(key, v.url, 'panel', v.key);
      if (mv && !mv.captured) {
        mv.title = mask(c.name).slice(0, 80); mv.headings = []; mv.opener = c.ref;
        mv.facts = factsOf(panelRoot(el, nodes), [mv.title, v.title, ...(v.headings || []), ...(v.facts || [])]);
        mv.controls = await controlsOf(mv, appeared.slice(0, LIMITS.controls), inDialog || !(isTab || makeMenu), new Map());
        if (makeMenu) mv.controls.forEach(x => { if (x.probe === undefined && x.role !== 'menuitem') x.probe = 'skip'; });
        // A tab of a dialog shares the dialog's footer: its commit («Done», enabled only on this tab) belongs to it.
        const box = inDialog ? dialogOf(v) : null;
        if (box) {
          const have = new Set(mv.controls.concat(v.controls || []).map(x => `${x.role}|${x.name}`));
          for (const x of inventory(box)) {
            if (have.has(`${x.role}|${x.name}`) || !commitOf(x.el, x.name)) continue;
            have.add(`${x.role}|${x.name}`);
            mv.controls.push(control(mv, x, mv.controls.length, true, undefined, new Map()));
          }
        }
        const root = isTab ? panelRoot(el, nodes) : null;
        if (root) mv.controls.push(...regionControls(mv, root, mv.controls.length, true));
        inlineCommits(mv);
        mv.captured = true;
        if ((isTab || makeMenu) && !inDialog && mv.controls.some(x => x.probe === undefined)) { mv.enter = { page: v.key, ref: c.ref, menu: makeMenu || undefined }; st.queue.push(key); }
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
      else if (el.isConnected || !restoreInPlace(c, appeared, self)) escape();
      await settle(150, 900);
      if (!ctx.ok) return;
      // A dialog that the press opened late, or a panel that would not fold: start this screen clean.
      const late = openDialogs().find(d => !beforeDialogs.includes(d));
      if (late && !(await closeDialog(late))) return ctx.ok ? stuck(c) : undefined;
      if (ctx.ok && appeared.some(x => x.el.isConnected && shown(x.el))) return reload();
      return;
    }
    // An in-place toggle re-rendered itself and showed nothing we read as controls: toggle it back.
    if (self && self.isConnected && pressKind(self)) { press(self); await settle(150, 900); }
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
  function controlOut(c, page, idOf, twin, dpath) {
    // A twin that was never reached (the view's press limit) shares what its pressed twin found.
    if (twin && twin !== c && c.probe === undefined) c = { ...c, to: c.to || twin.to, probe: 'twin' };
    const to = idOf(c.to);
    return {
      ref: c.ref, role: c.role, name: c.name, section: c.section, state: c.state, options: c.options,
      // Which screen the control lives on, so a guide can say «Перейдите на страницу …».
      d: c.d ? { ...c.d, ...(c.d.path === undefined && dpath ? { path: dpath } : {}), view: page.title } : c.d,
      to,
      commit: c.commit ? true : undefined,
      unexplored: c.ol && !c.commit && !to && !EXPLORED.has(c.probe) ? true : undefined,
      // One per row of a table or list: rowLabel is the label without the record data ("Actions for load …").
      row: c.rk ? true : undefined,
      rowLabel: c.rk ? c.rowLabel || undefined : undefined,
    };
  }
  /** One view in the map format (toMap and snapshot share it). */
  function viewOut(v, page, idOf, parentId, hotD) {
    const pressed = {};
    for (const c of v.controls || []) if (c.tw && !pressed[c.tw] && (c.to || EXPLORED.has(c.probe) || c.probe === 'pressed')) pressed[c.tw] = c;
    // A row control is listed once per view (the one that led somewhere, else the pressed one), not once per row.
    const rep = {}, worth = c => (c.to ? 2 : 0) + (c.probe === 'pressed' || c.probe === 'mutating' ? 1 : 0);
    for (const c of v.controls || []) if (c.rk && (!rep[c.rk] || worth(c) > worth(rep[c.rk]))) rep[c.rk] = c;
    const controls = (v.controls || []).filter(c => !c.rk || rep[c.rk] === c).map(c => controlOut(!c.d && c.dref && hotD && hotD[c.dref] ? { ...c, d: hotD[c.dref] } : c, page, idOf, c.tw && pressed[c.tw], v.dpath));
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
      views: views.map(v => viewOut(v, v.kind === 'page' ? v : all[v.parent] || v, idOf, v.parent && all[v.parent] ? all[v.parent].id : undefined, s.hotD)),
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
      views: {}, hot: [], queue: [], later: [], phase: 1, streak: 0, cur: null, probes: 0, pending: null, nav: null,
      n: { ids: 0, pages: 0, extra: 0 }, shapes: {}, redirects: {},
      // netBlocked: what the host said at start (kept for resumes); commits: role|name|section of controls seen
      // writing; seen: global header controls already pressed (→ the view key they opened, or null).
      netBlocked: o.netBlocked === true, forms: false, commits: {}, seen: {}, recSeen: {}, dlgSeen: {},
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
    st.hot = st.hot || []; st.queue = st.queue || []; st.later = st.later || []; st.shapes = st.shapes || {}; st.redirects = st.redirects || {};
    st.commits = st.commits || {}; st.seen = st.seen || {}; st.recSeen = st.recSeen || {}; st.dlgSeen = st.dlgSeen || {};
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
