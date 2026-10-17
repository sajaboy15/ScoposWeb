// End to end in a real (headless) Chrome with the real extension: learn a product, then walk its guides the way
// a user would — act on whatever the guide points at — and report, per step, whether the control was found.
//
//   node dev/e2e-learn-and-guide.mjs [url] [--guides N] [--skip-learn]
//
// Needs the demo server on :4173 with a Claude key saved on /setup (the extension uses it through the local
// proxy). Learning costs real tokens once; walking guides is free unless a guide continues live.
import { launch } from './ext-harness.mjs';

const args = process.argv.slice(2);
const url = args.find(a => /^https?:/.test(a)) || 'http://localhost:4173/demo/tms/index.html';
const maxGuides = +(args[args.indexOf('--guides') + 1] || 0) || 6;
const skipLearn = args.includes('--skip-learn');
const origin = new URL(url).origin;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = 'http://localhost:4173';
const writesPath = url.includes('/demo/tms') ? '/api/tms/writes' : '/api/demo/writes';
const writes = async () => (await (await fetch(server + writesPath)).json()).count;

const b = await launch();
const t0 = Date.now();
try {
  const p = await b.open(url);
  await p.evalScopos('1');
  const tabId = await b.evalWorker(`chrome.tabs.query({}).then(t => t.find(x => x.url.startsWith(${JSON.stringify(origin)})).id)`);
  await fetch(server + writesPath + '/reset', { method: 'POST' });
  const statsBefore = await (await fetch(server + '/api/scopos/stats')).json();

  if (!skipLearn) {
    console.log('key mode:', JSON.stringify(await b.evalWorker(`proxyEndpoint({ fresh: true }).then(e => e || 'none')`).catch(e => e.message)));
    console.log('learn:', await b.evalWorker(`learnStart(${tabId}, true).then(() => 'started', e => 'ERR ' + e.message)`));
    let last = '';
    for (;;) {
      await sleep(3000);
      const st = await b.evalWorker(`readLearn(${JSON.stringify(origin)}).then(x => x || {})`).catch(() => ({}));
      const line = `${st.status} · ${st.views || 0} views · ${st.probes || 0} probes · ${st.label || ''}${st.error ? ' · ' + st.error : ''}`;
      if (line !== last) { console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${line}`); last = line; }
      if (st.status && !['exploring', 'writing'].includes(st.status)) break;
      if (Date.now() - t0 > 30 * 60 * 1000) { console.log('  timeout'); break; }
    }
  }
  const learnWrites = await writes();
  const statsAfter = await (await fetch(server + '/api/scopos/stats')).json();
  const ext = statsAfter.byKind && statsAfter.byKind.extension;
  console.log(`\nwrites during learning: ${learnWrites}`);
  console.log(`claude via proxy: ${ext ? ext.calls + ' calls, $' + (ext.cost - ((statsBefore.byKind && statsBefore.byKind.extension && statsBefore.byKind.extension.cost) || 0)).toFixed(3) : 'none'}`);

  const pbs = await b.evalWorker(`getPlaybooks(${JSON.stringify(origin)})`);
  const learned = pbs.filter(x => x.learned);
  console.log(`\nguides: ${learned.length} (live ${learned.filter(g => g.live).length})`);
  for (const g of learned) {
    console.log(`  - ${g.name}${g.live ? ' [live]' : ''}: ${g.steps.map(s => `${s.action}:${(s.target && s.target.text) || '∅'}${s.target && s.target.row ? '[row]' : ''}`).join(' → ')}`);
    // Row steps (one per row of a table): the instruction must ask for the record the user needs, never the sample's.
    for (const s of g.steps.filter(s => s.target && s.target.row)) console.log(`      row step: «${s.instruction}»`);
  }

  // Walk the guides with fields first (the ones that used to stop half-way), then the rest.
  const order = learned.slice().sort((a, b) => (b.steps.some(s => s.action === 'type' || s.action === 'select') - a.steps.some(s => s.action === 'type' || s.action === 'select')) || (b.live - a.live));
  const results = [];
  for (const g of order.slice(0, maxGuides)) {
    await p.goto(url, { waitMs: 800 });
    await p.evalScopos('1');
    const r = { name: g.name, steps: [], ok: false, mores: 0 };
    const run = await b.evalWorker(`runPlaybook(${tabId}, ${JSON.stringify(origin)}, ${JSON.stringify(g.id)}).then(() => 'ok', e => 'ERR ' + e.message)`);
    if (run !== 'ok') { r.error = run; results.push(r); continue; }
    let stuck = 0;
    for (let guard = 0; guard < 40; guard++) {
      await sleep(900);
      let st = null;
      try { st = await p.evalScopos('Scopos.guide.state()'); } catch (e) { st = null; }
      if (!st) { r.ok = true; break; } // ended
      if (st.asking) { await sleep(1500); continue; }
      // What the guide points at right now, and the user's action on it.
      const act = await p.evalScopos(`(async () => {
        const S = Scopos, st = S.guide.state(), steps = S.guide.steps(), step = steps[st.index];
        if (!step) return { idx: st.index, none: true, total: st.total };
        const dbg = S.pointer.debug && S.pointer.debug();
        let el = null;
        try { el = step.target ? S.resolve(step.target) : null; } catch (e) { el = null; }
        if (!el && S.guide.findLocal) { try { const f = S.guide.findLocal(step); el = f && (f.el || f.nodeType ? (f.el || f) : null); } catch (e) { el = null; } }
        const shown = !!(dbg && dbg.frameOn);
        const info = { idx: st.index, total: st.total, action: step.action, text: (step.target && step.target.text) || '', instr: step.instruction, shown, found: !!el, pstate: dbg && dbg.state };
        if (!el) return info;
        if (step.action === 'look') { S.guide.go(st.index + 1); info.did = 'next'; return info; }
        if (step.action === 'type') {
          el.focus();
          const v = step.value || (el.type === 'email' ? 'test@example.com' : el.type === 'number' ? '1200' : el.type === 'date' ? '2026-10-20' : el.type === 'time' ? '09:00' : el.type === 'tel' ? '5550101' : 'Test');
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          try { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); } catch (e) { el.value = v; }
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur();
          info.did = 'type'; return info;
        }
        if (step.action === 'select') {
          if (el.tagName === 'SELECT') {
            const opt = [...el.options].find(o => step.value && o.text.trim() === step.value) || [...el.options].find(o => o.value);
            if (opt) el.value = opt.value;
            el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
            info.did = 'select'; return info;
          }
          el.click();
          await new Promise(r => setTimeout(r, 300));
          const o = [...document.querySelectorAll('[role=option]')].find(x => x.offsetParent);
          if (o) o.click();
          info.did = 'listbox'; return info;
        }
        el.click(); info.did = 'click'; return info;
      })()`).catch(e => ({ err: e.message }));
      const prev = r.steps[r.steps.length - 1];
      if (!prev || prev.idx !== act.idx || act.did) r.steps.push(act);
      if (act.none) { stuck++; if (stuck > 6) break; continue; }
      if (!act.found) { stuck++; if (stuck > 8) { r.stuckAt = act; break; } continue; }
      stuck = 0;
      if (act.did && act.did !== 'click' && act.did !== 'next') {
        // Fields advance on change; if this one didn't, the user would press «Далее».
        await sleep(800);
        const s2 = await p.evalScopos('Scopos.guide.state()').catch(() => null);
        if (s2 && s2.index === act.idx) await p.evalScopos(`Scopos.guide.go(${act.idx + 1})`).catch(() => {});
      }
    }
    try { r.mores = ((await p.evalScopos('Scopos.guide.state()')) || {}).mores || 0; } catch (e) { /* ended */ }
    results.push(r);
  }

  console.log('\nwalks:');
  for (const r of results) {
    const found = r.steps.filter(s => s.found && !s.none).length, total = r.steps.filter(s => !s.none).length;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${found}/${total} steps found${r.error ? ' · ' + r.error : ''}${r.stuckAt ? ` · stuck at ${r.stuckAt.idx + 1} ${r.stuckAt.action} «${r.stuckAt.text}» (${r.stuckAt.instr})` : ''}`);
    for (const s of r.steps.filter(s => !s.none)) console.log(`      ${s.idx + 1}. ${s.found ? 'found' : 'NOT FOUND'}${s.shown ? ' · shown' : ''} · ${s.action} «${s.text}» ${s.did ? '→ ' + s.did : ''}`);
  }
  const pbs2 = await b.evalWorker(`getPlaybooks(${JSON.stringify(origin)})`);
  const grown = pbs2.filter(x => x.learned).filter(x => { const o = learned.find(y => y.id === x.id); return o && x.steps.length > o.steps.length; });
  console.log(`\nguides extended live and saved: ${grown.map(g => g.name).join(', ') || 'none'}`);
  console.log(`total writes (guide walks press real commits): ${await writes()}, of which during learning: ${learnWrites}`);
  console.log(`time: ${Math.round((Date.now() - t0) / 1000)}s`);
} finally { await b.close(); }
