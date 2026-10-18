/* RoadLedger TMS replica: accounting (invoice batches, invoices, aging, factoring, salary batches and settlements,
   driver statements, deductions, bills management, payroll). */
(function () {
  'use strict';
  const RL = window.RL, db = RL.db, H = RL.h, ic = RL.ic;
  const { esc, money, num, r2, fmtDate, fmtLong, fmtDT, fmtEvt, fmtMDY, fmtWeekday, cust, drv, trk, mcOf, dname, loadById, loadUrl, firstStop, lastStop, place, totalPay, nowIso, byId, daysBetween, todayStr } = H;
  const { stPill, pill, copyBtn } = RL.pill;
  const { ACTS, CHANGES, SUBMITS, DBL, MENUS, POPS, mi, ml, msep, menu, commit, toast, openModal, formDialog, confirmDialog, field, validate, readForm } = RL;
  const ME = 'Tutorial Account';
  const ev = (L, text) => L.events.push({ at: nowIso(), text: `${ME} ${text}` });
  const IB = id => 'IB-' + String(id).padStart(6, '0'), SB = id => 'SB-' + String(id).padStart(6, '0');
  const acctTabs = i => RL.sectionTabs('Accounting sections', [['Invoices', '#/accounting/invoices/batches'], ['Salary', '#/accounting/salary/driver-settlements'], ['Bills Management', '#/accounting/bills'], ['Payroll', '#/accounting/payroll']], i);
  const invChips = i => RL.chipLinks('Invoice views', [['Batches', '#/accounting/invoices/batches'], ['Invoices', '#/accounting/invoices/invoices'], ['Aging report', '#/accounting/invoices/aging-report', 'bookmark'], ['Invoice reports', '#/accounting/invoices/invoice-reports'], ['Factoring', '#/accounting/invoices/factoring'], ['Reconciliation', '#/accounting/invoices/reconciliation'], ['Watchdogs', '#/accounting/invoices/watchdogs']], i, [2]);
  // Salary sub-chips in the order of frame iv8hngzif0g-t660. Callers pass 0 batches, 1 statements, 2 report, 3 scheduled payments, 4 balances, 5 dispatcher salary, 6 one time charges.
  const SAL_CHIPS = [['Salary batches', '#/accounting/salary/driver-settlements', 0], ['Driver statements', '#/accounting/salary/driver-statements', 1], ['Salary report', '#/accounting/salary/salary-report', 2], ['Driver balances', '#/accounting/salary/driver-balances', 4], ['Dispatcher salary', '#/accounting/salary/dispatcher-salary', 5], ['One time charges', '#/accounting/salary/one-time-charges', 6], ['Scheduled payments', '#/accounting/salary/deductions', 3]];
  const salChips = i => RL.chipLinks('Salary views', SAL_CHIPS.map(([t, h]) => [t, h]), SAL_CHIPS.findIndex(c => c[2] === i));
  RL.salChips = salChips; RL.invChips = invChips;
  const wrap = (tabs, head, body) => `<div class="card" style="margin-bottom:12px">${tabs}<div class="page-head" style="margin:0;border-radius:0 0 10px 10px">${head}</div></div>${body}`;
  const batchById = id => db.invBatches.find(b => b.id === +id);
  const stCls = s => String(s).toLowerCase().replace(/\s+/g, '_');

  // ======================= invoice batches =======================
  const batchTotal = b => r2(b.loadIds.reduce((a, id) => a + totalPay(loadById(id) || { otherPay: [], loadPay: 0 }), 0));
  RL.SELTEST.unpostedBatches = ids => ids.length > 0 && ids.every(id => (batchById(id) || {}).status === 'UNPOSTED');
  RL.route('/accounting/invoices/batches', () => ({
    crumbs: ['Accounting', 'Invoices', 'Batches'],
    html: wrap(acctTabs(0), `${invChips(0)}<span class="grow"></span><a class="btn primary" href="#/accounting/invoices/batches/create-batch">Create new batch</a><button type="button" class="btn" data-act="send-batches" data-needs-sel="batches" data-sel-test="unpostedBatches">Send batch</button><button type="button" class="icon-btn" data-act="menu" data-menu="batchesMore" aria-haspopup="menu" aria-expanded="false" aria-label="More batch actions">${ic('more')}</button>`,
      RL.table({ id: 'batches', label: 'Invoice batches', rowName: b => IB(b.id), dbl: 'openBatch', toolbarRight: RL.stdRight({ id: 'batches' }).replace(/<button[^>]*data-act="(save-view|density)"[\s\S]*?<\/button>/g, ''),
        columns: [{ key: 'id', label: 'Batch ID', text: b => IB(b.id), render: b => `<a href="#/accounting/invoices/batches/view-batch/${b.id}">${IB(b.id)}</a>`, sortVal: b => b.id }, { key: 'status', label: 'Post status', text: b => b.status, render: b => pill(b.status, stCls(b.status)) }, { key: 'by', label: 'Created by', text: b => b.createdBy }, { key: 'date', label: 'Created date', text: b => fmtDate(b.createdAt), sortVal: b => b.createdAt }, { key: 'n', label: 'Invoices', num: true, text: b => b.loadIds.length }, { key: 'mc', label: 'MC number', text: b => mcOf(b.mcId).name }, { key: 'total', label: 'Total amount', num: true, text: batchTotal, render: b => money(batchTotal(b)) }, { key: 'notes', label: 'Notes', text: b => b.notes || '-' }],
        rows: () => db.invBatches.slice().sort((a, b) => b.id - a.id), totals: rows => `<span>Total amount: <b>${money(rows.reduce((a, b) => a + batchTotal(b), 0))}</b></span>` })),
  }));
  DBL.openBatch = id => { location.hash = `#/accounting/invoices/batches/view-batch/${id}`; };
  MENUS.batchesMore = () => menu('Batches', [ml('Create new batch', '#/accounting/invoices/batches/create-batch'), ml('Aging report', '#/accounting/invoices/aging-report'), ml('Factoring', '#/accounting/invoices/factoring')]);
  ACTS['send-batches'] = t => { const ids = [...RL.TS.batches.sel].map(Number); sendBatches(t, ids.map(batchById)); };

  // create batch
  const CB = { mc: 1 };
  const eligible = mc => db.loads.filter(L => !L.deleted && ['delivered', 'invoiced'].includes(L.status) && !L.invoice.batchId && (!mc || L.mcId === +mc));
  RL.route('/accounting/invoices/batches/create-batch', () => ({
    crumbs: ['Accounting', 'Invoices', 'Create a new batch'],
    html: wrap(acctTabs(0), `<a class="icon-btn" href="#/accounting/invoices/batches" aria-label="Back to batches">${ic('left')}</a>${invChips(0)}<span class="grow"></span><button type="button" class="btn primary" data-act="create-batch" data-needs-sel="create-batch">Create batch</button>`,
      `<div class="row" style="margin-bottom:10px"><label class="row sm muted">MC number <select class="inp" style="width:200px" data-change="cb-mc" aria-label="MC number"><option value="">All MC numbers</option>${RL.selOptions.mcs().map(([v, l]) => `<option value="${v}" ${String(v) === String(CB.mc) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>${CB.mc ? `<button type="button" class="icon-btn" data-act="cb-clear" aria-label="Clear MC number">${ic('x')}</button>` : ''}<span class="muted sm">Selected: <b data-sel-count="create-batch">0</b></span></div>` +
      RL.table({ id: 'create-batch', label: 'Delivered loads to invoice', rowName: L => L.sid, toolbarRight: '<button type="button" class="btn sm" data-act="menu" data-pop="columns" data-t="create-batch" aria-haspopup="dialog" aria-expanded="false">Columns</button>',
        columns: [{ key: 'sid', label: 'Shipment ID', text: L => L.sid, render: L => `<a href="${loadUrl(L)}">${L.sid}</a>` }, { key: 'loadId', label: 'Load ID', text: L => L.loadId }, { key: 'customer', label: 'Customer', text: L => cust(L.customerId).name }, { key: 'mc', label: 'MC Number', text: L => mcOf(L.mcId).name }, { key: 'amount', label: 'Amount', num: true, text: L => totalPay(L), render: L => money(totalPay(L)) }, { key: 'pu', label: 'Pickup', text: L => `${firstStop(L).address}, ${place(firstStop(L))}` }, { key: 'del', label: 'Delivery', text: L => `${lastStop(L).address}, ${place(lastStop(L))}` }, { key: 'delTime', label: 'Delivery time', text: L => fmtDate(L.deliveredAt || lastStop(L).from), sortVal: L => L.deliveredAt }, { key: 'puTime', label: 'Pickup time', text: L => fmtDate(firstStop(L).from) }, { key: 'status', label: 'Invoice status', text: L => L.status, render: L => stPill(L.status) }, { key: 'notes', label: 'Notes', text: L => RL.hasPod(L) ? '-' : 'Missing Proof of Delivery' }],
        rows: () => eligible(CB.mc).sort((a, b) => b.id - a.id), totals: rows => `<span>Total amount: <b>${money(rows.reduce((a, L) => a + totalPay(L), 0))}</b></span>` })),
  }));
  CHANGES['cb-mc'] = t => { CB.mc = t.value; if (RL.TS['create-batch']) { RL.TS['create-batch'].sel.clear(); RL.TS['create-batch'].page = 1; } RL.rerender(); };
  ACTS['cb-clear'] = () => { CB.mc = ''; RL.rerender(); };
  ACTS['create-batch'] = async t => {
    const ids = [...RL.TS['create-batch'].sel].map(Number); const loads = ids.map(loadById).filter(Boolean); if (!loads.length) return;
    const id = Math.max(...db.invBatches.map(b => b.id)) + 1;
    if (await commit(t, 'create-batch', { batch: IB(id), loads: loads.map(L => L.sid), total: loads.reduce((a, L) => a + totalPay(L), 0) }, () => {
      const at = nowIso();
      db.invBatches.unshift({ id, status: 'UNPOSTED', createdBy: ME, createdAt: at, mcId: loads[0].mcId, loadIds: ids, notes: '', sentIds: [], events: [{ at, text: `${ME} created batch` }] });
      loads.forEach(L => { L.invoice.batchId = id; L.invoice.status = 'UNPOSTED'; if (!L.invoice.createdAt) L.invoice.createdAt = at; ev(L, `added the invoice to batch ${IB(id)}`); });
      RL.TS['create-batch'].sel.clear();
    })) location.hash = `#/accounting/invoices/batches/view-batch/${id}`;
  };

  // view batch
  /** Send invoices: the "Send Invoice Batch" modal (frame E9gihrMGGvQ-t140), then the "Missing documents" check, then one write. */
  function sendBatches(btn, batches, onlyIds) {
    batches = batches.filter(b => b && b.status !== 'PAID');
    let loads = batches.flatMap(b => b.loadIds.filter(id => !b.sentIds.includes(id)).map(loadById)).filter(Boolean);
    if (onlyIds) loads = loads.filter(L => onlyIds.includes(L.id));
    if (!loads.length) { toast('Select invoices that are not sent yet', 'error'); return; }
    const c0 = cust(loads[0].customerId), fc = db.factoringCos.find(x => x.default) || db.factoringCos[0];
    const modes = [['email', 'Email'], ['mark', "Mark as sent, but don't email"], ['factoring', 'Send to factoring Company'], ['other', 'Other']];
    const d = openModal({ title: 'Send Invoice Batch', sub: `${loads.length} ${loads.length > 1 ? 'invoices' : 'invoice'} · ${money(loads.reduce((a, L) => a + totalPay(L), 0))}`, kind: 'native', size: 'wide',
      body: `<div class="choice" role="radiogroup" aria-label="Delivery mode">${modes.map(([v, l], i) => `<label><input type="radio" name="mode" value="${v}" ${i === 0 ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
        <div id="sib-email" class="col">${field({ name: 'from', label: 'From', value: 'billing@roadledger-demo.example', readonly: true })}${field({ name: 'to', label: 'To', type: 'email', required: true, value: c0.email || '', placeholder: 'Please enter email address and press enter' })}${field({ name: 'cc', label: 'CC' })}${field({ name: 'bcc', label: 'BCC' })}${field({ name: 'subject', label: 'Subject', value: `Invoices ${loads.map(L => L.sid).join(', ')}` })}${field({ name: 'message', label: 'Message', type: 'textarea', value: 'Hello,\nPlease see attached Invoice along with POD and other documents.' })}
        <fieldset style="border:0;padding:0;margin:0"><legend class="sm b">Attach standard documents</legend><div class="grid3">${field({ name: 'att_rc', label: 'Rate confirmation', type: 'checkbox', value: true })}${field({ name: 'att_pod', label: 'Proof of Delivery', type: 'checkbox', value: true })}${field({ name: 'att_ci', label: 'Commercial Invoice', type: 'checkbox', value: true })}</div></fieldset></div>
        <p class="muted sm" id="sib-note" hidden></p>`,
      footer: `<button type="button" class="btn" data-act="dlg-close">Cancel</button><button type="submit" class="btn purple">Send</button>` });
    const sync = () => {
      const m = d.form.querySelector('[name=mode]:checked').value, box = H.$('#sib-email', d.el), n = H.$('#sib-note', d.el);
      box.hidden = m !== 'email' && m !== 'factoring'; d.form.to.required = !box.hidden;
      if (m === 'factoring') { d.form.to.value = fc.email; d.form.subject.value = `Schedule for ${fc.name}`; } else if (m === 'email') d.form.to.value = c0.email || '';
      n.hidden = box.hidden === false; n.textContent = m === 'mark' ? 'The invoices are marked as sent; nobody is emailed.' : 'Use Other when the invoices were delivered another way (portal upload, mail).';
    };
    d.form.addEventListener('change', e => { if (e.target.name === 'mode') sync(); });
    const missingDocs = f => (f.mode === 'email' || f.mode === 'factoring') ? loads.filter(L => (f.att_pod && !RL.hasPod(L)) || (f.att_rc && !L.docs.some(x => x.type === 'Rate confirmation'))) : [];
    const doSend = async (b2, f) => commit(b2, 'send-batch', { batches: batches.map(b => IB(b.id)), invoices: loads.map(L => L.sid), mode: f.mode, to: f.to || '', missingDocuments: missingDocs(f).map(L => L.sid) }, () => {
      const at = nowIso();
      loads.forEach(L => {
        const b = batchById(L.invoice.batchId); if (b && !b.sentIds.includes(L.id)) b.sentIds.push(L.id);
        if (L.status === 'delivered') L.status = 'invoiced'; if (!L.invoice.createdAt) L.invoice.createdAt = at; L.invoice.sent = true; L.locked = true; if (f.mode === 'factoring') L.invoice.factored = true;
        ev(L, f.mode === 'mark' ? 'marked the invoice as sent' : `sent invoice in batch ${IB(L.invoice.batchId)} (${f.mode})`);
      });
      if (f.mode === 'factoring') db.factoringSchedules.push({ id: Math.max(4400, ...db.factoringSchedules.map(x => x.id)) + 1, companyId: fc.id, loadIds: loads.map(L => L.id), sentAt: at, status: 'SENT', amount: loads.reduce((a, L) => a + totalPay(L), 0), docs: ['Invoice', 'Rate confirmation', 'Proof of Delivery'] });
      batches.forEach(b => { if (b.loadIds.every(id => b.sentIds.includes(id))) { b.status = 'POSTED'; b.loadIds.map(loadById).forEach(L => L && (L.invoice.status = 'POSTED')); } b.events.push({ at, text: `${ME} sent ${loads.filter(L => L.invoice.batchId === b.id).length} invoices (${f.mode})` }); });
      if (RL.TS.batches) RL.TS.batches.sel.clear(); if (RL.TS['batch-view']) RL.TS['batch-view'].sel.clear();
    });
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!H.$('#sib-email', d.el).hidden && !validate(H.$('#sib-email', d.el))) return;
      const f = readForm(d.form); const miss = missingDocs(f);
      if (!miss.length) { if (await doSend(d.form.querySelector('[type=submit]'), f)) { d.close(); RL.rerender(); } return; }
      const m = openModal({ title: 'Missing documents', kind: 'native', size: '', body: `<p class="muted" style="text-align:center;margin:0">${miss.length} invoices are missing documents</p>
        <table class="t" aria-label="Invoices missing documents"><thead><tr><th scope="col">Load</th><th scope="col">Rate confirmation</th><th scope="col">Proof of Delivery</th><th scope="col">Note</th></tr></thead><tbody>${miss.map(L => `<tr><td><a href="${loadUrl(L)}">${esc(L.loadId)}</a></td><td>${L.docs.some(x => x.type === 'Rate confirmation') ? `<span class="green" aria-label="Present">${ic('check')}</span>` : '<span aria-label="Missing">☐</span>'}</td><td>${RL.hasPod(L) ? `<span class="green" aria-label="Present">${ic('check')}</span>` : '<span aria-label="Missing">☐</span>'}</td><td>-</td></tr>`).join('')}</tbody></table>
        <p class="muted sm" style="margin:0">Invoices are sent without the missing files. Upload them on the load's Documents tab to include them next time.</p>`,
        footer: `<button type="submit" class="btn purple" style="width:100%">ok</button>` });
      m.form.addEventListener('submit', async e2 => { e2.preventDefault(); if (await doSend(m.form.querySelector('[type=submit]'), f)) { m.close(); d.close(); RL.rerender(); } });
    });
  }
  // Reconcile a posted batch against the customer payment (inferred from the "Reconcile" button in frame E9gihrMGGvQ-t080).
  ACTS['batch-reconcile'] = t => {
    const b = batchById(t.dataset.id); const loads = b.loadIds.map(loadById).filter(Boolean); const total = loads.reduce((a, L) => a + totalPay(L), 0);
    formDialog({ title: `Reconcile ${IB(b.id)}`, sub: `Expected ${money(total)}`, submit: 'Reconcile', name: 'reconcile-batch', fields: [{ name: 'received', label: 'Amount received', type: 'money', required: true, value: total }, { name: 'date', label: 'Payment date', type: 'date', required: true, value: todayStr }, { name: 'ref', label: 'Check / ACH reference', required: true }, { name: 'shortPay', label: 'Short pay reason', placeholder: 'Only when the amount differs' }],
      build: p => ({ batch: IB(b.id), ...p }), apply: p => { b.reconciled = { received: +p.received, date: p.date, ref: p.ref }; b.events.push({ at: nowIso(), text: `${ME} reconciled ${money(p.received)} (${p.ref})` }); if (Math.abs(+p.received - total) < 0.01) { b.status = 'PAID'; loads.forEach(L => { L.status = 'paid'; L.invoice.status = 'PAID'; L.invoice.paidAt = nowIso(); }); } } });
  };
  const VB = { id: null };
  RL.SELTEST.anySel = ids => ids.length > 0;
  RL.route('/accounting/invoices/batches/view-batch/:id', p => {
    const b = batchById(p.id); if (!b) return null;
    if (VB.id !== b.id) { VB.id = b.id; if (RL.TS['batch-view']) RL.TS['batch-view'].sel.clear(); }
    const loads = () => b.loadIds.map(loadById).filter(Boolean);
    const unposted = b.status === 'UNPOSTED', paid = b.status === 'PAID';
    return {
      crumbs: ['Accounting', ['Invoices', '#/accounting/invoices/batches'], IB(b.id)],
      html: wrap(acctTabs(0), `<a class="icon-btn" href="#/accounting/invoices/batches" aria-label="Back to batches">${ic('left')}</a>${invChips(0)}<span class="grow"></span>
        <button type="button" class="btn primary" data-act="send-batch" data-id="${b.id}" data-needs-sel="batch-view" aria-haspopup="dialog"><span>Send (<span data-sel-count="batch-view">0</span>)</span></button><button type="button" class="btn" data-act="batch-paid" data-id="${b.id}" ${b.status === 'POSTED' ? '' : 'disabled'}>Mark as paid</button>
        <button type="button" class="btn outline" data-act="batch-add-load" data-id="${b.id}" aria-haspopup="dialog" ${paid ? 'disabled' : ''}>Add load</button><button type="button" class="btn soft" data-act="batch-pdf" data-id="${b.id}" aria-haspopup="dialog">${ic('download')}Export as PDF</button><button type="button" class="btn" data-act="batch-reconcile" data-id="${b.id}" aria-haspopup="dialog" ${b.status === 'UNPOSTED' ? 'disabled' : ''}>Reconcile</button>
        <button type="button" class="icon-btn" data-act="menu" data-pop="batchHistory" data-id="${b.id}" aria-haspopup="dialog" aria-expanded="false" aria-label="Batch history">${ic('history')}</button><button type="button" class="icon-btn" data-act="batch-remove-loads" data-id="${b.id}" data-needs-sel="batch-view" aria-label="Remove selected loads from batch" ${unposted ? '' : 'hidden'}>${ic('minus')}</button>
        <button type="button" class="icon-btn" data-act="menu" data-menu="batchMore" data-id="${b.id}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${IB(b.id)}">${ic('more')}</button>`,
        RL.table({ id: 'batch-view', label: `Invoices in ${IB(b.id)}`, rowName: L => L.sid, dbl: 'openLoad',
          toolbarLeft: `<span class="grow"></span>`, toolbarRight: `<div class="field" style="width:200px"><label for="vb-mc">MC number</label><input id="vb-mc" value="${esc(mcOf(b.mcId).name)}" readonly></div>` + RL.stdRight({ id: 'batch-view' }).replace(/<button[^>]*data-act="(save-view|density)"[\s\S]*?<\/button>/g, ''),
          columns: [{ key: 'sid', label: 'Invoice Id', text: L => L.sid }, { key: 'customer', label: 'Customer', text: L => cust(L.customerId).name, render: L => `<a href="#/customer-management/customers/${L.customerId}">${esc(cust(L.customerId).name)}</a>` }, { key: 'loadId', label: 'Load Id', text: L => L.loadId, render: L => `<a href="${loadUrl(L)}">${esc(L.loadId)}</a>` }, { key: 'dpay', label: 'Driver pay', num: true, text: L => H.driverPayOf(L), render: L => money(H.driverPayOf(L)) },
            { key: 'delTime', label: 'Delivery time', text: L => L.deliveredAt ? fmtDate(L.deliveredAt) : '', sortVal: L => L.deliveredAt }, { key: 'puTime', label: 'Pickup time', text: L => fmtDate(firstStop(L).from) }, { key: 'appt', label: 'Delivery appointment', text: L => fmtDate(lastStop(L).from) }, { key: 'driver', label: 'Driver', text: L => L.trips.map(H.tripLabel).join(', ') || '-' }, { key: 'status', label: 'Status', text: L => L.status, render: L => stPill(L.status) },
            { key: 'fpdf', label: 'Factoring PDF', text: L => L.invoice.factored ? 'Yes' : 'No', render: L => `<button type="button" class="btn link" data-act="invoice-view" data-id="${L.id}" aria-haspopup="dialog" aria-label="View PDF of ${L.sid}">View PDF</button>` }, { key: 'billing', label: 'Billing type', text: L => L.invoice.billingType === 'FACTORING COMPANY' ? 'Factoring company' : L.invoice.billingType === 'QUICK PAY' ? 'Quick pay' : 'Direct bill' }, { key: 'total', label: 'Total amount', num: true, text: totalPay, render: L => money(totalPay(L)) },
            { key: 'sent', label: 'Is sent', text: L => b.sentIds.includes(L.id) ? 'Yes' : 'No', render: L => b.sentIds.includes(L.id) ? `<span class="green" aria-label="Sent">${ic('check')}</span>` : `<span class="red" aria-label="Not sent">${ic('x')}</span>` }, { key: 'ratecon', label: 'Rate confirmation', nosort: true, text: L => 'Rate confirmation', render: L => L.docs.length ? `<button type="button" class="btn link" data-act="view-doc" data-id="${L.id}" data-doc="${L.docs[0].id}" aria-haspopup="dialog" aria-label="Rate confirmation of ${L.sid}">${ic('file')}Rate confirmation</button>` : '-' }],
          rows: loads, totals: rows => `<span>Total amount sum: <b>${money(rows.reduce((a, L) => a + totalPay(L), 0))}</b></span>` })),
    };
  });
  ACTS['send-batch'] = t => sendBatches(t, [batchById(t.dataset.id)], [...RL.TS['batch-view'].sel].map(Number));
  ACTS['batch-paid'] = t => { const b = batchById(t.dataset.id); confirmDialog({ title: 'Mark as paid', message: `Mark ${IB(b.id)} (${b.loadIds.length} invoices, ${money(batchTotal(b))}) as paid?`, yes: 'Mark as paid', no: 'Cancel', name: 'mark-batch-paid', data: { batch: IB(b.id) }, apply: () => { b.status = 'PAID'; b.events.push({ at: nowIso(), text: `${ME} marked the batch as paid` }); b.loadIds.map(loadById).forEach(L => { L.status = 'paid'; L.invoice.status = 'PAID'; L.invoice.paidAt = nowIso(); ev(L, 'updated Load to paid status'); }); } }); };
  POPS.batchHistory = t => { const b = batchById(t.dataset.id); return `<div class="popover wide" role="dialog" aria-label="Batch history"><div class="pop-head"><h3>History</h3></div><ul class="notif">${[...b.events].reverse().map(e => `<li><span style="display:block;padding:6px">${esc(e.text)}<div class="muted xs">${fmtEvt(e.at)}</div></span></li>`).join('')}</ul></div>`; };
  MENUS.batchMore = t => { const b = batchById(t.dataset.id); return menu(`More actions for ${IB(b.id)}`, [mi('Edit notes', 'batch-notes', `data-id="${b.id}"`), msep, mi('Delete batch', 'batch-delete', `data-id="${b.id}" ${b.status === 'UNPOSTED' ? '' : 'aria-disabled="true"'}`, 'danger')]); };
  ACTS['batch-notes'] = t => { const b = batchById(t.dataset.id); formDialog({ title: `Notes for ${IB(b.id)}`, size: 'narrow', submit: 'Save', name: 'save-batch-notes', fields: [{ name: 'notes', label: 'Notes', type: 'textarea', value: b.notes, cls: 'span2' }], build: p => ({ batch: IB(b.id), ...p }), apply: p => (b.notes = p.notes) }); };
  ACTS['batch-delete'] = t => { const b = batchById(t.dataset.id); confirmDialog({ title: 'Delete batch', message: `Delete ${IB(b.id)}? Its ${b.loadIds.length} loads return to the list of loads to invoice.`, yes: 'Delete', no: 'Cancel', danger: true, name: 'delete-batch', data: { batch: IB(b.id) }, apply: () => { b.loadIds.map(loadById).forEach(L => { L.invoice.batchId = null; L.invoice.status = 'PENDING'; }); db.invBatches.splice(db.invBatches.indexOf(b), 1); }, after: () => { location.hash = '#/accounting/invoices/batches'; } }); };
  ACTS['batch-remove-loads'] = t => { const b = batchById(t.dataset.id); const ids = [...RL.TS['batch-view'].sel].map(Number); confirmDialog({ title: 'Remove loads', message: `Remove ${ids.length} selected ${ids.length > 1 ? 'invoices' : 'invoice'} from ${IB(b.id)}?`, yes: 'Remove', no: 'Cancel', danger: true, name: 'remove-batch-loads', data: { batch: IB(b.id), loads: ids }, apply: () => { b.loadIds = b.loadIds.filter(x => !ids.includes(x)); ids.map(loadById).forEach(L => { L.invoice.batchId = null; L.invoice.status = 'PENDING'; }); RL.TS['batch-view'].sel.clear(); } }); };
  ACTS['batch-add-load'] = t => {
    const b = batchById(t.dataset.id); const list = eligible(b.mcId);
    const d = openModal({ title: `Add load to ${IB(b.id)}`, kind: 'native', size: 'wide', body: list.length ? `<table class="t" aria-label="Loads to add"><thead><tr><th class="cb" scope="col"><span class="sr-only">Select</span></th><th scope="col">Shipment ID</th><th scope="col">Customer</th><th scope="col">Delivery</th><th scope="col" class="num">Amount</th></tr></thead><tbody>${list.map(L => `<tr><td class="cb"><input type="checkbox" name="add" value="${L.id}" aria-label="Add ${L.sid}"></td><td>${L.sid}</td><td>${esc(cust(L.customerId).name)}</td><td>${fmtDate(L.deliveredAt)}</td><td class="num">${money(totalPay(L))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No delivered loads without a batch for this MC number.</p>',
      footer: `<button type="button" class="btn" data-act="dlg-close">Cancel</button><button type="submit" class="btn purple" ${list.length ? '' : 'disabled'}>Add to batch</button>` });
    d.form.addEventListener('submit', async e => { e.preventDefault(); const ids = H.$$('[name=add]:checked', d.el).map(x => +x.value); if (!ids.length) { toast('Select at least one load', 'error'); return; } if (await commit(d.form.querySelector('[type=submit]'), 'batch-add-load', { batch: IB(b.id), loads: ids }, () => { b.loadIds.push(...ids); ids.map(loadById).forEach(L => { L.invoice.batchId = b.id; L.invoice.status = b.status === 'UNPOSTED' ? 'UNPOSTED' : 'POSTED'; if (!L.invoice.createdAt) L.invoice.createdAt = nowIso(); }); if (b.status !== 'UNPOSTED') b.status = 'UNPOSTED'; })) { d.close(); RL.rerender(); } });
  };
  ACTS['batch-pdf'] = t => {
    const b = batchById(t.dataset.id); const loads = b.loadIds.map(loadById).filter(Boolean);
    openModal({ title: `${IB(b.id)}.pdf`, sub: 'Combined PDF: invoice, rate confirmation and proof of delivery for every load', kind: 'native', size: 'wide', body: loads.map(L => `<div class="pdf" style="margin-bottom:10px"><div class="row"><b>INVOICE ${L.sid}</b><span class="grow"></span><span>${esc(cust(L.customerId).name)}</span></div><div class="band">Load ${esc(L.loadId)}</div><div>${esc(place(firstStop(L)))} → ${esc(place(lastStop(L)))} · ${num(L.miles.total)} miles · <b>${money(totalPay(L))}</b></div><div class="muted" style="margin-top:6px">Attached: ${L.docs.map(d => esc(d.type)).join(', ') || 'none'}</div></div>`).join(''),
      footer: `<button type="button" class="btn" data-act="dlg-close">Close</button><button type="button" class="btn purple" data-act="print">${ic('printer')}Print</button>` });
  };

  // invoices list
  const invRows = () => db.loads.filter(L => !L.deleted && (L.invoice.createdAt || L.invoice.batchId));
  const invStatus = L => L.invoice.factored ? 'FACTORED' : L.invoice.status;
  RL.route('/accounting/invoices/invoices', () => ({
    crumbs: ['Accounting', 'Invoices', 'Invoices'],
    html: wrap(acctTabs(0), `${invChips(1)}<span class="grow"></span><a class="btn primary" href="#/accounting/invoices/batches/create-batch">Create new batch</a>`,
      RL.table({ id: 'invoices', label: 'Invoices', rowName: L => 'invoice ' + L.sid, rowMenu: 'invoiceRow',
        columns: [{ key: 'sid', label: 'Invoice Id', text: L => L.sid }, { key: 'customer', label: 'Customer', text: L => cust(L.customerId).name }, { key: 'loadId', label: 'Load Id', text: L => L.loadId, render: L => `<a href="${loadUrl(L)}">${esc(L.loadId)}</a>` }, { key: 'amount', label: 'Amount', num: true, text: totalPay, render: L => money(totalPay(L)) }, { key: 'date', label: 'Invoice date', text: L => fmtDate(L.invoice.createdAt), sortVal: L => L.invoice.createdAt }, { key: 'days', label: 'Days outstanding', num: true, text: L => L.invoice.paidAt ? 0 : Math.max(0, daysBetween((L.invoice.createdAt || todayStr).slice(0, 10), todayStr)) }, { key: 'batch', label: 'Batch', text: L => L.invoice.batchId ? IB(L.invoice.batchId) : '-', render: L => L.invoice.batchId ? `<a href="#/accounting/invoices/batches/view-batch/${L.invoice.batchId}">${IB(L.invoice.batchId)}</a>` : '-' }, { key: 'billing', label: 'Billing type', text: L => L.invoice.billingType }, { key: 'status', label: 'Status', text: invStatus, render: L => pill(invStatus(L), stCls(invStatus(L))) }],
        rows: () => invRows().sort((a, b) => (b.invoice.createdAt || '').localeCompare(a.invoice.createdAt || '')), totals: rows => `<span>Total amount: <b>${money(rows.reduce((a, L) => a + totalPay(L), 0))}</b></span>` })),
  }));
  MENUS.invoiceRow = t => { const L = loadById(t.dataset.id); return menu(`Invoice ${L.sid}`, [mi('View invoice', 'invoice-view', `data-id="${L.id}"`), ml('Open load', loadUrl(L)), mi('Send to factoring', 'factor-one', `data-id="${L.id}" ${L.invoice.factored || L.invoice.billingType !== 'FACTORING COMPANY' ? 'aria-disabled="true"' : ''}`)]); };
  ACTS['invoice-view'] = t => { RL.closeFloating(); RL.invoicePreview(loadById(t.dataset.id)); };

  // aging report
  RL.route('/accounting/invoices/aging-report', () => {
    const open = db.loads.filter(L => !L.deleted && L.status === 'invoiced');
    const rows = db.customers.map(c => { const ls = open.filter(L => L.customerId === c.id); const b = [0, 0, 0, 0]; ls.forEach(L => { const d = daysBetween((L.invoice.createdAt || todayStr).slice(0, 10), todayStr); b[d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3] += totalPay(L); }); return { id: c.id, c, b, total: b.reduce((x, y) => x + y, 0), n: ls.length }; }).filter(r => r.n);
    return { crumbs: ['Accounting', 'Invoices', 'Aging report'], html: wrap(acctTabs(0), `${invChips(2)}<span class="grow"></span>`, RL.table({ id: 'aging', label: 'Aging report', select: false, columns: [{ key: 'name', label: 'Customer', text: r => r.c.name }, { key: 'n', label: 'Open invoices', num: true, text: r => r.n }, { key: 'b0', label: 'Current (0-30)', num: true, text: r => r.b[0], render: r => money(r.b[0]) }, { key: 'b1', label: '31-60 days', num: true, text: r => r.b[1], render: r => money(r.b[1]) }, { key: 'b2', label: '61-90 days', num: true, text: r => r.b[2], render: r => money(r.b[2]) }, { key: 'b3', label: '90+ days', num: true, text: r => r.b[3], render: r => money(r.b[3]) }, { key: 'total', label: 'Total', num: true, text: r => r.total, render: r => `<b>${money(r.total)}</b>` }], rows: () => rows, totals: rs => `<span>Total open: <b>${money(rs.reduce((a, r) => a + r.total, 0))}</b></span>` })) };
  });
  RL.route('/accounting/invoices/invoice-reports', () => {
    const months = {}; invRows().forEach(L => { const k = (L.invoice.createdAt || '').slice(0, 7); if (!k) return; months[k] = months[k] || { k, n: 0, amount: 0, paid: 0 }; months[k].n++; months[k].amount += totalPay(L); if (L.status === 'paid') months[k].paid += totalPay(L); });
    const rows = Object.values(months).sort((a, b) => b.k.localeCompare(a.k));
    const max = Math.max(1, ...rows.map(r => r.amount));
    return { crumbs: ['Accounting', 'Invoices', 'Invoice reports'], html: wrap(acctTabs(0), `${invChips(3)}<span class="grow"></span>`, `<div class="chart-card" style="margin-bottom:12px"><h3>Invoiced by month</h3><svg viewBox="0 0 700 180" role="img" aria-label="Invoiced amount by month">${rows.slice().reverse().map((r, i) => `<g><rect x="${30 + i * 120}" y="${150 - (r.amount / max) * 130}" width="70" height="${(r.amount / max) * 130}" fill="#8e6cf0"><title>${r.k}: ${money(r.amount)}</title></rect><text x="${65 + i * 120}" y="168" text-anchor="middle">${r.k}</text></g>`).join('')}</svg></div>` + RL.table({ id: 'inv-reports', label: 'Invoice reports', select: false, columns: [{ key: 'k', label: 'Month', text: r => r.k }, { key: 'n', label: 'Invoices', num: true, text: r => r.n }, { key: 'amount', label: 'Invoiced', num: true, text: r => r.amount, render: r => money(r.amount) }, { key: 'paid', label: 'Paid', num: true, text: r => r.paid, render: r => money(r.paid) }, { key: 'open', label: 'Open', num: true, text: r => r.amount - r.paid, render: r => money(r.amount - r.paid) }], rows: () => rows })) };
  });

  // factoring (inferred from tutorial titles "How to Send Invoices to Factoring Companies", "How to Change Remit Notice on Invoice Files")
  const factorable = () => db.loads.filter(L => !L.deleted && L.invoice.billingType === 'FACTORING COMPANY' && !L.invoice.factored && ['invoiced', 'delivered'].includes(L.status) && (L.invoice.createdAt || L.invoice.batchId));
  RL.route('/accounting/invoices/factoring', () => ({
    crumbs: ['Accounting', 'Invoices', 'Factoring'],
    html: wrap(acctTabs(0), `${invChips(4)}<span class="grow"></span><a class="btn" href="#/settings/factoring">${ic('edit')}Change remit notice</a><button type="button" class="btn primary" data-act="factor-send" data-needs-sel="factoring" aria-haspopup="dialog">${ic('send')}Send to factoring</button>`,
      `<h2 style="margin:4px 0 8px">Invoices ready for factoring</h2>` + RL.table({ id: 'factoring', label: 'Invoices ready for factoring', rowName: L => 'invoice ' + L.sid, columns: [{ key: 'sid', label: 'Invoice Id', text: L => L.sid }, { key: 'customer', label: 'Customer', text: L => cust(L.customerId).name }, { key: 'loadId', label: 'Load Id', text: L => L.loadId, render: L => `<a href="${loadUrl(L)}">${esc(L.loadId)}</a>` }, { key: 'amount', label: 'Amount', num: true, text: totalPay, render: L => money(totalPay(L)) }, { key: 'date', label: 'Invoice date', text: L => fmtDate(L.invoice.createdAt) }, { key: 'docs', label: 'Documents', text: L => L.docs.map(d => d.type).join(', ') || '-' }, { key: 'pod', label: 'Proof of Delivery', text: L => RL.hasPod(L) ? 'Yes' : 'Missing', render: L => RL.hasPod(L) ? `<span class="green">${ic('check')}</span>` : '<span class="red">Missing</span>' }], rows: () => factorable(), totals: rows => `<span>Total: <b>${money(rows.reduce((a, L) => a + totalPay(L), 0))}</b></span>` })
      + `<h2 style="margin:16px 0 8px">Schedules</h2>` + RL.table({ id: 'schedules', label: 'Factoring schedules', select: false, columns: [{ key: 'id', label: 'Schedule #', text: s => 'SCH-' + s.id }, { key: 'co', label: 'Factoring company', text: s => (byId(db.factoringCos, s.companyId) || {}).name }, { key: 'n', label: 'Invoices', num: true, text: s => s.loadIds.length }, { key: 'amount', label: 'Amount', num: true, text: s => s.amount, render: s => money(s.amount) }, { key: 'sent', label: 'Sent', text: s => fmtDT(s.sentAt), sortVal: s => s.sentAt }, { key: 'docs', label: 'Attached', text: s => s.docs.join(', ') }, { key: 'status', label: 'Status', text: s => s.status, render: s => pill(s.status, stCls(s.status)) }], rows: () => db.factoringSchedules.slice().sort((a, b) => b.id - a.id) })),
  }));
  function factorDialog(ids) {
    const loads = ids.map(loadById).filter(Boolean); const def = db.factoringCos.find(c => c.default) || db.factoringCos[0];
    const d = formDialog({ title: 'Send to factoring', sub: `${loads.length} ${loads.length > 1 ? 'invoices' : 'invoice'} · ${money(loads.reduce((a, L) => a + totalPay(L), 0))}`, submit: 'Send to factoring', name: 'send-to-factoring', size: 'wide',
      body: `<div class="grid2">${field({ name: 'companyId', label: 'Factoring company', type: 'select', required: true, options: db.factoringCos.map(c => [c.id, `${c.name} (${c.fee}%)`]), value: def.id, placeholder: false })}${field({ name: 'email', label: 'Send to email', type: 'email', required: true, value: def.email })}${field({ name: 'schedule', label: 'Schedule number', value: 'SCH-' + (Math.max(4400, ...db.factoringSchedules.map(s => s.id)) + 1), readonly: true })}${field({ name: 'note', label: 'Note' })}</div>
        <fieldset style="border:0;padding:0"><legend class="sm b">Attach documents</legend><div class="grid4">${['Invoice', 'Rate confirmation', 'Proof of Delivery', 'Bill of lading'].map((x, i) => field({ name: 'doc_' + i, label: x, type: 'checkbox', value: i < 3 })).join('')}</div></fieldset>
        <div class="card card-pad" style="background:var(--th)"><b class="sm">Remit notice on the invoice files</b><p class="sm" id="remit-text" style="margin:4px 0 0">${esc(def.remit)}</p></div>`,
      build: p => ({ invoices: loads.map(L => L.sid), companyId: +p.companyId, company: byId(db.factoringCos, p.companyId).name, email: p.email, schedule: p.schedule, documents: ['Invoice', 'Rate confirmation', 'Proof of Delivery', 'Bill of lading'].filter((_, i) => p['doc_' + i]) }),
      apply: p => { const id = +p.schedule.replace(/\D/g, ''); db.factoringSchedules.push({ id, companyId: p.companyId, loadIds: loads.map(L => L.id), sentAt: nowIso(), status: 'SENT', amount: loads.reduce((a, L) => a + totalPay(L), 0), docs: p.documents }); loads.forEach(L => { L.invoice.factored = true; L.invoice.scheduleId = id; ev(L, `sent invoice to factoring (${p.company}, ${p.schedule})`); }); if (RL.TS.factoring) RL.TS.factoring.sel.clear(); } });
    d.form.addEventListener('change', e => { if (e.target.name === 'companyId') { const c = byId(db.factoringCos, e.target.value); d.form.email.value = c.email; H.$('#remit-text', d.el).textContent = c.remit; } });
  }
  ACTS['factor-send'] = () => factorDialog([...RL.TS.factoring.sel].map(Number));
  ACTS['factor-one'] = t => { RL.closeFloating(); factorDialog([+t.dataset.id]); };

  // ======================= salary =======================
  const sbById = id => db.salBatches.find(b => b.id === +id);
  const tripById = id => { for (const L of db.loads) { const t = L.trips.find(x => x.id === id); if (t) return { L, t }; } return null; };
  const itemsSum = (st, kind) => r2(st.items.filter(i => i.kind === kind).reduce((a, i) => a + (+i.qty || 1) * (+i.rate || 0), 0));
  function stCalc(st) {
    const trips = st.tripIds.map(tripById).filter(Boolean);
    const pay = r2(trips.reduce((a, x) => a + x.t.driverPay, 0)), gross = r2(trips.reduce((a, x) => a + x.L.loadPay, 0));
    const adv = itemsSum(st, 'advance'), exp = itemsSum(st, 'expense'), ded = itemsSum(st, 'deduction'), oth = itemsSum(st, 'other'), bal = itemsSum(st, 'balance');
    return { trips, pay, gross, adv, exp, ded, oth, bal, net: r2(pay - adv - exp - ded - bal + oth) };
  }
  RL.stCalc = stCalc;
  const sbStatus = b => b.settlements.length && b.settlements.every(s => s.status === 'PAID') ? 'PAID' : b.settlements.some(s => s.status === 'UNPOSTED') ? 'UNPOSTED' : 'POSTED';
  RL.route('/accounting/salary/driver-settlements', () => ({
    crumbs: ['Accounting', 'Salary', 'Batches'],
    html: wrap(acctTabs(1), `${salChips(0)}<span class="grow"></span><a class="btn primary" href="#/accounting/salary/driver-settlements/create-batch">Create new batch</a><button type="button" class="icon-btn" data-act="menu" data-menu="salaryMore" aria-haspopup="menu" aria-expanded="false" aria-label="More salary actions">${ic('more')}</button>`,
      RL.table({ id: 'salary-batches', label: 'Salary batches', rowName: b => SB(b.id), dbl: 'openSb', toolbarRight: RL.stdRight({ id: 'salary-batches' }).replace(/<button[^>]*data-act="(save-view|density)"[\s\S]*?<\/button>/g, ''),
        columns: [{ key: 'id', label: 'Batch ID', text: b => SB(b.id), render: b => `<a href="#/accounting/salary/driver-settlements/batch-view/${b.id}">${SB(b.id)}</a>`, sortVal: b => b.id }, { key: 'status', label: 'Status', text: sbStatus, render: b => pill(sbStatus(b), stCls(sbStatus(b))) }, { key: 'mc', label: 'MC number', text: b => mcOf(b.mcId).name }, { key: 'period', label: 'Period', text: b => `${fmtMDY(b.from)}-${fmtMDY(b.to)}`, sortVal: b => b.from }, { key: 'st', label: 'Settlements', num: true, text: b => b.settlements.length }, { key: 'trips', label: 'Trips', num: true, text: b => b.settlements.reduce((a, s) => a + s.tripIds.length, 0) }, { key: 'net', label: 'Net pay', num: true, text: b => b.settlements.reduce((a, s) => a + stCalc(s).net, 0), render: b => money(b.settlements.reduce((a, s) => a + stCalc(s).net, 0)) }, { key: 'by', label: 'Created by', text: b => b.createdBy }, { key: 'date', label: 'Created date', text: b => fmtDate(b.createdAt), sortVal: b => b.createdAt }, { key: 'check', label: 'Check date', text: b => fmtMDY(b.checkDate) }],
        rows: () => db.salBatches.slice().sort((a, b) => b.id - a.id) })),
  }));
  DBL.openSb = id => { location.hash = `#/accounting/salary/driver-settlements/batch-view/${id}`; };
  MENUS.salaryMore = () => menu('Salary', [ml('Create new batch', '#/accounting/salary/driver-settlements/create-batch'), mi('Recalculate driver payment tariff', 'recalc-tariff', 'data-id="11"'), ml('Deductions', '#/accounting/salary/deductions'), ml('Driver statements', '#/accounting/salary/driver-statements')]);

  // create salary batch
  const SC = { mc: 1, from: RL.dayOff(-6).slice(0, 10), to: todayStr, time: 'Delivery time', open: { avail: true, not: true, range: true, transit: true, batch: false }, sel: new Set() };
  function salaryGroups() {
    const rows = [];
    db.loads.filter(L => !L.deleted && (!SC.mc || L.mcId === +SC.mc)).forEach(L => L.trips.forEach(t => { if (t.driverId) rows.push({ L, t }); }));
    const dateOf = r => (SC.time === 'Delivery time' ? (r.L.deliveredAt || lastStop(r.L).from) : firstStop(r.L).from).slice(0, 10);
    const inRange = r => { const d = dateOf(r); return d >= SC.from && d <= SC.to; };
    const done = r => ['delivered', 'invoiced', 'paid'].includes(r.L.status);
    const g = { avail: [], range: [], transit: [], batch: [] };
    rows.forEach(r => { if (r.t.salaryBatchId) g.batch.push(r); else if (!done(r)) { if (['in_transit', 'dispatched'].includes(r.L.status)) g.transit.push(r); } else if (inRange(r)) g.avail.push(r); else g.range.push(r); });
    Object.values(g).forEach(a => a.sort((x, y) => dateOf(y).localeCompare(dateOf(x))));
    g.batch = g.batch.slice(0, 60);
    return g;
  }
  function salaryRow(r, selectable) {
    const L = r.L, t = r.t, d = drv(t.driverId);
    return `<tr${selectable && SC.sel.has(t.id) ? ' class="sel"' : ''}><td class="cb">${selectable ? `<input type="checkbox" data-change="sc-sel" data-k="${t.id}" aria-label="Select trip ${t.id}" ${SC.sel.has(t.id) ? 'checked' : ''}>` : ''}</td><td>${t.id}</td><td>${esc(dname(d))}</td><td>${esc(L.loadId)}</td><td>${stPill(L.status)}</td><td class="num">${num(L.loadPay)}</td><td>${fmtMDY(firstStop(L).from)}</td><td>${fmtMDY(L.deliveredAt || lastStop(L).from)}</td><td>${fmtMDY(lastStop(L).from)}</td><td class="num">${money(t.driverPay)}</td><td>${t.salaryBatchId ? `<a href="#/accounting/salary/driver-settlements/batch-view/${t.salaryBatchId}">${SB(t.salaryBatchId)}</a>` : '<span class="red">Pending</span>'}</td><td>${esc(t.note || '')}</td></tr>`;
  }
  function salaryCreatePage() {
    const g = salaryGroups();
    SC.sel = new Set([...SC.sel].filter(id => g.avail.some(r => r.t.id === id)));
    const grp = (key, label, n, lvl = 1) => `<tr class="group${lvl === 2 ? ' lvl2' : ''}"><td colspan="12"><button type="button" data-act="sc-group" data-k="${key}" aria-expanded="${SC.open[key]}">${ic(SC.open[key] ? 'down' : 'right')}${esc(label)} <span class="muted">(${n})</span></button></td></tr>`;
    const allAvail = g.avail.length && g.avail.every(r => SC.sel.has(r.t.id));
    const head = ['ID', 'Payee', 'Load id', 'Status', 'Load pay', 'Pickup date', 'Delivery date', 'Appointed time', 'Pay', 'Batch number', 'Driver note'];
    const notCount = g.range.length + g.transit.length + g.batch.length;
    return {
      crumbs: ['Accounting', 'Salary', 'Batches', 'Create a new batch'],
      html: wrap(acctTabs(1), `<a class="icon-btn" href="#/accounting/salary/driver-settlements" aria-label="Back to salary batches">${ic('left')}</a>${salChips(0)}<span class="grow"></span><button type="button" class="btn primary" data-act="sc-add" ${SC.sel.size ? '' : 'disabled'}>Add trips</button>`,
        `<div class="card card-pad" style="margin-bottom:10px"><div class="grid4" role="group" aria-label="Batch period">${field({ name: 'mc', label: 'MC number', type: 'select', options: RL.selOptions.mcs(), value: SC.mc, placeholder: 'All MC numbers', id: 'sc-mc' }).replace('<select', '<select data-change="sc-f" data-k="mc"')}${field({ name: 'from', label: 'Date from', type: 'date', value: SC.from, id: 'sc-from' }).replace('<input', '<input data-change="sc-f" data-k="from"')}${field({ name: 'to', label: 'Date to', type: 'date', value: SC.to, id: 'sc-to' }).replace('<input', '<input data-change="sc-f" data-k="to"')}${field({ name: 'time', label: 'Time', type: 'select', options: ['Delivery time', 'Pickup time'], value: SC.time, placeholder: false, id: 'sc-time' }).replace('<select', '<select data-change="sc-f" data-k="time"')}</div></div>
        <section class="tbl-wrap" aria-label="Trips for the salary batch"><div class="toolbar"><span class="muted sm">Selected trips: <b>${SC.sel.size}</b> · Pay ${money([...SC.sel].reduce((a, id) => a + (tripById(id) || { t: { driverPay: 0 } }).t.driverPay, 0))}</span></div><div class="tscroll"><table class="t" aria-label="Trips"><thead><tr><th class="cb" scope="col"><input type="checkbox" data-change="sc-all" aria-label="Select all available trips" ${allAvail ? 'checked' : ''}></th>${head.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>
        ${grp('avail', 'Available trips', g.avail.length)}${SC.open.avail ? g.avail.map(r => salaryRow(r, true)).join('') || '<tr><td colspan="12" class="muted" style="padding-left:40px">No trips delivered in this period</td></tr>' : ''}
        ${grp('not', 'Not available trips', notCount)}${SC.open.not ? grp('range', 'Not in date range', g.range.length, 2) + (SC.open.range ? g.range.slice(0, 40).map(r => salaryRow(r, false)).join('') : '') + grp('transit', 'Not in date range InTransit Load', g.transit.length, 2) + (SC.open.transit ? g.transit.map(r => salaryRow(r, false)).join('') : '') + grp('batch', 'Already in batch', g.batch.length, 2) + (SC.open.batch ? g.batch.map(r => salaryRow(r, false)).join('') : '') : ''}
        </tbody></table></div><div class="tfoot"><span class="muted">Showing ${g.avail.length + notCount} trips</span></div></section>`),
    };
  }
  RL.route('/accounting/salary/driver-settlements/create-batch', salaryCreatePage);
  CHANGES['sc-f'] = t => { SC[t.dataset.k] = t.value; RL.rerender(); };
  CHANGES['sc-sel'] = t => { if (t.checked) SC.sel.add(t.dataset.k); else SC.sel.delete(t.dataset.k); RL.rerender(); };
  CHANGES['sc-all'] = t => { const g = salaryGroups(); g.avail.forEach(r => { if (t.checked) SC.sel.add(r.t.id); else SC.sel.delete(r.t.id); }); RL.rerender(); };
  ACTS['sc-group'] = t => { SC.open[t.dataset.k] = !SC.open[t.dataset.k]; RL.rerender(); };
  function scheduledFor(driverId, from, to) {
    // Weekly deductions once per batch; monthly ones when their day of month falls in the period.
    return db.schedDeductions.filter(s => s.driverId === driverId && s.status === 'ACTIVE' && s.startDate.slice(0, 10) <= to && (!s.endDate || s.endDate.slice(0, 10) >= from)).filter(s => {
      if (s.frequency === 'Weekly') return true;
      if (s.frequency === 'Monthly') { for (let d = new Date(from + 'T00:00'); d <= new Date(to + 'T00:00'); d.setDate(d.getDate() + 1)) if (d.getDate() === +s.day) return true; return false; }
      return false;
    });
  }
  ACTS['sc-add'] = async t => {
    const picked = [...SC.sel].map(tripById).filter(Boolean); if (!picked.length) return;
    const id = Math.max(...db.salBatches.map(b => b.id)) + 1;
    if (await commit(t, 'create-salary-batch', { batch: SB(id), trips: picked.map(x => x.t.id), from: SC.from, to: SC.to, time: SC.time }, () => {
      const at = nowIso(); const b = { id, mcId: +SC.mc || 1, from: SC.from, to: SC.to, timeType: SC.time, createdBy: ME, createdAt: at, payBy: mcOf(+SC.mc || 1).name, checkDate: RL.dayOff(3).slice(0, 10), description: '', settlements: [], events: [{ at, text: `${ME} created batch` }] };
      const byD = new Map(); picked.forEach(x => { if (!byD.has(x.t.driverId)) byD.set(x.t.driverId, []); byD.get(x.t.driverId).push(x); });
      byD.forEach((list, driverId) => {
        const st = { id: 'ST-' + String(++db.seq.stSeq).padStart(6, '0'), driverId, tripIds: list.map(x => x.t.id), status: 'UNPOSTED', emailSent: false, items: [] };
        scheduledFor(driverId, SC.from, SC.to).forEach(s => st.items.push({ kind: 'deduction', typeId: s.typeId, description: s.description, qty: 1, rate: s.amount, scheduledId: s.id }));
        (db.oneTimeCharges || []).filter(x => x.driverId === driverId && x.status === 'PENDING').forEach(x => { st.items.push(['Reimbursement', 'Bonus'].includes(x.type) ? { kind: 'other', otherType: x.type === 'Bonus' ? 'Bonus' : 'Reimbursements', description: x.note, qty: x.qty, rate: x.amount } : { kind: 'deduction', description: `${x.type}: ${x.note}`, qty: x.qty, rate: x.amount }); x.status = 'APPLIED'; x.settlementId = st.id; });
        (db.driverBalances || []).filter(x => x.driverId === driverId && x.type === 'ESCROW' && x.credit - x.debit < x.target).forEach(x => { st.items.push({ kind: 'balance', balType: 'ESCROW', description: `Recurrent #${x.txns + 1}, Total-${money(x.credit + 250)}, ${x.note}`, qty: 1, rate: 250 }); x.credit += 250; x.txns++; });
        db.cashAdvances.filter(a => a.driverId === driverId && a.status === 'PENDING').forEach(a => { st.items.push({ kind: 'advance', description: `Cash advance ${fmtMDY(a.date)}`, qty: 1, rate: a.amount, advanceId: a.id }); a.status = 'DEDUCTED'; a.settlementId = st.id; });
        const d = drv(driverId);
        if (d && d.type !== 'Company driver') {
          db.fuelTx.filter(x => x.driverId === driverId && !x.settlementId && x.date.slice(0, 10) >= SC.from && x.date.slice(0, 10) <= SC.to).forEach(x => { st.items.push({ kind: 'expense', description: `Fuel ${x.product} ${fmtMDY(x.date)}`, qty: 1, rate: x.net, fuelId: x.id }); x.settlementId = st.id; });
          db.tollTx.filter(x => x.driverId === driverId && !x.settlementId && x.date.slice(0, 10) >= SC.from && x.date.slice(0, 10) <= SC.to).forEach(x => { st.items.push({ kind: 'expense', description: `Toll ${x.agency} ${fmtMDY(x.date)}`, qty: 1, rate: x.amount, tollId: x.id }); x.settlementId = st.id; });
        }
        list.forEach(x => { x.t.salaryBatchId = id; x.t.settlementId = st.id; x.t.billing = 'IN BATCH'; });
        b.settlements.push(st);
      });
      db.salBatches.unshift(b); SC.sel.clear();
    })) location.hash = `#/accounting/salary/driver-settlements/batch-view/${id}`;
  };

  // salary batch view
  const SV = { id: null, chip: 'all' };
  const stById = (b, id) => b.settlements.find(s => s.id === id);
  RL.route('/accounting/salary/driver-settlements/batch-view/:id', p => {
    const b = sbById(p.id); if (!b) return null;
    if (SV.id !== b.id) { SV.id = b.id; SV.chip = 'all'; if (RL.TS['sb-view']) RL.TS['sb-view'].sel.clear(); }
    const sel = () => (RL.TS['sb-view'] ? [...RL.TS['sb-view'].sel] : []).map(id => stById(b, id)).filter(Boolean);
    const s = sel();
    const totals = b.settlements.map(stCalc).reduce((a, c) => ({ pay: a.pay + c.pay, adv: a.adv + c.adv, exp: a.exp + c.exp, oth: a.oth + c.oth, ded: a.ded + c.ded, net: a.net + c.net, trips: a.trips + c.trips.length }), { pay: 0, adv: 0, exp: 0, oth: 0, ded: 0, net: 0, trips: 0 });
    const pr = (k, v) => `<div class="pr"><span>${esc(k)}:</span><span>${v}</span></div>`;
    const chips = [['all', 'All'], ['paid', 'Paid'], ['posted', 'Posted'], ['unposted', 'Unposted']];
    return {
      crumbs: ['Accounting', ['Salary', '#/accounting/salary/driver-settlements'], ['Batches', '#/accounting/salary/driver-settlements'], SB(b.id)],
      html: wrap(acctTabs(1), `<a class="icon-btn" href="#/accounting/salary/driver-settlements" aria-label="Back to salary batches">${ic('left')}</a>${salChips(0)}<span class="grow"></span>
        <button type="button" class="btn soft" data-act="sb-send" data-id="${b.id}" aria-haspopup="dialog" id="sb-send" disabled>${ic('send')}Send to driver</button><button type="button" class="btn" data-act="sb-post" data-id="${b.id}" id="sb-post" disabled>Post</button>
        <button type="button" class="btn outline" data-act="sb-add-driver" data-id="${b.id}" aria-haspopup="dialog" id="sb-add-driver">Add driver</button><button type="button" class="btn outline" data-act="sb-add-settlement" data-id="${b.id}" aria-haspopup="dialog" id="sb-add-settlement">Add settlement</button>
        <button type="button" class="btn outline" data-act="sb-add-deduction" data-id="${b.id}" aria-haspopup="dialog" id="sb-add-deduction" disabled>Add deduction</button><button type="button" class="btn soft" data-act="sb-pdf" data-id="${b.id}" aria-haspopup="dialog" id="sb-pdf" disabled>${ic('download')}Export as PDF</button>
        <button type="button" class="icon-btn" data-act="menu" data-pop="sbHistory" data-id="${b.id}" aria-haspopup="dialog" aria-expanded="false" aria-label="Batch history">${ic('history')}</button><button type="button" class="icon-btn" data-act="sb-remove" data-id="${b.id}" id="sb-remove" disabled aria-label="Remove selected settlements">${ic('minus')}</button>
        <button type="button" class="icon-btn" data-act="menu" data-menu="sbMore" data-id="${b.id}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${SB(b.id)}">${ic('more')}</button>`,
        `<div class="with-side"><div>${RL.chipTabs('Settlement status', chips, SV.chip, 'sb-chip')}<div style="height:10px"></div>
          ${RL.table({ id: 'sb-view', label: `Settlements in ${SB(b.id)}`, key: st => st.id, rowName: st => `${st.id} ${dname(drv(st.driverId))}`, dbl: 'openSt', toolbarRight: RL.stdRight({ id: 'sb-view' }).replace(/<button[^>]*data-act="(save-view|density)"[\s\S]*?<\/button>/g, ''),
            columns: [{ key: 'id', label: 'ID', text: st => st.id, render: st => `<a href="#/accounting/salary/driver-settlements/batch-view/${b.id}/settlement/deduction/${+st.id.replace(/\D/g, '')}">${st.id}</a>` }, { key: 'payee', label: 'Payee', text: st => dname(drv(st.driverId)), render: st => `<a href="#/hr-management/edit-driver/${st.driverId}/detail">${esc(dname(drv(st.driverId)))}</a>` }, { key: 'status', label: 'Status', text: st => st.status, render: st => pill(st.status, stCls(st.status)) }, { key: 'trips', label: 'Trips', num: true, text: st => st.tripIds.length },
              { key: 'pay', label: 'Pay', num: true, text: st => stCalc(st).pay, render: st => money(stCalc(st).pay) }, { key: 'gross', label: 'Driver pay', num: true, text: st => stCalc(st).gross, render: st => money(stCalc(st).gross) }, { key: 'adv', label: 'Advances', num: true, text: st => stCalc(st).adv, render: st => money(stCalc(st).adv) }, { key: 'exp', label: 'Expenses', num: true, text: st => stCalc(st).exp, render: st => money(stCalc(st).exp) },
              { key: 'ded', label: 'Deductions', num: true, text: st => stCalc(st).ded, render: st => money(stCalc(st).ded) }, { key: 'oth', label: 'Other pay', num: true, text: st => stCalc(st).oth, render: st => money(stCalc(st).oth) }, { key: 'net', label: 'Net pay', num: true, text: st => stCalc(st).net, render: st => `<b>${money(stCalc(st).net)}</b>` },
              { key: 'email', label: 'Email sent', text: st => st.emailSent ? 'Yes' : 'No', render: st => st.emailSent ? `<span class="green" aria-label="Sent">${ic('check')}</span>` : `<span class="red" aria-label="Not sent">${ic('x')}</span>` }],
            rows: () => b.settlements.filter(st => SV.chip === 'all' || st.status.toLowerCase() === SV.chip) })}</div>
          <aside><section class="panel-box" aria-label="General"><h3>General <button type="button" class="icon-btn" style="width:22px;height:22px" data-act="sb-desc" data-id="${b.id}" aria-haspopup="dialog" aria-label="Edit batch">${ic('edit')}</button></h3>${pr('Created by', esc(b.createdBy))}${pr('Pay by', esc(b.payBy || mcOf(b.mcId).name))}${pr('Date', fmtMDY(b.createdAt))}</section>
          <section class="panel-box" aria-label="Totals"><h3>Totals</h3>${pr('Trip counts', totals.trips)}${pr('Settlements', b.settlements.length)}${pr('Unposted settlements', b.settlements.filter(x => x.status === 'UNPOSTED').length)}${pr('Posted settlements', b.settlements.filter(x => x.status !== 'UNPOSTED').length)}${pr('Period', `${fmtMDY(b.from)}-${fmtMDY(b.to)}`)}
            <div class="pr"><span>Check date:</span><span class="row">${fmtMDY(b.checkDate)}<button type="button" class="icon-btn" style="width:20px;height:20px;color:var(--brand)" data-act="menu" data-pop="checkDate" data-id="${b.id}" aria-haspopup="dialog" aria-expanded="false" aria-label="Edit check date">${ic('edit')}</button></span></div>
            ${pr('Pay', money(totals.pay))}${pr('Advances', `(${money(totals.adv)})`)}${pr('Expenses', money(totals.exp))}${pr('Other pay', money(totals.oth))}${pr('Deductions', `(${money(totals.ded)})`)}${pr('Net pay', `<b>${money(totals.net)}</b>`)}</section>
          <section class="panel-box" aria-label="Description"><h3>Description</h3><p style="margin:0">${esc(b.description || '-')}</p></section></aside></div>`),
      mount: () => syncSb(b),
    };
  });
  function syncSb(b) {
    if (!b) b = sbById(SV.id); if (!b) return;
    const s = (RL.TS['sb-view'] ? [...RL.TS['sb-view'].sel] : []).map(id => stById(b, id)).filter(Boolean);
    const set = (id, on) => { const el = document.getElementById(id); if (el) el.disabled = !on; };
    set('sb-send', s.length && s.every(x => x.status !== 'UNPOSTED')); set('sb-post', s.some(x => x.status === 'UNPOSTED')); set('sb-add-deduction', s.length > 0); set('sb-pdf', s.length > 0);
    set('sb-add-driver', !s.length); set('sb-add-settlement', !s.length || s.length === 1); set('sb-remove', s.length && s.every(x => x.status === 'UNPOSTED'));
  }
  RL.onSel = () => { if (SV.id && /batch-view/.test(location.hash)) syncSb(); };
  ACTS['sb-chip'] = t => { SV.chip = t.dataset.v; RL.rerender(); };
  DBL.openSt = id => { const b = sbById(SV.id); settlementPdf(b, [stById(b, id)]); };
  const selSt = b => [...RL.TS['sb-view'].sel].map(id => stById(b, id)).filter(Boolean);
  ACTS['sb-post'] = async t => { const b = sbById(t.dataset.id); const list = selSt(b).filter(s => s.status === 'UNPOSTED'); if (await commit(t, 'post-settlements', { batch: SB(b.id), settlements: list.map(s => s.id) }, () => { list.forEach(s => { s.status = 'POSTED'; s.tripIds.map(tripById).forEach(x => x && (x.t.billing = 'IN BATCH')); }); b.events.push({ at: nowIso(), text: `${ME} posted ${list.length} settlements` }); })) RL.rerender(); };
  ACTS['sb-send'] = t => {
    const b = sbById(t.dataset.id); const list = selSt(b);
    const d = openModal({ title: 'Send to Driver', sub: list.map(s => `${s.id} · ${dname(drv(s.driverId))}`).join(', '), kind: 'native', size: 'wide', body: `<div class="choice" role="radiogroup" aria-label="Send by">${[['email', 'Email'], ['manual', 'Manual update (Status only)'], ['app', 'Mobile app'], ['telegram', 'Telegram']].map(([v, l], i) => `<label><input type="radio" name="via" value="${v}" ${i === 0 ? 'checked' : ''}> ${l}</label>`).join('')}</div>${field({ name: 'message', label: 'Driver message', type: 'textarea', placeholder: 'Your settlement for this week is attached.' })}`,
      footer: `<button type="button" class="btn" data-act="dlg-close">Cancel</button><button type="submit" class="btn purple">Send to driver</button>` });
    d.form.addEventListener('submit', async e => { e.preventDefault(); const via = d.form.querySelector('[name=via]:checked').value; if (await commit(d.form.querySelector('[type=submit]'), 'send-to-driver', { batch: SB(b.id), settlements: list.map(s => s.id), via, message: d.form.message.value }, () => { list.forEach(s => { s.emailSent = true; s.sentVia = via; }); b.events.push({ at: nowIso(), text: `${ME} sent ${list.length} settlements to drivers by ${via}` }); })) { d.close(); RL.rerender(); } });
  };
  ACTS['sb-add-deduction'] = t => { const b = sbById(t.dataset.id); const list = selSt(b); formDialog({ title: 'Add deduction', sub: list.map(s => s.id).join(', '), submit: 'Add deduction', name: 'add-deduction', fields: [{ name: 'typeId', label: 'Deduction type', type: 'select', required: true, options: db.deductionTypes.map(x => [x.id, x.code]), placeholder: false }, { name: 'description', label: 'Description', value: db.deductionTypes[0].description }, { name: 'qty', label: 'Quantity', type: 'number', value: 1, step: '0.01', min: 0 }, { name: 'rate', label: 'Rate', type: 'money', required: true, value: db.deductionTypes[0].default }], build: p => ({ batch: SB(b.id), settlements: list.map(s => s.id), ...p }), apply: p => list.forEach(s => s.items.push({ kind: 'deduction', typeId: +p.typeId, description: p.description, qty: +p.qty || 1, rate: +p.rate })) }); const f = RL.topDialog().form; f.typeId.addEventListener('change', () => { const x = byId(db.deductionTypes, f.typeId.value); f.description.value = x.description; f.rate.value = x.default || ''; }); };
  ACTS['sb-add-settlement'] = t => { const b = sbById(t.dataset.id); const s0 = selSt(b)[0]; formDialog({ title: 'Add settlement', sub: 'Other pay, reimbursement, bonus, advance or expense on a driver settlement', submit: 'Add settlement', name: 'add-settlement', fields: [{ name: 'st', label: 'Settlement', type: 'select', required: true, options: b.settlements.map(s => [s.id, `${s.id} · ${dname(drv(s.driverId))}`]), value: s0 ? s0.id : '', placeholder: 'Select settlement' }, { name: 'kind', label: 'Type', type: 'select', required: true, options: [['other', 'Reimbursements'], ['other-bonus', 'Bonus'], ['advance', 'Advance'], ['expense', 'Expense']], value: 'other', placeholder: false }, { name: 'description', label: 'Description' }, { name: 'qty', label: 'Quantity', type: 'number', value: 1, min: 0, step: '0.01' }, { name: 'rate', label: 'Rate', type: 'money', required: true }], build: p => ({ batch: SB(b.id), ...p }), apply: p => { const s = stById(b, p.st); s.items.push({ kind: p.kind === 'other-bonus' ? 'other' : p.kind, description: p.description || (p.kind === 'other' ? 'Reimbursements' : p.kind === 'other-bonus' ? 'Bonus' : p.kind), qty: +p.qty || 1, rate: +p.rate }); } }); };
  ACTS['sb-add-driver'] = t => {
    const b = sbById(t.dataset.id); const inB = new Set(b.settlements.map(s => s.driverId));
    const cand = db.drivers.filter(d => d.employment === 'ACTIVE' && !inB.has(d.id));
    formDialog({ title: 'Add driver', sub: `${SB(b.id)} · ${fmtMDY(b.from)}-${fmtMDY(b.to)}`, submit: 'Add driver', name: 'add-driver-settlement', fields: [{ name: 'driverId', label: 'Driver', type: 'select', required: true, options: cand.map(d => [d.id, dname(d)]), cls: 'span2' }, { name: 'withTrips', label: "Include the driver's available trips in this period", type: 'checkbox', value: true, cls: 'span2' }],
      build: p => ({ batch: SB(b.id), ...p }),
      apply: p => { const driverId = +p.driverId; const st = { id: 'ST-' + String(++db.seq.stSeq).padStart(6, '0'), driverId, tripIds: [], status: 'UNPOSTED', emailSent: false, items: [] }; if (p.withTrips) db.loads.forEach(L => L.trips.forEach(x => { if (x.driverId === driverId && !x.salaryBatchId && ['delivered', 'invoiced', 'paid'].includes(L.status)) { const dd = (L.deliveredAt || '').slice(0, 10); if (dd >= b.from && dd <= b.to) { st.tripIds.push(x.id); x.salaryBatchId = b.id; x.settlementId = st.id; x.billing = 'IN BATCH'; } } })); scheduledFor(driverId, b.from, b.to).forEach(s => st.items.push({ kind: 'deduction', typeId: s.typeId, description: s.description, qty: 1, rate: s.amount })); b.settlements.push(st); } });
  };
  ACTS['sb-remove'] = t => { const b = sbById(t.dataset.id); const list = selSt(b); confirmDialog({ title: 'Remove settlements', message: `Remove ${list.map(s => s.id).join(', ')} from ${SB(b.id)}? Their trips become available again.`, yes: 'Remove', no: 'Cancel', danger: true, name: 'remove-settlements', data: { batch: SB(b.id), settlements: list.map(s => s.id) }, apply: () => { list.forEach(s => { s.tripIds.map(tripById).forEach(x => { if (x) { x.t.salaryBatchId = null; x.t.settlementId = null; x.t.billing = 'PENDING'; } }); b.settlements.splice(b.settlements.indexOf(s), 1); }); RL.TS['sb-view'].sel.clear(); } }); };
  ACTS['sb-pdf'] = t => { const b = sbById(t.dataset.id); settlementPdf(b, selSt(b)); };
  ACTS['sb-desc'] = t => { const b = sbById(t.dataset.id); formDialog({ title: `Edit ${SB(b.id)}`, submit: 'Save', name: 'save-salary-batch', fields: [{ name: 'payBy', label: 'Pay by', value: b.payBy || mcOf(b.mcId).name }, { name: 'date', label: 'Date', type: 'date', value: b.createdAt.slice(0, 10) }, { name: 'description', label: 'Description', type: 'textarea', value: b.description, cls: 'span2' }], build: p => ({ batch: SB(b.id), ...p }), apply: p => { b.payBy = p.payBy; b.description = p.description; if (p.date) b.createdAt = p.date + b.createdAt.slice(10); } }); };
  POPS.checkDate = t => { const b = sbById(t.dataset.id); return `<form class="popover" role="dialog" aria-label="Check date" data-submit="check-date" data-id="${b.id}"><div class="field"><label for="cd-${b.id}">Check date</label><input id="cd-${b.id}" type="date" name="date" required value="${b.checkDate}"></div><div class="pop-foot"><button type="button" class="btn sm" data-act="pop-close">Cancel</button><button type="submit" class="btn sm purple">Save</button></div></form>`; };
  SUBMITS['check-date'] = async f => { const b = sbById(f.dataset.id); if (!validate(f)) return; if (await commit(f.querySelector('[type=submit]'), 'set-check-date', { batch: SB(b.id), checkDate: f.date.value }, () => (b.checkDate = f.date.value))) { RL.closeFloating(); RL.rerender(); } };
  POPS.sbHistory = t => { const b = sbById(t.dataset.id); return `<div class="popover wide" role="dialog" aria-label="Batch history"><div class="pop-head"><h3>History</h3></div><ul class="notif">${[...b.events].reverse().map(e => `<li><span style="display:block;padding:6px">${esc(e.text)}<div class="muted xs">${fmtEvt(e.at)}</div></span></li>`).join('')}</ul></div>`; };
  MENUS.sbMore = t => { const b = sbById(t.dataset.id); const posted = b.settlements.some(s => s.status === 'POSTED'); return menu(`More actions for ${SB(b.id)}`, [mi('Mark posted settlements as paid', 'sb-paid', `data-id="${b.id}" ${posted ? '' : 'aria-disabled="true"'}`), mi('Recalculate driver payment tariff', 'recalc-tariff', `data-id="${(b.settlements[0] || {}).driverId || 1}"`), msep, mi('Delete batch', 'sb-delete', `data-id="${b.id}" ${b.settlements.every(s => s.status === 'UNPOSTED') ? '' : 'aria-disabled="true"'}`, 'danger')]); };
  ACTS['sb-paid'] = t => { const b = sbById(t.dataset.id); const list = b.settlements.filter(s => s.status === 'POSTED'); confirmDialog({ title: 'Mark as paid', message: `Mark ${list.length} posted settlements in ${SB(b.id)} as paid?`, yes: 'Mark as paid', no: 'Cancel', name: 'mark-settlements-paid', data: { batch: SB(b.id), settlements: list.map(s => s.id) }, apply: () => list.forEach(s => { s.status = 'PAID'; s.tripIds.map(tripById).forEach(x => x && (x.t.billing = 'PAID')); }) }); };
  ACTS['sb-delete'] = t => { const b = sbById(t.dataset.id); confirmDialog({ title: 'Delete batch', message: `Delete ${SB(b.id)}? Its trips become available for a new batch.`, yes: 'Delete', no: 'Cancel', danger: true, name: 'delete-salary-batch', data: { batch: SB(b.id) }, apply: () => { b.settlements.forEach(s => s.tripIds.map(tripById).forEach(x => { if (x) { x.t.salaryBatchId = null; x.t.settlementId = null; x.t.billing = 'PENDING'; } })); db.salBatches.splice(db.salBatches.indexOf(b), 1); }, after: () => { location.hash = '#/accounting/salary/driver-settlements'; } }); };
  const fuelTbl = st => { const xs = st.items.filter(i => i.fuelId).map(i => byId(db.fuelTx, i.fuelId)).filter(Boolean); if (!xs.length) return '';
    return `<div class="band">Fuel</div><table><tr><th>Type</th><th>Description</th><th>Product</th><th>City</th><th>State</th><th>Quantity</th><th>Fee</th><th>Misc amount</th><th>Total retail amount</th></tr>${xs.map(x => { const [, loc = ''] = x.location.split(', '); const st2 = x.location.split(', ').pop(); return `<tr><td>Fuel</td><td>${esc(x.description)} #${esc(x.location.split(',')[0])}</td><td>${x.product}</td><td>${esc(loc)}</td><td>${esc(st2)}</td><td>${num(x.qty)}</td><td>${money(x.fee)}</td><td>${money(x.misc || 0)}</td><td>${money(x.retail)}</td></tr>`; }).join('')}<tr class="tot"><td>Total:</td><td colspan="4"></td><td>${num(xs.reduce((a, x) => a + x.qty, 0))}</td><td>${money(xs.reduce((a, x) => a + x.fee, 0))}</td><td>$0.00</td><td>${money(xs.reduce((a, x) => a + x.retail, 0))}</td></tr></table>`; };
  const tollTbl = st => { const xs = st.items.filter(i => i.tollId).map(i => byId(db.tollTx, i.tollId)).filter(Boolean); if (!xs.length) return '';
    return `<div class="band">Toll</div><table><tr><th>Type</th><th>Date</th><th>Description</th><th>Exit Plaza</th><th>City</th><th>State</th><th>Total Amount</th></tr>${xs.map(x => `<tr><td>Toll</td><td>${fmtMDY(x.date)}</td><td>${esc(x.agency)} ${esc(x.transponder.slice(-5))}</td><td>${esc(x.exit)}</td><td></td><td></td><td>${money(x.amount)}</td></tr>`).join('')}<tr class="tot"><td>Total:</td><td colspan="5"></td><td>${money(xs.reduce((a, x) => a + x.amount, 0))}</td></tr></table>`; };
  const balancesTbl = st => { const bs = db.driverBalances.filter(x => x.driverId === st.driverId); const fuel = st.items.filter(i => i.fuelId).reduce((a, i) => a + i.rate, 0), toll = st.items.filter(i => i.tollId).reduce((a, i) => a + i.rate, 0);
    const rows = [...bs.map(x => [x.type === 'ESCROW' ? 'Escrow' : x.type, -(x.credit - x.debit)]), ['Fuel', fuel], ['Toll', toll]];
    return `<div class="band" style="width:50%">Balances</div><table style="width:50%"><tr><th>Description</th><th>Total amount</th></tr>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v < 0 ? '-' + money(-v) : money(v)}</td></tr>`).join('')}<tr class="tot"><td>Total:</td><td>${money(rows.reduce((a, r) => a + r[1], 0))}</td></tr></table>`; };
  function settlementPdf(b, list) {
    const cfg = db.config.statementSections;
    const one = st => {
      const c = stCalc(st), d = drv(st.driverId), t = trk(d.truckId), m = mcOf(b.mcId);
      const rows = kind => st.items.filter(i => i.kind === kind);
      const tbl = (title, items, neg) => items.length ? `<div class="band">${title}</div><table><tr><th>${title === 'Deductions' ? 'Deduction type' : title}</th><th>Description</th><th>Quantity</th><th>Rate</th><th>Total amount</th></tr>${items.map(i => `<tr><td>${esc(i.typeId ? (byId(db.deductionTypes, i.typeId) || {}).code : i.kind === 'other' ? 'Reimbursements' : i.kind)}</td><td>${esc(i.description || '')}</td><td>${(+i.qty || 1).toFixed(2)}</td><td>${money(i.rate)}</td><td>${neg ? `(${money((+i.qty || 1) * i.rate)})` : money((+i.qty || 1) * i.rate)}</td></tr>`).join('')}<tr class="tot"><td>Total:</td><td colspan="3"></td><td>${neg ? `(${money(items.reduce((a, i) => a + (+i.qty || 1) * i.rate, 0))})` : money(items.reduce((a, i) => a + (+i.qty || 1) * i.rate, 0))}</td></tr></table>` : '';
      return `<div class="pdf" style="margin-bottom:12px"><div class="row" style="align-items:flex-start">${cfg.logo ? `<span style="background:#6a2ee0;border-radius:6px;padding:6px;display:inline-flex">${RL.LOGO}</span>` : ''}<div class="grow" style="margin-left:10px"><b>${esc(m.company || m.name)}</b><div>${esc(m.address || '')}</div></div><div style="text-align:right">Period End: ${fmtMDY(b.to)}<br>Check Date: ${fmtMDY(b.checkDate)}</div></div>
        <div class="band">Driver Pay Settlement</div><div class="row"><b>Settlement ${st.id}</b><span class="muted">Batch ID: ${b.id}</span><span class="grow"></span>Driver: <b>${esc(dname(d))}</b><span class="muted">Unit Number: ${esc(t ? t.unit : '-')}</span></div>
        <div class="grid2" style="margin-top:8px"><table><tr><td>Earnings:</td><td>${money(c.pay)}</td></tr><tr><td>Advances:</td><td>${money(c.adv)}</td></tr><tr><td>Reimbursements:</td><td>${money(c.exp)}</td></tr><tr><td>Deductions:</td><td>(${money(c.ded)})</td></tr><tr><td>Other pay:</td><td>${money(c.oth)}</td></tr><tr class="tot"><td>Net Pay</td><td>${money(c.net)}</td></tr></table><div>Pay_to: <b>${esc(d.payTo || dname(d))}</b></div></div>
        ${cfg.earnings ? `<div class="band">Earnings</div><table><tr><th>Load number</th><th>PU</th><th>DEL</th><th>DEL date</th><th>Payment type</th>${cfg.miles ? '<th>Loaded miles</th><th>Empty miles</th>' : ''}<th>Total amount</th></tr>${c.trips.map(x => `<tr><td>${esc(x.L.loadId)}</td><td>${esc(place(firstStop(x.L)))}</td><td>${esc(place(lastStop(x.L)))}</td><td>${fmtMDY(x.L.deliveredAt)}</td><td>Linehaul</td>${cfg.miles ? `<td>${num(x.t.loadedMiles)}</td><td>${num(x.t.emptyMiles)}</td>` : ''}<td>${money(x.t.driverPay)}</td></tr>`).join('')}<tr class="tot"><td>Total:</td><td colspan="${cfg.miles ? 6 : 4}"></td><td>${money(c.pay)}</td></tr></table>` : ''}
        ${cfg.deductions ? tbl('Deductions', rows('deduction'), true) : ''}${tbl('Advances', rows('advance'), true)}${tbl('Expenses', rows('expense').filter(i => !i.fuelId && !i.tollId), true)}${cfg.fuel ? fuelTbl(st) : ''}${cfg.toll ? tollTbl(st) : ''}${cfg.otherPay ? tbl('Other pay', rows('other'), false) : ''}
        ${tbl('Driver balances', rows('balance'), true)}${cfg.balances ? balancesTbl(st) : ''}</div>`;
    };
    openModal({ title: list.length === 1 ? `${list[0].id}.pdf` : `${SB(b.id)} settlements.pdf`, kind: 'native', size: 'xl', body: list.map(one).join(''), footer: `<button type="button" class="btn" data-act="dlg-close">Close</button><button type="button" class="btn purple" data-act="print">${ic('printer')}Print</button>` });
  }
  RL.settlementPdf = settlementPdf;

  // driver statements (inferred from tutorial title "Customize Driver Salary Statements")
  const allSt = () => db.salBatches.flatMap(b => b.settlements.map(st => ({ b, st, id: st.id })));
  RL.route('/accounting/salary/driver-statements', () => ({
    crumbs: ['Accounting', 'Salary', 'Driver statements'],
    html: wrap(acctTabs(1), `${salChips(1)}<span class="grow"></span><button type="button" class="btn" data-act="customize-statement" aria-haspopup="dialog">${ic('gear')}Customize statement</button>`,
      RL.table({ id: 'statements', label: 'Driver statements', key: r => r.id, rowName: r => r.id, dbl: 'openStatement',
        columns: [{ key: 'id', label: 'ID', text: r => r.id, render: r => `<button type="button" class="btn link" data-act="statement-view" data-id="${r.id}" aria-haspopup="dialog">${r.id}</button>` }, { key: 'payee', label: 'Payee', text: r => dname(drv(r.st.driverId)) }, { key: 'type', label: 'Driver type', text: r => drv(r.st.driverId).type }, { key: 'batch', label: 'Batch', text: r => SB(r.b.id), render: r => `<a href="#/accounting/salary/driver-settlements/batch-view/${r.b.id}">${SB(r.b.id)}</a>` }, { key: 'period', label: 'Period', text: r => `${fmtMDY(r.b.from)}-${fmtMDY(r.b.to)}`, sortVal: r => r.b.from }, { key: 'status', label: 'Status', text: r => r.st.status, render: r => pill(r.st.status, stCls(r.st.status)) }, { key: 'pay', label: 'Pay', num: true, text: r => stCalc(r.st).pay, render: r => money(stCalc(r.st).pay) }, { key: 'net', label: 'Net pay', num: true, text: r => stCalc(r.st).net, render: r => money(stCalc(r.st).net) }, { key: 'sent', label: 'Email sent', text: r => r.st.emailSent ? 'Yes' : 'No' }],
        rows: () => allSt().reverse() })),
  }));
  DBL.openStatement = id => { const r = allSt().find(x => x.id === id); if (r) settlementPdf(r.b, [r.st]); };
  ACTS['statement-view'] = t => DBL.openStatement(t.dataset.id);
  ACTS['customize-statement'] = () => { const c = db.config.statementSections; formDialog({ title: 'Customize driver statement', sub: 'Sections shown on the settlement PDF', submit: 'Save', name: 'save-statement-settings', fields: [['earnings', 'Earnings'], ['miles', 'Loaded and empty miles'], ['deductions', 'Deductions'], ['otherPay', 'Other pay'], ['fuel', 'Fuel details'], ['toll', 'Toll details'], ['balances', 'Balances'], ['logo', 'Company logo']].map(([k, l]) => ({ name: k, label: l, type: 'checkbox', value: c[k] })), build: p => p, apply: p => Object.keys(c).forEach(k => (c[k] = !!p[k])) }); };
  RL.route('/accounting/salary/salary-report', () => {
    const per = new Map(); allSt().forEach(({ st }) => { const k = st.driverId; const c = stCalc(st); const r = per.get(k) || { id: k, trips: 0, pay: 0, ded: 0, net: 0, gross: 0, n: 0 }; r.trips += c.trips.length; r.pay += c.pay; r.ded += c.ded; r.net += c.net; r.gross += c.gross; r.n++; per.set(k, r); });
    return { crumbs: ['Accounting', 'Salary', 'Salary report'], html: wrap(acctTabs(1), `${salChips(2)}<span class="grow"></span>`, RL.table({ id: 'salary-report', label: 'Salary report', select: false, columns: [{ key: 'name', label: 'Driver', text: r => dname(drv(r.id)) }, { key: 'type', label: 'Driver type', text: r => drv(r.id).type }, { key: 'n', label: 'Settlements', num: true, text: r => r.n }, { key: 'trips', label: 'Trips', num: true, text: r => r.trips }, { key: 'gross', label: 'Gross revenue', num: true, text: r => r.gross, render: r => money(r.gross) }, { key: 'pay', label: 'Pay', num: true, text: r => r.pay, render: r => money(r.pay) }, { key: 'ded', label: 'Deductions', num: true, text: r => r.ded, render: r => money(r.ded) }, { key: 'net', label: 'Net pay', num: true, text: r => r.net, render: r => money(r.net) }], rows: () => [...per.values()].sort((a, b) => b.net - a.net) })) };
  });

  // deductions (inferred from tutorial title "How to Set Up Weekly & Monthly Driver Deductions")
  RL.route('/accounting/salary/deductions', () => ({
    crumbs: ['Accounting', 'Salary', 'Deductions'],
    html: wrap(acctTabs(1), `${salChips(3)}<span class="grow"></span><button type="button" class="btn primary" data-act="create-deduction" aria-haspopup="dialog">${ic('plus')}Create deduction</button>`,
      `<p class="muted sm" style="margin:0 0 10px">Scheduled deductions are added automatically to every salary batch: weekly ones once per batch, monthly ones when their day of the month falls in the batch period.</p>` +
      RL.table({ id: 'deductions', label: 'Scheduled deductions', rowEdit: 'create-deduction', rowName: s => `deduction ${s.id}`,
        columns: [{ key: 'driver', label: 'Driver', text: s => dname(drv(s.driverId)) }, { key: 'type', label: 'Deduction type', text: s => (byId(db.deductionTypes, s.typeId) || {}).code }, { key: 'desc', label: 'Description', text: s => s.description }, { key: 'freq', label: 'Frequency', text: s => s.frequency }, { key: 'day', label: 'Day', text: s => s.frequency === 'Monthly' ? `Day ${s.day}` : s.day }, { key: 'amount', label: 'Amount', num: true, text: s => s.amount, render: s => money(s.amount) }, { key: 'start', label: 'Start date', text: s => fmtMDY(s.startDate), sortVal: s => s.startDate }, { key: 'end', label: 'End date', text: s => s.endDate ? fmtMDY(s.endDate) : '-' }, { key: 'limit', label: 'Total limit', num: true, text: s => s.limit, render: s => s.limit ? money(s.limit) : '-' }, { key: 'status', label: 'Status', text: s => s.status, render: s => pill(s.status, stCls(s.status)) }],
        rows: () => db.schedDeductions })),
  }));
  ACTS['create-deduction'] = t => {
    const s = t && t.dataset.id ? byId(db.schedDeductions, t.dataset.id) : null;
    const d = formDialog({ title: s ? 'Edit deduction' : 'Create deduction', kind: 'drawer', submit: 'Save', cancel: 'Close', name: s ? 'save-deduction' : 'create-deduction',
      fields: [{ name: 'driverId', label: 'Driver', type: 'select', required: true, options: RL.selOptions.drivers(), value: s ? s.driverId : t && t.dataset && t.dataset.driver }, { name: 'typeId', label: 'Deduction type', type: 'select', required: true, options: db.deductionTypes.map(x => [x.id, x.code]), value: s && s.typeId },
        { name: 'frequency', label: 'Frequency', type: 'select', required: true, options: ['Weekly', 'Monthly', 'One time'], value: s ? s.frequency : 'Weekly', placeholder: false }, { name: 'day', label: 'Day', type: 'select', options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', ...Array.from({ length: 28 }, (_, i) => String(i + 1))], value: s ? s.day : 'Friday', placeholder: false, hint: 'Weekly: day of week. Monthly: day of month.' },
        { name: 'amount', label: 'Amount', type: 'money', required: true, value: s && s.amount }, { name: 'description', label: 'Description', value: s && s.description }, { name: 'startDate', label: 'Start date', type: 'date', required: true, value: s ? s.startDate.slice(0, 10) : todayStr }, { name: 'endDate', label: 'End date', type: 'date', value: s && s.endDate ? s.endDate.slice(0, 10) : '' },
        { name: 'limit', label: 'Total limit (loans, escrow)', type: 'money', value: s && s.limit || '' }, { name: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'PAUSED'], value: s ? s.status : 'ACTIVE', placeholder: false }],
      build: p => ({ id: s ? s.id : db.schedDeductions.length + 1, driver: dname(drv(p.driverId)), ...p }),
      apply: p => { const rec = s || { id: p.id }; Object.assign(rec, { driverId: +p.driverId, typeId: +p.typeId, frequency: p.frequency, day: p.day, amount: +p.amount, description: p.description || (byId(db.deductionTypes, p.typeId) || {}).description, startDate: p.startDate, endDate: p.endDate, limit: +p.limit || 0, status: p.status }); if (!s) db.schedDeductions.push(rec); } });
    d.form.typeId.addEventListener('change', () => { const x = byId(db.deductionTypes, d.form.typeId.value); if (x) { if (!d.form.description.value) d.form.description.value = x.description; if (!d.form.amount.value && x.default) d.form.amount.value = x.default; } });
  };

  // ======================= bills management (inferred from tutorial title "Salary Statements & Bill Statements (Truck Owners)") =======================
  RL.route('/accounting/bills', () => ({
    crumbs: ['Accounting', 'Bills Management'],
    html: wrap(acctTabs(2), `<h2 style="font-size:15px">Bills</h2><span class="grow"></span><button type="button" class="btn" data-act="bills-paid" data-needs-sel="bills">Mark as paid</button><button type="button" class="btn primary" data-act="create-bill" aria-haspopup="dialog">${ic('plus')}Create bill</button>`,
      RL.table({ id: 'bills', label: 'Bills', rowEdit: 'create-bill', rowName: b => b.number, columns: [{ key: 'number', label: 'Bill ID', text: b => b.number }, { key: 'payee', label: 'Payee', text: b => b.payee }, { key: 'truck', label: 'Truck', text: b => (trk(b.truckId) || {}).unit || '-' }, { key: 'category', label: 'Category', text: b => b.category }, { key: 'amount', label: 'Amount', num: true, text: b => b.amount, render: b => money(b.amount) }, { key: 'date', label: 'Bill date', text: b => fmtMDY(b.date), sortVal: b => b.date }, { key: 'due', label: 'Due date', text: b => fmtMDY(b.due), sortVal: b => b.due }, { key: 'status', label: 'Status', text: b => b.status, render: b => pill(b.status, stCls(b.status)) }], rows: () => db.bills, totals: rows => `<span>Unpaid: <b>${money(rows.filter(b => b.status === 'UNPAID').reduce((a, b) => a + b.amount, 0))}</b></span>` })),
  }));
  ACTS['create-bill'] = t => { const b = t && t.dataset.id ? byId(db.bills, t.dataset.id) : null; formDialog({ title: b ? `Edit bill ${b.number}` : 'Create bill', kind: 'drawer', submit: 'Save', cancel: 'Close', name: b ? 'save-bill' : 'create-bill', fields: [{ name: 'payee', label: 'Payee', required: true, value: b && b.payee }, { name: 'truckId', label: 'Truck', type: 'select', options: RL.selOptions.trucks(), value: b && b.truckId }, { name: 'category', label: 'Category', type: 'select', required: true, options: db.billExpenses.map(x => x.name), value: b && b.category, placeholder: false }, { name: 'amount', label: 'Amount', type: 'money', required: true, value: b && b.amount }, { name: 'date', label: 'Bill date', type: 'date', required: true, value: b ? b.date.slice(0, 10) : todayStr }, { name: 'due', label: 'Due date', type: 'date', value: b ? b.due.slice(0, 10) : RL.dayOff(30).slice(0, 10) }, { name: 'note', label: 'Note', type: 'textarea', cls: 'span2', value: b && b.note }], build: p => ({ id: b ? b.id : db.bills.length + 1, ...p }), apply: p => { const rec = b || { id: p.id, number: 'BL-' + String(500 + p.id).padStart(6, '0'), status: 'UNPAID' }; Object.assign(rec, { payee: p.payee, truckId: +p.truckId || null, category: p.category, amount: +p.amount, date: p.date, due: p.due, note: p.note }); if (!b) db.bills.unshift(rec); } }); };
  ACTS['bills-paid'] = t => { const ids = [...RL.TS.bills.sel].map(Number); confirmDialog({ title: 'Mark as paid', message: `Mark ${ids.length} selected bills as paid?`, yes: 'Mark as paid', no: 'Cancel', name: 'mark-bills-paid', data: { bills: ids }, apply: () => { ids.forEach(id => (byId(db.bills, id).status = 'PAID')); RL.TS.bills.sel.clear(); } }); };

  // ======================= payroll (inferred from tutorial title tabs: dispatcher payroll) =======================
  RL.route('/accounting/payroll', () => ({
    crumbs: ['Accounting', 'Payroll'],
    html: wrap(acctTabs(3), `<h2 style="font-size:15px">Dispatcher payroll</h2><span class="grow"></span><button type="button" class="btn primary" data-act="create-payroll" aria-haspopup="dialog">${ic('plus')}Create payroll</button>`,
      RL.table({ id: 'payroll', label: 'Payroll', rowName: p => p.number, columns: [{ key: 'number', label: 'Payroll ID', text: p => p.number }, { key: 'disp', label: 'Dispatcher', text: p => dname(H.disp(p.dispatcherId)) }, { key: 'period', label: 'Period', text: p => `${fmtMDY(p.from)}-${fmtMDY(p.to)}`, sortVal: p => p.from }, { key: 'loads', label: 'Loads', num: true, text: p => p.loads }, { key: 'gross', label: 'Gross revenue', num: true, text: p => p.gross, render: p => money(p.gross) }, { key: 'rate', label: 'Commission', num: true, text: p => p.rate, render: p => p.rate + '%' }, { key: 'amount', label: 'Amount', num: true, text: p => r2(p.gross * p.rate / 100), render: p => money(p.gross * p.rate / 100) }, { key: 'status', label: 'Status', text: p => p.status, render: p => pill(p.status, stCls(p.status)) }], rows: () => db.payrolls })),
  }));
  ACTS['create-payroll'] = () => formDialog({ title: 'Create payroll', submit: 'Create payroll', name: 'create-payroll', fields: [{ name: 'dispatcherId', label: 'Dispatcher', type: 'select', required: true, options: db.dispatchers.map(d => [d.id, dname(d)]) }, { name: 'rate', label: 'Commission, %', type: 'number', step: '0.1', value: 5 }, { name: 'from', label: 'Date from', type: 'date', required: true, value: RL.dayOff(-13).slice(0, 10) }, { name: 'to', label: 'Date to', type: 'date', required: true, value: todayStr }],
    build: p => { const ls = db.loads.filter(L => !L.deleted && L.dispatcherId === +p.dispatcherId && L.deliveredAt && L.deliveredAt.slice(0, 10) >= p.from && L.deliveredAt.slice(0, 10) <= p.to); return { ...p, loads: ls.length, gross: r2(ls.reduce((a, L) => a + totalPay(L), 0)) }; },
    apply: p => db.payrolls.unshift({ id: db.payrolls.length + 1, number: 'PR-' + String(60 + db.payrolls.length).padStart(6, '0'), dispatcherId: +p.dispatcherId, from: p.from, to: p.to, loads: p.loads, gross: p.gross, rate: +p.rate || 0, status: 'UNPOSTED' }) });

  // ======================= driver balances, one time charges, dispatcher salary (frame iv8hngzif0g-t660 sub-chips) =======================
  if (!db.driverBalances) {
    db.driverBalances = [];
    db.drivers.filter(d => d.employment === 'ACTIVE' && d.type !== 'Company driver').forEach((d, k) => {
      db.driverBalances.push({ id: db.driverBalances.length + 1, driverId: d.id, type: 'ESCROW', note: 'Safety deposit', txns: 4 + (k % 6), debit: 0, credit: 250 * (4 + (k % 6)), target: 2500 });
      if (k % 3 === 0) db.driverBalances.push({ id: db.driverBalances.length + 1, driverId: d.id, type: 'LOAN', note: 'Truck down payment loan', txns: 3, debit: 3000, credit: 1500, target: 3000 });
    });
    // The tutorial driver of SB-000142 pays escrow weekly.
    const sb = db.salBatches.find(b => b.id === 142); const st = sb && sb.settlements.find(x => x.id === 'ST-000256');
    if (st && !st.items.some(i => i.kind === 'balance')) st.items.push({ kind: 'balance', balType: 'ESCROW', description: 'Recurrent #1, Total-$250.00, Safety deposit', qty: 1, rate: 250 });
  }
  if (!db.oneTimeCharges) db.oneTimeCharges = Array.from({ length: 14 }, (_, k) => { const d = db.drivers.filter(x => x.employment === 'ACTIVE')[(k * 5) % 36]; return { id: k + 1, driverId: d.id, type: ['Admin fee', 'Damage', 'Traffic ticket', 'Reimbursement', 'Bonus'][k % 5], note: ['Onboarding admin fee', 'Trailer door damage', 'Speeding ticket TX', 'Scale ticket', 'Safety bonus'][k % 5], qty: 1, amount: [75, 400, 150, 15, 200][k % 5], date: RL.dayOff(-k * 3).slice(0, 10), status: k < 6 ? 'PENDING' : 'APPLIED', settlementId: k < 6 ? '' : 'ST-' + String(230 + k).padStart(6, '0') }; });
  const BAL_TYPES = ['ESCROW', 'LOAN', 'FUEL ADVANCE', 'DAMAGE'];
  const balOf = x => r2(x.credit - x.debit);
  RL.route('/accounting/salary/driver-balances', () => ({
    crumbs: ['Accounting', 'Salary', 'Driver balances'],
    html: wrap(acctTabs(1), `${salChips(4)}<span class="grow"></span><button type="button" class="btn primary" data-act="create-balance" aria-haspopup="dialog">${ic('plus')}Add balance</button>`,
      RL.table({ id: 'driver-balances', label: 'Driver balances', rowName: x => `${dname(drv(x.driverId))} ${x.type}`, rowEdit: 'create-balance',
        columns: [{ key: 'driver', label: 'Driver', text: x => dname(drv(x.driverId)), render: x => `<a href="#/hr-management/edit-driver/${x.driverId}/accounting">${esc(dname(drv(x.driverId)))}</a>` }, { key: 'type', label: 'Type', text: x => x.type }, { key: 'note', label: 'Note', text: x => x.note }, { key: 'txns', label: 'Number of transactions', num: true, text: x => x.txns }, { key: 'debit', label: 'Debit', num: true, text: x => x.debit, render: x => money(x.debit) }, { key: 'credit', label: 'Credit', num: true, text: x => x.credit, render: x => money(x.credit) }, { key: 'balance', label: 'Balance', num: true, text: balOf, render: x => `<b>${money(balOf(x))}</b>` }, { key: 'target', label: 'Target', num: true, text: x => x.target, render: x => x.target ? money(x.target) : '-' }],
        rows: () => db.driverBalances, totals: rows => `<span>Total balance: <b>${money(rows.reduce((a, x) => a + balOf(x), 0))}</b></span>` })),
  }));
  ACTS['create-balance'] = t => {
    const x = t && t.dataset.id ? byId(db.driverBalances, t.dataset.id) : null; const presetDriver = t && t.dataset.driver;
    formDialog({ title: x ? `Edit balance ${x.type}` : 'Add driver balance', kind: 'drawer', submit: 'Save', cancel: 'Close', name: x ? 'save-driver-balance' : 'create-driver-balance',
      fields: [{ name: 'driverId', label: 'Driver', type: 'select', required: true, options: RL.selOptions.drivers(), value: x ? x.driverId : presetDriver }, { name: 'type', label: 'Type', type: 'select', required: true, options: BAL_TYPES, value: x ? x.type : 'ESCROW', placeholder: false }, { name: 'note', label: 'Note', value: x ? x.note : '', cls: 'span2' }, { name: 'target', label: 'Target amount', type: 'money', value: x ? x.target : 2500 }, { name: 'opening', label: 'Opening balance', type: 'money', value: x ? balOf(x) : 0 }],
      build: p => ({ id: x ? x.id : db.driverBalances.length + 1, ...p }),
      apply: p => { const rec = x || { id: p.id, txns: 0, debit: 0, credit: 0 }; Object.assign(rec, { driverId: +p.driverId, type: p.type, note: p.note, target: +p.target || 0 }); if (!x) { rec.credit = +p.opening || 0; rec.txns = rec.credit ? 1 : 0; db.driverBalances.push(rec); } } });
  };
  RL.route('/accounting/salary/one-time-charges', () => ({
    crumbs: ['Accounting', 'Salary', 'One time charges'],
    html: wrap(acctTabs(1), `${salChips(6)}<span class="grow"></span><button type="button" class="btn primary" data-act="create-otc" aria-haspopup="dialog">${ic('plus')}Create one time charge</button>`,
      `<p class="muted sm" style="margin:0 0 10px">One time charges and credits are added to the driver's next salary batch.</p>` + RL.table({ id: 'one-time-charges', label: 'One time charges', rowName: x => `${x.type} ${x.id}`, rowEdit: 'create-otc',
        columns: [{ key: 'driver', label: 'Driver', text: x => dname(drv(x.driverId)) }, { key: 'type', label: 'Type', text: x => x.type }, { key: 'note', label: 'Note', text: x => x.note }, { key: 'qty', label: 'Quantity', num: true, text: x => x.qty }, { key: 'amount', label: 'Amount', num: true, text: x => x.amount, render: x => money(x.amount) }, { key: 'total', label: 'Total amount', num: true, text: x => x.qty * x.amount, render: x => money(x.qty * x.amount) }, { key: 'date', label: 'Date', text: x => fmtMDY(x.date), sortVal: x => x.date }, { key: 'st', label: 'Settlement', text: x => x.settlementId || 'Next batch' }, { key: 'status', label: 'Status', text: x => x.status, render: x => pill(x.status, x.status === 'APPLIED' ? 'closed' : 'pending') }],
        rows: () => db.oneTimeCharges })),
  }));
  ACTS['create-otc'] = t => {
    const x = t && t.dataset.id ? byId(db.oneTimeCharges, t.dataset.id) : null; const presetDriver = t && t.dataset.driver;
    formDialog({ title: x ? 'Edit one time charge' : 'Create one time charge', kind: 'drawer', submit: 'Save', cancel: 'Close', name: x ? 'save-one-time-charge' : 'create-one-time-charge',
      fields: [{ name: 'driverId', label: 'Driver', type: 'select', required: true, options: RL.selOptions.drivers(), value: x ? x.driverId : presetDriver }, { name: 'type', label: 'Type', type: 'select', required: true, options: ['Admin fee', 'Damage', 'Traffic ticket', 'Reimbursement', 'Bonus', 'Other'], value: x ? x.type : 'Admin fee', placeholder: false }, { name: 'qty', label: 'Quantity', type: 'number', value: x ? x.qty : 1, min: 0 }, { name: 'amount', label: 'Amount', type: 'money', required: true, value: x ? x.amount : '' }, { name: 'date', label: 'Date', type: 'date', value: x ? x.date : todayStr }, { name: 'note', label: 'Note', value: x ? x.note : '', cls: 'span2' }],
      build: p => ({ id: x ? x.id : db.oneTimeCharges.length + 1, ...p }),
      apply: p => { const rec = x || { id: p.id, status: 'PENDING', settlementId: '' }; Object.assign(rec, { driverId: +p.driverId, type: p.type, qty: +p.qty || 1, amount: +p.amount, date: p.date, note: p.note }); if (!x) db.oneTimeCharges.unshift(rec); } });
  };
  RL.route('/accounting/salary/dispatcher-salary', () => ({
    crumbs: ['Accounting', 'Salary', 'Dispatcher salary'],
    html: wrap(acctTabs(1), `${salChips(5)}<span class="grow"></span><button type="button" class="btn primary" data-act="create-payroll" aria-haspopup="dialog">${ic('plus')}Create payroll</button>`,
      RL.table({ id: 'dispatcher-salary', label: 'Dispatcher salary', rowName: x => x.number, columns: [{ key: 'number', label: 'Payroll ID', text: x => x.number }, { key: 'disp', label: 'Dispatcher', text: x => dname(H.disp(x.dispatcherId)) }, { key: 'period', label: 'Period', text: x => `${fmtMDY(x.from)}-${fmtMDY(x.to)}`, sortVal: x => x.from }, { key: 'loads', label: 'Loads', num: true, text: x => x.loads }, { key: 'gross', label: 'Gross revenue', num: true, text: x => x.gross, render: x => money(x.gross) }, { key: 'rate', label: 'Commission', num: true, text: x => x.rate, render: x => x.rate + '%' }, { key: 'amount', label: 'Salary', num: true, text: x => r2(x.gross * x.rate / 100), render: x => money(x.gross * x.rate / 100) }, { key: 'status', label: 'Status', text: x => x.status, render: x => pill(x.status, stCls(x.status)) }], rows: () => db.payrolls })),
  }));

  // ======================= settlement edit page (frame iv8hngzif0g-t660) =======================
  const KINDS = {
    other: { title: 'Other pay', col: 'Other pay', types: ['Reimbursements', 'Bonus', 'Detention pay', 'Layover', 'Fuel rebate', 'Other'], sign: 1 },
    deduction: { title: 'Deductions', col: 'Deduction type', types: () => db.deductionTypes.map(x => [x.id, x.name]), sign: -1 },
    balance: { title: 'Driver Balances', col: 'Type', types: BAL_TYPES, sign: -1 },
  };
  const itemType = i => i.kind === 'deduction' ? ((byId(db.deductionTypes, i.typeId) || {}).name || i.description) : i.kind === 'balance' ? i.balType : (i.otherType || 'Reimbursements');
  RL.route('/accounting/salary/driver-settlements/batch-view/:id/settlement/deduction/:sid', p => {
    const b = sbById(p.id); if (!b) return null;
    const st = b.settlements.find(x => +x.id.replace(/\D/g, '') === +p.sid); if (!st) return null;
    const c = stCalc(st), d = drv(st.driverId), locked = st.status === 'PAID';
    const section = kind => {
      const K = KINDS[kind], items = st.items.map((it, i) => ({ it, i })).filter(x => x.it.kind === kind);
      const types = typeof K.types === 'function' ? K.types() : K.types.map(t => [t, t]);
      return `<section class="dcard" style="margin-bottom:12px" aria-label="${K.title}"><h3 style="color:var(--brand)">${K.title}</h3><div style="overflow:auto"><table class="t" aria-label="${K.title}"><thead><tr><th scope="col">${K.col}</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Quantity</th><th scope="col" class="num">Total amount</th><th scope="col">Description</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
        ${items.map(({ it, i }) => `<tr><td>${it.scheduledId || /^Recurrent/.test(it.description || '') ? `<span title="Recurring" aria-label="Recurring">${ic('sync')}</span> ` : ''}${esc(itemType(it))}</td><td class="num">${money(it.rate)}</td><td class="num">${num(it.qty || 1)}</td><td class="num">${money((+it.qty || 1) * it.rate)}</td><td>${esc(it.description || '')}</td>
          <td class="act"><span><span>${locked ? '' : `<button type="button" class="icon-btn" data-act="st-edit-item" data-b="${b.id}" data-st="${st.id}" data-i="${i}" aria-haspopup="dialog" aria-label="Edit ${esc(itemType(it))}">${ic('edit')}</button><button type="button" class="icon-btn" data-act="st-del-item" data-b="${b.id}" data-st="${st.id}" data-i="${i}" aria-label="Delete ${esc(itemType(it))}">${ic('trash')}</button>`}</span></span></td></tr>`).join('') || `<tr><td colspan="6" class="muted">No ${K.title.toLowerCase()} yet</td></tr>`}
        </tbody></table></div>
        ${locked ? '' : `<form class="other-pay" style="grid-template-columns:1.4fr 1fr 1fr 1fr 1.4fr auto;margin-top:8px" data-submit="st-add-item" data-b="${b.id}" data-st="${st.id}" data-kind="${kind}" aria-label="Add ${K.title}">
          <select name="type" required aria-label="${K.col}"><option value="">Select…</option>${types.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select><input name="rate" type="number" step="0.01" min="0" value="1" required aria-label="Amount"><input name="qty" type="number" step="0.01" min="0" value="1" aria-label="Quantity"><input value="$1.00" readonly aria-label="Total amount" tabindex="-1"><input name="description" aria-label="Description" placeholder="Description"><button type="submit" class="btn sm">${ic('plus')}Add</button></form>`}</section>`;
    };
    return {
      crumbs: ['Accounting', ['Salary', '#/accounting/salary/driver-settlements'], ['Batches', '#/accounting/salary/driver-settlements'], [SB(b.id), `#/accounting/salary/driver-settlements/batch-view/${b.id}`], st.id],
      html: wrap(acctTabs(1), `<a class="icon-btn" href="#/accounting/salary/driver-settlements/batch-view/${b.id}" aria-label="Back to ${SB(b.id)}">${ic('left')}</a>${salChips(0)}<span class="grow"></span>
        <button type="button" class="btn primary" data-act="st-send" data-id="${b.id}" data-st="${st.id}" aria-haspopup="dialog" ${st.status === 'UNPOSTED' ? 'disabled' : ''}>${ic('send')}Send to driver</button><button type="button" class="btn purple" data-act="st-post" data-id="${b.id}" data-st="${st.id}" ${st.status === 'UNPOSTED' ? '' : 'disabled'}>Post</button>
        <button type="button" class="btn outline" data-act="st-tariff" data-b="${b.id}" data-st="${st.id}" aria-haspopup="dialog" ${locked ? 'disabled' : ''}>${ic('plus')}Deduction tariff</button><button type="button" class="btn soft" data-act="st-pdf" data-b="${b.id}" data-st="${st.id}" aria-haspopup="dialog">${ic('download')}Export as PDF</button>
        <button type="button" class="icon-btn" data-act="menu" data-menu="stMore" data-b="${b.id}" data-st="${st.id}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${st.id}">${ic('more')}</button>`,
        `<div class="with-side"><div>
          <section class="dcard" style="margin-bottom:12px" aria-label="Earnings"><h3 style="color:var(--brand)">Earnings <span class="muted sm">${esc(dname(d))} · ${pill(st.status, stCls(st.status))}</span></h3><table class="t" aria-label="Earnings"><thead><tr><th scope="col">Trip</th><th scope="col">Load number</th><th scope="col">PU</th><th scope="col">DEL</th><th scope="col">DEL date</th><th scope="col" class="num">Loaded miles</th><th scope="col" class="num">Empty miles</th><th scope="col" class="num">Total amount</th></tr></thead><tbody>${c.trips.map(x => `<tr><td>${x.t.id}</td><td><a href="${loadUrl(x.L)}">${esc(x.L.loadId)}</a></td><td>${esc(place(firstStop(x.L)))}</td><td>${esc(place(lastStop(x.L)))}</td><td>${fmtMDY(x.L.deliveredAt)}</td><td class="num">${num(x.t.loadedMiles)}</td><td class="num">${num(x.t.emptyMiles)}</td><td class="num">${money(x.t.driverPay)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No trips</td></tr>'}</tbody></table></section>
          ${section('other')}${section('deduction')}${section('balance')}</div>
          <aside><section class="panel-box" aria-label="Totals"><h3>${st.id}</h3><div class="pr"><span>Payee:</span><span>${esc(dname(d))}</span></div><div class="pr"><span>Pay to:</span><span>${esc(d.payTo || dname(d))}</span></div><div class="pr"><span>Period:</span><span>${fmtMDY(b.from)}-${fmtMDY(b.to)}</span></div>
            <div class="pr"><span>Pay:</span><span>${money(c.pay)}</span></div><div class="pr"><span>Advances:</span><span>(${money(c.adv)})</span></div><div class="pr"><span>Expenses:</span><span>(${money(c.exp)})</span></div><div class="pr"><span>Other pay:</span><span>${money(c.oth)}</span></div><div class="pr"><span>Deductions:</span><span>(${money(c.ded)})</span></div><div class="pr"><span>Driver balances:</span><span>(${money(c.bal)})</span></div><div class="pr"><span>Net pay:</span><b>${money(c.net)}</b></div></section></aside></div>`),
    };
  });
  const findSt = t => { const b = sbById(t.dataset.b); return { b, st: b && b.settlements.find(x => x.id === t.dataset.st) }; };
  SUBMITS['st-add-item'] = async f => {
    const { b, st } = findSt(f); const kind = f.dataset.kind; if (!validate(f)) return;
    const type = f.type.value, rate = +f.rate.value, qty = +f.qty.value || 1, description = f.description.value.trim();
    const item = kind === 'deduction' ? { kind, typeId: +type, description: description || (byId(db.deductionTypes, type) || {}).description, qty, rate } : kind === 'balance' ? { kind, balType: type, description, qty, rate } : { kind, otherType: type, description: description || type, qty, rate };
    if (await commit(f.querySelector('[type=submit]'), 'settlement-add-' + kind, { batch: SB(b.id), settlement: st.id, type, amount: rate, quantity: qty }, () => {
      st.items.push(item);
      if (kind === 'balance') { let bal = db.driverBalances.find(x => x.driverId === st.driverId && x.type === type); if (!bal) { bal = { id: db.driverBalances.length + 1, driverId: st.driverId, type, note: description, txns: 0, debit: 0, credit: 0, target: 0 }; db.driverBalances.push(bal); } bal.credit = r2(bal.credit + rate * qty); bal.txns++; }
    })) RL.rerender();
  };
  CHANGES['st-total'] = () => {};
  document.addEventListener('input', e => { const f = e.target.closest('form[data-submit=st-add-item]'); if (f) { const tot = f.querySelector('[aria-label="Total amount"]'); tot.value = money((+f.rate.value || 0) * (+f.qty.value || 1)); } });
  ACTS['st-del-item'] = async t => { const { b, st } = findSt(t); const i = +t.dataset.i; const it = st.items[i]; if (await commit(t, 'settlement-delete-item', { batch: SB(b.id), settlement: st.id, type: itemType(it) }, () => st.items.splice(i, 1))) RL.rerender(); };
  ACTS['st-edit-item'] = t => { const { b, st } = findSt(t); const i = +t.dataset.i; const it = st.items[i];
    formDialog({ title: `Edit ${itemType(it)}`, sub: st.id, size: 'narrow', submit: 'Save', name: 'settlement-edit-item', fields: [{ name: 'rate', label: 'Amount', type: 'money', required: true, value: it.rate }, { name: 'qty', label: 'Quantity', type: 'number', step: '0.01', value: it.qty || 1 }, { name: 'description', label: 'Description', value: it.description || '', cls: 'span2' }],
      build: p => ({ batch: SB(b.id), settlement: st.id, ...p }), apply: p => Object.assign(it, { rate: +p.rate, qty: +p.qty || 1, description: p.description }) }); };
  ACTS['st-tariff'] = t => { const { b, st } = findSt(t);
    formDialog({ title: 'Deduction tariff', sub: `${st.id} · ${dname(drv(st.driverId))}`, submit: 'Add deduction', name: 'settlement-deduction-tariff', fields: [{ name: 'typeId', label: 'Deduction tariff', type: 'select', required: true, options: db.deductionTypes.map(x => [x.id, `${x.name} · ${money(x.default)}`]), cls: 'span2' }, { name: 'recurring', label: 'Also schedule it weekly for this driver', type: 'checkbox', value: false, cls: 'span2' }],
      build: p => ({ batch: SB(b.id), settlement: st.id, ...p }),
      apply: p => { const x = byId(db.deductionTypes, p.typeId); st.items.push({ kind: 'deduction', typeId: x.id, description: x.description, qty: 1, rate: x.default }); if (p.recurring) db.schedDeductions.push({ id: db.schedDeductions.length + 1, driverId: st.driverId, typeId: x.id, description: `Weekly ${x.name}`, frequency: 'Weekly', day: 'Friday', amount: x.default, startDate: todayStr, endDate: '', limit: 0, status: 'ACTIVE' }); } }); };
  ACTS['st-pdf'] = t => { const { b, st } = findSt(t); settlementPdf(b, [st]); };
  ACTS['st-post'] = t => { RL.tstate('sb-view').sel = new Set([t.dataset.st]); SV.id = +t.dataset.id; ACTS['sb-post'](t); };
  ACTS['st-send'] = t => { RL.tstate('sb-view').sel = new Set([t.dataset.st]); SV.id = +t.dataset.id; ACTS['sb-send'](t); };
  MENUS.stMore = t => { const { b, st } = findSt(t); return menu(`More actions for ${st.id}`, [ml(`Back to ${SB(b.id)}`, `#/accounting/salary/driver-settlements/batch-view/${b.id}`), ml('Driver accounting', `#/hr-management/edit-driver/${st.driverId}/accounting`), msep, mi('Remove settlement', 'st-remove', `data-b="${b.id}" data-st="${st.id}" ${st.status === 'UNPOSTED' ? '' : 'aria-disabled="true"'}`, 'danger')]); };
  ACTS['st-remove'] = t => { RL.tstate('sb-view').sel = new Set([t.dataset.st]); const b = sbById(t.dataset.b); confirmDialog({ title: 'Remove settlement', message: `Remove ${t.dataset.st} from ${SB(b.id)}? Its trips become available again.`, yes: 'Remove', no: 'Cancel', danger: true, name: 'remove-settlements', data: { batch: SB(b.id), settlements: [t.dataset.st] }, apply: () => { const st = b.settlements.find(x => x.id === t.dataset.st); st.tripIds.map(tripById).forEach(x => { if (x) { x.t.salaryBatchId = null; x.t.settlementId = null; x.t.billing = 'PENDING'; } }); b.settlements.splice(b.settlements.indexOf(st), 1); }, after: () => { location.hash = `#/accounting/salary/driver-settlements/batch-view/${b.id}`; } }); };
  RL.oneTimeChargesFor = id => db.oneTimeCharges.filter(x => x.driverId === id);

  // Reconciliation and Watchdogs invoice chips (frame E9gihrMGGvQ-t080; screens inferred from the chip names).
  RL.route('/accounting/invoices/reconciliation', () => ({ crumbs: ['Accounting', 'Invoices', 'Reconciliation'], html: wrap(acctTabs(0), `${invChips(5)}<span class="grow"></span>`,
    RL.table({ id: 'reconciliation', label: 'Reconciliation', rowName: x => IB(x.id), select: false, columns: [{ key: 'id', label: 'Batch ID', text: x => IB(x.id), render: x => `<a href="#/accounting/invoices/batches/view-batch/${x.id}">${IB(x.id)}</a>` }, { key: 'status', label: 'Post status', text: x => x.status, render: x => pill(x.status, stCls(x.status)) }, { key: 'expected', label: 'Expected', num: true, text: batchTotal, render: x => money(batchTotal(x)) }, { key: 'received', label: 'Received', num: true, text: x => x.reconciled ? x.reconciled.received : (x.status === 'PAID' ? batchTotal(x) : 0), render: x => money(x.reconciled ? x.reconciled.received : (x.status === 'PAID' ? batchTotal(x) : 0)) }, { key: 'diff', label: 'Difference', num: true, text: x => (x.reconciled ? x.reconciled.received : (x.status === 'PAID' ? batchTotal(x) : 0)) - batchTotal(x), render: x => { const v = (x.reconciled ? x.reconciled.received : (x.status === 'PAID' ? batchTotal(x) : 0)) - batchTotal(x); return `<span class="${v < 0 ? 'red' : ''}">${money(v)}</span>`; } }, { key: 'ref', label: 'Reference', text: x => x.reconciled ? x.reconciled.ref : '-' }], rows: () => db.invBatches.filter(x => x.status !== 'UNPOSTED') })) }));
  RL.route('/accounting/invoices/watchdogs', () => { const rows = db.loads.filter(L => !L.deleted && ['delivered', 'invoiced'].includes(L.status)).map(L => ({ id: L.id, L, issue: !RL.hasPod(L) ? 'Missing Proof of Delivery' : !L.invoice.batchId ? 'Delivered, not in a batch' : !L.invoice.sent ? 'In batch, not sent' : daysBetween((L.invoice.createdAt || todayStr).slice(0, 10), todayStr) > 30 ? 'Unpaid over 30 days' : '' })).filter(x => x.issue);
    return { crumbs: ['Accounting', 'Invoices', 'Watchdogs'], html: wrap(acctTabs(0), `${invChips(6)}<span class="grow"></span>`, RL.table({ id: 'watchdogs', label: 'Watchdogs', select: false, rowName: x => x.L.sid, columns: [{ key: 'sid', label: 'Shipment ID', text: x => x.L.sid, render: x => `<a href="${loadUrl(x.L)}">${x.L.sid}</a>` }, { key: 'customer', label: 'Customer', text: x => cust(x.L.customerId).name }, { key: 'issue', label: 'Issue', text: x => x.issue, render: x => `<span class="red">${ic('warn')} ${esc(x.issue)}</span>` }, { key: 'status', label: 'Status', text: x => x.L.status, render: x => stPill(x.L.status) }, { key: 'amount', label: 'Amount', num: true, text: x => totalPay(x.L), render: x => money(totalPay(x.L)) }], rows: () => rows })) }; });
})();
