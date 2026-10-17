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
 * The walk is a small state machine saved through opts.store, so a full page
 * load in the middle of it resumes on the next page. Stop is saved too.
 */
(function (root) {
  const S = (root.Scopos = root.Scopos || {});
  if (S.explore) return; // loaded twice: one walker per document

  const LIMITS = { views: 40, extra: 60, probes: 160, perView: 30, controls: 150, ms: 5 * 60 * 1000, step: 8000, bytes: 1.5e6 };

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
  /** 'write' | 'danger' | null for one attribute. */
  function fwAttr(name, value) {
    if (FW_WRITE.test(name)) return 'write';
    if (/^data-(?:turbo-)?method$/i.test(name)) return /^\s*get\s*$/i.test(value || 'get') ? null : 'write';
    if (!FW_CLICK.test(name) || !value) return null;
    const v = String(value).slice(0, MAX_ATTR);
    if (/^(?:data-)?hx-get$/i.test(name)) return isDangerAddress(v) ? 'danger' : null;
    // Addresses inside handler code (location.href = '/items/5/archive') are checked like links.
    const URLS = /https?:\/\/[^\s'"`)]+|\/[\w./?=&%:-]+/g;
    for (const m of v.match(URLS) || []) if (m.length > 1 && isDangerAddress(m)) return 'danger';
    const code = v.replace(URLS, ' ');
    const toks = dnorm(code).split(' ').filter(Boolean);
    if (!toks.length || toks.every(t => UI_SAFE.has(t) || /^\d+$/.test(t))) return null;
    if (isDangerText(code)) return 'danger';
    return actionPart(code, UI_SAFE) ? 'danger' : null;
  }
  /** The element (or an ancestor whose click handler it would trigger) writes or names an action. */
  function fwCheck(el) {
    let hit = null;
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 25; n = n.parentElement, depth++) {
      const attrs = n.attributes || [];
      for (let i = 0; i < attrs.length; i++) {
        const r = fwAttr(attrs[i].name, attrs[i].value);
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
    if (T === 'A' && !anchorTrigger(el)) return null; // links are followed by address, never clicked
    if (T !== 'SUMMARY' && !/^(button|tab|menuitem|treeitem|link)$/.test(role)) return null;
    // hx-post/put/patch/delete, phx-submit, wire:submit, data-method="delete" (here or on an ancestor the click
    // bubbles to), a handler that names an action, or any risky word anywhere in the element: never pressed.
    if (danger(el)) return null;
    if (role === 'tab') return 'tab';
    if (T === 'SUMMARY') return 'disclosure';
    const popup = el.getAttribute('aria-haspopup');
    if (popup && popup !== 'false') return 'menu';
    if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls')) return 'disclosure';
    if (role !== 'button') return null; // menu items and tree items act; only their submenus open
    if (OPENER.test(norm(S.labelOf ? S.labelOf(el) : el.textContent))) return 'opener';
    // Everything else («Пригласить коллегу», «Сменить тариф», Watch, Follow …) is not pressed: the allow-list is
    // the safety, not the guard. What such a button opens is learned only when an opener reveals the same dialog.
    return null;
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
    if (isDangerAddress(u.href)) return null;
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
   */
  async function guardOn() {
    if (!S.guard || typeof S.guard.on !== 'function') return false;
    let confirmed = false, p = null;
    try { p = S.guard.on(); } catch (e) { p = null; }
    if (p && typeof p.then === 'function') p.then(ok => { if (ok) confirmed = true; }, () => {});
    const main = () => { try { return document.documentElement.getAttribute('data-scopos-guard-main') === '1'; } catch (e) { return false; } };
    const t0 = Date.now();
    while (!confirmed && !main() && Date.now() - t0 < 1500) await wait(50);
    return confirmed || main();
  }
  const guardOff = () => { try { if (S.guard) S.guard.off(); } catch (e) { /* ignore */ } };
  const blockedCount = () => { try { return S.guard ? S.guard.blocked() : 0; } catch (e) { return 0; } };

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
      if (check !== false && (isDangerAddress(check || url) || isDangerAddress(url))) return unsafeView(key, kind, parent);
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

  function control(v, x, i, inner, d, kinds) {
    if (d === undefined) { try { d = S.describe(x.el); } catch (e) { d = null; } }
    d = d ? slim(d) : null;
    const c = { ref: `${v.id}.${i + 1}`, role: x.role, name: x.name, section: x.section, state: x.state, d };
    if (x.options !== undefined) c.options = x.options;
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
  function pick(list, kinds) {
    if (list.length <= LIMITS.controls) return list;
    const rank = x => (x.el.closest(CHROME) ? 0 : x.el.tagName === 'A' || kindIn(kinds, x.el) ? 1 : 2);
    const keep = new Set(list.map((x, i) => [rank(x), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, LIMITS.controls).map(p => p[1]));
    return list.filter((x, i) => keep.has(i));
  }

  async function captureView(v, container) {
    const kinds = new Map();
    const list = pick(inventory(container), kinds);
    const h1 = document.querySelector('h1');
    v.title = mask(container ? dialogTitle(container) : (h1 && !ours(h1) && h1.textContent) || document.title).replace(/\s+/g, ' ').trim().slice(0, 80);
    v.headings = [...(container || document).querySelectorAll('h1,h2,h3')].filter(h => !ours(h)).slice(0, 8).map(h => mask(h.textContent).replace(/\s+/g, ' ').trim().slice(0, 60));
    v.controls = await controlsOf(v, list, !!container, kinds);
    v.captured = true;
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
      v => { v.headings = (v.headings || []).slice(0, 2); },
      v => v.controls.forEach(c => { if (c.d && c.d.sel) c.d.sel = c.d.sel.slice(0, 1); }),
      v => { if (v.controls.length > 60) { const keep = v.controls.filter(c => c.to || c.probe === undefined || c.probe === 'pressed'); v.controls = keep.concat(v.controls.filter(c => !keep.includes(c)).slice(0, Math.max(0, 60 - keep.length))); } },
    ];
    for (const cut of cuts) { views.forEach(cut); if (size() <= LIMITS.bytes) return; }
  }

  // ---------------- navigation ----------------
  /** 'here' when on the view, 'leaving' when a full load started, 'skip' when it can't be reached. */
  async function goTo(v) {
    if (pageKey() === v.key) return 'here';
    if ((v.fails || 0) >= 2) return 'skip';
    let a;
    try { a = new URL(v.url, location.href); } catch (e) { return 'skip'; }
    if (a.origin !== st.origin) return 'skip';
    // Never (re)open an address that acts. The start view was opened by the user and is exempt.
    if (v.status === 'unsafe' || (!v.start && isDangerAddress(a.href))) { v.status = 'unsafe'; return 'skip'; }
    if (a.origin + a.pathname + a.search === location.origin + location.pathname + location.search && a.hash) {
      location.hash = a.hash; // same document: the SPA re-renders in place
      await settle();
      return pageKey() === v.key ? 'here' : 'skip';
    }
    st.nav = { key: v.key, at: Date.now() };
    await save();
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

  function nextProbe(v) {
    if ((v.pressed || 0) >= LIMITS.perView || v.blocked) return null;
    return v.controls.find(c => c.probe === undefined) || null;
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
        if (at === 'skip' || pageKey() !== v.key) { v.status = v.status || 'unreachable'; st.cur = null; continue; }
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
        if (c.probe !== 'missing' && c.probe !== 'covered') progress(`Нажал «${c.name}»`);
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
    const blocked0 = blockedCount();
    c.probe = 'pressed';
    // Counted before the press: if it loads another page, the count is already saved.
    v.pressed = (v.pressed || 0) + 1;
    st.probes++;
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
    // The guard stopped a write or a prompt: the label lied. Remember it so guides warn about this control.
    if (blockedCount() > blocked0) { c.probe = 'mutating'; c.state = c.state ? `${c.state}, changes data` : 'changes data'; }
    if (!live(g)) return;

    const afterKey = pageKey();
    if (afterKey !== beforeKey) {
      const t = location.origin === st.origin ? addView(afterKey, cleanUrl(location.href), 'page', undefined, false, location.href) : null;
      if (t) c.to = t.key;
      c.kind = 'page';
      return (await goTo(v)) === 'leaving' ? 'leaving' : undefined;
    }

    const dlg = openDialogs().find(d => !beforeDialogs.includes(d));
    if (dlg) {
      const key = `${v.key} › ${dialogTitle(dlg)}`;
      const dv = addView(key, v.url, 'dialog', v.key);
      if (dv && !dv.captured) { dv.opener = c.ref; await captureView(dv, dlg); }
      if (dv) c.to = key;
      c.kind = 'dialog';
      if (!(await closeDialog(dlg))) return ctx.ok ? stuck(c) : undefined;
      await settle(150, 800);
      return;
    }

    // A menu, a disclosure, a tab panel or an inline form: controls that appeared after the press.
    const appeared = appearedAfter(el, nodes, before);
    if (appeared.length || (expandedBefore !== 'true' && el.getAttribute('aria-expanded') === 'true')) {
      const key = `${v.key} › ${mask(c.name)}`;
      const mv = addView(key, v.url, 'panel', v.key);
      if (mv && !mv.captured) {
        mv.title = mask(c.name).slice(0, 80); mv.headings = []; mv.opener = c.ref;
        mv.controls = await controlsOf(mv, appeared.slice(0, LIMITS.controls), true, new Map());
        mv.captured = true;
      }
      if (mv) c.to = key;
      c.kind = 'panel';
      // Put the screen back for the next probe: the previous tab, collapse, or Escape.
      if (tabBefore && tabBefore !== el && tabBefore.isConnected && pressKind(tabBefore) === 'tab') press(tabBefore);
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
    S.pointer.hide();
    if (notify && opts) {
      const reason = st.cancelled ? 'cancelled' : st.stopReason === 'redirect' ? 'redirect' : null;
      try {
        if (reason && opts.onAbort) opts.onAbort(reason, toMap(st));
        else if (opts.onDone) opts.onDone(toMap(st));
      } catch (e) { /* ignore */ }
    }
  }

  /** The stored map: what guides and answers are written from. */
  function toMap(s) {
    const all = (s && s.views) || {};
    const views = Object.values(all).filter(v => v.captured);
    const idOf = k => (k && all[k] && all[k].captured ? all[k].id : undefined);
    return {
      origin: s.origin, learnedAt: new Date().toISOString(), status: s.status, probes: s.probes,
      views: views.map(v => {
        const page = v.kind === 'page' ? v : all[v.parent] || v;
        return {
          id: v.id, key: v.key, url: v.url, kind: v.kind, parent: v.parent && all[v.parent] ? all[v.parent].id : undefined, opener: v.opener,
          title: v.title, headings: v.headings,
          controls: (v.controls || []).map(c => ({
            ref: c.ref, role: c.role, name: c.name, section: c.section, state: c.state, options: c.options,
            // Which screen the control lives on, so a guide can say «Перейдите на страницу …».
            d: c.d ? { ...c.d, view: page.title } : c.d,
            to: idOf(c.to),
          })),
        };
      }),
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
    };
    const first = addView(pageKey(), cleanUrl(location.href), 'page', undefined, true, false);
    if (first) first.start = true;
    // Nothing is pressed before the page-world guard has landed (or 1.5 s went by).
    st.guardMain = await guardOn();
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
    st.guardMain = await guardOn();
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

  S.explore = { start, resume, stop, toMap, running, pageKey, pressable: el => !!pressKind(el), isDangerous: el => danger(el) };
  // Pure helpers for dev/explore-safety-test.mjs (no DOM needed except for the element-level ones).
  S._exploreTest = { isDangerText, isDangerAddress, linkTextDanger, dnorm, fwAttr, fwCheck, pressKind, closerIn, dialogQuestion };
})(typeof window !== 'undefined' ? window : globalThis);
