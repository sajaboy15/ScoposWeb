/* RoadLedger TMS replica: core (helpers, write/commit, toasts, menus, dialogs, drawers, tables, router, shell).
   A workflow-level replica of a trucking TMS rebuilt from tutorial-video frames and notes, used as a test bed for Scopos.
   Every commit POSTs /api/tms/write with action "replica:<name>"; opening forms, tabs, menus and drawers makes no network calls. */
(function () {
  'use strict';
  const RL = window.RL, db = RL.db;

  // =============== helpers ===============
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const money = (n, paren) => { const v = +n || 0; const s = '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return v < 0 || paren ? `(${s})` : s; };
  const num = (n, d = 2) => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const p2 = n => String(n).padStart(2, '0');
  const toD = s => s ? new Date(s.length <= 10 ? s + 'T00:00' : s) : null;
  const fmtDate = s => { const d = toD(s); return d ? `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : '-'; };
  const fmtLong = s => { const d = toD(s); return d ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : 'N/A'; };
  const fmtTime = s => { const d = toD(s); return d ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : ''; };
  const fmtDT = s => s ? `${fmtDate(s)}, ${fmtTime(s)}` : '-';
  const fmtEvt = s => { const d = toD(s); return d ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}` : ''; };
  const fmtMDY = s => { const d = toD(s); return d ? `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${d.getFullYear()}` : '-'; };
  const fmtWeekday = s => { const d = toD(s); return d ? `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : '-'; };
  const daysBetween = (a, b) => Math.round((toD(b) - toD(a)) / 864e5);
  let clock = 0;
  const nowIso = () => RL.iso(new Date(RL.TODAY.getTime() + (++clock) * 60000));
  const todayStr = RL.iso(RL.TODAY).slice(0, 10);
  let uid = 0;
  const nid = () => 'u' + (++uid);

  // entities
  const byId = (arr, id) => arr.find(x => String(x.id) === String(id));
  const cust = id => byId(db.customers, id) || { name: '-' };
  const drv = id => byId(db.drivers, id);
  const trk = id => byId(db.trucks, id);
  const trl = id => byId(db.trailers, id);
  const mcOf = id => byId(db.mcs, id) || { name: '-' };
  const disp = id => byId(db.dispatchers, id);
  const carrier = id => byId(db.carriers, id);
  const dname = d => d ? `${d.first} ${d.last}` : '';
  const loadById = id => db.loads.find(L => L.id === +id && !L.deleted);
  const loadBySid = s => db.loads.find(L => L.sid === s && !L.deleted);
  const SLUG = { offer: 'offer', booked: 'booked', assigned: 'assigned', dispatched: 'dispatched', in_transit: 'in-transit', delivered: 'delivered', invoiced: 'invoiced', paid: 'paid' };
  const loadUrl = L => `#/load-management/create-load/${SLUG[L.status]}/${L.id}/${L.sid}`;
  const firstStop = L => L.stops.find(s => s.type === 'Pickup') || L.stops[0];
  const lastStop = L => [...L.stops].reverse().find(s => s.type === 'Delivery') || L.stops[L.stops.length - 1];
  const place = s => s ? `${s.city}, ${s.state}` : '';
  const placeLong = s => s ? `${s.city}, ${RL.STATE_NAMES[s.state] || s.state}` : '';
  const accessorials = L => r2(L.otherPay.filter(o => o.type !== 'Driver').reduce((a, o) => a + (+o.amount || 0), 0));
  const totalPay = L => L.tonu ? r2(L.tonuAmount || L.loadPay) : r2(L.loadPay + accessorials(L));
  const driverPayOf = L => r2(L.trips.reduce((a, t) => a + (+t.driverPay || 0), 0) + L.otherPay.filter(o => o.type === 'Driver').reduce((a, o) => a + (+o.amount || 0), 0));
  const tripDriver = t => t && (t.driverId ? drv(t.driverId) : null);
  const mainTrip = L => L.trips[0];
  const tripLabel = t => !t ? '-' : t.carrierId ? (carrier(t.carrierId) || {}).name : dname(tripDriver(t));
  const truckOfTrip = t => t && t.truckId ? trk(t.truckId) : null;
  RL.h = { $, $$, esc, r2, money, num, fmtDate, fmtLong, fmtTime, fmtDT, fmtEvt, fmtMDY, fmtWeekday, daysBetween, nowIso, todayStr, nid, byId, cust, drv, trk, trl, mcOf, disp, carrier, dname, loadById, loadBySid, loadUrl, SLUG, firstStop, lastStop, place, placeLong, accessorials, totalPay, driverPayOf, tripDriver, mainTrip, tripLabel, truckOfTrip, toD, MON };

  // =============== icons ===============
  const P = {
    menu: 'M3 6h18M3 12h18M3 18h18', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3', plus: 'M12 5v14M5 12h14', down: 'M6 9l6 6 6-6', up: 'M18 15l-6-6-6 6', right: 'M9 18l6-6-6-6', left: 'M15 18l-6-6 6-6',
    first: 'M11 17l-5-5 5-5M18 17l-5-5 5-5', last: 'M13 17l5-5-5-5M6 17l5-5-5-5', x: 'M18 6L6 18M6 6l12 12', filter: 'M3 4h18l-7 8.5V18l-4 2v-7.5z', sort: 'M8 4v16M4.5 7.5L8 4l3.5 3.5M16 20V4M12.5 16.5L16 20l3.5-3.5',
    upload: 'M12 16V4M7 9l5-5 5 5M4 20h16', download: 'M12 4v12M7 11l5 5 5-5M4 20h16', columns: 'M3 4h18v16H3zM9 4v16M15 4v16', bookmark: 'M6 3h12v18l-6-4-6 4z', density: 'M4 5h16M4 10h16M4 15h16M4 20h16',
    more: 'M12 5h.01M12 12h.01M12 19h.01', edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4', copy: 'M9 9h11v11H9zM5 15H4V4h11v1', flag: 'M5 21V4h13l-3 4 3 4H5', map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15',
    dashboard: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z', file: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h7M9 17h7', calendar: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4', pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
    dollar: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.8 3 2.1 3 .9 3 2.1-1.3 2-3 2c-1.4 0-2.6-.6-3-1.6M12 6v2M12 16v2', crm: 'M3 4h18v16H3zM7 9h5M7 13h3M7 16h6M15 9h2v6h-2z',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', truck: 'M2 6h11v10H2zM13 9h4l4 4v3h-8zM6.5 16a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM17.5 16a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
    wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z', users: 'M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 20c.6-3.5 3.3-5.5 6.5-5.5s5.9 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c1.9.7 3.2 2.6 3.5 5.4',
    report: 'M6 2h12v20H6zM9 7h6M9 11h6M9 15h4', nodes: 'M5 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6.5 6.5l3.6 3.6M17.5 6.5l-3.6 3.6M6.5 17.5l3.6-3.6M17.5 17.5l-3.6-3.6',
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    tasks: 'M5 4h14v18H5zM9 2h6v4H9zM9 13l2 2 4-4', bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4', chat: 'M4 4h16v12H8l-4 4z', help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z', send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z', user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21c1-4 4-6 8-6s7 2 8 6', userplus: 'M10 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM3 21c1-4 3.5-6 7-6s6 2 7 6M19 8v6M16 11h6',
    share: 'M10 9V5l-7 7 7 7v-4c5 0 8 1.5 11 5-1-6-4-10-11-11z', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    ok: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12l3 3 5-6', warn: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v6M12 16.5h.01', bad: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6', check: 'M5 12l5 5 9-10',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1', mail: 'M3 5h18v14H3zM3 7l9 6 9-6', phone: 'M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z',
    sync: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5', split: 'M7 3v18M7 8h6a4 4 0 0 1 4 4v9', grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', lock: 'M5 11h14v10H5zM8 11V8a4 4 0 0 1 8 0v3', unlock: 'M5 11h14v10H5zM8 11V8a4 4 0 0 1 7.5-2',
    history: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2', minus: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12h8', building: 'M4 21V5l8-3v19M12 21h8V9l-8-3M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2', headset: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v5H4zM17 14h3v5h-3z',
    printer: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M6 14h12v7H6z', layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5', home: 'M3 11l9-8 9 8v10H3z', grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', fuel: 'M4 21V4h9v17M3 21h11M13 8h3l2 2v7a1.5 1.5 0 0 0 3 0V9l-3-3M6 8h5',
    road: 'M6 21L10 3M18 21L14 3M12 6v2M12 11v2M12 16v2', cash: 'M2 6h20v12H2zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 9v.01M18 15v.01', clip: 'M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8', star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  };
  const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${n === 'more' || n === 'grip' ? ' style="stroke-width:3"' : ''}><path d="${P[n] || P.file}"/></svg>`;
  const LOGO = `<svg class="logo" viewBox="0 0 26 26" aria-hidden="true">${[0, 1, 2].map(r => [0, 1, 2].map(c => `<circle cx="${5 + c * 8}" cy="${5 + r * 8}" r="${(r + c) % 2 ? 2.2 : 3}" fill="#fff" opacity="${(r === 1 && c === 1) ? 1 : (r + c) % 2 ? 0.75 : 0.95}"/>`).join('')).join('')}</svg>`;
  RL.ic = ic; RL.LOGO = LOGO;

  // pills
  const LOAD_ST = { offer: 'OFFER', booked: 'BOOKED', assigned: 'ASSIGNED', dispatched: 'DISPATCHED', in_transit: 'IN TRANSIT', delivered: 'DELIVERED', invoiced: 'INVOICED', paid: 'PAID' };
  const stPill = s => `<span class="st ${s}">${LOAD_ST[s] || esc(s)}</span>`;
  const DRV_ST = { available: 'AVAILABLE', in_transit: 'IN TRANSIT', home: 'HOME', inactive: 'INACTIVE', shop: 'SHOP', rest: 'REST', dispatched: 'DISPATCHED' };
  const drvPill = s => `<span class="st ${s}">${DRV_ST[s] || esc(s)}</span>`;
  const pill = (text, cls) => `<span class="st ${cls || String(text).toLowerCase().replace(/\s+/g, '_')}">${esc(text)}</span>`;
  const readyHtml = r => r === 'ready' ? `<span class="ready ok">${ic('ok')}Ready to go</span>` : r === 'blocked' ? `<span class="ready bad">${ic('bad')}Blocked</span>` : `<span class="ready warn">${ic('warn')}Not ready</span>`;
  const copyBtn = (text, what) => `<span class="cpw"><span><button type="button" class="icon-btn copy" data-act="copy" data-text="${esc(text)}" aria-label="Copy ${esc(what || text)}" title="Copy">${ic('copy')}</button></span></span>`;
  RL.pill = { stPill, drvPill, pill, readyHtml, copyBtn, LOAD_ST, DRV_ST };

  // =============== network: the only place that calls fetch ===============
  async function write(name, data) {
    const r = await fetch('/api/tms/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'replica:' + name, ...(data || {}) }) });
    if (r.status === 403) throw new Error("You don't have permission to do that (403)");
    if (!r.ok) throw new Error('Server error ' + r.status);
    return r.json().catch(() => ({}));
  }
  /** POST the write; on a 200 apply it to memory and toast "Success". On failure: error toast, nothing applied, the caller keeps its dialog open. */
  async function commit(btn, name, data, apply, okMsg) {
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try { await write(name, data); }
    catch (e) { toast(`Couldn't complete the action. ${e && e.message && !/fetch/i.test(e.message) ? e.message + '.' : 'Check your connection and try again.'}`, 'error'); return false; }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); } }
    try { if (apply) apply(); } catch (e) { console.error(e); }
    toast(okMsg || 'Success');
    return true;
  }
  function toast(msg, kind = 'success') {
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    t.innerHTML = `<span class="ti">${ic(kind === 'error' ? 'x' : 'check')}</span><span class="msg">${esc(msg)}</span><button type="button" class="icon-btn" aria-label="Dismiss notification">${ic('x')}</button><span class="prog"></span>`;
    t.querySelector('button').onclick = () => t.remove();
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4500);
  }
  RL.write = write; RL.commit = commit; RL.toast = toast;

  // =============== floating layer: menus and popovers ===============
  let open = null;
  function closeFloating() { if (!open) return; open.el.remove(); if (open.trigger) open.trigger.setAttribute('aria-expanded', 'false'); open = null; }
  function showFloating(trigger, html, { align = 'right', focus = true } = {}) {
    closeFloating();
    const box = document.createElement('div'); box.innerHTML = html.trim(); const node = box.firstElementChild; $('#layer').appendChild(node);
    const r = trigger.getBoundingClientRect(), w = node.offsetWidth, h = node.offsetHeight;
    node.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, align === 'right' ? r.right - w : r.left)) + 'px';
    node.style.top = (r.bottom + 6 + h > window.innerHeight && r.top - h - 6 > 0 ? r.top - h - 6 : Math.min(r.bottom + 6, window.innerHeight - h - 8)) + 'px';
    trigger.setAttribute('aria-expanded', 'true'); open = { trigger, el: node, at: Date.now() };
    if (focus) { const f = node.querySelector('[role=menuitem]:not([aria-disabled=true]), input:not([type=hidden]), select, textarea'); if (f) f.focus({ preventScroll: true }); }
    return node;
  }
  const MENUS = {}; // name -> (triggerEl) => html
  const POPS = {};  // name -> (triggerEl) => html, with optional mount(node, trigger)
  RL.MENUS = MENUS; RL.POPS = POPS; RL.showFloating = showFloating; RL.closeFloating = closeFloating;
  const mi = (label, act, attrs = '', cls = '') => `<li role="none"><button type="button" role="menuitem" class="${cls}" data-act="${act}" ${attrs}>${esc(label)}</button></li>`;
  const ml = (label, href) => `<li role="none"><a role="menuitem" href="${href}">${esc(label)}</a></li>`;
  const msep = '<li role="separator"></li>';
  const menu = (label, items) => `<ul class="menu" role="menu" aria-label="${esc(label)}">${items.join('')}</ul>`;
  RL.mi = mi; RL.ml = ml; RL.msep = msep; RL.menu = menu;

  // =============== dialogs: native <dialog>, div[role=dialog] and right-side drawers ===============
  const stack = [];
  function openModal({ title, sub = '', body, footer, kind = 'native', size = '', headExtra = '', label }) {
    closeFloating();
    const id = nid(), opener = document.activeElement;
    const inner = `<form class="modal-form" novalidate><div class="modal-head"><div class="grow"><h2 id="${id}-t">${esc(title)}</h2>${sub ? `<div class="sub-t">${esc(sub)}</div>` : ''}</div>${headExtra}${kind === 'drawer' ? '' : `<button type="button" class="icon-btn" aria-label="Close" data-act="dlg-close">${ic('x')}</button>`}</div>
      <div class="modal-body">${body}</div>${footer != null ? `<div class="modal-foot">${footer}</div>` : ''}</form>`;
    let root, el;
    if (kind === 'native') { root = el = document.createElement('dialog'); el.className = 'modal ' + size; el.setAttribute('aria-labelledby', id + '-t'); el.innerHTML = inner; document.body.appendChild(el); el.showModal(); }
    else if (kind === 'drawer') {
      root = document.createElement('div'); root.className = 'drawer-wrap';
      root.innerHTML = `<div class="drawer-backdrop" data-act="dlg-close"></div><aside class="drawer ${size}" role="dialog" aria-modal="true" aria-labelledby="${id}-t"><button type="button" class="drawer-x" aria-label="Close" data-act="dlg-close">${ic('x')}</button>${inner}</aside>`;
      document.body.appendChild(root); el = root.lastElementChild;
    } else { root = document.createElement('div'); root.className = 'overlay'; root.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="${id}-t">${inner}</div>`; document.body.appendChild(root); el = root.firstElementChild; }
    if (label) el.setAttribute('aria-label', label);
    if (kind !== 'native') root.style.zIndex = String(60 + stack.length * 2); // a drawer opened from a modal stays on top of it
    const rec = { el, root, kind, form: el.querySelector('form'), close() { root.remove(); const i = stack.indexOf(rec); if (i >= 0) stack.splice(i, 1); if (opener && opener.isConnected) opener.focus({ preventScroll: true }); } };
    if (kind === 'native') el.addEventListener('cancel', e => { e.preventDefault(); rec.close(); });
    if (kind === 'div') root.addEventListener('mousedown', e => { if (e.target === root) rec.close(); });
    rec.form.addEventListener('submit', e => e.preventDefault());
    stack.push(rec);
    const f = el.querySelector('.modal-body input:not([type=hidden]):not([type=radio]):not([type=checkbox]), .modal-body select, .modal-body textarea'); if (f) f.focus({ preventScroll: true });
    return rec;
  }
  const topDialog = () => stack[stack.length - 1];
  const closeAllDialogs = () => { while (stack.length) stack[stack.length - 1].close(); };
  RL.openModal = openModal; RL.closeAllDialogs = closeAllDialogs;

  const opt = o => Array.isArray(o) ? o : [o, o];
  /** A labelled form field. type: text | number | date | datetime-local | email | tel | select | textarea | checkbox | money */
  function field(f) {
    const id = f.id || `f-${f.name}-${nid()}`, req = f.required ? ' required aria-required="true"' : '', v = f.value == null ? '' : f.value, dis = f.disabled ? ' disabled' : '', ro = f.readonly ? ' readonly' : '';
    if (f.type === 'checkbox') return `<div class="field check ${f.cls || ''}"><input type="checkbox" id="${id}" name="${f.name}" ${f.value ? 'checked' : ''}${dis}><label for="${id}">${esc(f.label)}</label></div>`;
    let ctl;
    if (f.type === 'select') ctl = `<select id="${id}" name="${f.name}"${req}${dis}>${f.placeholder === false ? '' : `<option value="">${esc(f.placeholder || 'Select…')}</option>`}${f.options.map(o => { const [val, lab] = opt(o); return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
    else if (f.type === 'textarea') ctl = `<textarea id="${id}" name="${f.name}" placeholder="${esc(f.placeholder || '')}"${req}${dis}>${esc(v)}</textarea>`;
    else ctl = `<input id="${id}" name="${f.name}" type="${f.type === 'money' ? 'number' : f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"${f.type === 'money' ? ' step="0.01" min="0"' : ''}${f.step ? ` step="${f.step}"` : ''}${f.min != null ? ` min="${f.min}"` : ''}${req}${dis}${ro}${f.list ? ` list="${f.list}"` : ''}>`;
    return `<div class="field ${f.type === 'money' ? 'money ' : ''}${f.cls || ''}"><label for="${id}">${esc(f.label)}${f.required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>${ctl}${f.hint ? `<small class="hint">${esc(f.hint)}</small>` : ''}<small class="err" hidden></small></div>`;
  }
  const readForm = form => { const o = {}; new FormData(form).forEach((v, k) => { if (!(v instanceof File)) { if (k in o) o[k] = [].concat(o[k], v); else o[k] = v; } }); $$('input[type=checkbox][name]', form).forEach(c => { if (!c.value || c.value === 'on') o[c.name] = c.checked; }); return o; };
  function validate(form) {
    let first = null;
    $$('[required]', form).forEach(el => {
      const box = el.closest('.field'), err = box && box.querySelector('.err');
      const bad = el.disabled ? false : el.type === 'radio' ? !form.querySelector(`[name="${el.name}"]:checked`) : !String(el.value).trim() || (el.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(el.value)) || (el.type === 'number' && el.min !== '' && +el.value < +el.min);
      el.setAttribute('aria-invalid', String(bad));
      if (err) { err.hidden = !bad; err.textContent = bad ? (String(el.value).trim() ? 'Enter a valid value' : 'This field is required') : ''; }
      if (bad && !first) first = el;
    });
    if (first) first.focus();
    return !first;
  }
  /** A dialog or drawer whose submit commits one write. */
  function formDialog({ title, sub, body, fields, submit = 'Save', cancel = 'Cancel', name, kind = 'native', size = '', build, apply, okMsg, after, footerExtra = '' }) {
    const html = body != null ? body : `<div class="grid2">${fields.map(field).join('')}</div>`;
    const d = openModal({ title, sub, kind, size, body: html, footer: `${footerExtra}<button type="button" class="btn" data-act="dlg-close">${esc(cancel)}</button><button type="submit" class="btn purple">${esc(submit)}</button>` });
    d.form.addEventListener('submit', async e => {
      e.preventDefault(); if (!validate(d.form)) return;
      const data = readForm(d.form); const payload = build ? build(data, d) : data;
      if (payload === false) return;
      const ok = await commit(d.form.querySelector('[type=submit]'), name, payload, () => apply && apply(payload, data, d), okMsg);
      if (ok) { d.close(); if (after) after(payload, data); else rerender(); }
    });
    return d;
  }
  function confirmDialog({ title = 'Confirmation', message, details = '', yes = 'Yes', no = 'No', name, data, apply, danger, after, okMsg }) {
    const d = openModal({ title, kind: 'native', size: 'narrow', body: `<div class="row" style="align-items:flex-start"><span class="confirm-icon">${ic('warn')}</span><p style="margin:0">${esc(message)}</p></div>${details}`, footer: `<button type="button" class="btn" data-act="dlg-close">${esc(no)}</button><button type="submit" class="btn ${danger ? 'danger' : 'purple'}">${esc(yes)}</button>` });
    d.el.setAttribute('role', 'alertdialog');
    d.form.addEventListener('submit', async e => { e.preventDefault(); if (await commit(d.form.querySelector('[type=submit]'), name, data, apply, okMsg)) { d.close(); if (after) after(); else rerender(); } });
    return d;
  }
  RL.field = field; RL.readForm = readForm; RL.validate = validate; RL.formDialog = formDialog; RL.confirmDialog = confirmDialog; RL.topDialog = topDialog;

  // =============== tables ===============
  const TS = {}, TCFG = {};
  function tstate(id, cfg) {
    if (!TS[id]) TS[id] = { sort: cfg && cfg.sort || null, filters: {}, page: 1, size: (cfg && cfg.size) || 20, sel: new Set(), hidden: new Set(cfg ? cfg.columns.filter(c => c.hidden).map(c => c.key) : []), dense: false, open: new Set() };
    return TS[id];
  }
  const colText = (c, r) => { const v = c.text ? c.text(r) : r[c.key]; return v == null ? '' : v; };
  function filteredRows(cfg) {
    const s = tstate(cfg.id, cfg);
    let rows = cfg.rows();
    for (const [k, v] of Object.entries(s.filters)) { if (!v) continue; const c = cfg.columns.find(x => x.key === k); if (c) { const q = String(v).toLowerCase(); rows = rows.filter(r => String(colText(c, r)).toLowerCase().includes(q)); } }
    if (s.sort) { const c = cfg.columns.find(x => x.key === s.sort.key); if (c) { const val = c.sortVal || (r => colText(c, r)); const dir = s.sort.dir === 'asc' ? 1 : -1; rows = rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * dir; }); } }
    return rows;
  }
  function pagerHtml(id, page, pages) {
    const btn = (p, label, aria, dis) => `<button type="button" data-act="tpage" data-t="${id}" data-p="${p}" aria-label="${aria}"${dis ? ' disabled' : ''}${p === page && /^\d+$/.test(label) ? ' aria-current="page"' : ''}>${label}</button>`;
    const nums = []; const lo = Math.max(1, Math.min(page - 2, pages - 4)), hi = Math.min(pages, lo + 4);
    for (let p = lo; p <= hi; p++) nums.push(btn(p, String(p), `Page ${p}`));
    if (hi < pages) nums.push('<span class="muted">…</span>', btn(pages, String(pages), `Page ${pages}`));
    return `<nav class="pager" aria-label="Pagination">${btn(page - 1, '‹', 'Previous page', page <= 1)}${nums.join('')}${btn(page + 1, '›', 'Next page', page >= pages)}</nav>`;
  }
  function tableBody(cfg) {
    const s = tstate(cfg.id, cfg);
    const rows = filteredRows(cfg), total = rows.length, pages = Math.max(1, Math.ceil(total / s.size));
    if (s.page > pages) s.page = pages;
    const pageRows = rows.slice((s.page - 1) * s.size, s.page * s.size);
    const cols = cfg.columns.filter(c => !s.hidden.has(c.key));
    const key = cfg.key || (r => r.id);
    const allSel = pageRows.length && pageRows.every(r => s.sel.has(String(key(r))));
    const th = cols.map(c => {
      const sorted = s.sort && s.sort.key === c.key ? (s.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const inner = c.nosort ? `<span>${esc(c.label)}</span>` : `<button type="button" class="sortb" data-act="tsort" data-t="${cfg.id}" data-k="${c.key}" aria-sort="${sorted}" aria-label="Sort by ${esc(c.label)}">${ic('sort')}<span>${esc(c.label)}</span></button>`;
      const filt = c.nofilter || c.nosort ? '' : `<button type="button" class="icon-btn fbtn${s.filters[c.key] ? ' on' : ''}" data-act="tfilter" data-t="${cfg.id}" data-k="${c.key}" aria-haspopup="dialog" aria-expanded="false" aria-label="Filter ${esc(c.label)}">${ic('filter')}</button>`;
      return `<th scope="col"${c.num ? ' class="num"' : ''}${sorted !== 'none' ? ` aria-sort="${sorted}"` : ''}><div class="th"><span class="thw"><span>${inner}</span></span>${filt}</div></th>`;
    }).join('');
    const body = pageRows.map(r => {
      const k = String(key(r)), sel = s.sel.has(k), rowName = cfg.rowName ? cfg.rowName(r) : k;
      const cls = [sel ? 'sel' : '', cfg.rowClass ? cfg.rowClass(r) : ''].join(' ').trim();
      const exp = cfg.expand ? `<td class="cb"><button type="button" class="icon-btn" style="width:22px;height:22px" data-act="texpand" data-t="${cfg.id}" data-k="${esc(k)}" aria-expanded="${s.open.has(k)}" aria-label="Show trips of ${esc(rowName)}">${ic(s.open.has(k) ? 'down' : 'right')}</button></td>` : '';
      const tds = cols.map(c => `<td${c.num ? ' class="num"' : ''}>${c.render ? c.render(r) : esc(colText(c, r))}</td>`).join('');
      const act = cfg.rowMenu ? `<td class="act"><span><span><button type="button" class="icon-btn" data-act="menu" data-menu="${cfg.rowMenu}" data-id="${esc(k)}" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${esc(rowName)}">${ic('more')}</button>${cfg.flag && cfg.flag(r) ? `<span class="flag" title="${esc(cfg.flag(r))}" aria-label="${esc(cfg.flag(r))}">${ic('flag')}</span>` : ''}</span></span></td>` : cfg.rowEdit ? `<td class="act"><span><span><button type="button" class="icon-btn" data-act="${cfg.rowEdit}" data-id="${esc(k)}" aria-haspopup="dialog" aria-label="Edit ${esc(rowName)}">${ic('edit')}</button></span></span></td>` : '';
      const main = `<tr class="${cls}" data-k="${esc(k)}"${cfg.dbl ? ` data-dbl="${cfg.dbl}" data-id="${esc(k)}"` : ''}>${cfg.select !== false ? `<td class="cb"><input type="checkbox" data-act="tsel" data-t="${cfg.id}" data-k="${esc(k)}" aria-label="Select ${esc(rowName)}" ${sel ? 'checked' : ''}></td>` : ''}${exp}${tds}${act}</tr>`;
      return main + (cfg.expand && s.open.has(k) ? cfg.expand(r, cols.length + 2 + (cfg.select !== false ? 1 : 0)) : '');
    }).join('');
    const colspan = cols.length + (cfg.select !== false ? 1 : 0) + (cfg.expand ? 1 : 0) + (cfg.rowMenu || cfg.rowEdit ? 1 : 0);
    const totals = cfg.totals ? `<div class="totals">${cfg.totals(rows, s)}</div>` : '';
    const from = total ? (s.page - 1) * s.size + 1 : 0, to = Math.min(total, s.page * s.size);
    return `<div class="tscroll${cfg.tall ? ' tall' : ''}"><table class="t${s.dense ? ' dense' : ''}" aria-label="${esc(cfg.label)}"><thead><tr>${cfg.select !== false ? `<th class="cb" scope="col"><input type="checkbox" data-act="tselall" data-t="${cfg.id}" aria-label="Select all rows" ${allSel ? 'checked' : ''}></th>` : ''}${cfg.expand ? '<th class="cb" scope="col"><span class="sr-only">Expand</span></th>' : ''}${th}${cfg.rowMenu || cfg.rowEdit ? '<th class="act" scope="col"><span class="sr-only">Actions</span></th>' : ''}</tr></thead>
      <tbody>${body || `<tr><td colspan="${colspan}" class="empty">${esc(cfg.empty || 'No data')}</td></tr>`}</tbody></table></div>
      <div class="tfoot">${totals}<span class="grow"></span><span class="muted">Showing ${from}-${to} from ${total} data</span>${pagerHtml(cfg.id, s.page, pages)}<label class="rows-sel muted">Show Rows <select data-change="tsize" data-t="${cfg.id}" aria-label="Rows per page">${[20, 50, 100].map(n => `<option ${n === s.size ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>`;
  }
  /** Table with its toolbar. cfg: { id, label, columns, rows: () => [], key, rowName, select, rowMenu, rowEdit, dbl, expand, totals, toolbarLeft, toolbarRight, rowClass, flag } */
  function table(cfg) {
    TCFG[cfg.id] = cfg; tstate(cfg.id, cfg);
    const tb = cfg.toolbar === false ? '' : `<div class="tb-top"><div class="toolbar" role="toolbar" aria-label="${esc(cfg.label)} tools"><div class="tgrp"><button type="button" class="btn sm" data-act="menu" data-pop="filters" data-t="${cfg.id}" aria-haspopup="dialog" aria-expanded="false">${ic('filter')}Filter</button>${activeFilterChips(cfg)}${cfg.toolbarLeft || ''}<span class="grow"></span>${cfg.toolbarRight != null ? cfg.toolbarRight : stdRight(cfg)}</div></div></div>`;
    return `<section class="tbl-wrap" data-table="${cfg.id}" aria-label="${esc(cfg.label)}">${tb}<div class="tbody-host" id="tb-${cfg.id}">${tableBody(cfg)}</div></section>`;
  }
  function activeFilterChips(cfg) {
    const s = tstate(cfg.id, cfg);
    return Object.entries(s.filters).filter(([, v]) => v).map(([k, v]) => { const c = cfg.columns.find(x => x.key === k) || { label: k }; return `<span class="filter-chip">${esc(c.label)}: <b>${esc(v)}</b><button type="button" class="icon-btn" data-act="tclearf" data-t="${cfg.id}" data-k="${k}" aria-label="Remove filter ${esc(c.label)}">${ic('x')}</button></span>`; }).join('');
  }
  const stdRight = (cfg, extra = '') => `${extra}<button type="button" class="btn sm" data-act="export" data-t="${cfg.id}">${ic('download')}Export</button><button type="button" class="btn sm soft" data-act="save-view" data-t="${cfg.id}" aria-haspopup="dialog">${ic('bookmark')}Save view</button><button type="button" class="btn sm" data-act="density" data-t="${cfg.id}" aria-pressed="${!!(TS[cfg.id] && TS[cfg.id].dense)}">${ic('density')}Density</button><button type="button" class="btn sm" data-act="menu" data-pop="columns" data-t="${cfg.id}" aria-haspopup="dialog" aria-expanded="false">${ic('columns')}Columns</button>`;
  function rerenderTable(id) {
    const cfg = TCFG[id], host = document.getElementById('tb-' + id); if (!cfg || !host) return;
    const sc = host.querySelector('.tscroll'), st = sc ? sc.scrollLeft : 0;
    host.innerHTML = tableBody(cfg);
    const sc2 = host.querySelector('.tscroll'); if (sc2) sc2.scrollLeft = st;
    const wrap = host.closest('[data-table]'); const tb = wrap && wrap.querySelector('.toolbar');
    if (tb) { $$('.filter-chip', tb).forEach(x => x.remove()); const btn = tb.querySelector('[data-pop=filters]'); if (btn) btn.insertAdjacentHTML('afterend', activeFilterChips(cfg)); }
    selDeps();
  }
  /** Buttons that need a selection: data-needs-sel="<tableId>" (optionally data-sel-test="<name>" in SELTEST). */
  const SELTEST = {};
  function selDeps() {
    $$('[data-needs-sel]').forEach(b => {
      const s = TS[b.dataset.needsSel]; const n = s ? s.sel.size : 0;
      const ok = b.dataset.selTest && SELTEST[b.dataset.selTest] ? SELTEST[b.dataset.selTest](s ? [...s.sel] : []) : n > 0;
      b.disabled = !ok; if (b.tagName !== 'BUTTON') b.setAttribute('aria-disabled', String(!ok));
    });
    $$('[data-sel-count]').forEach(x => { const s = TS[x.dataset.selCount]; x.textContent = s ? s.sel.size : 0; });
    if (RL.onSel) RL.onSel();
  }
  RL.table = table; RL.TS = TS; RL.TCFG = TCFG; RL.tstate = tstate; RL.rerenderTable = rerenderTable; RL.filteredRows = filteredRows; RL.SELTEST = SELTEST; RL.selDeps = selDeps; RL.stdRight = stdRight;
  POPS.columns = t => { const cfg = TCFG[t.dataset.t], s = tstate(cfg.id, cfg); return `<div class="popover" role="dialog" aria-label="Columns"><div class="pop-head"><h3>Columns</h3></div><div class="col-list">${cfg.columns.map(c => `<label><input type="checkbox" data-change="tcol" data-t="${cfg.id}" data-k="${c.key}" ${s.hidden.has(c.key) ? '' : 'checked'}> ${esc(c.label)}</label>`).join('')}</div></div>`; };
  POPS.tfilter = t => { const cfg = TCFG[t.dataset.t], c = cfg.columns.find(x => x.key === t.dataset.k), v = tstate(cfg.id).filters[c.key] || ''; const fid = nid(); return `<form class="popover" role="dialog" aria-label="Filter ${esc(c.label)}" data-submit="tfilter-apply" data-t="${cfg.id}" data-k="${c.key}"><div class="field"><label for="${fid}">Filter ${esc(c.label)}</label><input id="${fid}" name="q" value="${esc(v)}" placeholder="Contains…"></div><div class="pop-foot"><button type="button" class="btn sm" data-act="tclearf" data-t="${cfg.id}" data-k="${c.key}">Clear</button><button type="submit" class="btn sm purple">Apply</button></div></form>`; };
  POPS.filters = t => {
    const cfg = TCFG[t.dataset.t], s = tstate(cfg.id, cfg);
    const cols = cfg.columns.filter(c => !c.nofilter && !c.nosort).slice(0, 8);
    return `<form class="popover wide" role="dialog" aria-label="Filter" data-submit="filters-apply" data-t="${cfg.id}"><div class="pop-head"><h3>Filter</h3></div><div class="grid2">${cols.map(c => { const fid = nid(); return `<div class="field"><label for="${fid}">${esc(c.label)}</label><input id="${fid}" name="${c.key}" value="${esc(s.filters[c.key] || '')}" placeholder="Contains…"></div>`; }).join('')}</div><div class="pop-foot"><button type="button" class="btn sm" data-act="filters-clear" data-t="${cfg.id}">Clear all</button><button type="submit" class="btn sm purple">Apply</button></div></form>`;
  };

  // =============== router ===============
  const ROUTES = [];
  RL.route = (pattern, fn) => { const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'); ROUTES.push({ re, keys, fn, pattern }); };
  let current = null;
  function parseHash() { const h = location.hash.replace(/^#/, '') || ''; const [path, qs] = h.split('?'); const q = {}; new URLSearchParams(qs || '').forEach((v, k) => (q[k] = v)); return { path: path || '/', q }; }
  function render() {
    const { path, q } = parseHash();
    if (path === '/' || path === '') { location.replace('#/dashboard/overview'); return; }
    let hit = null, params = {};
    for (const r of ROUTES) { const m = r.re.exec(path); if (m) { hit = r; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); break; } }
    closeFloating();
    const main = $('#main');
    if (!main) return; // the shell is not mounted yet (an early hashchange before boot)
    let view;
    try { view = hit ? hit.fn(params, q) : null; } catch (e) { console.error(e); view = null; }
    if (!view) view = { crumbs: ['Not found'], html: `<div class="card card-pad"><h1>Page not found</h1><p class="muted">The address <code>${esc(path)}</code> does not match a screen.</p><a class="btn purple" href="#/dashboard/overview">Go to Dashboard</a></div>` };
    if (view.redirect) { location.replace(view.redirect); return; }
    const same = current && current.path === path;
    current = { path, q, params, view };
    main.className = 'content' + (view.flush ? ' flush' : '');
    const st = main.scrollTop;
    main.innerHTML = view.html;
    if (same && current.keepScroll) main.scrollTop = st; else if (!same) main.scrollTop = 0;
    setCrumbs(view.crumbs || []);
    document.title = `${(view.crumbs || []).slice(-1)[0] || 'RoadLedger'} · RoadLedger TMS`;
    markNav(path);
    if (view.mount) view.mount(main);
    selDeps();
  }
  /** Re-render the current screen in place (after a write), keeping scroll. */
  function rerender() { if (current) current.keepScroll = true; render(); if (current) current.keepScroll = false; }
  RL.render = render; RL.rerender = rerender; RL.current = () => current;
  function setCrumbs(c) {
    $('#crumbs').innerHTML = c.map((x, i) => { const [t, href] = Array.isArray(x) ? x : [x]; return `${i ? '<span class="sep" aria-hidden="true">/</span>' : ''}${href ? `<a href="${href}">${esc(t)}</a>` : `<span${i === c.length - 1 ? ' aria-current="page"' : ''}>${esc(t)}</span>`}`; }).join('');
  }

  // =============== shell ===============
  const NAV = [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', href: '#/dashboard/overview', match: /^\/dashboard\/overview/ },
    { key: 'loads', label: 'Load Management', icon: 'file', match: /^\/load-management/, items: [['Load + Trip', '#/load-management/load-trip', ['/load-management/load-trip', '/load-management/create-load', '/load-management/loads']], ['Trips', '#/load-management/trips'], ['Drivers Unbilled', '#/load-management/drivers-unbilled'], ['Amazon loads', '#/load-management/amazon-loads']] },
    { key: 'planning', label: 'Planning Calendar', icon: 'calendar', href: '#/planning', match: /^\/planning/ },
    { key: 'map', label: 'MAP', icon: 'map', href: '#/map', match: /^\/map/ },
    { key: 'accounting', label: 'Accounting', icon: 'dollar', match: /^\/accounting/, items: [['Invoices', '#/accounting/invoices/batches', ['/accounting/invoices']], ['Factoring', '#/accounting/invoices/factoring'], ['Salary', '#/accounting/salary/driver-settlements', ['/accounting/salary']], ['Scheduled payments', '#/accounting/salary/deductions'], ['Bills Management', '#/accounting/bills'], ['Payroll', '#/accounting/payroll']] },
    { key: 'crm', label: 'Customer Management', icon: 'crm', match: /^\/customer-management/, items: [['Customers', '#/customer-management/customers', ['/customer-management']]] },
    { key: 'safety', label: 'Safety', icon: 'shield', href: '#/safety', match: /^\/safety/ },
    { key: 'fleet', label: 'Fleet Management', icon: 'truck', match: /^\/fleet-management/, items: [['Trucks', '#/fleet-management/trucks'], ['Trailers', '#/fleet-management/trailers']] },
    { key: 'maintenance', label: 'Maintenance', icon: 'wrench', href: '#/maintenance', match: /^\/maintenance/ },
    { key: 'hr', label: 'HR Management', icon: 'users', match: /^\/hr-management/, items: [['Drivers', '#/hr-management/driver/drivers', ['/hr-management/driver', '/hr-management/edit-driver']], ['Dispatchers', '#/hr-management/dispatchers']] },
    { key: 'reports', label: 'Reports', icon: 'report', href: '#/dashboard/reports/profit-by-customer', match: /^\/dashboard\/reports/ },
    { key: 'integration', label: 'Integration', icon: 'nodes', match: /^\/integrations/, items: [['Fuel', '#/integrations/fuel/transactions', ['/integrations/fuel']], ['Toll', '#/integrations/toll/transactions', ['/integrations/toll']], ['Money code', '#/integrations/money-code'], ['Cash advance', '#/integrations/cash-advance']] },
    { key: 'settings', label: 'Settings', icon: 'gear', href: '#/settings/mc-numbers', match: /^\/settings/ },
    { key: 'tasks', label: 'Tasks', icon: 'tasks', href: '#/tasks', match: /^\/tasks/ },
  ];
  const navOpen = new Set(), autoOpen = new Set();
  let collapsed = false;
  try { collapsed = localStorage.getItem('rl-collapsed') === '1'; } catch (e) { /* storage blocked */ }
  function navHtml() {
    return NAV.map(n => {
      if (!n.items) return `<a class="nav-item" href="${n.href}" data-nav="${n.key}" aria-label="${esc(n.label)}">${ic(n.icon)}<span class="lbl">${esc(n.label)}</span></a>`;
      const isOpen = navOpen.has(n.key);
      return `<button type="button" class="nav-item" data-act="nav-toggle" data-key="${n.key}" data-nav="${n.key}" aria-expanded="${collapsed ? false : isOpen}" ${collapsed ? 'aria-haspopup="menu"' : `aria-controls="sub-${n.key}"`} aria-label="${esc(n.label)}">${ic(n.icon)}<span class="lbl">${esc(n.label)}</span>${ic('down', 'chev')}</button>
        <div class="sub" id="sub-${n.key}" ${isOpen ? '' : 'hidden'}>${n.items.map(([t, h]) => `<a href="${h}" data-sub="${h}">${esc(t)}</a>`).join('')}</div>`;
    }).join('');
  }
  function markNav(path) {
    // The current section's group opens by itself; groups opened that way fold again when you leave the section.
    NAV.forEach(n => { if (!n.items) return; const here = n.match.test(path); if (here && !navOpen.has(n.key)) { setGroup(n.key, true); autoOpen.add(n.key); } else if (!here && autoOpen.has(n.key)) { setGroup(n.key, false); autoOpen.delete(n.key); } });
    $$('[data-nav]').forEach(el => { const n = NAV.find(x => x.key === el.dataset.nav); const on = n.match.test(path) && !(n.key === 'dashboard' && /reports/.test(path)); el.classList.toggle('active', on); if (el.tagName === 'A') { if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); } });
    NAV.filter(n => n.items).forEach(n => {
      let best = null, len = -1;
      n.items.forEach(([, h, pre]) => (pre || [h.slice(1)]).forEach(x => { if ((path === x || path.startsWith(x + '/')) && x.length > len) { best = h; len = x.length; } }));
      $$(`#sub-${n.key} a`).forEach(a => { if (a.dataset.sub === best) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    });
  }
  /** Open or fold one sidebar group in place (the button element stays the same). */
  function setGroup(key, on) {
    if (on) navOpen.add(key); else navOpen.delete(key);
    const b = $(`[data-act=nav-toggle][data-key=${key}]`), sub = $('#sub-' + key);
    if (sub) sub.hidden = !on;
    if (b && !collapsed) b.setAttribute('aria-expanded', String(on));
  }
  /** Expanded sidebar: groups are disclosures. Collapsed icon rail: groups are menu buttons with a flyout. */
  function syncNavMode() {
    $$('[data-act=nav-toggle]').forEach(b => {
      if (collapsed) { b.setAttribute('aria-haspopup', 'menu'); b.removeAttribute('aria-controls'); b.setAttribute('aria-expanded', 'false'); }
      else { b.removeAttribute('aria-haspopup'); b.setAttribute('aria-controls', 'sub-' + b.dataset.key); b.setAttribute('aria-expanded', String(navOpen.has(b.dataset.key))); }
    });
  }
  function shell() {
    $('#root').innerHTML = `<div class="app${collapsed ? ' collapsed' : ''}" id="app">
      <aside class="sidebar" aria-label="Main navigation"><a class="brand" href="#/dashboard/overview" aria-label="RoadLedger TMS home">${LOGO}<span class="brand-name">RoadLedger</span></a><nav class="nav" id="nav" aria-label="Sections">${navHtml()}</nav></aside>
      <div class="main-col">
        <header class="topbar" role="banner">
          <button type="button" class="icon-btn" data-act="toggle-sidebar" aria-label="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-expanded="${!collapsed}" aria-controls="nav">${ic('menu')}</button>
          <nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav>
          <div class="gsearch" role="search"><label for="gsearch" class="sr-only">Search</label><input id="gsearch" type="search" placeholder="Search" autocomplete="off" aria-autocomplete="list" aria-controls="gsearch-list" aria-expanded="false"><label for="gscope" class="sr-only">Search scope</label><select id="gscope" aria-label="Search scope"><option>All</option><option>Load ID</option><option>Driver</option><option>Truck</option><option>Customer</option></select><kbd aria-hidden="true">Ctrl+K</kbd>${ic('search')}<div class="gsearch-list" id="gsearch-list" role="listbox" aria-label="Search results" hidden></div></div>
          <button type="button" class="pill-btn" data-act="menu" data-pop="support" aria-haspopup="dialog" aria-expanded="false">${ic('headset')}Live Support</button>
          <button type="button" class="pill-btn" data-act="menu" data-menu="createNew" aria-haspopup="menu" aria-expanded="false">${ic('plus')}Create new</button>
          <button type="button" class="icon-btn" data-act="menu" data-pop="telegram" aria-haspopup="dialog" aria-expanded="false" aria-label="Telegram bot">${ic('send')}</button>
          <button type="button" class="icon-btn" data-act="theme" aria-pressed="false" aria-label="Dark mode">${ic('moon')}</button>
          <button type="button" class="icon-btn" id="bell" data-act="menu" data-pop="bell" aria-haspopup="dialog" aria-expanded="false" aria-label="Notifications"></button>
          <button type="button" class="icon-btn" data-act="menu" data-pop="messages" aria-haspopup="dialog" aria-expanded="false" aria-label="Messages">${ic('chat')}</button>
          <button type="button" class="icon-btn" data-act="menu" data-pop="help" aria-haspopup="dialog" aria-expanded="false" aria-label="Help">${ic('help')}</button>
          <button type="button" class="acct" data-act="menu" data-menu="account" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu, Tutorial Account"><span class="avatar" aria-hidden="true">TA</span><span>Tutorial Account</span>${ic('down')}</button>
        </header>
        <main class="content" id="main" tabindex="-1"></main>
      </div></div>
      <div id="layer"></div><div id="toasts" aria-live="polite"></div>`;
    renderBell();
  }
  function renderBell() { const n = db.notifications.filter(x => x.unread).length; const b = $('#bell'); if (!b) return; b.innerHTML = ic('bell') + (n ? `<span class="count" aria-hidden="true">${n}</span>` : ''); b.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications'); }
  RL.renderBell = renderBell;

  MENUS.createNew = () => menu('Create new', [mi('New Load', 'new-load'), mi('Create driver', 'create-driver'), mi('Create Truck', 'truck-manual'), mi('Create new customer', 'create-customer'), mi('Create user', 'create-user'), mi('Fuel transaction', 'fuel-create')]);
  MENUS.account = () => menu('Account', ['<li role="none" class="muted sm" style="padding:6px 10px">tutorial@roadledger-demo.example</li>', ml('Users management', '#/settings/users-management'), ml('Company settings', '#/settings/mc-numbers'), ml('Default configurations', '#/settings/default-configurations'), msep, mi('Log out', 'logout')]);
  POPS.bell = () => { const unread = db.notifications.filter(n => n.unread).length; return `<div class="popover wide" role="dialog" aria-label="Notifications"><div class="pop-head"><h3>Notifications</h3><span class="muted sm">${unread} unread</span></div><ul class="notif">${db.notifications.map(n => `<li class="${n.unread ? 'unread' : ''}"><a href="${n.href}">${esc(n.text)}<div class="muted xs">${fmtEvt(n.at)}</div></a></li>`).join('')}</ul><div class="pop-foot"><button type="button" class="btn sm" data-act="mark-read" ${unread ? '' : 'disabled'}>Mark all as read</button></div></div>`; };
  POPS.messages = () => { const withChat = db.loads.filter(L => L.chat.length && !L.deleted).slice(-6).reverse(); return `<div class="popover wide" role="dialog" aria-label="Messages"><div class="pop-head"><h3>Messages</h3></div>${withChat.length ? `<ul class="notif">${withChat.map(L => `<li><a href="${loadUrl(L)}"><b>${L.sid}</b> · ${esc(L.chat[L.chat.length - 1].text)}<div class="muted xs">${esc(L.chat[L.chat.length - 1].from)}</div></a></li>`).join('')}</ul>` : '<p class="muted">No messages yet. Open a load and use the Chat tab in Activity.</p>'}</div>`; };
  POPS.help = () => `<div class="popover wide" role="dialog" aria-label="Help"><div class="pop-head"><h3>Help center</h3></div><ul class="notif">${[['How to create loads', '#/load-management/load-trip'], ['How to edit load details', '#/load-management/create-load/dispatched/8/DT-000008'], ['How to create invoice batches', '#/accounting/invoices/batches'], ['How to prepare salary statements', '#/accounting/salary/driver-settlements'], ['How to edit fuel transactions', '#/integrations/fuel/transactions'], ['How to set up weekly deductions', '#/accounting/salary/deductions'], ['How to import toll transactions', '#/integrations/toll/transactions']].map(([t, h]) => `<li><a href="${h}">${esc(t)}</a></li>`).join('')}</ul><p class="muted sm">Keyboard: Ctrl+K focuses search.</p></div>`;
  POPS.support = () => { const fid = nid(); return `<form class="popover wide" role="dialog" aria-label="Live Support" data-submit="support-send"><div class="pop-head"><h3>Live Support</h3><span class="muted sm">Typically replies in 5 min</span></div><div class="field"><label for="${fid}">Message</label><textarea id="${fid}" name="message" required placeholder="Describe your question"></textarea></div><div class="pop-foot"><button type="submit" class="btn sm purple">Send message</button></div></form>`; };
  POPS.telegram = () => { const t = db.integrations.find(i => i.id === 'telegram'); return `<div class="popover wide" role="dialog" aria-label="Telegram bot"><div class="pop-head"><h3>Telegram bot</h3>${pill(t.status === 'Connected' ? 'CONNECTED' : 'OFF', t.status === 'Connected' ? 'active' : 'inactive')}</div><p class="sm">Bot <b>${esc(t.account)}</b> sends trip details and salary statements to drivers and lets dispatchers get load updates.</p><p class="sm muted">${db.drivers.filter(d => d.telegram).length} drivers and ${db.users.filter(u => u.telegram).length} users are linked.</p><div class="pop-foot"><a class="btn sm" href="#/settings/integrations">Open integration settings</a></div></div>`; };

  // =============== global events ===============
  const ACTS = {}, CHANGES = {}, SUBMITS = {}, DBL = {};
  RL.ACTS = ACTS; RL.CHANGES = CHANGES; RL.SUBMITS = SUBMITS; RL.DBL = DBL;
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (open && !open.el.contains(e.target) && !(t && t === open.trigger)) closeFloating();
    if (!t || t.disabled || t.getAttribute('aria-disabled') === 'true') return;
    const a = t.dataset.act;
    if (t.tagName === 'A' && !t.getAttribute('href')) e.preventDefault();
    if (t.type === 'checkbox' && a !== 'tsel' && a !== 'tselall') { /* handled by change */ }
    if (ACTS[a]) { if (t.tagName === 'A' || t.tagName === 'BUTTON') e.preventDefault(); ACTS[a](t, e); }
  });
  document.addEventListener('dblclick', e => { const tr = e.target.closest('[data-dbl]'); if (!tr || e.target.closest('button,a,input,select')) return; const f = DBL[tr.dataset.dbl]; if (f) f(tr.dataset.id, tr); });
  document.addEventListener('change', e => { const t = e.target.closest('[data-change]'); if (t && CHANGES[t.dataset.change]) CHANGES[t.dataset.change](t, e); });
  document.addEventListener('input', e => { const t = e.target.closest('[data-input]'); if (t && CHANGES[t.dataset.input]) CHANGES[t.dataset.input](t, e); });
  document.addEventListener('submit', e => { const f = e.target.closest('[data-submit]'); if (f && SUBMITS[f.dataset.submit]) { e.preventDefault(); SUBMITS[f.dataset.submit](f, e); } });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (open) { const tr = open.trigger; closeFloating(); tr && tr.focus(); return; } const d = topDialog(); if (d && d.kind !== 'native') { d.close(); return; } }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#gsearch').focus(); }
    const t = e.target;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open && open.el.matches('.menu')) { const items = $$('[role=menuitem]:not([aria-disabled=true])', open.el); const i = items.indexOf(document.activeElement); if (items.length) { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); } }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && t.getAttribute && t.getAttribute('role') === 'tab' && t.parentElement.getAttribute('role') === 'tablist') { const tabs = $$('[role=tab]', t.parentElement); const i = tabs.indexOf(t); const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]; n.focus(); n.click(); }
    if (e.key === 'Enter' && t.id === 'gsearch') { const f = $('#gsearch-list [role=option]'); if (f) { e.preventDefault(); location.hash = f.getAttribute('href'); t.value = ''; gsearch(''); } }
  });
  window.addEventListener('hashchange', () => { closeAllDialogs(); render(); });
  window.addEventListener('resize', closeFloating);

  ACTS['dlg-close'] = t => { const d = stack.find(x => x.root.contains(t)); if (d) d.close(); };
  ACTS.menu = t => {
    if (open && open.trigger === t) { closeFloating(); return; }
    if (t.dataset.menu) { const f = MENUS[t.dataset.menu]; if (f) showFloating(t, f(t)); }
    else if (t.dataset.pop) { const f = POPS[t.dataset.pop]; if (f) { const node = showFloating(t, f(t), { align: t.dataset.align || 'right' }); if (f.mount) f.mount(node, t); } }
  };
  ACTS.tfilter = t => { if (open && open.trigger === t) { closeFloating(); return; } showFloating(t, POPS.tfilter(t), { align: 'left' }); };
  SUBMITS['tfilter-apply'] = f => { const s = tstate(f.dataset.t); s.filters[f.dataset.k] = f.q.value.trim(); s.page = 1; closeFloating(); rerenderTable(f.dataset.t); };
  SUBMITS['filters-apply'] = f => { const s = tstate(f.dataset.t); new FormData(f).forEach((v, k) => (s.filters[k] = String(v).trim())); s.page = 1; closeFloating(); rerenderTable(f.dataset.t); };
  ACTS['filters-clear'] = t => { const s = tstate(t.dataset.t); s.filters = {}; s.page = 1; closeFloating(); rerenderTable(t.dataset.t); };
  ACTS.tclearf = t => { const s = tstate(t.dataset.t); delete s.filters[t.dataset.k]; s.page = 1; closeFloating(); rerenderTable(t.dataset.t); };
  ACTS.tsort = t => { const s = tstate(t.dataset.t); const k = t.dataset.k; s.sort = !s.sort || s.sort.key !== k ? { key: k, dir: 'asc' } : s.sort.dir === 'asc' ? { key: k, dir: 'desc' } : null; rerenderTable(t.dataset.t); };
  ACTS.tpage = t => { const s = tstate(t.dataset.t); s.page = +t.dataset.p; rerenderTable(t.dataset.t); };
  ACTS.texpand = t => { const s = tstate(t.dataset.t); const k = t.dataset.k; if (s.open.has(k)) s.open.delete(k); else s.open.add(k); rerenderTable(t.dataset.t); };
  ACTS.tsel = t => { const s = tstate(t.dataset.t); if (t.checked) s.sel.add(t.dataset.k); else s.sel.delete(t.dataset.k); const tr = t.closest('tr'); if (tr) tr.classList.toggle('sel', t.checked); syncSelAll(t.dataset.t); selDeps(); };
  ACTS.tselall = t => { const cfg = TCFG[t.dataset.t], s = tstate(cfg.id); const rows = filteredRows(cfg).slice((s.page - 1) * s.size, s.page * s.size); const key = cfg.key || (r => r.id); rows.forEach(r => { if (t.checked) s.sel.add(String(key(r))); else s.sel.delete(String(key(r))); }); rerenderTable(cfg.id); };
  function syncSelAll(id) { const host = document.getElementById('tb-' + id); if (!host) return; const all = $$('input[data-act=tsel]', host); const h = host.querySelector('[data-act=tselall]'); if (h) h.checked = all.length > 0 && all.every(x => x.checked); }
  CHANGES.tsize = t => { const s = tstate(t.dataset.t); s.size = +t.value; s.page = 1; rerenderTable(t.dataset.t); };
  CHANGES.tcol = t => { const s = tstate(t.dataset.t); if (t.checked) s.hidden.delete(t.dataset.k); else s.hidden.add(t.dataset.k); rerenderTable(t.dataset.t); };
  ACTS.density = t => { const s = tstate(t.dataset.t); s.dense = !s.dense; t.setAttribute('aria-pressed', String(s.dense)); rerenderTable(t.dataset.t); };
  ACTS.export = t => {
    const cfg = TCFG[t.dataset.t]; if (!cfg) return; const s = tstate(cfg.id); const cols = cfg.columns.filter(c => !s.hidden.has(c.key));
    const rows = filteredRows(cfg); const csv = [cols.map(c => c.label), ...rows.map(r => cols.map(c => String(colText(c, r)).replace(/"/g, '""')))].map(r => r.map(x => `"${x}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${cfg.id}.csv`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    toast(`Exported ${rows.length} rows`);
  };
  ACTS.copy = t => { try { navigator.clipboard && navigator.clipboard.writeText(t.dataset.text); } catch (e) { /* not allowed */ } toast('Copied'); };
  ACTS['toggle-sidebar'] = t => { collapsed = !collapsed; try { localStorage.setItem('rl-collapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ } $('#app').classList.toggle('collapsed', collapsed); t.setAttribute('aria-expanded', String(!collapsed)); t.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar'); closeFloating(); syncNavMode(); };
  ACTS['nav-toggle'] = t => {
    const k = t.dataset.key, n = NAV.find(x => x.key === k);
    if (collapsed) { if (open && open.trigger === t) { closeFloating(); return; } const node = showFloating(t, menu(n.label, n.items.map(([lab, h]) => ml(lab, h))), { align: 'left' }); const r = t.getBoundingClientRect(); node.style.left = r.right + 8 + 'px'; node.style.top = r.top + 'px'; return; }
    autoOpen.delete(k);
    setGroup(k, !navOpen.has(k));
  };
  ACTS.theme = t => { const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; t.setAttribute('aria-pressed', String(dark)); };
  ACTS['mark-read'] = t => commit(t, 'mark-notifications-read', {}, () => { db.notifications.forEach(n => (n.unread = false)); renderBell(); closeFloating(); });
  ACTS.logout = () => { closeFloating(); toast('Log out is disabled in the demo account'); };
  SUBMITS['support-send'] = async f => { if (!validate(f)) return; const msg = f.message.value; if (await commit(f.querySelector('[type=submit]'), 'support-message', { message: msg })) closeFloating(); };
  // Saved views (loads, trucks, drivers, planning).
  ACTS['save-view'] = t => {
    const tid = t.dataset.t;
    formDialog({ title: 'Save view', size: 'narrow', submit: 'Save view', name: 'save-view', fields: [{ name: 'name', label: 'View name', required: true, placeholder: 'e.g. Shop trucks', cls: 'span2' }],
      build: d => ({ table: tid, name: d.name, filters: { ...tstate(tid).filters } }),
      apply: p => { const group = tid.startsWith('trucks') ? 'trucks' : tid.startsWith('drivers') ? 'drivers' : tid.startsWith('planning') ? 'planning' : 'loads'; db.savedViews[group].push({ id: 'sv-' + nid(), name: p.name, filter: { cols: p.filters, ...(RL.viewFilter ? RL.viewFilter(tid) : {}) } }); } });
  };

  // global search
  function gsearch(q) {
    const list = $('#gsearch-list'), s = q.trim().toLowerCase(), scope = $('#gscope').value;
    if (!s) { list.hidden = true; $('#gsearch').setAttribute('aria-expanded', 'false'); return; }
    const hits = [];
    if (scope === 'All' || scope === 'Load ID') db.loads.filter(L => !L.deleted && `${L.sid} ${L.loadId} ${cust(L.customerId).name}`.toLowerCase().includes(s)).slice(0, 6).forEach(L => hits.push([loadUrl(L), `${L.sid} · ${L.loadId} · ${cust(L.customerId).name}`, 'Load']));
    if (scope === 'All' || scope === 'Driver') db.drivers.filter(d => dname(d).toLowerCase().includes(s)).slice(0, 4).forEach(d => hits.push([`#/hr-management/edit-driver/${d.id}/detail`, dname(d), 'Driver']));
    if (scope === 'All' || scope === 'Truck') db.trucks.filter(t => t.unit.toLowerCase().includes(s)).slice(0, 3).forEach(t => hits.push([`#/fleet-management/trucks/${t.id}`, `Unit ${t.unit}`, 'Truck']));
    if (scope === 'All' || scope === 'Customer') db.customers.filter(c => c.name.toLowerCase().includes(s)).slice(0, 3).forEach(c => hits.push([`#/customer-management/customers/${c.id}`, c.name, 'Customer']));
    list.innerHTML = hits.length ? hits.map(([h, t, k]) => `<a role="option" aria-selected="false" href="${h}">${esc(t)}<span class="muted sm">${k}</span></a>`).join('') : `<div class="muted" style="padding:8px 10px">No results for “${esc(q)}”</div>`;
    list.hidden = false; $('#gsearch').setAttribute('aria-expanded', 'true');
  }
  document.addEventListener('input', e => { if (e.target.id === 'gsearch') gsearch(e.target.value); });
  document.addEventListener('click', e => { if (e.target.closest('#gsearch-list [role=option]')) { $('#gsearch').value = ''; gsearch(''); } else if (!e.target.closest('.gsearch')) { const l = $('#gsearch-list'); if (l && !l.hidden) gsearch(''); } });

  // tooltips for the collapsed rail
  document.addEventListener('mouseover', e => { const n = e.target.closest('.app.collapsed .nav-item'); const old = $('.tip'); if (old) old.remove(); if (!n) return; const r = n.getBoundingClientRect(); const tip = document.createElement('div'); tip.className = 'tip'; tip.textContent = n.getAttribute('aria-label'); tip.style.left = r.right + 8 + 'px'; tip.style.top = r.top + r.height / 2 - 11 + 'px'; document.body.appendChild(tip); });

  // =============== shared pieces used by several screens ===============
  /** Section tabs (role=tab links), e.g. Invoices · Salary · Bills Management · Payroll. */
  RL.sectionTabs = (label, tabs, activeIdx) => `<div class="section-tabs" role="tablist" aria-label="${esc(label)}">${tabs.map(([t, h], i) => `<a role="tab" href="${h}" aria-selected="${i === activeIdx}"${i === activeIdx ? ' aria-current="page"' : ''}>${esc(t)}</a>`).join('')}</div>`;
  /** Chip links (route chips such as Batches · Invoices · Aging report). */
  RL.chipLinks = (label, chips, activeIdx, saved = []) => `<nav class="chips" aria-label="${esc(label)}">${chips.map(([t, h, icn], i) => `<a class="chip${saved.includes(i) ? ' saved' : ''}${i === activeIdx ? ' on' : ''}" href="${h}"${i === activeIdx ? ' aria-current="page"' : ''}>${icn ? ic(icn) : ''}${esc(t)}</a>`).join('')}</nav>`;
  /** Chip tabs that filter in place (role=tab). */
  RL.chipTabs = (label, chips, active, act, extra = '') => `<div class="chips" role="tablist" aria-label="${esc(label)}">${chips.map(([key, t, saved]) => `<button type="button" role="tab" class="chip${saved ? ' saved' : ''}" data-act="${act}" data-v="${esc(key)}" aria-selected="${key === active}">${saved ? ic('bookmark') : ''}${esc(t)}</button>`).join('')}${extra}</div>`;
  RL.selOptions = {
    drivers: (all) => db.drivers.filter(d => all || d.employment === 'ACTIVE').map(d => [d.id, `${dname(d)}${d.truckId ? ' / UNIT ' + trk(d.truckId).unit : ''}`]),
    trucks: () => db.trucks.filter(t => t.active).map(t => [t.id, `${t.unit} · ${t.make} ${t.model}`]),
    trailers: () => db.trailers.filter(t => t.active).map(t => [t.id, `${t.unit} · ${t.type}`]),
    mcs: () => db.mcs.slice(0, 3).map(m => [m.id, m.name]),
    customers: () => db.customers.map(c => [c.id, `${c.name} / ${c.mc}`]),
  };

  // Create new customer (drawer): company name required, the rest optional. Used by Create New Load and Customer Management.
  RL.createCustomer = (onDone) => formDialog({ title: 'Create new customer', kind: 'drawer', submit: 'Save', cancel: 'Close', name: 'create-customer',
    fields: [{ name: 'name', label: 'Company name', required: true, cls: 'span2' }, { name: 'mc', label: 'MC number' }, { name: 'dot', label: 'USDOT' }, { name: 'address', label: 'Address', cls: 'span2' },
      { name: 'city', label: 'City' }, { name: 'state', label: 'State' }, { name: 'zip', label: 'Zip' }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Billing email', type: 'email' }, { name: 'contact', label: 'Contact person' },
      { name: 'billingType', label: 'Customer billing type', type: 'select', options: ['FACTORING COMPANY', 'DIRECT BILL', 'QUICK PAY'], value: 'FACTORING COMPANY', placeholder: false }, { name: 'terms', label: 'Payment terms', type: 'select', options: ['Net 30', 'Net 15', 'Net 45', 'Quick pay 2%'], value: 'Net 30', placeholder: false },
      { name: 'creditLimit', label: 'Credit limit', type: 'money' }, { name: 'notes', label: 'Notes', type: 'textarea', cls: 'span2' }],
    build: d => ({ ...d, id: db.customers.length + 1 }),
    apply: p => { db.customers.push({ id: p.id, name: p.name, mc: p.mc || 'nan', billingType: p.billingType, address: p.address || 'nan', city: p.city, state: p.state, zip: p.zip, email: p.email, phone: p.phone, contact: p.contact, terms: p.terms, creditLimit: +p.creditLimit || 0, recent: true, color: '#7e3af2' }); },
    after: p => { if (onDone) onDone(p); else rerender(); } });
  ACTS['create-customer'] = () => RL.createCustomer();

  // boot
  RL.boot = () => { shell(); render(); };
})();
