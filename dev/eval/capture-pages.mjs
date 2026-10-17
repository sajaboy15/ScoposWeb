// Captures real page scans (Scopos.scan(), what the model gets in ask / locate / continue) of the Haulr TMS
// fixture in states the explorer did not open, for the locate and continue evals. No Claude call, no writes.
//
//   node dev/eval/capture-pages.mjs            -> $EVAL_OUT/pages-tms.json
import { launch } from '../ext-harness.mjs';
import { save } from './lib.mjs';

const BASE = 'http://localhost:4173/demo/tms/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clickText = (sel, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.offsetParent && e.textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`;

const STATES = [
  { id: 'trucks', hash: '#/trucks', query: 'add truck' },
  { id: 'add-truck', hash: '#/trucks', click: ['button', 'Add truck'], query: 'add truck' },
  { id: 'drivers', hash: '#/drivers', query: 'add driver' },
  { id: 'add-driver', hash: '#/drivers', click: ['button', 'Add driver'], query: 'save driver' },
  { id: 'invoices', hash: '#/billing/invoices', query: 'create invoice' },
  { id: 'users-roles', hash: '#/settings', click: ['[role=tab]', 'Users & Roles'], query: 'invite user' },
  { id: 'new-load-stop', hash: '#/loads/new', click: ['button', '+ Add stop'], query: 'add stop' },
  { id: 'load-more', hash: '#/loads/1042', click: ['button', 'More actions'], query: 'more actions' },
  { id: 'maintenance-schedule', hash: '#/maintenance', click: ['button', 'Schedule service'], query: 'schedule service' },
];

const b = await launch({ width: 1366, height: 860 });
const out = {};
try {
  const p = await b.open(BASE);
  for (const s of STATES) {
    await p.goto(BASE + s.hash, { waitMs: 900 });
    await p.evalScopos('1');
    if (s.click) { const ok = await p.eval(clickText(s.click[0], s.click[1])); await sleep(600); if (!ok) console.log('no control to click for', s.id); }
    out[s.id] = await p.evalScopos(`Scopos.scan({ query: ${JSON.stringify(s.query)} })`);
    console.log(s.id, out[s.id].lines.length, 'lines', out[s.id].title);
  }
} finally { await b.close(); }
save('pages-tms.json', out);
