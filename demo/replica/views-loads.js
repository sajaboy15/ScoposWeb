/* RoadLedger TMS replica: load management (load board, Create New Load, load detail, trips, drivers unbilled, Amazon loads). */
(function () {
  'use strict';
  const RL = window.RL, db = RL.db, H = RL.h, ic = RL.ic;
  const { esc, money, num, r2, fmtDate, fmtLong, fmtDT, fmtEvt, fmtTime, fmtMDY, cust, drv, trk, trl, mcOf, dname, loadById, loadUrl, firstStop, lastStop, place, placeLong, totalPay, driverPayOf, accessorials, tripLabel, nowIso, byId } = H;
  const { stPill, pill, readyHtml, copyBtn } = RL.pill;
  const { ACTS, CHANGES, SUBMITS, DBL, MENUS, POPS, mi, ml, msep, menu, commit, toast, openModal, formDialog, confirmDialog, field, validate, readForm } = RL;
  const ME = 'Tutorial Account';
  const ORDER = RL.ORDER;
  const ev = (L, text, who = ME) => L.events.push({ at: nowIso(), text: `${who} ${text}` });
  db.loads.forEach(L => { if (L.status === 'invoiced' || L.status === 'paid') L.locked = true; });

  // ---------- load model helpers ----------
  function legMiles(stops, type = 'Google map') {
    let m = 0; for (let i = 1; i < stops.length; i++) { const a = stops[i - 1], b = stops[i]; m += a.cityIdx != null && b.cityIdx != null ? RL.roadMiles(a.cityIdx, b.cityIdx, type) : 0; }
    return r2(m);
  }
  function recalcMiles(L) {
    const loaded = legMiles(L.stops, L.mileageType);
    if (loaded > 0) L.miles.loaded = loaded;
    if (!L.trips.some(t => t.emptyManual)) L.miles.empty = L.miles.empty || 0;
    L.miles.total = r2(L.miles.loaded + L.miles.empty);
  }
  function parseLocation(text) {
    const c = RL.cityByName(text);
    if (c) return { cityIdx: c.i, city: c.city, state: c.state, zip: c.zip };
    const m = /([^,]+),\s*([A-Z]{2})\s*(\d{5})?/.exec(text || '');
    return m ? { cityIdx: null, city: m[1].trim(), state: m[2], zip: m[3] || '' } : { cityIdx: null, city: (text || '').trim() || 'Unknown', state: '', zip: '' };
  }
  /** A new load in status Booked, built from a creation method. */
  function buildLoad(o) {
    const id = ++db.seq.load;
    const c = cust(o.customerId);
    const L = {
      id, sid: 'DT-' + String(id).padStart(6, '0'), loadId: o.loadId, refId: o.refId || '', customerId: +o.customerId, mcId: +o.mcId || 1, mode: o.mode || 'FTL', equipment: o.equipment || 'Dry van',
      equipments: ['Van 48', 'Van 53'], addEquip: [], driverReq: [], status: 'booked', stops: o.stops.map((s, i) => ({ id: i + 1, ...s })), loadPay: +o.loadPay || 0, otherPay: [], tonu: false, tonuAmount: 0,
      paymentType: c.billingType === 'QUICK PAY' ? 'Quick pay' : 'Standard', mileageType: db.config.mileageType, miles: { total: 0, loaded: 0, empty: 0 }, tags: o.tags || [], createdBy: ME, createdAt: nowIso(), special: o.special || '',
      commodities: o.commodity ? [{ desc: o.commodity, qty: o.pieces || 1, type: 'Pallets', pcs: o.pieces || 1, wt: o.weight || 0, w: 48, h: 60, l: 40, note: '' }] : [], freightTags: { temperature: o.equipment === 'Reefer', hazmat: false, oversize: false, highValue: false, team: false },
      trips: [], invoice: { createdAt: '', batchId: null, status: 'PENDING', billingType: c.billingType || 'FACTORING COMPANY', sent: false, factored: false, scheduleId: null, paidAt: '' }, dispatcherId: 1, commission: '',
      eta: { at: '', miles: '' }, deliveredAt: '', pickedAt: '', events: [], notes: [], chat: [], docs: o.rateCon ? [{ id: 1, type: 'Rate confirmation', name: o.rateCon, at: nowIso(), by: o.parsedBy || ME }] : [], following: true, locked: false, amazon: !!o.amazon, deleted: false,
    };
    const loaded = legMiles(L.stops);
    L.miles = { loaded: loaded || +o.miles || 0, empty: 0, total: loaded || +o.miles || 0 };
    if (o.miles && !loaded) L.miles = { loaded: +o.miles, empty: 0, total: +o.miles };
    L.events.push({ at: L.createdAt, text: `${ME} created Load` });
    return L;
  }
  RL.buildLoad = buildLoad;
  const stopLabel = (L, i) => `${L.stops[i].type}-${i + 1}`;
  const apptRange = s => `${fmtDT(s.from)}${s.to ? ' - ' + fmtDT(s.to) : ''}`;
  const hasPod = L => L.docs.some(d => d.type === 'Proof of Delivery');
  const missing = L => (['booked', 'assigned'].includes(L.status) && !L.trips.length && L.status !== 'offer') ? 'Driver is not assigned' : (['delivered', 'invoiced'].includes(L.status) && !hasPod(L)) ? 'Missing Proof of Delivery' : '';
  RL.hasPod = hasPod;
  function setDriverBusy(t, status) {
    const d = t && t.driverId ? drv(t.driverId) : null; if (d) { d.status = status; if (status === 'available') d.currentLoadId = null; }
    const tr = t && t.truckId ? trk(t.truckId) : null; if (tr) tr.status = status === 'in_transit' ? 'IN TRANSIT' : status === 'dispatched' ? 'DISPATCHED' : 'AVAILABLE';
  }

  // ======================= load board =======================
  const LS = { chip: 'all', puFrom: '', puTo: '', delFrom: '', delTo: '', status: '', dispatchView: false };
  const upcoming = L => ['offer', 'booked', 'assigned'].includes(L.status) && firstStop(L).from >= H.todayStr;
  function boardRows() {
    let rows = db.loads.filter(L => !L.deleted);
    const c = LS.chip;
    if (c === 'upcoming') rows = rows.filter(upcoming);
    else if (c === 'dispatched') rows = rows.filter(L => L.status === 'dispatched' || L.status === 'assigned');
    else if (c === 'in_transit') rows = rows.filter(L => L.status === 'in_transit');
    else if (c === 'delivered') rows = rows.filter(L => L.status === 'delivered');
    else if (c === 'unpaid') rows = rows.filter(L => L.status === 'invoiced');
    else if (c.startsWith('sv-')) { const v = db.savedViews.loads.find(x => x.id === c); const f = v ? v.filter : {}; if (f.amazon) rows = rows.filter(L => L.amazon && ['booked', 'assigned', 'dispatched', 'in_transit'].includes(L.status)); if (f.status) rows = rows.filter(L => L.status === f.status); }
    if (LS.status) rows = rows.filter(L => L.status === LS.status);
    if (LS.puFrom) rows = rows.filter(L => firstStop(L).from.slice(0, 10) >= LS.puFrom);
    if (LS.puTo) rows = rows.filter(L => firstStop(L).from.slice(0, 10) <= LS.puTo);
    if (LS.delFrom) rows = rows.filter(L => lastStop(L).from.slice(0, 10) >= LS.delFrom);
    if (LS.delTo) rows = rows.filter(L => lastStop(L).from.slice(0, 10) <= LS.delTo);
    return rows.sort((a, b) => b.id - a.id);
  }
  const twoLine = (a, b) => `<div class="two"><span>${esc(a)}</span><small>${esc(b)}</small></div>`;
  const loadCols = () => [
    { key: 'sid', label: 'Shipment ID', render: L => `<a href="${loadUrl(L)}">${L.sid}</a>${copyBtn(L.sid, 'Shipment ID ' + L.sid)}`, sortVal: L => L.id },
    { key: 'loadId', label: 'Load ID', render: L => `<a href="${loadUrl(L)}" aria-label="Load ${esc(L.loadId)}">${esc(L.loadId)}</a>${copyBtn(L.loadId, 'Load ID ' + L.loadId)}` },
    { key: 'customer', label: 'Customer', text: L => cust(L.customerId).name, render: L => `<a href="#/customer-management/customers/${L.customerId}">${esc(cust(L.customerId).name)}</a>` },
    { key: 'driver', label: 'Driver/Carrier', text: L => L.trips.map(tripLabel).join(', ') || '-' },
    { key: 'truck', label: 'Truck', text: L => L.trips.map(t => (trk(t.truckId) || {}).unit).filter(Boolean).join(', ') || '-', render: L => { const t = L.trips[0] && trk(L.trips[0].truckId); return t ? `<a href="#/fleet-management/trucks/${t.id}">${esc(t.unit)}</a>` : '-'; } },
    { key: 'mc', label: 'MC Number', text: L => mcOf(L.mcId).name },
    { key: 'pickup', label: 'Pickup', text: L => `${firstStop(L).company} ${place(firstStop(L))}`, render: L => twoLine(firstStop(L).company, `${place(firstStop(L))} ${firstStop(L).zip}`) },
    { key: 'delivery', label: 'Delivery', text: L => `${lastStop(L).company} ${place(lastStop(L))}`, render: L => twoLine(lastStop(L).company, `${place(lastStop(L))} ${lastStop(L).zip}`) },
    { key: 'puDate', label: 'PU date', text: L => fmtDate(firstStop(L).from), sortVal: L => firstStop(L).from, hidden: true },
    { key: 'delDate', label: 'DEL date', text: L => fmtDate(lastStop(L).from), sortVal: L => lastStop(L).from },
    { key: 'status', label: 'Load status', text: L => RL.STATUS_TEXT[L.status], render: L => stPill(L.status), sortVal: L => ORDER.indexOf(L.status) },
    { key: 'loadPay', label: 'Load pay', num: true, text: L => L.loadPay, render: L => `<span class="cell-edit">${money(L.loadPay)}<button type="button" class="icon-btn" data-act="menu" data-pop="loadPay" data-id="${L.id}" aria-haspopup="dialog" aria-expanded="false" aria-label="Edit load pay for ${L.sid}">${ic('edit')}</button></span>` },
    { key: 'totalPay', label: 'Total pay', num: true, text: L => totalPay(L), render: L => money(totalPay(L)) },
    { key: 'miles', label: 'Total miles', num: true, text: L => L.miles.total, render: L => num(L.miles.total) },
    { key: 'rpm', label: 'Revenue per mile', num: true, text: L => L.miles.total ? r2(totalPay(L) / L.miles.total) : 0, render: L => '$' + (L.miles.total ? (totalPay(L) / L.miles.total).toFixed(2) : '0.00') },
    { key: 'equipment', label: 'Equipment', text: L => L.equipment },
    { key: 'createdBy', label: 'Created By', text: L => L.createdBy, hidden: true },
    { key: 'tag', label: 'Tag', text: L => L.tags.join(', '), render: L => L.tags.map(t => `<span class="tag solid">${esc(t)}</span>`).join(' ') || '-', hidden: true },
    { key: 'dispatcher', label: 'Dispatcher', text: L => dname(H.disp(L.dispatcherId)), hidden: true },
  ];
  function loadTotals(rows) {
    const tp = rows.reduce((a, L) => a + totalPay(L), 0), dp = rows.reduce((a, L) => a + driverPayOf(L), 0), tm = rows.reduce((a, L) => a + L.miles.total, 0), em = rows.reduce((a, L) => a + L.miles.empty, 0), lm = tm - em;
    return `<span>Total pay: <b>${money(tp)}</b></span><span>Driver pay: <b>${money(dp)}</b></span><span>Total miles: <b>${num(tm)}</b></span><span>Empty miles: <b>${num(em)}</b></span><span>RPM for loaded miles: <b>$${lm ? (tp / lm).toFixed(2) : '0.00'}</b></span><span>RPM for total miles: <b>$${tm ? (tp / tm).toFixed(2) : '0.00'}</b></span><span>Service fee: <b>${money(tp - dp)}</b></span>`;
  }
  function tripSubRows(L, span) {
    if (!L.trips.length) return `<tr class="sub"><td></td><td colspan="${span - 1}" class="muted">This load does not have a trip assigned to the driver yet</td></tr>`;
    return L.trips.map(t => `<tr class="sub"><td></td><td colspan="${span - 1}">${ic(t.split ? 'split' : 'road')} <b>${t.id}</b> · <span class="outline-st">${esc(t.status)}</span> · ${esc(tripLabel(t))} · Truck ${esc((trk(t.truckId) || {}).unit || '-')} · Driver pay ${money(t.driverPay)}</td></tr>`).join('');
  }
  function loadBoard(params, q, title = 'Load + Trip') {
    if (q && q.view) LS.chip = q.view;
    const n = db.loads.filter(L => !L.deleted && upcoming(L)).length;
    const chips = [['all', 'All Loads'], ['upcoming', `(${n}) Upcoming Loads`], ['dispatched', 'Dispatched'], ['in_transit', 'In-Transit'], ['delivered', 'Delivered'], ['unpaid', 'Unpaid'], ...db.savedViews.loads.map(v => [v.id, v.name, true])];
    const cfg = {
      id: 'loads', label: 'Loads', columns: loadCols(), rows: boardRows, rowName: L => L.sid, rowMenu: 'loadRow', dbl: 'openLoad', expand: tripSubRows, totals: loadTotals,
      rowClass: L => missing(L) && ['booked', 'assigned', 'delivered'].includes(L.status) ? 'pink' : '', flag: missing,
      toolbarLeft: `<div class="row" role="group" aria-label="Pickup Time"><span class="muted sm">Pickup Time</span><input class="inp" style="width:132px;height:30px" type="date" data-change="ls" data-k="puFrom" value="${LS.puFrom}" aria-label="Pickup time from"><input class="inp" style="width:132px;height:30px" type="date" data-change="ls" data-k="puTo" value="${LS.puTo}" aria-label="Pickup time to"></div>
        <div class="row" role="group" aria-label="Delivery Time"><span class="muted sm">Delivery Time</span><input class="inp" style="width:132px;height:30px" type="date" data-change="ls" data-k="delFrom" value="${LS.delFrom}" aria-label="Delivery time from"><input class="inp" style="width:132px;height:30px" type="date" data-change="ls" data-k="delTo" value="${LS.delTo}" aria-label="Delivery time to"></div>
        <select class="inp" style="width:140px;height:30px" data-change="ls" data-k="status" aria-label="Load status"><option value="">Load status</option>${ORDER.map(s => `<option value="${s}" ${LS.status === s ? 'selected' : ''}>${RL.STATUS_TEXT[s]}</option>`).join('')}</select>`,
      toolbarRight: `<button type="button" class="btn sm" data-act="dispatch-view" aria-pressed="${LS.dispatchView}">Dispatch view</button><button type="button" class="btn sm" data-act="menu" data-menu="loadBulk" aria-haspopup="menu" aria-expanded="false">Bulk actions${ic('down')}</button>` + RL.stdRight({ id: 'loads' }),
    };
    if (LS.dispatchView) { const keep = ['sid', 'driver', 'truck', 'pickup', 'delivery', 'puDate', 'delDate', 'status', 'dispatcher']; const s = RL.tstate('loads', cfg); cfg.columns.forEach(c => { if (keep.includes(c.key)) s.hidden.delete(c.key); else s.hidden.add(c.key); }); }
    return {
      crumbs: ['Load management', title],
      html: `<div class="page-head">${RL.chipTabs('Load views', chips, LS.chip, 'load-chip', `<a class="chip" href="#/load-management/trips">Trips</a><a class="chip" href="#/load-management/drivers-unbilled">Drivers Unbilled</a>`)}<span class="grow"></span>
        <div class="split"><button type="button" class="btn primary" data-act="new-load" aria-haspopup="dialog">${ic('plus')}New Load</button><button type="button" class="btn primary" data-act="menu" data-menu="newLoadMore" aria-haspopup="menu" aria-expanded="false" aria-label="More ways to create a load">${ic('down')}</button></div>
        <button type="button" class="icon-btn" data-act="menu" data-menu="loadsMore" aria-haspopup="menu" aria-expanded="false" aria-label="More load board actions">${ic('more')}</button></div>
        ${RL.table(cfg)}`,
    };
  }
  RL.route('/load-management/load-trip', (p, q) => loadBoard(p, q));
  RL.route('/load-management/loads', (p, q) => loadBoard(p, q, 'Loads'));
  RL.viewFilter = tid => tid === 'loads' ? { chip: LS.chip, status: LS.status } : {};
  ACTS['load-chip'] = t => { LS.chip = t.dataset.v; RL.TS.loads && (RL.TS.loads.page = 1); RL.rerender(); };
  CHANGES.ls = t => { LS[t.dataset.k] = t.value; if (RL.TS.loads) RL.TS.loads.page = 1; RL.rerenderTable('loads'); };
  ACTS['dispatch-view'] = t => { LS.dispatchView = !LS.dispatchView; if (!LS.dispatchView && RL.TS.loads) RL.TS.loads.hidden = new Set(['puDate', 'createdBy', 'tag', 'dispatcher']); RL.rerender(); };
  DBL.openLoad = id => { const L = loadById(id); if (L) location.hash = loadUrl(L); };
  MENUS.loadRow = t => { const L = loadById(t.dataset.id); return menu(`Actions for ${L.sid}`, [ml('View load', loadUrl(L)), mi('Edit load', 'row-edit-load', `data-id="${L.id}"`), mi('Share', 'share-load', `data-id="${L.id}"`), mi('Duplicate load', 'duplicate-load', `data-id="${L.id}"`), msep, mi('Delete load', 'delete-load', `data-id="${L.id}"`, 'danger')]); };
  MENUS.newLoadMore = () => menu('Create load', [mi('Manual entry', 'new-load', 'data-tab="manual"'), mi('AI parse rate confirmation', 'new-load', 'data-tab="ai"'), mi('Import Amazon loads (CSV)', 'amazon-import')]);
  MENUS.loadsMore = () => menu('Load board', [ml('Amazon loads', '#/load-management/amazon-loads'), ml('Drivers Unbilled', '#/load-management/drivers-unbilled'), ml('Planning board', '#/planning'), ml('Map view', '#/map')]);
  MENUS.loadBulk = () => { const n = RL.TS.loads ? RL.TS.loads.sel.size : 0; return menu('Bulk actions', [mi(`Add tag (${n})`, 'bulk-tag', n ? '' : 'aria-disabled="true"'), mi(`Change dispatcher (${n})`, 'bulk-dispatcher', n ? '' : 'aria-disabled="true"'), msep, mi(`Delete loads (${n})`, 'bulk-delete', n ? '' : 'aria-disabled="true"', 'danger')]); };
  ACTS['row-edit-load'] = t => { const L = loadById(t.dataset.id); LD.id = L.id; LD.edit = !L.locked; LD.tab = 'info'; location.hash = loadUrl(L); };
  POPS.loadPay = t => { const L = loadById(t.dataset.id); return `<form class="popover" role="dialog" aria-label="Edit load pay" data-submit="load-pay" data-id="${L.id}"><div class="field money"><label for="lp-${L.id}">Load pay</label><input id="lp-${L.id}" name="loadPay" type="number" step="0.01" min="0" required value="${L.loadPay}"></div><div class="pop-foot"><button type="button" class="btn sm" data-act="pop-close">Cancel</button><button type="submit" class="btn sm purple">Save</button></div></form>`; };
  ACTS['pop-close'] = () => RL.closeFloating();
  SUBMITS['load-pay'] = async f => { const L = loadById(f.dataset.id); const v = +f.loadPay.value; if (!(v >= 0) || f.loadPay.value === '') { f.loadPay.setAttribute('aria-invalid', 'true'); return; } const old = L.loadPay; if (await commit(f.querySelector('[type=submit]'), 'update-load-pay', { load: L.sid, loadPay: v }, () => { L.loadPay = v; ev(L, `updated Load pay: ${money(old)} → ${money(v)}`); })) { RL.closeFloating(); RL.rerender(); } };
  ACTS['bulk-tag'] = () => { const ids = [...RL.TS.loads.sel]; formDialog({ title: 'Add tag', size: 'narrow', submit: 'Add tag', name: 'bulk-add-tag', fields: [{ name: 'tag', label: 'Tag', required: true, cls: 'span2' }], build: d => ({ loads: ids, tag: d.tag.toUpperCase() }), apply: p => ids.forEach(id => { const L = loadById(id); if (L && !L.tags.includes(p.tag)) L.tags.push(p.tag); }) }); };
  ACTS['bulk-dispatcher'] = () => { const ids = [...RL.TS.loads.sel]; formDialog({ title: 'Change dispatcher', size: 'narrow', submit: 'Save', name: 'bulk-dispatcher', fields: [{ name: 'dispatcherId', label: 'Dispatcher', type: 'select', required: true, cls: 'span2', options: db.dispatchers.map(d => [d.id, dname(d)]) }], build: d => ({ loads: ids, dispatcherId: +d.dispatcherId }), apply: p => ids.forEach(id => { const L = loadById(id); if (L) L.dispatcherId = p.dispatcherId; }) }); };
  ACTS['bulk-delete'] = () => { const ids = [...RL.TS.loads.sel]; confirmDialog({ title: 'Delete loads', message: `Delete ${ids.length} selected loads from the load board?`, yes: 'Delete', no: 'Cancel', danger: true, name: 'delete-loads', data: { loads: ids }, apply: () => { ids.forEach(id => { const L = loadById(id); if (L) L.deleted = true; }); RL.TS.loads.sel.clear(); } }); };
  ACTS['delete-load'] = t => { const L = loadById(t.dataset.id); confirmDialog({ title: 'Delete load', message: `Delete load ${L.sid} (Load ID ${L.loadId})? It will be removed from the load board.`, yes: 'Delete', no: 'Cancel', danger: true, name: 'delete-load', data: { load: L.sid }, apply: () => { L.deleted = true; if (RL.TS.loads) RL.TS.loads.sel.delete(String(L.id)); }, after: () => { if (/create-load/.test(location.hash)) location.hash = '#/load-management/load-trip'; else RL.rerender(); } }); };
  ACTS['duplicate-load'] = t => {
    const S = loadById(t.dataset.id);
    confirmDialog({ title: 'Duplicate load', message: `Create a copy of ${S.sid} in status Booked? Stops, customer and pay are copied; trips and documents are not.`, yes: 'Duplicate', no: 'Cancel', name: 'duplicate-load', data: { load: S.sid },
      apply: () => { const L = buildLoad({ customerId: S.customerId, mcId: S.mcId, loadId: S.loadId, refId: S.refId, mode: S.mode, equipment: S.equipment, loadPay: S.loadPay, stops: S.stops.map(s => ({ ...s })), special: S.special }); db.loads.push(L); RL._dup = L; },
      after: () => { location.hash = loadUrl(RL._dup); } });
  };

  // ======================= Create New Load =======================
  const SAMPLES = [
    { file: 'rate-confirmation-sample-logistics.pdf', customer: 'Sample Logistics', loadId: '15128819', refId: '20101992', pay: 4200, equipment: 'Dry van', commodity: 'FAK', pieces: 20, weight: 45000, miles: 1010,
      stops: [{ type: 'Pickup', company: 'Prairie Electronics Corp.', address: '3450 Roy Orr Blvd', cityIdx: 0, day: 3, h: 8, h2: 16 }, { type: 'Delivery', company: 'JACFL Parcel Hub', address: '4420 Imeson Rd', cityIdx: 1, day: 5, h: 8, h2: 13 }] },
    { file: 'ratecon-big-state-logistics.pdf', customer: 'Big State Logistics', loadId: 'BSL-772041', refId: 'PO-55120', pay: 3150, equipment: 'Reefer', commodity: 'Frozen poultry', pieces: 22, weight: 41000,
      stops: [{ type: 'Pickup', company: 'Peach State Poultry', address: '1200 Commerce St', cityIdx: 9, day: 2, h: 6, h2: 10 }, { type: 'Delivery', company: 'Evergreen Grocers DC', address: '88 Distribution Way', cityIdx: 12, day: 3, h: 7, h2: 12 }] },
    { file: 'carrier-rate-confirmation-summer.pdf', customer: 'Summer Logistics LLC', loadId: 'SL-90317', refId: '', pay: 2650, equipment: 'Dry van', commodity: 'Paper products', pieces: 26, weight: 38000,
      stops: [{ type: 'Pickup', company: 'Midwest Paper Mill', address: '700 Industrial Pkwy', cityIdx: 13, day: 2, h: 9, h2: 15 }, { type: 'Delivery', company: 'Liberty Paper Products', address: '41 Trade Center Dr', cityIdx: 30, day: 4, h: 8, h2: 14 }] },
  ];
  const sampleStops = s => s.stops.map(x => { const c = RL.CITIES[x.cityIdx]; return { type: x.type, company: x.company, address: x.address, cityIdx: c.i, city: c.city, state: c.state, zip: c.zip, from: RL.dayOff(x.day, x.h), to: RL.dayOff(x.day, x.h2) }; });
  function customerRadios(filter = '') {
    const q = filter.trim().toLowerCase();
    const list = db.customers.filter(c => (q ? c.name.toLowerCase().includes(q) || String(c.mc).includes(q) : c.recent)).slice(0, 12);
    if (!list.length) return '<p class="muted sm">No customers found. Use “+ Create new customer”.</p>';
    return list.map(c => `<label class="radio-row"><input type="radio" name="customerPick" value="${c.id}"><span class="ini" style="background:${c.color}" aria-hidden="true">${esc(c.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span><span>${esc(c.name)} / ${esc(c.address || 'nan')} / ${esc(c.mc || 'nan')}</span></label>`).join('');
  }
  function manualFields() {
    const mcs = RL.selOptions.mcs(), custs = RL.selOptions.customers();
    const stop = (kind, k) => `<fieldset class="card card-pad" style="border:1px solid var(--line-2)"><legend class="b" style="padding:0 6px">${kind}</legend><div class="grid2">
      ${field({ name: k + 'Company', label: 'Company name', required: true, placeholder: kind === 'Pickup' ? 'Shipper' : 'Receiver' })}${field({ name: k + 'Address', label: 'Address', required: true, placeholder: 'Street, City, ST zip', list: 'city-list' })}
      ${field({ name: k + 'From', label: 'Appointment from', type: 'datetime-local', required: true })}${field({ name: k + 'To', label: 'Appointment to', type: 'datetime-local' })}</div></fieldset>`;
    return `<div class="grid3">${field({ name: 'mcId', label: 'MC number', type: 'select', required: true, options: mcs, value: 1, placeholder: false })}${field({ name: 'customerId', label: 'Customer', type: 'select', required: true, options: custs, placeholder: 'Select customer' })}${field({ name: 'loadId', label: 'Load ID', required: true, placeholder: 'Broker load number' })}
      ${field({ name: 'refId', label: 'Reference ID' })}${field({ name: 'mode', label: 'Transportation mode', type: 'select', options: [['FTL', 'Full Truck Load (FTL)'], ['LTL', 'Less Than Truckload (LTL)']], value: 'FTL', placeholder: false })}${field({ name: 'equipment', label: 'Equipment type', type: 'select', required: true, options: ['Dry van', 'Reefer', 'Flatbed', 'Step deck', 'Power only', 'Conestoga'], value: 'Dry van', placeholder: false })}
      ${field({ name: 'loadPay', label: 'Load pay', type: 'money', required: true })}${field({ name: 'miles', label: 'Total miles', type: 'number', hint: 'Leave empty to calculate from the stops' })}${field({ name: 'commodity', label: 'Commodity', placeholder: 'e.g. FAK' })}</div>
      ${stop('Pickup', 'pu')}${stop('Delivery', 'del')}
      ${field({ name: 'special', label: 'Notes (special instructions)', type: 'textarea' })}
      <datalist id="city-list">${RL.CITIES.map(c => `<option value="${esc(`${c.city}, ${c.state} ${c.zip}`)}">`).join('')}</datalist>`;
  }
  function openCreateLoad(tab = 'ai-premium') {
    const tabs = [['ai-premium', 'AI parse Premium'], ['manual', 'Manual entry'], ['ai', 'AI parse'], ['other', 'Other methods']];
    const tid = H.nid();
    const aiPanel = `<div class="col">${field({ name: 'aiMc', label: 'MC number', type: 'select', options: RL.selOptions.mcs(), value: 1, placeholder: false })}
        <input type="search" class="inp" data-input="cnl-search" placeholder="Search…" aria-label="Search customers">
        <div><h3 class="sm" style="margin-bottom:4px">Recent Customers</h3><div class="radios" id="cnl-radios" role="radiogroup" aria-label="Recent Customers" style="max-height:170px;overflow:auto">${customerRadios()}</div></div>
        <div class="field"><span class="lab" id="${tid}-rc">Rate confirmation <span class="req">*</span></span>
        <button type="button" class="drop" data-act="cnl-pick" aria-describedby="${tid}-rc" id="cnl-drop">${ic('upload')}<span>Click or drag file to Rate confirmation</span></button></div>
        <div id="cnl-parsed" aria-live="polite"></div><p class="muted xs" id="cnl-speed"></p></div>`;
    const otherPanel = `<div class="grid2"><div class="card card-pad col"><h3>${ic('upload')} Import Amazon loads (CSV)</h3><p class="muted sm">Create Booked loads from an Amazon Relay CSV export.</p><button type="button" class="btn" data-act="amazon-import" aria-haspopup="dialog">Import CSV</button></div>
      <div class="card card-pad col"><h3>${ic('copy')} Copy an existing load</h3><div class="field"><label for="${tid}-dup">Load</label><select id="${tid}-dup" name="dupFrom">${db.loads.filter(L => !L.deleted).slice(-30).reverse().map(L => `<option value="${L.id}">${L.sid} · ${esc(cust(L.customerId).name)}</option>`).join('')}</select></div><button type="button" class="btn" data-act="cnl-copy">Copy into manual entry</button></div>
      <div class="card card-pad col span2"><h3>${ic('mail')} Email forwarding</h3><p class="muted sm">Forward rate confirmations to <b>loads@roadledger-demo.example</b>; each attachment is parsed with AI parse and appears on the load board in status Booked.</p></div></div>`;
    const d = openModal({ title: 'Create New Load', sub: 'Choose a way of creating your load', kind: 'div', size: 'wide',
      headExtra: `<button type="button" class="btn" data-act="cnl-new-customer" aria-haspopup="dialog">${ic('plus')}Create new customer</button>`,
      body: `<div class="method-tabs" role="tablist" aria-label="Load creation method">${tabs.map(([k, t]) => `<button type="button" role="tab" id="cnl-tab-${k}" aria-controls="cnl-p-${k === 'ai' ? 'ai-premium' : k}" aria-selected="${k === tab}" data-act="cnl-tab" data-v="${k}">${esc(t)}</button>`).join('')}</div>
        <div role="tabpanel" id="cnl-p-ai-premium" aria-labelledby="cnl-tab-ai-premium" ${tab === 'ai-premium' || tab === 'ai' ? '' : 'hidden'}>${aiPanel}</div>
        <div role="tabpanel" id="cnl-p-manual" aria-labelledby="cnl-tab-manual" ${tab === 'manual' ? '' : 'hidden'}>${manualFields()}</div>
        <div role="tabpanel" id="cnl-p-other" aria-labelledby="cnl-tab-other" ${tab === 'other' ? '' : 'hidden'}>${otherPanel}</div>`,
      footer: `<button type="button" class="btn" data-act="dlg-close">Cancel</button><button type="submit" class="btn purple" id="cnl-done">Done</button>` });
    d.state = { tab, parsed: null, parsing: false };
    RL._cnl = d;
    syncCnl();
    d.form.addEventListener('submit', e => { e.preventDefault(); cnlDone(d); });
    d.form.addEventListener('change', e => { if (e.target.name === 'customerPick') syncCnl(); });
    return d;
  }
  function syncCnl() {
    const d = RL._cnl; if (!d || !d.root.isConnected) return;
    const s = d.state, ai = s.tab === 'ai' || s.tab === 'ai-premium';
    const done = d.el.querySelector('#cnl-done');
    done.disabled = ai ? !s.parsed || s.parsing : s.tab === 'other';
    const sp = d.el.querySelector('#cnl-speed'); if (sp) sp.textContent = s.tab === 'ai-premium' ? 'AI parse Premium reads a rate confirmation in about 10 seconds and fills every field.' : s.tab === 'ai' ? 'AI parse reads a rate confirmation in about 15 seconds.' : '';
  }
  ACTS['new-load'] = t => { RL.closeFloating(); openCreateLoad(t.dataset.tab || 'ai-premium'); };
  ACTS['cnl-tab'] = t => {
    const d = RL._cnl; const k = t.dataset.v; d.state.tab = k;
    H.$$('[role=tab]', t.parentElement).forEach(x => x.setAttribute('aria-selected', String(x === t)));
    const panel = k === 'ai' ? 'ai-premium' : k;
    H.$$('[role=tabpanel]', d.el).forEach(p => (p.hidden = p.id !== 'cnl-p-' + panel));
    H.$('#cnl-p-ai-premium', d.el).setAttribute('aria-labelledby', 'cnl-tab-' + (k === 'ai' ? 'ai' : 'ai-premium'));
    syncCnl();
  };
  CHANGES['cnl-search'] = t => { const box = H.$('#cnl-radios'); if (box) box.innerHTML = customerRadios(t.value); };
  ACTS['cnl-new-customer'] = () => RL.createCustomer(p => { const box = H.$('#cnl-radios'); if (box) { box.innerHTML = customerRadios(p.name); const r = box.querySelector(`input[value="${p.id}"]`); if (r) r.checked = true; } const sel = RL._cnl && RL._cnl.el.querySelector('[name=customerId]'); if (sel) { sel.insertAdjacentHTML('beforeend', `<option value="${p.id}">${esc(p.name)} / ${esc(p.mc || 'nan')}</option>`); } });
  ACTS['cnl-pick'] = t => {
    // Simulated file pick: a sample rate confirmation is "parsed" for 2 seconds, then the load fields are filled.
    const d = RL._cnl; if (d.state.parsing) return;
    const sample = SAMPLES[db.seq.parse % SAMPLES.length];
    d.state.parsing = true; d.state.parsed = null; syncCnl();
    t.classList.add('busy'); t.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(sample.file)}</span><span class="muted sm">${d.state.tab === 'ai' ? 'AI parse' : 'AI parse Premium'} is reading the rate confirmation… It will take some time</span>`;
    H.$('#cnl-parsed', d.el).innerHTML = '';
    setTimeout(() => {
      if (!d.root.isConnected) return;
      db.seq.parse++;
      d.state.parsing = false; d.state.parsed = sample;
      t.classList.remove('busy'); t.innerHTML = `${ic('file')}<span class="filechip">${esc(sample.file)}</span><span class="muted sm">Click to choose another file</span>`;
      const st = sampleStops(sample);
      H.$('#cnl-parsed', d.el).innerHTML = `<div class="parsed" role="status" aria-label="Parsed rate confirmation"><div><small class="muted">Customer</small><div class="b">${esc(sample.customer)}</div></div><div><small class="muted">Load ID</small><div class="b">${esc(sample.loadId)}</div></div><div><small class="muted">Load pay</small><div class="b">${money(sample.pay)}</div></div>
        <div><small class="muted">Pickup</small><div>${esc(st[0].company)}, ${esc(place(st[0]))}</div></div><div><small class="muted">Delivery</small><div>${esc(st[1].company)}, ${esc(place(st[1]))}</div></div><div><small class="muted">Equipment</small><div>${esc(sample.equipment)} · ${esc(sample.commodity)}</div></div></div>`;
      syncCnl();
    }, 2000);
  };
  ACTS['cnl-copy'] = t => {
    const d = RL._cnl; const S = loadById(d.form.dupFrom.value); if (!S) return;
    ACTS['cnl-tab'](H.$('#cnl-tab-manual', d.el));
    const f = d.form, set = (n, v) => { if (f[n]) f[n].value = v == null ? '' : v; };
    set('mcId', S.mcId); set('customerId', S.customerId); set('loadId', S.loadId); set('refId', S.refId); set('mode', S.mode); set('equipment', S.equipment); set('loadPay', S.loadPay);
    const a = firstStop(S), b = lastStop(S);
    set('puCompany', a.company); set('puAddress', `${a.address}, ${a.city}, ${a.state} ${a.zip}`); set('puFrom', RL.dayOff(1, 8)); set('delCompany', b.company); set('delAddress', `${b.address}, ${b.city}, ${b.state} ${b.zip}`); set('delFrom', RL.dayOff(3, 8));
  };
  function cnlDone(d) {
    const s = d.state;
    let o;
    if (s.tab === 'manual') {
      const panel = H.$('#cnl-p-manual', d.el); if (!validate(panel)) return;
      const f = readForm(d.form);
      const pu = parseLocation(f.puAddress), de = parseLocation(f.delAddress);
      const street = a => String(a).split(',')[0];
      o = { customerId: +f.customerId, mcId: +f.mcId, loadId: f.loadId.trim(), refId: f.refId, mode: f.mode, equipment: f.equipment, loadPay: +f.loadPay, miles: +f.miles || 0, special: f.special, commodity: f.commodity,
        stops: [{ type: 'Pickup', company: f.puCompany, address: street(f.puAddress), ...pu, from: f.puFrom, to: f.puTo || '' }, { type: 'Delivery', company: f.delCompany, address: street(f.delAddress), ...de, from: f.delFrom, to: f.delTo || '' }], method: 'manual' };
    } else {
      if (!s.parsed) { toast('Add a rate confirmation first', 'error'); return; }
      const picked = d.form.querySelector('[name=customerPick]:checked');
      const c = picked ? cust(picked.value) : db.customers.find(x => x.name === s.parsed.customer) || db.customers[0];
      const smp = s.parsed;
      o = { customerId: c.id, mcId: +d.form.aiMc.value || 1, loadId: smp.loadId, refId: smp.refId, mode: 'FTL', equipment: smp.equipment, loadPay: smp.pay, miles: smp.miles, commodity: smp.commodity, pieces: smp.pieces, weight: smp.weight, stops: sampleStops(smp), rateCon: smp.file, parsedBy: s.tab === 'ai' ? 'AI parse' : 'AI parse Premium', tags: ['AUTOBOT'], method: s.tab };
    }
    const dup = db.loads.find(L => !L.deleted && L.loadId === o.loadId);
    const create = async (btn, after) => {
      const ok = await commit(btn, 'create-load', { method: o.method, loadId: o.loadId, customer: cust(o.customerId).name, loadPay: o.loadPay, pickup: place(o.stops[0]), delivery: place(o.stops[1]) },
        () => { const L = buildLoad(o); db.loads.push(L); RL._created = L; });
      if (ok) { if (after) after(); d.close(); location.hash = loadUrl(RL._created); }
    };
    if (dup) {
      const c = openModal({ title: 'Confirmation', kind: 'native', size: 'narrow', body: `<div class="row" style="align-items:flex-start"><span class="confirm-icon">${ic('warn')}</span><p style="margin:0">The load with the current LOAD ID exists in the system, Please see below.<br>Do you still want to proceed to create the load?</p></div>
          <dl class="kv"><dt>Shipment ID:</dt><dd>${dup.sid}</dd><dt>Load ID:</dt><dd>${esc(dup.loadId)}</dd><dt>Customer:</dt><dd>${esc(cust(dup.customerId).name)}</dd><dt>Load Pay:</dt><dd>${money(dup.loadPay)}</dd><dt>Total miles:</dt><dd>${num(dup.miles.total)}</dd></dl>`,
        footer: `<button type="button" class="btn" data-act="dlg-close">No</button><button type="submit" class="btn purple">Yes</button>` });
      c.el.setAttribute('role', 'alertdialog');
      c.form.addEventListener('submit', e => { e.preventDefault(); create(c.form.querySelector('[type=submit]'), () => c.close()); });
      return;
    }
    create(d.form.querySelector('#cnl-done'));
  }

  // ======================= load detail =======================
  const LD = { id: null, tab: 'info', edit: false, act: 'events', map: false, op: null, noteOpen: false };
  const STEPS = ['Offer', 'Booked', 'Assigned', 'Dispatched', 'In-Transit', 'Delivered', 'Invoiced', 'Paid'];
  function stepper(L) {
    const cur = ORDER.indexOf(L.status);
    return `<ol class="stepper" aria-label="Load status">${STEPS.map((s, i) => `<li class="step ${i < cur ? 'done' : i === cur ? 'cur done' : ''}" ${i === cur ? 'aria-current="step"' : ''} style="list-style:none"><span class="dot">${i + 1}</span><span class="lbl2">${s}</span></li>`).join('')}</ol>`;
  }
  function primaryActions(L) {
    const b = (label, act, cls = 'primary', extra = '') => `<button type="button" class="btn ${cls}" data-act="${act}" data-id="${L.id}" ${extra}>${esc(label)}</button>`;
    switch (L.status) {
      case 'offer': return b('Mark as Booked', 'mark-booked');
      case 'booked': return b('Assign', 'assign-open', '', 'data-mode="assign" aria-haspopup="dialog"') + b('Dispatch', 'assign-open', 'primary', 'data-mode="dispatch" aria-haspopup="dialog"');
      case 'assigned': return b('Dispatch to driver', 'dispatch-load');
      case 'dispatched': return b('Mark as In-Transit', 'mark-in-transit') + b('Set ETA', 'set-eta', '', 'aria-haspopup="dialog"');
      case 'in_transit': return b('Mark as Delivered', 'mark-delivered') + b('Set ETA', 'set-eta', '', 'aria-haspopup="dialog"');
      case 'delivered': return b('Create invoice', 'create-invoice');
      default: return b('View invoice', 'view-invoice', 'primary', 'aria-haspopup="dialog"');
    }
  }
  const kv = (label, value, cls = '') => `<div class="k"><small>${esc(label)}</small><b class="${cls}">${value}</b></div>`;
  const inp = (name, label, value, opts = {}) => field({ name, label, value, ...opts });
  function detailCards(L) {
    const E = LD.edit, c = cust(L.customerId), t0 = L.trips[0];
    const onTime = v => v == null ? '<span class="green">N/A</span>' : v ? '<span class="green">On time</span>' : '<span class="red">Late</span>';
    const pu = firstStop(L), de = lastStop(L);
    const ptOnTime = L.pickedAt ? true : null, dlOnTime = L.deliveredAt ? (L.stopsOnTime !== false) : null;
    const etaOk = L.eta.at ? L.eta.at <= (de.to || de.from) : false;
    const loadInfo = E ? `<div class="grid2">${inp('mcId', 'MC number', L.mcId, { type: 'select', options: RL.selOptions.mcs(), required: true, placeholder: false })}${inp('loadId', 'Load ID', L.loadId, { required: true })}${inp('mode', 'Transportation mode', L.mode, { type: 'select', options: [['FTL', 'Full Truck Load (FTL)'], ['LTL', 'Less Than Truckload (LTL)']], placeholder: false })}${inp('refId', 'Reference ID', L.refId)}</div>`
      : `<div class="kvs">${kv('MC Number', esc(mcOf(L.mcId).name))}${kv('Load ID', esc(L.loadId) + copyBtn(L.loadId, 'Load ID'))}${kv('Transportation mode', L.mode === 'LTL' ? 'Ltl' : 'Ftl')}${kv('Reference ID', esc(L.refId || 'N/A'))}</div>`;
    const mileage = E ? `<div class="grid2">${inp('mileageType', 'Mileage type', L.mileageType, { type: 'select', options: ['Google map', 'Trucking', 'PC Miler', 'PC Miler Practical', 'Manual'], placeholder: false })}${kv('Total miles', num(L.miles.total) + ' mile', 'big')}${inp('loadedMiles', 'Loaded miles', L.miles.loaded, { type: 'number', step: '0.01' })}${inp('emptyMiles', 'Empty miles', L.miles.empty, { type: 'number', step: '0.01', hint: 'Automatic from the previous delivery; edit to override' })}</div>`
      : `<div class="kvs">${kv('Mileage type', esc(L.mileageType))}${kv('Total miles', num(L.miles.total) + ' mile', 'big')}${kv('Loaded miles', num(L.miles.loaded) + ' mile', 'big')}${kv('Empty miles', num(L.miles.empty) + ' mile', 'big')}</div>`;
    const customer = E ? inp('customerId', 'Customer', L.customerId, { type: 'select', options: RL.selOptions.customers(), required: true, placeholder: false })
      : `<div class="row">${ic('building')}<a href="#/customer-management/customers/${c.id}">${esc(c.name.toUpperCase())}</a><span class="muted sm">ID: ${esc(c.mc)}</span></div><div class="muted sm" style="margin-top:4px">${esc(c.email || '')}</div>`;
    const payment = E ? `<div class="grid2">${inp('loadPay', 'Load pay', L.loadPay, { type: 'money', required: true })}${inp('totalPayRo', 'Total pay', totalPay(L), { type: 'money', readonly: true })}${inp('paymentType', 'Payment type', L.paymentType, { type: 'select', options: ['Standard', 'Quick pay', 'Factoring', 'COD'] })}${inp('pmr', 'Per mile revenue', L.miles.total ? (totalPay(L) / L.miles.total).toFixed(2) : '0', { readonly: true })}</div>`
      : `<div class="kvs">${kv('Load pay', money(L.loadPay) + copyBtn(L.loadPay, 'load pay'), 'big')}${kv('Total pay', money(totalPay(L)), 'big')}${kv('Payment type', esc(L.paymentType === 'Standard' ? 'N/A' : L.paymentType))}${kv('Per mile revenue', L.miles.total ? (totalPay(L) / L.miles.total).toFixed(2) : '0')}</div>`;
    const stopsInfo = `<div class="kvs">${kv('Pickup time', fmtLong(pu.from))}${kv('Delivery time', fmtLong(de.from))}${kv('On time pickup', onTime(ptOnTime))}${kv('On time delivery', onTime(dlOnTime))}</div>`;
    const inv = L.invoice;
    const invoiceCard = `<div class="kvs">${kv('Created date', inv.createdAt ? fmtLong(inv.createdAt) : 'N/A')}${kv('Batch status', pill(inv.status, inv.status.toLowerCase()))}${kv('Batch number', inv.batchId ? `<a href="#/accounting/invoices/batches/view-batch/${inv.batchId}">IB-000${inv.batchId}</a>` : 'N/A')}${kv('Customer billing type', esc(inv.billingType))}</div>`;
    const equipment = E ? `<div class="grid2">${inp('equipment', 'Equipment type', L.equipment, { type: 'select', options: ['Dry van', 'Reefer', 'Flatbed', 'Step deck', 'Power only', 'Conestoga'], placeholder: false })}${inp('equipments', 'Equipments', L.equipments.join(', '), { hint: 'Comma separated' })}${inp('addEquip', 'Additional equipments', L.addEquip.join(', '), { placeholder: 'Load bars, Straps…' })}${inp('driverReq', 'Driver requirements', L.driverReq.join(', '), { placeholder: 'TWIC, Hazmat…' })}</div>`
      : `<div class="kvs">${kv('Equipment type', `<span class="equip-chip">${esc(L.equipment)}</span>`)}${kv('Equipments', L.equipments.map(e => `<span class="equip-chip">${esc(e)}</span>`).join('') + ' <span class="muted sm">+24 more</span>')}${kv('Additional equipments', esc(L.addEquip.join(', ') || '-'))}${kv('Driver requirements', esc(L.driverReq.join(', ') || '-'))}</div>`;
    const eta = `<div class="kvs">${kv('ETA', L.eta.at ? `<span class="green">${fmtTime(L.eta.at)}</span>` : '-')}${kv('ETA date', L.eta.at ? fmtDate(L.eta.at) : '-')}${kv('Miles', L.eta.miles ? num(L.eta.miles) + ' miles' : '-')}${kv('Potential on time pickup', L.eta.at ? (etaOk ? '<span class="green">On time</span>' : '<span class="red">Not on time</span>') : '<span class="red">Not on time</span>')}</div>`;
    const sb = t0 && t0.salaryBatchId;
    const ap = `<div class="kvs">${kv('Salary batch number', sb ? `<a href="#/accounting/salary/driver-settlements/batch-view/${sb}">SB-000${sb}</a>` : 'N/A')}${kv('Driver billing status', pill(t0 ? t0.billing || 'PENDING' : 'PENDING', t0 && t0.billing === 'PAID' ? 'paid' : t0 && t0.billing === 'IN BATCH' ? 'posted' : 'pending'))}${kv('Dispatcher batch number', 'N/A')}${kv('Dispatcher billing status', pill('PENDING', 'pending'))}</div>`;
    const special = E ? inp('special', 'Special Instructions', L.special, { type: 'textarea' }) : `<div class="k"><small>Special Instructions</small><b>${esc(L.special || '-')}</b></div>`;
    const ft = L.freightTags;
    const tagsCard = [['temperature', 'Temperature requirements'], ['hazmat', 'Hazardous materials'], ['oversize', 'Oversize / overweight'], ['highValue', 'High value'], ['team', 'Team required']].map(([k, lbl]) => `<div class="field check"><input type="checkbox" form="ld-form" id="ft-${k}" name="ft_${k}" ${ft[k] ? 'checked' : ''} ${E ? '' : 'disabled'}><label for="ft-${k}">${lbl}</label></div>`).join('');
    return `<form id="ld-form" aria-label="Load details" novalidate><div class="details-grid">
      <section class="dcard" aria-label="Load info"><h3>Load info</h3>${loadInfo}</section>
      <section class="dcard" aria-label="Mileage Calculation"><h3>Mileage Calculation <button type="button" class="btn sm" data-act="mapping" data-id="${L.id}" aria-haspopup="dialog">Mapping</button></h3>${mileage}</section>
      <section class="dcard" aria-label="Customer"><h3>Customer</h3>${customer}</section>
      <section class="dcard" aria-label="Payment"><h3>Payment</h3>${payment}</section>
      <section class="dcard" aria-label="Stops Info"><h3>Stops Info</h3>${stopsInfo}</section>
      <section class="dcard" aria-label="Invoice Billing - Accounts receivable"><h3>Invoice Billing - Accounts receivable</h3>${invoiceCard}</section>
      <section class="dcard" aria-label="Equipment and additional requirements"><h3>Equipment and additional requirements</h3>${equipment}</section>
      <section class="dcard" aria-label="Expected time of arrival (ETA)"><h3>Expected time of arrival (ETA)</h3>${eta}</section>
      <section class="dcard" aria-label="Accounts Payable Billing"><h3>Accounts Payable Billing</h3>${ap}</section>
      <section class="dcard span3" aria-label="Special Instructions"><h3>Special Instructions</h3>${special}</section>
      </div></form>
      ${otherPayCard(L)}
      <div class="details-grid" style="margin-top:12px"><section class="dcard span2" aria-label="Commodities"><h3>Commodities <button type="button" class="btn sm" data-act="add-commodity" data-id="${L.id}" aria-haspopup="dialog">${ic('plus')}Add commodity</button></h3>${commoditiesTable(L)}</section>
      <section class="dcard" aria-label="Freight tags"><h3>Freight tags</h3><div class="col">${tagsCard}</div></section></div>`;
  }
  function commoditiesTable(L) {
    return `<div style="overflow:auto"><table class="t" aria-label="Commodities"><thead><tr>${['Description', 'QTY', 'Type', 'PCS', 'TOTAL WT', 'Width', 'Height', 'Length', 'Note', ''].map(h => `<th scope="col">${h ? h : '<span class="sr-only">Actions</span>'}</th>`).join('')}</tr></thead><tbody>${L.commodities.length ? L.commodities.map((c, i) => `<tr><td>${esc(c.desc)}</td><td>${c.qty}</td><td>${esc(c.type)}</td><td>${c.pcs}</td><td>${num(c.wt)} lb</td><td>${c.w}</td><td>${c.h}</td><td>${c.l}</td><td>${esc(c.note || '-')}</td><td><button type="button" class="icon-btn" data-act="del-commodity" data-id="${L.id}" data-i="${i}" aria-label="Remove commodity ${esc(c.desc)}">${ic('trash')}</button></td></tr>`).join('') : '<tr><td colspan="10" class="empty">No commodities</td></tr>'}</tbody></table></div>`;
  }
  const CHARGES = ['Detention', 'Lumper', 'Layover', 'TONU', 'Fuel surcharge', 'Stop off', 'Driver assist', 'Other'];
  const PAYTYPES = [['Customer', 'Customer charge'], ['Driver', 'Driver pay'], ['Company', 'Company expense']];
  function otherPayCard(L) {
    const op = LD.op || { rows: L.otherPay.map(o => ({ ...o })), tonu: L.tonu, tonuAmount: L.tonuAmount, dirty: false };
    LD.op = op;
    const rows = op.rows.length ? op.rows : [];
    const total = rows.reduce((a, o) => a + (+o.amount || 0), 0);
    const row = (o, i) => `<div class="other-pay" role="group" aria-label="Other pay row ${i + 1}"><select data-change="op" data-i="${i}" data-k="charge" aria-label="Pay/other charges, row ${i + 1}"><option value="">Select…</option>${CHARGES.map(c => `<option ${c === o.charge ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <select data-change="op" data-i="${i}" data-k="type" aria-label="Type, row ${i + 1}"><option value="">Select…</option>${PAYTYPES.map(([v, l]) => `<option value="${v}" ${v === o.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="number" step="0.01" min="0" value="${o.amount === '' ? '' : o.amount}" data-change="op" data-i="${i}" data-k="amount" aria-label="Amount, row ${i + 1}" placeholder="$"><input value="${esc(o.note || '')}" data-change="op" data-i="${i}" data-k="note" aria-label="Note, row ${i + 1}" placeholder="Note">
      <button type="button" class="icon-btn" data-act="op-del" data-i="${i}" aria-label="Remove other pay row ${i + 1}">${ic('x')}</button></div>`;
    return `<section class="dcard" style="margin-top:12px" aria-label="Other pay"><h3>Other pay</h3>
      <div class="other-pay"><span class="h">Pay/other charges</span><span class="h">Type</span><span class="h">Amount</span><span class="h">Note</span><span></span></div>
      <div class="col" style="margin-top:6px">${rows.map(row).join('') || '<p class="muted sm" style="margin:4px 0">No other pay yet. Add detention, lumper or another pay below.</p>'}</div>
      <div class="op-links"><span>Total amount: <b>${money(total)}</b></span><span class="grow"></span>
        <label class="row sm"><input type="checkbox" data-change="op-tonu" ${op.tonu ? 'checked' : ''} style="accent-color:var(--brand)"> TONU</label>
        ${op.tonu ? `<label class="row sm">TONU amount <input class="inp" style="width:110px;height:30px" type="number" min="0" step="0.01" value="${op.tonuAmount || ''}" data-change="op-tonu-amt" aria-label="TONU amount"></label>` : ''}
        <button type="button" class="btn link" data-act="create-echeck" data-id="${L.id}" aria-haspopup="dialog">+ Create e-check</button>
        <button type="button" class="btn link" data-act="op-add" data-v="Detention">+ Add New Detention</button>
        <button type="button" class="btn link" data-act="op-add" data-v="Lumper">+ Add New Lumper</button>
        <button type="button" class="btn link" data-act="op-add" data-v="">+ Add Another Pay</button></div>
      ${op.dirty ? `<div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn" data-act="op-cancel">Cancel</button><button type="button" class="btn purple" data-act="op-save" data-id="${L.id}">Save other pay</button></div>` : ''}</section>`;
  }
  function stopsTable(L) {
    const locked = L.locked;
    return `<div class="stops"><table aria-label="Stops"><thead><tr><th scope="col">Stop position</th><th scope="col">Company name</th><th scope="col">Stop location</th><th scope="col">Zip</th><th scope="col">Appointment date</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${L.stops.map((s, i) => `<tr><td><span class="drag" aria-hidden="true">${ic('grip')}</span> <b>${stopLabel(L, i)}</b></td><td class="b">${esc(s.company)}</td><td><span class="pin${s.type === 'Delivery' ? ' blue' : ''}">${ic('pin')}</span> ${esc(placeLong(s))}</td><td>${esc(s.zip)}</td><td>${apptRange(s)}</td>
        <td><button type="button" class="icon-btn" data-act="menu" data-menu="stopRow" data-id="${L.id}" data-i="${i}" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for stop ${stopLabel(L, i)}" ${locked ? 'disabled' : ''}>${ic('more')}</button></td></tr>`).join('')}
      ${locked ? '' : `<tr><td><button type="submit" form="add-stop-form" class="btn link" style="color:var(--green)">+ Add stop position</button></td>
        <td><input form="add-stop-form" name="company" placeholder="Add company name" aria-label="Add company name"></td><td><input form="add-stop-form" name="location" placeholder="Add stop location" aria-label="Add stop location" list="city-list-2"></td>
        <td><input form="add-stop-form" name="zip" placeholder="Add Zip" aria-label="Add Zip"></td><td><input form="add-stop-form" name="from" type="datetime-local" aria-label="Appointment date"></td>
        <td><select form="add-stop-form" name="type" aria-label="Stop type"><option>Delivery</option><option>Pickup</option></select></td></tr>`}
      </tbody></table><form id="add-stop-form" data-submit="add-stop" data-id="${L.id}" novalidate aria-label="Add stop position"></form><datalist id="city-list-2">${RL.CITIES.map(c => `<option value="${esc(`${c.city}, ${c.state}`)}">`).join('')}</datalist></div>`;
  }
  function tripsTable(L, big) {
    if (!L.trips.length) return `<div class="trips-card"><div class="card-h"><h3 style="color:var(--brand)">Trips</h3><span class="grow"></span>${['booked', 'offer'].includes(L.status) ? `<button type="button" class="btn primary" data-act="assign-open" data-mode="dispatch" data-id="${L.id}" aria-haspopup="dialog">Dispatch to driver</button>` : ''}</div><div class="empty muted">This load does not have a trip assigned to the driver yet</div></div>`;
    const canSplit = L.trips.length === 1 && ['assigned', 'dispatched', 'in_transit'].includes(L.status);
    return `<div class="trips-card"><div class="card-h"><h3 style="color:var(--brand)">Trips</h3><span class="grow"></span>${canSplit ? `<button type="button" class="btn sm" data-act="split-trip" data-id="${L.id}" aria-haspopup="dialog">${ic('split')}Split trip</button>` : ''}<span class="hint-dbl">${ic('eye')}Double click on the row to view Trip</span></div>
      <div style="overflow:auto"><table class="t" aria-label="Trips"><thead><tr><th scope="col">Trip ID</th><th scope="col">Status</th><th scope="col">Pickup</th><th scope="col">Delivery</th><th scope="col">Driver/Carrier</th><th scope="col">Truck</th>${big ? '<th scope="col">Trailer</th><th scope="col" class="num">Loaded miles</th><th scope="col" class="num">Empty miles</th>' : ''}<th scope="col" class="num">Driver pay</th><th scope="col"><span class="sr-only">Confirmed</span></th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${L.trips.map(t => { const a = t.relayFrom ? t.relayPoint || { city: 'Grand Prairie', state: 'TX' } : L.stops[t.from]; const b = t.relay ? t.relay : L.stops[t.to] || lastStop(L); const tk = trk(t.truckId), tl = trl(t.trailerId), d = drv(t.driverId);
        return `<tr data-dbl="trip" data-id="${L.id}|${t.id}" tabindex="0" aria-label="Trip ${t.id}"><td class="b">${t.split ? ic('split') + ' ' : ''}${t.id} <button type="button" class="icon-btn" style="width:22px;height:22px;color:var(--brand)" data-act="trip-open" data-id="${L.id}" data-trip="${t.id}" aria-haspopup="dialog" aria-label="Edit trip ${t.id}">${ic('edit')}</button></td>
          <td><span class="outline-st">${esc(t.status)}</span></td><td><span class="pin">${ic('pin')}</span> ${esc(placeLong(a))}</td><td><span class="pin blue">${ic('pin')}</span> ${esc(placeLong(b))}</td>
          <td>${t.carrierId ? esc((H.carrier(t.carrierId) || {}).name) : d ? `<a href="#/hr-management/edit-driver/${d.id}/detail">${esc(dname(d))}/</a>` : '-'}</td><td>${tk ? `<a href="#/fleet-management/trucks/${tk.id}">${esc(tk.unit)}</a>` : '-'}</td>
          ${big ? `<td>${tl ? esc(tl.unit) : '-'}</td><td class="num">${num(t.loadedMiles)}</td><td class="num">${num(t.emptyMiles)}</td>` : ''}<td class="num">${money(t.driverPay)}</td><td>${t.confirmed ? '<span class="filter-chip" style="padding-right:10px">Confirmed trip</span>' : '<span class="muted sm">Not confirmed</span>'}</td>
          <td>${t.split || L.trips.length > 1 ? `<button type="button" class="icon-btn" data-act="delete-trip" data-id="${L.id}" data-trip="${t.id}" aria-label="Delete trip ${t.id}">${ic('trash')}</button>` : ''}</td></tr>`; }).join('')}
      </tbody></table></div></div>`;
  }
  function activityCard(L) {
    const tab = LD.act;
    const tabs = [['events', 'Events'], ['notes', 'Notes'], ['chat', 'Chat']];
    let body;
    if (tab === 'events') body = `<div class="feed">${[...L.events].reverse().map(e => `<div><small>${fmtEvt(e.at)}</small>${esc(e.text)}</div>`).join('')}</div>`;
    else if (tab === 'notes') body = `${LD.noteOpen ? `<form data-submit="add-note" data-id="${L.id}" class="col" style="margin-top:8px"><div class="field"><label for="note-${L.id}">New note</label><textarea id="note-${L.id}" name="text" required></textarea></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn sm" data-act="note-cancel">Cancel</button><button type="submit" class="btn sm purple">Save note</button></div></form>` : `<button type="button" class="btn sm" style="margin-top:8px" data-act="note-open">New note</button>`}
      <div class="feed">${L.notes.length ? [...L.notes].reverse().map(n => `<div><small>${fmtEvt(n.at)} · ${esc(n.by)}</small>${esc(n.text)}</div>`).join('') : '<p class="muted" style="text-align:center">No notes</p>'}</div>`;
    else body = `<div class="feed">${L.chat.length ? L.chat.map(m => `<div class="bubble${m.me ? ' me' : ''}"><small>${esc(m.from)}</small>${esc(m.text)}<small>${fmtMDY(m.at)} ${fmtTime(m.at)}</small></div>`).join('') : '<p class="muted" style="text-align:center">No messages with the driver yet</p>'}</div>
      <form class="chat-in" data-submit="send-chat" data-id="${L.id}"><input name="text" placeholder="Type a message" aria-label="Message to driver" autocomplete="off"><button type="submit" class="icon-btn" aria-label="Send message">${ic('send')}</button></form>`;
    return `<section class="side-card" aria-label="Activity"><h3>Activity</h3><div class="pill-tabs" role="tablist" aria-label="Activity">${tabs.map(([k, t]) => `<button type="button" role="tab" aria-selected="${tab === k}" aria-controls="act-panel" data-act="act-tab" data-v="${k}">${t}</button>`).join('')}</div><div id="act-panel" role="tabpanel" aria-label="${tab}">${body}</div></section>`;
  }
  function profitCard(L) {
    const rev = L.tonu ? totalPay(L) : L.loadPay, acc = L.tonu ? 0 : accessorials(L), dp = driverPayOf(L), bills = 0, gp = r2(rev + acc - dp - bills);
    return `<section class="side-card profit" aria-label="Profit box"><h3>Profit box</h3><div class="pill-tabs"><span class="st round" style="background:var(--brand);min-width:60px">Actual</span></div>
      <h3 style="margin:12px 0 6px;font-size:15px">Customer</h3><div class="pr"><span>Total mile revenue</span><span class="blue">${money(rev)}</span></div><div class="pr"><span>Accessorials</span><span>${money(acc)}</span></div>
      <div class="pr"><span>Driver pay</span><span class="red">(${money(dp)})</span></div><div class="pr"><span>Bills</span><span class="red">(${money(bills)})</span></div><div class="pr"><span>Gross profit</span><b>${money(gp)}</b></div><div class="pr"><span>Margin</span><span>${rev + acc ? ((gp / (rev + acc)) * 100).toFixed(1) : '0.0'}%</span></div></section>`;
  }
  function documentsTab(L) {
    return `<section class="card" aria-label="Documents"><div class="card-h"><h3>Documents</h3><span class="grow"></span><button type="button" class="btn purple" data-act="upload-doc" data-id="${L.id}" aria-haspopup="dialog">${ic('upload')}Upload document</button></div>
      <div style="padding:0 14px 14px"><table class="t" aria-label="Load documents"><thead><tr><th scope="col">Document type</th><th scope="col">File name</th><th scope="col">Uploaded by</th><th scope="col">Date</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${L.docs.length ? L.docs.map(d => `<tr><td class="b">${esc(d.type)}</td><td>${ic('file')} ${esc(d.name)}</td><td>${esc(d.by)}</td><td>${fmtDT(d.at)}</td><td><button type="button" class="btn sm" data-act="view-doc" data-id="${L.id}" data-doc="${d.id}" aria-haspopup="dialog">View</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty">No documents uploaded</td></tr>'}
      </tbody></table><p class="muted sm">Required for invoicing: Rate confirmation ${L.docs.some(d => d.type === 'Rate confirmation') ? '✓' : '✗'} · Proof of Delivery ${hasPod(L) ? '✓' : '✗'}</p></div></section>`;
  }
  function mapSvg(L, h = 260) {
    const pts = L.stops.filter(s => s.cityIdx != null).map(s => RL.CITIES[s.cityIdx]);
    const X = lon => ((lon + 125) / 58) * 1000, Y = lat => ((50 - lat) / 26) * 520;
    return `<svg viewBox="0 0 1000 520" role="img" aria-label="Route map from ${esc(place(firstStop(L)))} to ${esc(place(lastStop(L)))}"><rect width="1000" height="520" fill="none"/><path d="M40 90 L250 40 L520 60 L760 70 L930 120 L960 260 L870 330 L840 470 L700 420 L560 470 L420 420 L300 440 L160 360 L60 300 Z" fill="#dcd8cc" stroke="#c5bfae"/>
      ${pts.length > 1 ? `<polyline points="${pts.map(c => `${X(c.lon)},${Y(c.lat)}`).join(' ')}" fill="none" stroke="#6a2ee0" stroke-width="4" stroke-dasharray="2 0"/>` : ''}
      ${pts.map((c, i) => `<g><circle cx="${X(c.lon)}" cy="${Y(c.lat)}" r="9" fill="${i === 0 ? '#3cb371' : '#2f5ce8'}"/><text x="${X(c.lon) + 12}" y="${Y(c.lat) - 10}" font-size="16" fill="#333">${esc(c.city)}</text></g>`).join('')}</svg>`;
  }
  RL.mapSvg = mapSvg;
  function loadDetail(p) {
    const L = loadById(p.id);
    if (!L) return null;
    if (p.status !== H.SLUG[L.status] || p.sid !== L.sid) return { redirect: loadUrl(L) };
    if (LD.id !== L.id) { LD.id = L.id; LD.tab = 'info'; LD.edit = false; LD.act = 'events'; LD.map = false; LD.op = null; LD.noteOpen = false; }
    if (LD.op && !LD.op.dirty) LD.op = null;
    const tabs = [['info', 'LOAD INFO'], ['trips', 'TRIPS'], ['commodities', 'COMMODITIES'], ['documents', 'DOCUMENTS']];
    let main;
    if (LD.tab === 'info') main = `<section class="card" aria-label="Status and stops">${stepper(L)}<h3 style="padding:4px 16px 8px">Stops</h3>${stopsTable(L)}</section>${tripsTable(L)}
      <div class="card-h" style="padding:6px 2px"><h2>Details</h2><span class="grow"></span>${LD.edit ? `<button type="button" class="btn link" data-act="cancel-edit">Cancel</button><button type="button" class="btn link" data-act="save-load" data-id="${L.id}">Save load</button>` : `<button type="button" class="btn link" data-act="edit-load" data-id="${L.id}" ${L.locked ? 'disabled' : ''}>${ic('edit')} Edit load</button>`}</div>${detailCards(L)}`;
    else if (LD.tab === 'trips') main = tripsTable(L, true) + `<section class="card card-pad" aria-label="Trip summary"><h3>Trip summary</h3><div class="grid4" style="margin-top:10px">${kv('Trips', L.trips.length)}${kv('Total driver pay', money(driverPayOf(L)))}${kv('Loaded miles', num(L.miles.loaded))}${kv('Empty miles', num(L.miles.empty))}</div></section>`;
    else if (LD.tab === 'commodities') main = `<section class="card card-pad" aria-label="Commodities"><div class="row" style="margin-bottom:10px"><h3>Commodities</h3><span class="grow"></span><button type="button" class="btn purple" data-act="add-commodity" data-id="${L.id}" aria-haspopup="dialog">${ic('plus')}Add commodity</button></div>${commoditiesTable(L)}</section>`;
    else main = documentsTab(L);
    const following = L.following;
    return {
      crumbs: [['Load management', '#/load-management/load-trip'], `Load / ${L.loadId}`],
      html: `<div class="ld-head" aria-label="Load header">
        <div><div class="ld-title"><a class="icon-btn back" href="#/load-management/load-trip" aria-label="Back to loads">${ic('left')}</a><h1 style="font-size:19px;font-weight:500">Loads / ${L.sid}</h1><span class="st-badge">${RL.STATUS_TEXT[L.status]}</span>${L.locked ? `<span class="locked">${ic('lock')}Locked</span>` : ''}</div>
          <div class="row" style="margin-top:6px"><span class="muted sm">Tags:</span>${L.tags.map(t => `<span class="tag">${esc(t)}<button type="button" class="icon-btn" data-act="remove-tag" data-id="${L.id}" data-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${ic('x')}</button></span>`).join('')}<button type="button" class="icon-btn" style="width:24px;height:24px;border:1px solid var(--brand);border-radius:50%;color:var(--brand)" data-act="menu" data-pop="addTag" data-id="${L.id}" aria-haspopup="dialog" aria-expanded="false" aria-label="Add tag">${ic('plus')}</button></div></div>
        <div class="ld-facts"><div class="f"><small>Load ID</small><b>${esc(L.loadId)}</b>${copyBtn(L.loadId, 'Load ID')}</div><div class="f"><small>Total Pay</small><b>${money(totalPay(L))}</b></div><div class="f"><small>Created by</small><b>${esc(L.createdBy)}</b></div></div>
        <div class="ld-actions"><button type="button" class="follow" data-act="follow-load" data-id="${L.id}" aria-pressed="${following}">${ic(following ? 'user' : 'userplus')}${following ? 'Unfollow load' : 'Follow load'}</button><span class="avatar" aria-hidden="true">TA</span>
          <button type="button" class="btn" data-act="share-load" data-id="${L.id}" aria-haspopup="dialog">${ic('share')}Share</button>${primaryActions(L)}
          ${LD.edit ? `<button type="button" class="btn primary" data-act="save-load" data-id="${L.id}">Save load</button>` : `<button type="button" class="btn" data-act="edit-load" data-id="${L.id}" ${L.locked ? 'disabled title="Invoiced loads are locked. Unlock the load to edit it."' : ''}>${ic('edit')}Edit load</button>`}
          <button type="button" class="icon-btn" data-act="menu" data-menu="loadMore" data-id="${L.id}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${L.sid}">${ic('more')}</button></div>
        <div class="ld-actions2"><button type="button" class="btn sm" data-act="map-toggle" aria-pressed="${LD.map}">${ic('map')}${LD.map ? 'Map hide' : 'Map view'}</button><label class="row sm muted">Commission: <select data-change="commission" data-id="${L.id}" aria-label="Commission">${['', ...db.dispatchers.map(d => `${dname(d)} / ${d.commission}%`)].map(o => `<option ${o === L.commission ? 'selected' : ''} value="${esc(o)}">${esc(o || 'None')}</option>`).join('')}</select></label></div></div>
        ${LD.map ? `<div class="map-box" style="margin-bottom:12px">${mapSvg(L)}</div>` : ''}
        <div class="ld"><div><div class="card" style="margin-bottom:12px"><div class="ul-tabs" role="tablist" aria-label="Load sections" style="padding:0 16px">${tabs.map(([k, t]) => `<button type="button" role="tab" aria-selected="${LD.tab === k}" aria-controls="ld-panel" data-act="ld-tab" data-v="${k}">${t}</button>`).join('')}</div></div>
          <div id="ld-panel" role="tabpanel" aria-label="${tabs.find(x => x[0] === LD.tab)[1]}">${main}</div></div>
          <aside>${activityCard(L)}${profitCard(L)}</aside></div>`,
    };
  }
  RL.route('/load-management/create-load/:status/:id/:sid', loadDetail);
  RL.LD = LD;
  const cur = t => loadById(t.dataset.id || LD.id);
  ACTS['ld-tab'] = t => { LD.tab = t.dataset.v; RL.rerender(); };
  ACTS['act-tab'] = t => { LD.act = t.dataset.v; RL.rerender(); };
  ACTS['map-toggle'] = () => { LD.map = !LD.map; RL.rerender(); };
  ACTS['note-open'] = () => { LD.noteOpen = true; RL.rerender(); const n = H.$('#act-panel textarea'); if (n) n.focus(); };
  ACTS['note-cancel'] = () => { LD.noteOpen = false; RL.rerender(); };
  SUBMITS['add-note'] = async f => { const L = loadById(f.dataset.id); if (!validate(f)) return; const text = f.text.value.trim(); if (await commit(f.querySelector('[type=submit]'), 'add-note', { load: L.sid, text }, () => { L.notes.push({ at: nowIso(), by: ME, text }); LD.noteOpen = false; })) RL.rerender(); };
  SUBMITS['send-chat'] = async f => { const L = loadById(f.dataset.id); const text = f.text.value.trim(); if (!text) { f.text.focus(); return; } if (await commit(f.querySelector('[type=submit]'), 'send-chat', { load: L.sid, text }, () => L.chat.push({ at: nowIso(), from: ME, text, me: true }))) { RL.rerender(); const i = H.$('.chat-in input'); if (i) i.focus(); } };
  ACTS['edit-load'] = t => { const L = cur(t); if (L.locked) { toast('Invoiced loads are locked. Unlock the load to edit it.', 'error'); return; } LD.edit = true; LD.tab = 'info'; RL.rerender(); const f = H.$('#ld-form input, #ld-form select'); if (f) f.focus(); };
  ACTS['cancel-edit'] = () => { LD.edit = false; RL.rerender(); };
  ACTS['save-load'] = async t => {
    const L = cur(t), form = H.$('#ld-form'); if (!form || !validate(form)) return;
    const f = readForm(form);
    const changes = [];
    const next = { mcId: +f.mcId, loadId: f.loadId.trim(), mode: f.mode, refId: f.refId, mileageType: f.mileageType, customerId: +f.customerId, loadPay: +f.loadPay, paymentType: f.paymentType || 'Standard', equipment: f.equipment,
      equipments: String(f.equipments || '').split(',').map(s => s.trim()).filter(Boolean), addEquip: String(f.addEquip || '').split(',').map(s => s.trim()).filter(Boolean), driverReq: String(f.driverReq || '').split(',').map(s => s.trim()).filter(Boolean), special: f.special || '',
      loadedMiles: +f.loadedMiles, emptyMiles: +f.emptyMiles };
    if (next.loadPay !== L.loadPay) changes.push(`updated Load pay: ${money(L.loadPay)} → ${money(next.loadPay)}`);
    if (next.loadId !== L.loadId) changes.push(`updated Load ID: ${L.loadId} → ${next.loadId}`);
    if (next.mcId !== L.mcId) changes.push(`updated MC number: ${mcOf(L.mcId).name} → ${mcOf(next.mcId).name}`);
    if (next.equipment !== L.equipment) changes.push(`updated Equipment type: ${L.equipment} → ${next.equipment}`);
    if (next.customerId !== L.customerId) changes.push(`updated Customer: ${cust(L.customerId).name} → ${cust(next.customerId).name}`);
    if (next.mileageType !== L.mileageType) changes.push(`Re-calculated mileage with ${next.mileageType}`);
    const ok = await commit(t, 'save-load', { load: L.sid, ...next }, () => {
      const typeChanged = next.mileageType !== L.mileageType;
      Object.assign(L, { mcId: next.mcId, loadId: next.loadId, mode: next.mode, refId: next.refId, mileageType: next.mileageType, customerId: next.customerId, loadPay: next.loadPay, paymentType: next.paymentType, equipment: next.equipment, equipments: next.equipments, addEquip: next.addEquip, driverReq: next.driverReq, special: next.special });
      if (typeChanged) { const lm = legMiles(L.stops, L.mileageType); L.miles.loaded = lm || L.miles.loaded; L.miles.empty = r2(next.emptyMiles * ({ Trucking: 1.06, 'PC Miler': 1.03 }[L.mileageType] || 1)); }
      else { L.miles.loaded = next.loadedMiles || L.miles.loaded; L.miles.empty = isNaN(next.emptyMiles) ? L.miles.empty : next.emptyMiles; }
      L.miles.total = r2(L.miles.loaded + L.miles.empty);
      L.customerId = next.customerId; L.invoice.billingType = cust(L.customerId).billingType || L.invoice.billingType;
      Object.keys(L.freightTags).forEach(k => (L.freightTags[k] = !!f['ft_' + k]));
      (changes.length ? changes : ['updated Load']).forEach(c => ev(L, c));
      LD.edit = false;
    });
    if (ok) RL.rerender();
  };
  CHANGES.commission = async t => { const L = cur(t); const v = t.value, old = L.commission; if (!(await commit(null, 'set-commission', { load: L.sid, commission: v }, () => { L.commission = v; ev(L, `set commission ${v || 'None'}`); }))) t.value = old; };
  ACTS['follow-load'] = async t => { const L = cur(t); if (await commit(t, 'follow-load', { load: L.sid, follow: !L.following }, () => (L.following = !L.following))) RL.rerender(); };
  ACTS['remove-tag'] = async t => { const L = cur(t); const tag = t.dataset.tag; if (await commit(t, 'remove-tag', { load: L.sid, tag }, () => (L.tags = L.tags.filter(x => x !== tag)))) RL.rerender(); };
  POPS.addTag = t => `<form class="popover" role="dialog" aria-label="Add tag" data-submit="add-tag" data-id="${t.dataset.id}"><div class="field"><label for="tag-in">Tag</label><input id="tag-in" name="tag" required placeholder="e.g. AUTOBOT"></div><div class="pop-foot"><button type="button" class="btn sm" data-act="pop-close">Cancel</button><button type="submit" class="btn sm purple">Add tag</button></div></form>`;
  POPS.addTag.mount = () => {};
  SUBMITS['add-tag'] = async f => { const L = loadById(f.dataset.id); if (!validate(f)) return; const tag = f.tag.value.trim().toUpperCase(); if (await commit(f.querySelector('[type=submit]'), 'add-tag', { load: L.sid, tag }, () => { if (!L.tags.includes(tag)) L.tags.push(tag); })) { RL.closeFloating(); RL.rerender(); } };
  MENUS.loadMore = t => { const L = cur(t); return menu(`More actions for ${L.sid}`, [mi('Duplicate load', 'duplicate-load', `data-id="${L.id}"`), L.locked ? mi('Unlock load', 'unlock-load', `data-id="${L.id}"`) : '', mi('Print rate confirmation', 'view-doc', `data-id="${L.id}" data-doc="${(L.docs[0] || {}).id || ''}"`, ''), mi('Open in planning board', 'goto', 'data-href="#/planning"'), msep, mi('Delete load', 'delete-load', `data-id="${L.id}"`, 'danger')]); };
  ACTS.goto = t => { RL.closeFloating(); location.hash = t.dataset.href; };
  // Unlock invoiced load: inferred from tutorial title 'How to Edit Invoiced Loads (Unlock & Modify Posted Loads)'.
  ACTS['unlock-load'] = t => { const L = cur(t); confirmDialog({ title: 'Unlock load', message: `Load ${L.sid} is invoiced. Unlocking lets you change it; the invoice in batch ${L.invoice.batchId ? 'IB-000' + L.invoice.batchId : '(none)'} is updated when you save.`, yes: 'Unlock', no: 'Cancel', name: 'unlock-load', data: { load: L.sid }, apply: () => { L.locked = false; ev(L, 'unlocked the invoiced load'); } }); };
  // status lifecycle
  ACTS['mark-booked'] = async t => { const L = cur(t); if (await commit(t, 'mark-booked', { load: L.sid }, () => { L.status = 'booked'; ev(L, 'updated Load to booked status'); })) RL.rerender(); };
  ACTS['dispatch-load'] = async t => { const L = cur(t); if (!L.trips.length) { openAssign(L, 'dispatch'); return; } if (await commit(t, 'dispatch-load', { load: L.sid, trip: L.trips[0].id }, () => { L.status = 'dispatched'; L.trips.forEach(x => setDriverBusy(x, 'dispatched')); ev(L, 'updated Load to dispatched status'); })) RL.rerender(); };
  ACTS['mark-in-transit'] = async t => { const L = cur(t); if (await commit(t, 'mark-in-transit', { load: L.sid }, () => { L.status = 'in_transit'; L.pickedAt = nowIso(); L.trips.forEach(x => { x.status = 'In-transit'; setDriverBusy(x, 'in_transit'); }); ev(L, 'updated Load to in-transit status'); })) RL.rerender(); };
  ACTS['mark-delivered'] = async t => { const L = cur(t); if (await commit(t, 'mark-delivered', { load: L.sid }, () => { L.status = 'delivered'; L.deliveredAt = nowIso(); L.stopsOnTime = true; L.trips.forEach(x => { x.status = 'Delivered'; x.billing = x.billing || 'PENDING'; setDriverBusy(x, 'available'); }); ev(L, 'updated Load to delivered status'); })) RL.rerender(); };
  ACTS['create-invoice'] = async t => { const L = cur(t); if (await commit(t, 'create-invoice', { load: L.sid, amount: totalPay(L), customer: cust(L.customerId).name }, () => { L.status = 'invoiced'; L.invoice.createdAt = nowIso(); L.locked = true; ev(L, `created invoice ${L.sid} for ${money(totalPay(L))}`); })) RL.rerender(); };
  ACTS['view-invoice'] = t => { const L = cur(t); RL.invoicePreview(L); };
  RL.invoicePreview = L => {
    const c = cust(L.customerId), m = mcOf(L.mcId), fc = db.factoringCos.find(x => x.default);
    openModal({ title: `Invoice ${L.sid}`, kind: 'native', size: 'wide', body: `<div class="pdf"><div class="row"><div>${RL.LOGO.replace('class="logo"', 'class="logo" style="background:#6a2ee0;border-radius:6px;width:40px;height:40px;padding:6px"')}</div><div class="grow"><b>${esc(m.company || m.name)}</b><div>${esc(m.address || '')}</div><div>MC ${esc(m.number || '')}</div></div><div style="text-align:right"><b style="font-size:18px">INVOICE</b><div>${L.sid}</div><div>Date: ${fmtMDY(L.invoice.createdAt || H.todayStr)}</div></div></div>
      <div class="band">Bill to</div><div><b>${esc(c.name)}</b><br>${esc(c.address)}, ${esc(c.city)}, ${esc(c.state)} ${esc(c.zip)}<br>${esc(c.email || '')}</div>
      <div class="band">Load</div><table><tr><th>Load ID</th><th>Pickup</th><th>Delivery</th><th>Miles</th><th>Amount</th></tr><tr><td>${esc(L.loadId)}</td><td>${esc(place(firstStop(L)))} ${fmtMDY(firstStop(L).from)}</td><td>${esc(place(lastStop(L)))} ${fmtMDY(lastStop(L).from)}</td><td>${num(L.miles.total)}</td><td>${money(L.loadPay)}</td></tr>
      ${L.otherPay.filter(o => o.type !== 'Driver').map(o => `<tr><td colspan="4">${esc(o.charge)} ${esc(o.note || '')}</td><td>${money(o.amount)}</td></tr>`).join('')}<tr class="tot"><td colspan="4">Total</td><td>${money(totalPay(L))}</td></tr></table>
      ${L.invoice.billingType === 'FACTORING COMPANY' && fc ? `<p style="margin-top:12px;font-size:11px"><b>Remit notice:</b> ${esc(fc.remit)}</p>` : ''}</div>`,
      footer: `<button type="button" class="btn" data-act="dlg-close">Close</button><button type="button" class="btn purple" data-act="print">${ic('printer')}Print</button>` });
  };
  ACTS.print = () => window.print();
  // Assign Driver/Carrier
  // Assign Driver/Carrier is from frames; the LTL 'Add to an existing trip' part is inferred from tutorial title 'How to Create Partial Loads / LTL Trips'.
  function openAssign(L, mode) {
    const rank = d => (d.status === 'available' ? 0 : 2) + (d.ready === 'ready' ? 0 : 1);
    const list = (q = '') => db.drivers.filter(d => d.employment === 'ACTIVE' && (!q || `${dname(d)} ${(trk(d.truckId) || {}).unit || ''}`.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => rank(a) - rank(b)).map(d => {
      const t = trk(d.truckId); const r = d.ready === 'ready' ? ['ok', 'Ready to go'] : d.ready === 'blocked' ? ['bad', 'Blocked'] : ['warn', 'Not ready'];
      return `<label class="radio-row" style="justify-content:space-between"><span class="row"><span class="ready ${r[0]}" title="${r[1]}">${ic(r[0])}<span class="sr-only">${r[1]}</span></span>${esc(dname(d))} / UNIT ${esc(t ? t.unit : '')}<span class="muted xs">${RL.pill.DRV_ST[d.status] || ''}</span></span><input type="radio" name="driverId" value="${d.id}" ${d.ready === 'blocked' ? 'disabled' : ''} aria-label="${esc(dname(d))}, ${r[1]}"></label>`;
    }).join('') || '<p class="muted">No drivers found</p>';
    const carriers = db.carriers.map(c => `<label class="radio-row" style="justify-content:space-between"><span class="row"><span class="ready ${c.ready === 'ready' ? 'ok' : 'warn'}">${ic(c.ready === 'ready' ? 'ok' : 'warn')}</span>${esc(c.name)} / MC ${esc(c.mc)}</span><input type="radio" name="carrierId" value="${c.id}" aria-label="${esc(c.name)}"></label>`).join('');
    const ltlTrips = db.loads.filter(x => x.id !== L.id && x.mode === 'LTL' && ['assigned', 'dispatched'].includes(x.status)).flatMap(x => x.trips.map(t => [t.id, `${t.id} · ${tripLabel(t)} · ${place(firstStop(x))} → ${place(lastStop(x))}`]));
    const d = openModal({ title: 'Assign Driver/Carrier', kind: 'native', size: '', body: `<div class="pill-tabs" role="tablist" aria-label="Assign to"><button type="button" role="tab" id="as-tab-d" aria-controls="as-d" aria-selected="true" data-act="as-tab" data-v="d">Assign Driver</button><button type="button" role="tab" id="as-tab-c" aria-controls="as-c" aria-selected="false" data-act="as-tab" data-v="c">Assign Carrier</button></div>
      <div id="as-d" role="tabpanel" aria-labelledby="as-tab-d"><div class="card" style="background:var(--th);padding:10px 14px;margin:8px 0">Select driver</div><input type="search" class="inp" data-input="as-search" placeholder="Search driver or unit" aria-label="Search driver"><div class="radios" id="as-list" role="radiogroup" aria-label="Drivers" style="max-height:260px;overflow:auto;margin-top:8px">${list()}</div>
        <div class="grid2" style="margin-top:10px">${field({ name: 'truckId', label: 'Truck', type: 'select', options: RL.selOptions.trucks(), placeholder: 'Driver\'s truck' })}${field({ name: 'trailerId', label: 'Trailer', type: 'select', options: RL.selOptions.trailers(), placeholder: 'Driver\'s trailer' })}</div>
        ${L.mode === 'LTL' ? `<fieldset style="border:1px solid var(--line-2);border-radius:8px;margin-top:10px"><legend class="sm b">Partial load (LTL)</legend><label class="radio-row"><input type="radio" name="ltl" value="new" checked> Create a new trip</label><label class="radio-row"><input type="radio" name="ltl" value="existing" ${ltlTrips.length ? '' : 'disabled'}> Add to an existing trip</label>${field({ name: 'ltlTrip', label: 'Existing trip', type: 'select', options: ltlTrips, placeholder: ltlTrips.length ? 'Select trip' : 'No open LTL trips' })}</fieldset>` : ''}</div>
      <div id="as-c" role="tabpanel" aria-labelledby="as-tab-c" hidden><div class="card" style="background:var(--th);padding:10px 14px;margin:8px 0">Select carrier</div><div class="radios" role="radiogroup" aria-label="Carriers">${carriers}</div>${field({ name: 'carrierPay', label: 'Carrier pay', type: 'money' })}</div>`,
      footer: `<button type="submit" class="btn purple" id="as-submit" disabled>Submit</button>` });
    d.mode = mode; d.tab = 'd';
    const sync = () => { const f = d.form; const ok = d.tab === 'd' ? !!f.querySelector('[name=driverId]:checked') : !!f.querySelector('[name=carrierId]:checked'); d.el.querySelector('#as-submit').disabled = !ok; };
    d.form.addEventListener('change', e => { if (e.target.name === 'driverId') { const dr = drv(e.target.value); if (dr) { d.form.truckId.value = dr.truckId || ''; d.form.trailerId.value = dr.trailerId || ''; } } sync(); });
    d.sync = sync; RL._assign = d;
    d.form.addEventListener('submit', async e => {
      e.preventDefault();
      const f = d.form;
      let trip;
      const willStatus = mode === 'assign' ? 'assigned' : 'dispatched';
      if (d.tab === 'd') {
        const dr = drv(f.querySelector('[name=driverId]:checked').value);
        const truckId = +f.truckId.value || dr.truckId, trailerId = +f.trailerId.value || dr.trailerId;
        const ltlExisting = f.ltl && f.querySelector('[name=ltl]:checked').value === 'existing' && f.ltlTrip.value;
        const ok = await commit(f.querySelector('[type=submit]'), mode === 'assign' ? 'assign-driver' : 'dispatch-to-driver', { load: L.sid, driver: dname(dr), truck: (trk(truckId) || {}).unit, partialOf: ltlExisting || undefined }, () => {
          trip = RL.addTripRaw(L, dr, {}); trip.truckId = truckId; trip.trailerId = trailerId || null; trip.billing = 'PENDING';
          trip.emptyMiles = L.miles.empty; trip.loadedMiles = L.miles.loaded; trip.driverPay = RL.calcPay(dr, L.loadPay, L.miles.loaded, L.miles.empty);
          if (ltlExisting) { trip.sharedWith = ltlExisting; trip.driverPay = r2(trip.driverPay * 0.6); ev(L, `added the load to trip ${ltlExisting} as a partial load`); }
          L.status = willStatus; setDriverBusy(trip, 'dispatched');
          ev(L, `assigned ${dname(dr)} to trip ${trip.id}`); if (willStatus === 'dispatched') ev(L, 'updated Load to dispatched status');
        });
        if (ok) { d.close(); RL.rerender(); }
      } else {
        const c = H.carrier(f.querySelector('[name=carrierId]:checked').value); const pay = +f.carrierPay.value || r2(L.loadPay * 0.85);
        const ok = await commit(f.querySelector('[type=submit]'), mode === 'assign' ? 'assign-carrier' : 'dispatch-to-carrier', { load: L.sid, carrier: c.name, pay }, () => {
          L.trips.push({ id: `TR-${String(L.id).padStart(6, '0')}-${String(L.trips.length + 1).padStart(2, '0')}`, status: 'Assigned', driverId: null, carrierId: c.id, truckId: null, trailerId: null, coDriverId: null, from: 0, to: L.stops.length - 1, relay: null, driverPay: pay, confirmed: true, loadedMiles: L.miles.loaded, emptyMiles: 0, emptyManual: false, salaryBatchId: null, settlementId: null, billing: 'PENDING' });
          L.status = willStatus; ev(L, `assigned carrier ${c.name}`);
        });
        if (ok) { d.close(); RL.rerender(); }
      }
    });
    return d;
  }
  ACTS['assign-open'] = t => { const L = cur(t); openAssign(L, t.dataset.mode || 'dispatch'); };
  ACTS['as-tab'] = t => { const d = RL._assign; d.tab = t.dataset.v; H.$$('[role=tab]', t.parentElement).forEach(x => x.setAttribute('aria-selected', String(x === t))); H.$('#as-d', d.el).hidden = d.tab !== 'd'; H.$('#as-c', d.el).hidden = d.tab !== 'c'; d.sync(); };
  CHANGES['as-search'] = t => { const d = RL._assign; const q = t.value.toLowerCase(); H.$$('#as-list .radio-row', d.el).forEach(r => (r.hidden = q && !r.textContent.toLowerCase().includes(q))); };
  // Set ETA
  ACTS['set-eta'] = t => { const L = cur(t); formDialog({ title: 'Set ETA', sub: `${L.sid} · ${place(firstStop(L))} → ${place(lastStop(L))}`, submit: 'Set ETA', name: 'set-eta', fields: [{ name: 'at', label: 'ETA date and time', type: 'datetime-local', required: true, value: lastStop(L).from }, { name: 'miles', label: 'Miles left', type: 'number', value: Math.round(L.miles.loaded / 2) }, { name: 'note', label: 'Note', type: 'textarea', cls: 'span2' }], build: d => ({ load: L.sid, ...d }), apply: p => { L.eta = { at: p.at, miles: +p.miles || '' }; ev(L, `set ETA ${fmtDT(p.at)}`); } }); };
  // Share load / trip info (inferred from tutorial title "How to Share Load & Trip Info with Brokers and Drivers")
  ACTS['share-load'] = t => {
    RL.closeFloating();
    const L = cur(t), c = cust(L.customerId), d0 = drv((L.trips[0] || {}).driverId);
    const link = `${location.origin}/demo/replica/index.html#/share/${L.sid}`;
    const d = openModal({ title: 'Share load', sub: `${L.sid} · Load ID ${L.loadId}`, kind: 'native', size: 'wide', body: `<div class="pill-tabs" role="tablist" aria-label="Share with"><button type="button" role="tab" aria-selected="true" data-act="share-tab" data-v="broker">Share with broker</button><button type="button" role="tab" aria-selected="false" data-act="share-tab" data-v="driver">Share with driver</button></div>
      <fieldset style="border:0;padding:0;margin:0"><legend class="sm b" style="margin-bottom:6px">Include</legend><div class="grid3">${[['info', 'Load info', true], ['stops', 'Stops and appointments', true], ['driver', 'Driver and truck', true], ['location', 'Live location link', true], ['docs', 'Documents (rate con, POD)', false], ['pay', 'Driver pay', false]].map(([k, l, on]) => field({ name: 'inc_' + k, label: l, type: 'checkbox', value: on })).join('')}</div></fieldset>
      <div class="field"><span class="lab">Channel</span><div class="choice" role="radiogroup" aria-label="Channel">${['Email', 'SMS', 'Telegram', 'Mobile app'].map((ch, i) => `<label><input type="radio" name="channel" value="${ch}" ${i === 0 ? 'checked' : ''}> ${ch}</label>`).join('')}</div></div>
      <div class="grid2">${field({ name: 'to', label: 'Recipient', required: true, value: c.email || '', placeholder: 'Email or phone' })}${field({ name: 'link', label: 'Tracking link', value: link, readonly: true })}</div>${field({ name: 'message', label: 'Message', type: 'textarea', value: `Load ${L.loadId}: ${place(firstStop(L))} → ${place(lastStop(L))}. Driver ${d0 ? dname(d0) : 'TBD'}.` })}`,
      footer: `<button type="button" class="btn" data-act="copy" data-text="${esc(link)}">${ic('link')}Copy link</button><button type="button" class="btn" data-act="dlg-close">Cancel</button><button type="submit" class="btn purple">Send</button>` });
    d.form.addEventListener('submit', async e => { e.preventDefault(); if (!validate(d.form)) return; const f = readForm(d.form); if (await commit(d.form.querySelector('[type=submit]'), 'share-load', { load: L.sid, channel: f.channel, to: f.to }, () => ev(L, `shared load info by ${f.channel}`))) { d.close(); RL.rerender(); } });
    d.c = c; d.d0 = d0; RL._share = d;
  };
  ACTS['share-tab'] = t => { const d = RL._share; H.$$('[role=tab]', t.parentElement).forEach(x => x.setAttribute('aria-selected', String(x === t))); d.form.to.value = t.dataset.v === 'broker' ? d.c.email || '' : d.d0 ? d.d0.phone : ''; };
  // Mapping
  ACTS.mapping = t => {
    const L = cur(t);
    const legs = L.stops.slice(1).map((s, i) => [L.stops[i], s]);
    const d = openModal({ title: 'Mapping', sub: `${L.sid} · ${L.mileageType}`, kind: 'native', size: 'wide', body: `<div class="map-box">${mapSvg(L)}</div><table class="t" aria-label="Route legs"><thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col" class="num">Miles</th></tr></thead><tbody>${legs.map(([a, b]) => `<tr><td>${esc(place(a))}</td><td>${esc(place(b))}</td><td class="num">${a.cityIdx != null && b.cityIdx != null ? num(RL.roadMiles(a.cityIdx, b.cityIdx, L.mileageType)) : '-'}</td></tr>`).join('')}</tbody></table>
      <div class="grid2">${field({ name: 'mileageType', label: 'Mileage type', type: 'select', options: ['Google map', 'Trucking', 'PC Miler', 'PC Miler Practical'], value: L.mileageType, placeholder: false })}${field({ name: 'empty', label: 'Empty miles', type: 'number', value: L.miles.empty, step: '0.01' })}</div>`,
      footer: `<button type="button" class="btn" data-act="dlg-close">Close</button><button type="submit" class="btn purple">Recalculate</button>` });
    d.form.addEventListener('submit', async e => { e.preventDefault(); const type = d.form.mileageType.value, empty = +d.form.empty.value || 0; if (await commit(d.form.querySelector('[type=submit]'), 'recalculate-miles', { load: L.sid, mileageType: type, emptyMiles: empty }, () => { L.mileageType = type; L.miles.loaded = legMiles(L.stops, type) || L.miles.loaded; L.miles.empty = empty; L.miles.total = r2(L.miles.loaded + empty); L.trips.forEach(x => { x.loadedMiles = L.miles.loaded; ev(L, `Re-calculated trip ${x.id}`); }); })) { d.close(); RL.rerender(); } });
  };
  // Other pay (detention, lumper, TONU)
  // Other pay rows, TONU, detention, lumper, e-check: the card layout is from frames; behaviour inferred from tutorial titles 'How to Add Detention and Lumper Fees', 'How to Create a TONU Load'.
  const opDirty = () => { LD.op.dirty = true; };
  ACTS['op-add'] = t => { const L = loadById(LD.id); if (!LD.op) LD.op = { rows: L.otherPay.map(o => ({ ...o })), tonu: L.tonu, tonuAmount: L.tonuAmount }; LD.op.rows.push({ charge: t.dataset.v, type: 'Customer', amount: '', note: t.dataset.v === 'Detention' ? 'hours at facility' : '' }); opDirty(); RL.rerender(); const ins = H.$$('.other-pay input[data-k=amount]'); if (ins.length) ins[ins.length - 1].focus(); };
  ACTS['op-del'] = t => { LD.op.rows.splice(+t.dataset.i, 1); opDirty(); RL.rerender(); };
  CHANGES.op = t => { const r = LD.op.rows[+t.dataset.i]; r[t.dataset.k] = t.dataset.k === 'amount' ? (t.value === '' ? '' : +t.value) : t.value; const was = LD.op.dirty; opDirty(); if (!was || t.dataset.k === 'amount') RL.rerender(); };
  CHANGES['op-tonu'] = t => { LD.op.tonu = t.checked; opDirty(); RL.rerender(); };
  CHANGES['op-tonu-amt'] = t => { LD.op.tonuAmount = +t.value || 0; opDirty(); RL.rerender(); };
  ACTS['op-cancel'] = () => { LD.op = null; RL.rerender(); };
  ACTS['op-save'] = async t => {
    const L = cur(t), op = LD.op;
    const bad = op.rows.find(r => !r.charge || !r.type || r.amount === '' || !(+r.amount >= 0));
    if (bad) { toast('Fill Pay/other charges, Type and Amount in every row', 'error'); return; }
    if (op.tonu && !(op.tonuAmount > 0)) { toast('Enter the TONU amount', 'error'); return; }
    if (await commit(t, 'save-other-pay', { load: L.sid, rows: op.rows, tonu: op.tonu, tonuAmount: op.tonuAmount }, () => {
      const added = op.rows.length - L.otherPay.length;
      L.otherPay = op.rows.map(r => ({ ...r, amount: +r.amount })); if (op.tonu !== L.tonu) ev(L, op.tonu ? `marked the load as TONU (${money(op.tonuAmount)})` : 'removed TONU');
      L.tonu = op.tonu; L.tonuAmount = op.tonuAmount; ev(L, added > 0 ? `added ${added} other pay ${added > 1 ? 'rows' : 'row'}` : 'updated Other pay'); LD.op = null;
    })) RL.rerender();
  };
  ACTS['create-echeck'] = t => {
    const L = cur(t), d0 = drv((L.trips[0] || {}).driverId);
    formDialog({ title: 'Create e-check', sub: `${L.sid} · ${cust(L.customerId).name}`, submit: 'Create e-check', name: 'create-echeck',
      fields: [{ name: 'purpose', label: 'Purpose', type: 'select', required: true, options: ['Lumper', 'Repair', 'Scale ticket', 'Washout', 'Advance'], value: 'Lumper', placeholder: false }, { name: 'amount', label: 'Amount', type: 'money', required: true },
        { name: 'driverId', label: 'Driver', type: 'select', options: RL.selOptions.drivers(), value: d0 ? d0.id : '', placeholder: 'Select driver' }, { name: 'payee', label: 'Payee name', placeholder: 'e.g. lumper service' },
        { name: 'deduct', label: "Deduct from driver's settlement", type: 'checkbox', value: false }, { name: 'billCustomer', label: 'Bill to customer as other pay', type: 'checkbox', value: true }, { name: 'memo', label: 'Memo', type: 'textarea', cls: 'span2' }],
      build: d => ({ load: L.sid, ...d, code: 'MC' + (73200000 + db.moneyCodes.length * 1373) }),
      apply: p => { db.moneyCodes.unshift({ id: db.moneyCodes.length + 1, code: p.code, driverId: +p.driverId || null, truckId: d0 ? d0.truckId : null, amount: +p.amount, fee: 2.5, purpose: p.purpose, issued: nowIso(), status: 'ISSUED', deduct: !!p.deduct, loadId: L.id });
        if (p.billCustomer) L.otherPay.push({ charge: p.purpose === 'Lumper' ? 'Lumper' : 'Other', type: 'Customer', amount: +p.amount, note: `E-check ${p.code}` }); LD.op = null; ev(L, `created e-check ${p.code} for ${money(p.amount)}`); },
      okMsg: 'Success' });
  };
  // Stops
  // Stop edit/move/delete: inferred from tutorial title 'How to Edit Load Dates (Pickup & Delivery)'.
  MENUS.stopRow = t => { const L = cur(t), i = +t.dataset.i; return menu(`Stop ${stopLabel(L, i)}`, [mi('Edit stop', 'edit-stop', `data-id="${L.id}" data-i="${i}"`), i > 0 ? mi('Move up', 'move-stop', `data-id="${L.id}" data-i="${i}" data-d="-1"`) : '', i < L.stops.length - 1 ? mi('Move down', 'move-stop', `data-id="${L.id}" data-i="${i}" data-d="1"`) : '', msep, mi('Delete stop', 'delete-stop', `data-id="${L.id}" data-i="${i}" ${L.stops.length <= 2 ? 'aria-disabled="true"' : ''}`, 'danger')]); };
  SUBMITS['add-stop'] = async f => {
    const L = loadById(f.dataset.id);
    const get = n => H.$(`[form=add-stop-form][name=${n}]`);
    const company = get('company').value.trim(), location = get('location').value.trim();
    get('company').setAttribute('aria-invalid', String(!company)); get('location').setAttribute('aria-invalid', String(!location));
    if (!company || !location) { toast('Enter the company name and stop location', 'error'); (company ? get('location') : get('company')).focus(); return; }
    const loc = parseLocation(location), from = get('from').value || lastStop(L).from, type = get('type').value;
    if (await commit(H.$('[form=add-stop-form][type=submit]'), 'add-stop', { load: L.sid, type, company, location, from }, () => {
      const stop = { id: L.stops.length + 1, type, company, address: '', ...loc, zip: get('zip').value || loc.zip, from, to: '' };
      if (type === 'Pickup') { const k = L.stops.findIndex(s => s.type === 'Delivery'); L.stops.splice(k < 0 ? L.stops.length : k, 0, stop); } else L.stops.push(stop);
      recalcMiles(L); L.trips.forEach(t => { t.to = L.stops.length - 1; t.loadedMiles = L.miles.loaded; }); ev(L, `added stop ${type} ${company}`);
    })) RL.rerender();
  };
  ACTS['edit-stop'] = t => {
    const L = cur(t), i = +t.dataset.i, s = L.stops[i];
    formDialog({ title: `Edit stop ${stopLabel(L, i)}`, submit: 'Save stop', name: 'save-stop',
      fields: [{ name: 'type', label: 'Stop type', type: 'select', options: ['Pickup', 'Delivery'], value: s.type, placeholder: false }, { name: 'company', label: 'Company name', required: true, value: s.company }, { name: 'address', label: 'Address', value: s.address },
        { name: 'location', label: 'Stop location', required: true, value: place(s), list: 'city-list-2' }, { name: 'zip', label: 'Zip', value: s.zip }, { name: 'from', label: 'Appointment from', type: 'datetime-local', required: true, value: s.from }, { name: 'to', label: 'Appointment to', type: 'datetime-local', value: s.to }],
      build: d => ({ load: L.sid, stop: i + 1, ...d }),
      apply: p => { const loc = parseLocation(p.location); const oldFrom = s.from; Object.assign(s, { type: p.type, company: p.company, address: p.address, ...loc, zip: p.zip || loc.zip, from: p.from, to: p.to }); recalcMiles(L); ev(L, oldFrom !== p.from ? `updated ${stopLabel(L, i)} appointment: ${fmtDT(oldFrom)} → ${fmtDT(p.from)}` : `updated stop ${stopLabel(L, i)}`); } });
  };
  ACTS['move-stop'] = async t => { const L = cur(t), i = +t.dataset.i, j = i + +t.dataset.d; if (await commit(t, 'move-stop', { load: L.sid, from: i + 1, to: j + 1 }, () => { const [s] = L.stops.splice(i, 1); L.stops.splice(j, 0, s); recalcMiles(L); ev(L, 'changed stop order'); })) { RL.closeFloating(); RL.rerender(); } };
  ACTS['delete-stop'] = t => { const L = cur(t), i = +t.dataset.i; confirmDialog({ title: 'Delete stop', message: `Delete stop ${stopLabel(L, i)} (${L.stops[i].company})?`, yes: 'Delete', no: 'Cancel', danger: true, name: 'delete-stop', data: { load: L.sid, stop: i + 1 }, apply: () => { L.stops.splice(i, 1); recalcMiles(L); L.trips.forEach(x => (x.to = Math.min(x.to, L.stops.length - 1))); ev(L, 'deleted a stop'); } }); };
  // Commodities
  ACTS['add-commodity'] = t => { const L = cur(t); formDialog({ title: 'Add commodity', submit: 'Add commodity', name: 'add-commodity', fields: [{ name: 'desc', label: 'Description', required: true }, { name: 'qty', label: 'QTY', type: 'number', value: 1 }, { name: 'type', label: 'Type', type: 'select', options: ['Pallets', 'Boxes', 'Crates', 'Pieces', 'Drums', 'Rolls'], value: 'Pallets', placeholder: false }, { name: 'pcs', label: 'PCS', type: 'number' }, { name: 'wt', label: 'Total WT (lb)', type: 'number' }, { name: 'w', label: 'Width', type: 'number' }, { name: 'h', label: 'Height', type: 'number' }, { name: 'l', label: 'Length', type: 'number' }, { name: 'note', label: 'Note', cls: 'span2' }], build: d => ({ load: L.sid, ...d }), apply: p => { L.commodities.push({ desc: p.desc, qty: +p.qty || 1, type: p.type, pcs: +p.pcs || 0, wt: +p.wt || 0, w: +p.w || 0, h: +p.h || 0, l: +p.l || 0, note: p.note }); ev(L, `added commodity ${p.desc}`); } }); };
  ACTS['del-commodity'] = async t => { const L = cur(t), i = +t.dataset.i; if (await commit(t, 'delete-commodity', { load: L.sid, index: i }, () => L.commodities.splice(i, 1))) RL.rerender(); };
  // Documents
  ACTS['upload-doc'] = t => {
    const L = cur(t);
    const d = formDialog({ title: 'Upload document', sub: L.sid, submit: 'Upload', name: 'upload-document', body: `<div class="grid2">${field({ name: 'type', label: 'Document type', type: 'select', required: true, options: ['Rate confirmation', 'Proof of Delivery', 'Bill of lading', 'Lumper receipt', 'Scale ticket', 'Other'], value: hasPod(L) ? 'Bill of lading' : 'Proof of Delivery', placeholder: false })}${field({ name: 'note', label: 'Note' })}</div>
      <div class="field"><span class="lab">File <span class="req">*</span></span><button type="button" class="drop" data-act="fake-file" data-target="docFile">${ic('upload')}<span>Click or drag file to upload</span></button><input type="hidden" name="docFile"></div>`,
      build: f => { if (!f.docFile) { toast('Choose a file to upload', 'error'); return false; } return { load: L.sid, type: f.type, file: f.docFile }; },
      apply: p => { L.docs.push({ id: L.docs.length + 1, type: p.type, name: p.file, at: nowIso(), by: ME }); ev(L, p.type === 'Proof of Delivery' ? `uploaded Proof of Delivery for Load ${L.sid}` : `uploaded ${p.type}`); } });
    return d;
  };
  /** Simulated file chooser: no OS dialog, a deterministic file name is "picked". */
  ACTS['fake-file'] = t => { const form = t.closest('form'); const hidden = form.querySelector(`[name=${t.dataset.target}]`); const kind = form.type ? form.type.value : 'document'; const name = `${String(kind).toLowerCase().replace(/[^a-z]+/g, '-')}-${H.nid()}.pdf`; hidden.value = name; t.innerHTML = `${ic('file')}<span class="filechip">${esc(name)}</span><span class="muted sm">Click to choose another file</span>`; };
  ACTS['view-doc'] = t => {
    RL.closeFloating();
    const L = cur(t), doc = L.docs.find(x => String(x.id) === String(t.dataset.doc)) || L.docs[0]; if (!doc) { toast('No documents on this load', 'error'); return; }
    const a = firstStop(L), b = lastStop(L), c = cust(L.customerId);
    openModal({ title: doc.type, sub: doc.name, kind: 'native', size: 'wide', body: doc.type === 'Rate confirmation' ? `<div class="pdf"><h2 style="letter-spacing:.2em">${esc(c.name.toUpperCase())}</h2><p style="letter-spacing:.15em">RATE CONFIRMATION</p><div class="grid2"><div><b>${esc(c.contact || '')}</b><br>${esc(c.phone || '')}<br>${esc(c.email || '')}</div><div>MC: ${esc(c.mc)}<br>Load ID # ${esc(L.loadId)}<br>Reference # ${esc(L.refId || '-')}</div></div>
      <div class="grid2" style="margin-top:12px"><div><b>PICK UP</b><br>${esc(a.company)}<br>${esc(a.address)}, ${esc(place(a))} ${esc(a.zip)}<br>Appointment ${fmtDT(a.from)}</div><div><b>DELIVERY</b><br>${esc(b.company)}<br>${esc(b.address)}, ${esc(place(b))} ${esc(b.zip)}<br>Appointment ${fmtDT(b.from)}</div></div>
      <p>Size &amp; Type: 53' ${esc(L.equipment)} · Miles: ${num(L.miles.loaded)} · Linehaul rate: ${money(L.loadPay)}</p></div>` : `<div class="pdf" style="text-align:center;padding:60px">${ic('file')}<p><b>${esc(doc.name)}</b></p><p class="muted">${esc(doc.type)} uploaded by ${esc(doc.by)} on ${fmtDT(doc.at)}</p></div>`,
      footer: `<button type="button" class="btn" data-act="dlg-close">Close</button>` });
  };
  // Trips: drawer, split, delete
  // Trip drawer and split trip: inferred from tutorial titles 'Trip Management: Change Drivers, Trucks, Trailers & Adjust Pay', 'How to Split a Trip Between Two Drivers', 'How Empty Miles Work'.
  function tripDrawer(L, t) {
    const d0 = drv(t.driverId);
    const d = formDialog({ title: `Trip ${t.id}`, sub: `${L.sid} · ${t.status}`, kind: 'drawer', submit: 'Save', cancel: 'Close', name: 'save-trip',
      body: `<div class="grid2">
        ${field({ name: 'driverId', label: 'Driver', type: 'select', options: RL.selOptions.drivers(), value: t.driverId || '', placeholder: t.carrierId ? 'Carrier trip' : 'Select Driver', required: !t.carrierId })}${field({ name: 'coDriverId', label: 'Co-driver', type: 'select', options: RL.selOptions.drivers(), value: t.coDriverId || '', placeholder: 'No co-driver' })}
        ${field({ name: 'truckId', label: 'Truck', type: 'select', options: RL.selOptions.trucks(), value: t.truckId || '', placeholder: 'Select Truck' })}${field({ name: 'trailerId', label: 'Trailer', type: 'select', options: RL.selOptions.trailers(), value: t.trailerId || '', placeholder: 'Select Trailer' })}
        <div class="field"><span class="lab">Pickup</span><div>${esc(placeLong(L.stops[t.from] || firstStop(L)))}</div></div><div class="field"><span class="lab">Delivery</span><div>${esc(placeLong(t.relay || L.stops[t.to] || lastStop(L)))}</div></div>
        ${field({ name: 'loadedMiles', label: 'Loaded miles', type: 'number', step: '0.01', value: t.loadedMiles })}${field({ name: 'emptyMiles', label: 'Empty miles', type: 'number', step: '0.01', value: t.emptyMiles, hint: 'From the previous delivery to this pickup' })}
        ${field({ name: 'autoEmpty', label: 'Calculate empty miles automatically', type: 'checkbox', value: !t.emptyManual, cls: 'span2' })}
        ${field({ name: 'driverPay', label: 'Driver pay', type: 'money', required: true, value: t.driverPay })}<div class="field"><span class="lab">Tariff</span><div class="row"><span>${esc(d0 ? (byId(db.tariffs, d0.tariffId) || {}).name || '-' : '-')}</span><button type="button" class="btn sm" data-act="trip-recalc">Recalculate by tariff</button></div></div>
        ${field({ name: 'confirmed', label: 'Confirmed trip', type: 'checkbox', value: t.confirmed })}${field({ name: 'note', label: 'Driver note', value: t.note || '' })}</div>`,
      build: f => ({ load: L.sid, trip: t.id, ...f }),
      apply: p => {
        const before = { d: t.driverId, tk: t.truckId, tl: t.trailerId, pay: t.driverPay };
        t.driverId = +p.driverId || t.driverId; t.coDriverId = +p.coDriverId || null; t.truckId = +p.truckId || null; t.trailerId = +p.trailerId || null; t.loadedMiles = +p.loadedMiles || 0; t.emptyManual = !p.autoEmpty; t.emptyMiles = +p.emptyMiles || 0; t.driverPay = +p.driverPay; t.confirmed = !!p.confirmed; t.note = p.note;
        if (L.trips.length === 1) { L.miles.empty = t.emptyMiles; L.miles.total = r2(L.miles.loaded + L.miles.empty); }
        if (before.d !== t.driverId) ev(L, `changed driver on trip ${t.id}: ${dname(drv(before.d))} → ${dname(drv(t.driverId))}`);
        if (before.tk !== t.truckId) ev(L, `changed truck on trip ${t.id}: ${(trk(before.tk) || {}).unit || '-'} → ${(trk(t.truckId) || {}).unit || '-'}`);
        if (before.tl !== t.trailerId) ev(L, `changed trailer on trip ${t.id}: ${(trl(before.tl) || {}).unit || '-'} → ${(trl(t.trailerId) || {}).unit || '-'}`);
        if (before.pay !== t.driverPay) ev(L, `updated Driver Pay for Load's trip: ${money(before.pay)} → ${money(t.driverPay)}`);
        ev(L, `Re-calculated trip ${t.id}`);
      } });
    d.form.addEventListener('change', e => { if (e.target.name === 'driverId') { const dr = drv(e.target.value); if (dr) { d.form.truckId.value = dr.truckId || ''; d.form.trailerId.value = dr.trailerId || ''; } } });
    RL._trip = { d, L, t };
    return d;
  }
  ACTS['trip-recalc'] = () => { const { d, L } = RL._trip; const dr = drv(d.form.driverId.value); if (!dr) { toast('Select a driver first', 'error'); return; } d.form.driverPay.value = RL.calcPay(dr, L.loadPay, +d.form.loadedMiles.value || 0, +d.form.emptyMiles.value || 0); };
  ACTS['trip-open'] = t => { const L = loadById(t.dataset.id); const tr = L.trips.find(x => x.id === t.dataset.trip); if (tr) tripDrawer(L, tr); };
  DBL.trip = id => { const [lid, tid] = id.split('|'); const L = loadById(lid); const tr = L && L.trips.find(x => x.id === tid); if (tr) tripDrawer(L, tr); };
  ACTS['delete-trip'] = t => { const L = cur(t), id = t.dataset.trip; confirmDialog({ title: 'Delete trip', message: `Delete trip ${id}? Its driver pay is removed from the load.`, yes: 'Delete', no: 'Cancel', danger: true, name: 'delete-trip', data: { load: L.sid, trip: id }, apply: () => { const tr = L.trips.find(x => x.id === id); setDriverBusy(tr, 'available'); L.trips = L.trips.filter(x => x.id !== id); if (!L.trips.length && ['assigned', 'dispatched'].includes(L.status)) L.status = 'booked'; ev(L, `deleted trip ${id}`); } }); };
  ACTS['split-trip'] = t => {
    const L = cur(t), t1 = L.trips[0];
    const total = t1.driverPay;
    const d = formDialog({ title: 'Split trip between two drivers', sub: `${t1.id} · ${place(firstStop(L))} → ${place(lastStop(L))}`, submit: 'Split trip', name: 'split-trip',
      fields: [{ name: 'relayCompany', label: 'Relay point company', required: true, value: 'Relay yard' }, { name: 'relayCity', label: 'Relay location', type: 'select', required: true, options: RL.CITIES.map(c => [c.i, `${c.city}, ${c.state}`]), value: firstStop(L).cityIdx != null ? firstStop(L).cityIdx : 0, placeholder: false },
        { name: 'driver2', label: 'Second driver', type: 'select', required: true, options: RL.selOptions.drivers().filter(([id]) => id !== t1.driverId) }, { name: 'truck2', label: 'Second truck', type: 'select', options: RL.selOptions.trucks(), placeholder: "Second driver's truck" },
        { name: 'pay1', label: `Driver pay, ${t1.id}`, type: 'money', required: true, value: r2(total * 0.6) }, { name: 'pay2', label: 'Driver pay, second trip', type: 'money', required: true, value: r2(total * 0.4) }],
      build: f => ({ load: L.sid, trip: t1.id, ...f }),
      apply: p => {
        const c = RL.CITIES[+p.relayCity]; const d2 = drv(p.driver2);
        t1.relay = { company: p.relayCompany, city: c.city, state: c.state, cityIdx: c.i }; t1.driverPay = +p.pay1;
        const a = firstStop(L), b = lastStop(L);
        const m1 = a.cityIdx != null ? RL.roadMiles(a.cityIdx, c.i, L.mileageType) : r2(L.miles.loaded / 2), m2 = b.cityIdx != null ? RL.roadMiles(c.i, b.cityIdx, L.mileageType) : r2(L.miles.loaded / 2);
        t1.loadedMiles = m1;
        const t2 = RL.addTripRaw(L, d2, { split: true, pay: +p.pay2 }); t2.relayFrom = true; t2.relayPoint = { city: c.city, state: c.state }; t2.truckId = +p.truck2 || d2.truckId; t2.loadedMiles = m2; t2.emptyMiles = 0; t2.status = t1.status; t2.billing = 'PENDING';
        setDriverBusy(t2, L.status === 'in_transit' ? 'in_transit' : 'dispatched');
        ev(L, `split trip ${t1.id} at ${c.city}, ${c.state}: ${t2.id} assigned to ${dname(d2)}`);
      } });
    d.form.addEventListener('change', e => { if (e.target.name === 'driver2') { const dr = drv(e.target.value); if (dr) d.form.truck2.value = dr.truckId || ''; } });
  };

  // ======================= trips list =======================
  const allTrips = () => db.loads.filter(L => !L.deleted).flatMap(L => L.trips.map(t => ({ L, t, id: L.id + '|' + t.id })));
  const tripCols = () => [
    { key: 'trip', label: 'Trip ID', text: r => r.t.id, render: r => `${r.t.split ? ic('split') + ' ' : ''}<a href="${loadUrl(r.L)}">${r.t.id}</a>` },
    { key: 'status', label: 'Status', text: r => r.t.status, render: r => stPill(r.t.status === 'Assigned' ? 'assigned' : r.t.status === 'In-transit' ? 'in_transit' : r.t.status === 'Delivered' ? 'delivered' : 'booked') },
    { key: 'loadId', label: 'Load ID', text: r => r.L.loadId },
    { key: 'mc', label: 'MC Number', text: r => mcOf(r.L.mcId).name },
    { key: 'pickup', label: 'Pickup', text: r => place(firstStop(r.L)), render: r => twoLine(firstStop(r.L).company, place(firstStop(r.L))) },
    { key: 'puTime', label: 'Pickup time', text: r => H.fmtWeekday(firstStop(r.L).from), sortVal: r => firstStop(r.L).from },
    { key: 'delivery', label: 'Delivery', text: r => place(lastStop(r.L)), render: r => twoLine(lastStop(r.L).company, place(lastStop(r.L))) },
    { key: 'delTime', label: 'Delivery time', text: r => H.fmtWeekday(r.L.deliveredAt || lastStop(r.L).from), sortVal: r => r.L.deliveredAt || lastStop(r.L).from },
    { key: 'unit', label: 'Unit-Driver-Carrier', text: r => tripLabel(r.t) },
    { key: 'codriver', label: 'Co-Driver', text: r => dname(drv(r.t.coDriverId)) || '-' },
    { key: 'pay', label: 'Driver pay', num: true, text: r => r.t.driverPay, render: r => money(r.t.driverPay) },
    { key: 'billing', label: 'Billing status', text: r => r.t.billing || 'PENDING', render: r => pill(r.t.billing || 'PENDING', (r.t.billing || 'PENDING') === 'PAID' ? 'paid' : r.t.billing === 'IN BATCH' ? 'posted' : 'pending') },
    { key: 'miles', label: 'Total miles', num: true, text: r => r2(r.t.loadedMiles + r.t.emptyMiles), render: r => num(r.t.loadedMiles + r.t.emptyMiles) },
  ];
  const tripTotals = rows => `<span>Total pay: <b>${money(rows.reduce((a, r) => a + r.t.driverPay, 0))}</b></span><span>Total miles: <b>${num(rows.reduce((a, r) => a + r.t.loadedMiles + r.t.emptyMiles, 0))}</b></span>`;
  const loadChipsLinks = active => RL.chipLinks('Load management views', [['Load + Trip', '#/load-management/load-trip'], ['Trips', '#/load-management/trips'], ['Drivers Unbilled', '#/load-management/drivers-unbilled', 'bookmark'], ['Amazon loads', '#/load-management/amazon-loads', 'bookmark']], active, [2, 3]);
  RL.route('/load-management/trips', () => ({ crumbs: ['Load management', 'Trips'], html: `<div class="page-head">${loadChipsLinks(1)}<span class="grow"></span><button type="button" class="btn primary" data-act="new-load" aria-haspopup="dialog">${ic('plus')}New Load</button></div>${RL.table({ id: 'trips', label: 'Trips', columns: tripCols(), rows: () => allTrips().reverse(), rowName: r => r.t.id, dbl: 'trip', totals: tripTotals })}` }));
  RL.route('/load-management/drivers-unbilled', () => ({ crumbs: ['Load management', 'Drivers Unbilled'], html: `<div class="page-head">${loadChipsLinks(2)}<span class="grow"></span><a class="btn primary" href="#/accounting/salary/driver-settlements/create-batch">Create salary batch</a></div>${RL.table({ id: 'unbilled', label: 'Drivers Unbilled', columns: tripCols(), rows: () => allTrips().filter(r => ['delivered', 'invoiced', 'paid'].includes(r.L.status) && !r.t.salaryBatchId && !r.t.carrierId).reverse(), rowName: r => r.t.id, dbl: 'trip', totals: tripTotals })}` }));

  // ======================= Amazon loads (inferred from tutorial titles: import Amazon loads, CSV to Booked, CSV to Delivered) =======================
  RL.route('/load-management/amazon-loads', () => ({
    crumbs: ['Load management', 'Amazon loads'],
    html: `<div class="page-head">${loadChipsLinks(3)}<span class="grow"></span><button type="button" class="btn" data-act="amazon-mark-delivered" data-needs-sel="amazon">Mark as Delivered (<span data-sel-count="amazon">0</span>)</button><button type="button" class="btn primary" data-act="amazon-import" aria-haspopup="dialog">${ic('upload')}Import Amazon loads</button></div>
      <p class="muted sm" style="margin:0 0 10px">Amazon loads come from the Relay CSV export: <b>CSV to Booked</b> creates the loads, <b>CSV to Delivered</b> closes the delivered ones in bulk. Street loads are marked delivered one by one on the load page.</p>
      ${RL.table({ id: 'amazon', label: 'Amazon loads', columns: [loadCols()[0], { key: 'loadId', label: 'Amazon trip ID', text: L => L.loadId }, loadCols()[3], loadCols()[4], loadCols()[6], loadCols()[7], loadCols()[9], loadCols()[10], loadCols()[11]], rows: () => db.loads.filter(L => !L.deleted && (L.amazon || L.customerId === 2)).sort((a, b) => b.id - a.id), rowName: L => L.sid, dbl: 'openLoad', rowMenu: 'loadRow', totals: loadTotals })}`,
  }));
  RL.SELTEST.amazonDeliverable = ids => ids.length > 0;
  ACTS['amazon-mark-delivered'] = t => {
    const ids = [...RL.TS.amazon.sel].map(Number); const ok = ids.map(loadById).filter(L => L && ['dispatched', 'in_transit'].includes(L.status));
    if (!ok.length) { toast('Select Dispatched or In-Transit Amazon loads', 'error'); return; }
    confirmDialog({ title: 'Mark as Delivered', message: `Mark ${ok.length} Amazon ${ok.length > 1 ? 'loads' : 'load'} as Delivered?`, yes: 'Yes', no: 'No', name: 'mark-delivered-bulk', data: { loads: ok.map(L => L.sid) }, apply: () => { ok.forEach(L => { L.status = 'delivered'; L.deliveredAt = nowIso(); L.trips.forEach(x => { x.status = 'Delivered'; setDriverBusy(x, 'available'); }); ev(L, 'updated Load to delivered status (Amazon bulk)'); }); RL.TS.amazon.sel.clear(); } });
  };
  ACTS['amazon-import'] = () => {
    RL.closeFloating();
    const d = openModal({ title: 'Import Amazon loads', sub: 'Amazon Relay CSV export', kind: 'native', size: 'wide', body: `<div class="field"><span class="lab">Import mode</span><div class="choice" role="radiogroup" aria-label="Import mode" style="grid-template-columns:1fr 1fr"><label><input type="radio" name="mode" value="booked" checked> CSV to Booked (create loads)</label><label><input type="radio" name="mode" value="delivered"> CSV to Delivered (update status)</label></div></div>
      ${field({ name: 'mcId', label: 'MC number', type: 'select', options: RL.selOptions.mcs(), value: 1, placeholder: false })}
      <div class="field"><span class="lab">CSV file <span class="req">*</span></span><button type="button" class="drop" data-act="amazon-pick">${ic('upload')}<span>Click or drag Amazon CSV file</span></button></div><div id="amz-preview" aria-live="polite"></div>`,
      footer: `<button type="button" class="btn" data-act="dlg-close">Cancel</button><button type="submit" class="btn purple" id="amz-go" disabled>Import</button>` });
    RL._amz = d; d.rows = null;
    d.form.addEventListener('change', e => { if (e.target.name === 'mode' && d.rows) ACTS['amazon-pick'](H.$('[data-act=amazon-pick]', d.el)); });
    d.form.addEventListener('submit', async e => {
      e.preventDefault(); if (!d.rows) return;
      const mode = d.form.querySelector('[name=mode]:checked').value;
      const ok = await commit(d.form.querySelector('[type=submit]'), mode === 'booked' ? 'import-amazon-booked' : 'import-amazon-delivered', { rows: d.rows.length, mode }, () => {
        if (mode === 'booked') d.rows.forEach(r => { const L = buildLoad({ customerId: 2, mcId: +d.form.mcId.value, loadId: r.trip, loadPay: r.pay, equipment: 'Dry van', amazon: true, tags: ['AMAZON'], stops: [{ type: 'Pickup', company: r.from, address: '', ...RL.CITIES[r.a], cityIdx: r.a, from: r.start, to: '' }, { type: 'Delivery', company: r.to, address: '', ...RL.CITIES[r.b], cityIdx: r.b, from: r.end, to: '' }] }); db.loads.push(L); });
        else d.rows.forEach(r => { const L = r.L; if (L) { L.status = 'delivered'; L.deliveredAt = nowIso(); L.trips.forEach(x => { x.status = 'Delivered'; setDriverBusy(x, 'available'); }); ev(L, 'updated Load to delivered status (Amazon CSV)'); } });
      }, mode === 'booked' ? `Success: ${d.rows.length} loads created` : `Success: ${d.rows.length} loads delivered`);
      if (ok) { d.close(); if (/amazon-loads/.test(location.hash)) RL.rerender(); else location.hash = '#/load-management/amazon-loads'; }
    });
  };
  ACTS['amazon-pick'] = t => {
    const d = RL._amz; const mode = d.form.querySelector('[name=mode]:checked').value;
    t.classList.add('busy'); t.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>amazon-relay-export.csv</span><span class="muted sm">Reading the file…</span>`;
    H.$('#amz-go', d.el).disabled = true;
    setTimeout(() => {
      if (!d.root.isConnected) return;
      t.classList.remove('busy'); t.innerHTML = `${ic('file')}<span class="filechip">amazon-relay-export.csv</span>`;
      if (mode === 'booked') d.rows = [0, 1, 2, 3].map(i => ({ trip: `1${['1', '2', '3', '4'][i]}${['6KT', '7QX', '3MZ', '9RB'][i]}${9 + i}N${i}V`, from: ['Amazon HOU8', 'Amazon DFW6', 'Amazon ONT8', 'Amazon MEM1'][i], to: ['Amazon DFW6', 'Amazon OKC1', 'Amazon PHX7', 'Amazon BNA2'][i], a: [2, 3, 4, 9][i], b: [0, 23, 18, 24][i], start: RL.dayOff(1 + i, 6), end: RL.dayOff(1 + i, 18), pay: [300, 820, 1150, 640][i] }));
      else d.rows = db.loads.filter(L => !L.deleted && (L.amazon || L.customerId === 2) && ['dispatched', 'in_transit'].includes(L.status)).map(L => ({ L, trip: L.loadId, from: firstStop(L).company, to: lastStop(L).company, pay: L.loadPay }));
      H.$('#amz-preview', d.el).innerHTML = d.rows.length ? `<table class="t" aria-label="CSV preview"><thead><tr><th scope="col">Trip ID</th><th scope="col">Facility sequence</th><th scope="col" class="num">Payout</th><th scope="col">Result</th></tr></thead><tbody>${d.rows.map(r => `<tr><td>${esc(r.trip)}</td><td>${esc(r.from)} → ${esc(r.to)}</td><td class="num">${money(r.pay)}</td><td>${mode === 'booked' ? 'New load (Booked)' : `${r.L.sid} → Delivered`}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No matching Dispatched or In-Transit Amazon loads in the file.</p>';
      H.$('#amz-go', d.el).disabled = !d.rows.length;
    }, 1200);
  };
})();
