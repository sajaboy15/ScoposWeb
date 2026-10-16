/*
 * Service worker: state, storage and the Claude call.
 *
 * Per tab, chrome.storage.session holds the running session
 *   guide:<tabId> = { question, answer, steps, index, status, source, ms, origin }
 * so a walkthrough survives page loads and the side panel can reopen on it.
 * Saved walkthroughs ("сценарии") live in chrome.storage.local per site
 *   playbooks:<origin> = [{ id, name, steps, created, runs }]
 * and replay instantly without calling the model.
 */
importScripts('core/brain.js');
const Brain = self.ScoposBrain;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'open-scopos' && tab) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// ---------- storage ----------
const sessionKey = tabId => `guide:${tabId}`;
const getSession = async tabId => (await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)] || null;
async function setSession(tabId, patch) {
  const next = patch === null ? null : { ...(await getSession(tabId)), ...patch, tabId };
  if (next) await chrome.storage.session.set({ [sessionKey(tabId)]: next });
  else await chrome.storage.session.remove(sessionKey(tabId));
  chrome.runtime.sendMessage({ type: 'session', tabId, session: next }).catch(() => {});
  return next;
}
const pbKey = origin => `playbooks:${origin}`;
const getPlaybooks = async origin => (await chrome.storage.local.get(pbKey(origin)))[pbKey(origin)] || [];
const setPlaybooks = (origin, list) => chrome.storage.local.set({ [pbKey(origin)]: list });
const mapKey = origin => `map:${origin}`;
const getMap = async origin => (await chrome.storage.local.get(mapKey(origin)))[mapKey(origin)] || null;
const getKey = async () => (await chrome.storage.local.get('apiKey')).apiKey || '';
chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(sessionKey(tabId)));

// ---------- talking to the page ----------
async function toTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    // Tabs opened before the extension was installed have no content script yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['core/scan.js', 'core/pointer.js', 'core/guide.js', 'core/explore.js', 'content.js'] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}
const originOf = url => { try { return new URL(url).origin; } catch (e) { return ''; } };
const usable = url => /^(https?|file):/.test(url || '') && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(url);

// ---------- playbook matching: a question that names a saved walkthrough runs it with 0 tokens ----------
const words = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2).map(w => w.slice(0, 6));
function matchPlaybook(question, list) {
  const q = new Set(words(question));
  let best = null, bestScore = 0;
  for (const pb of list) {
    const n = words(pb.name);
    if (!n.length) continue;
    const score = n.filter(w => q.has(w)).length / n.length;
    if (score > bestScore) { best = pb; bestScore = score; }
  }
  return bestScore >= 0.67 ? best : null;
}

// ---------- the ask flow ----------
const inflight = new Map(); // tabId -> AbortController

async function ask(tabId, question) {
  const tab = await chrome.tabs.get(tabId);
  if (!usable(tab.url)) throw new Error('На этой странице браузер не даёт расширениям работать. Откройте сайт или веб-приложение.');
  const origin = originOf(tab.url);
  const t0 = Date.now();
  await toTab(tabId, { type: 'guide:stop' });

  const pb = matchPlaybook(question, await getPlaybooks(origin));
  if (pb) {
    await bumpRuns(origin, pb.id);
    return start(tabId, { question, answer: `Сценарий «${pb.name}»`, steps: pb.steps, source: 'playbook', playbookId: pb.id, ms: Date.now() - t0, origin });
  }

  const apiKey = await getKey();
  if (!apiKey) throw new Error('Добавьте ключ Anthropic API в настройках, и Scopos начнёт отвечать.');
  inflight.get(tabId)?.abort();
  const ctl = new AbortController();
  inflight.set(tabId, ctl);
  await setSession(tabId, { question, answer: '', steps: [], index: 0, status: 'thinking', source: 'claude', origin, error: null });

  // A learned product map: plan across every screen at once, with exact controls.
  const map = await getMap(origin);
  if (map) {
    const prevMap = await getSession(tabId);
    const historyMap = (prevMap && prevMap.history) || [];
    const out = await Brain.call(Brain.buildAskMap({ question, map, current: Brain.viewOf(map, tab.url), history: historyMap }), apiKey, { signal: ctl.signal });
    inflight.delete(tabId);
    const nextHistory = [...historyMap, { role: 'user', content: question }, { role: 'assistant', content: JSON.stringify(out) }].slice(-6);
    return start(tabId, { question, answer: out.answer, steps: Brain.refSteps(out.steps, map), source: 'map', ms: Date.now() - t0, origin, history: nextHistory });
  }

  const page = await toTab(tabId, { type: 'scan' });
  const prev = await getSession(tabId);
  const history = (prev && prev.history) || [];
  const out = await Brain.call(Brain.buildAsk({ question, page, history }), apiKey, { signal: ctl.signal });
  inflight.delete(tabId);

  const descriptors = await toTab(tabId, { type: 'describe', ids: out.steps.map(s => s.element_id) });
  const steps = out.steps.map((s, i) => ({
    instruction: s.instruction,
    action: s.action,
    value: s.value,
    target: descriptors[i] || (s.element_text ? { sel: [], text: s.element_text, role: null } : null),
  }));
  const nextHistory = [...history, { role: 'user', content: question }, { role: 'assistant', content: JSON.stringify(out) }].slice(-6);
  return start(tabId, { question, answer: out.answer, steps, source: 'claude', ms: Date.now() - t0, origin, history: nextHistory });
}

const delayFor = source => (source === 'claude' ? 1200 : 2500);

async function start(tabId, data) {
  const session = await setSession(tabId, { ...data, index: 0, status: data.steps.length ? 'running' : 'answered', error: null });
  if (data.steps.length) await toTab(tabId, { type: 'guide:start', steps: data.steps, index: 0, missingDelay: delayFor(data.source) });
  return session;
}

async function bumpRuns(origin, id) {
  const list = await getPlaybooks(origin);
  const pb = list.find(p => p.id === id);
  if (pb) { pb.runs = (pb.runs || 0) + 1; await setPlaybooks(origin, list); }
}

// A Claude answer reached a page where its guessed control isn't: plan the remaining steps from this page.
async function replan(tabId, index, page) {
  const s = await getSession(tabId);
  const apiKey = await getKey();
  if (!s || !apiKey || s.replanned === index) return;
  await setSession(tabId, { replanned: index });
  const progress = s.steps.slice(0, index).map(st => st.instruction);
  const out = await Brain.call(Brain.buildAsk({ question: s.question, page, history: s.history || [], progress }), apiKey);
  const cur = await getSession(tabId);
  if (!cur || cur.index !== index) return;
  const descriptors = await toTab(tabId, { type: 'describe', ids: out.steps.map(st => st.element_id) });
  const rest = out.steps.map((st, i) => ({ instruction: st.instruction, action: st.action, value: st.value, target: descriptors[i] || (st.element_text ? { sel: [], text: st.element_text, role: null } : null) }));
  const steps = cur.steps.slice(0, index).concat(rest);
  if (!rest.length) { await toTab(tabId, { type: 'guide:stop' }); await setSession(tabId, { steps, index, status: 'done' }); return; }
  await setSession(tabId, { steps });
  await toTab(tabId, { type: 'guide:start', steps, index, missingDelay: delayFor('claude') });
}

// The UI changed and a step's control can't be found: ask Claude for that one control and fix the saved walkthrough.
async function heal(tabId, step, page) {
  const apiKey = await getKey();
  if (!apiKey) return { id: null };
  const out = await Brain.call(Brain.buildLocate({ instruction: step.instruction, oldText: step.target && step.target.text, page }), apiKey);
  return { id: out.element_id };
}
// Remember the re-found control, in the running session and in the saved walkthrough it came from.
async function storeHealed(tabId, index, target) {
  const s = await getSession(tabId);
  if (!s || !s.steps[index]) return;
  const steps = s.steps.map((st, i) => (i === index ? { ...st, target } : st));
  await setSession(tabId, { steps });
  if (s.source === 'playbook' && s.playbookId) {
    const list = await getPlaybooks(s.origin);
    const pb = list.find(p => p.id === s.playbookId);
    if (pb && pb.steps[index]) { pb.steps[index].target = target; pb.healed = (pb.healed || 0) + 1; await setPlaybooks(s.origin, list); }
  }
}

// ---------- learning: the explorer walks the product, then Claude writes guides from the map ----------
const exploreKey = tabId => `explore:${tabId}`;
const learnKey = origin => `learn:${origin}`;
async function setLearn(origin, patch) {
  const cur = (await chrome.storage.local.get(learnKey(origin)))[learnKey(origin)] || {};
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [learnKey(origin)]: next });
  chrome.runtime.sendMessage({ type: 'learn', origin, learn: next }).catch(() => {});
  return next;
}
async function learnFrom(origin, map) {
  await chrome.storage.local.set({ [mapKey(origin)]: map });
  const apiKey = await getKey();
  if (!apiKey) return setLearn(origin, { status: 'mapped', views: map.views.length, probes: map.probes, at: Date.now(), error: 'Карта сохранена. Чтобы Claude написал гайды, добавьте ключ в настройках.' });
  await setLearn(origin, { status: 'writing', views: map.views.length, probes: map.probes });
  try {
    const out = await Brain.call(Brain.buildLearn({ map }), apiKey);
    const guides = out.guides.map(g => ({ id: crypto.randomUUID(), name: g.name.slice(0, 90), steps: Brain.refSteps(g.steps, map), created: Date.now(), runs: 0, learned: true })).filter(g => g.steps.some(st => st.target));
    // Learned guides replace the previous learned set; scenarios the user recorded stay.
    const mine = (await getPlaybooks(origin)).filter(p => !p.learned);
    await setPlaybooks(origin, [...guides, ...mine]);
    return setLearn(origin, { status: 'done', views: map.views.length, probes: map.probes, guides: guides.length, summary: out.summary, at: Date.now(), error: null });
  } catch (e) {
    return setLearn(origin, { status: 'error', error: e.message || String(e) });
  }
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fromTab = sender.tab && sender.tab.id;
  (async () => {
    switch (msg.type) {
      // from the side panel
      case 'ask':
        try { return reply({ session: await ask(msg.tabId, msg.question) }); }
        catch (e) {
          if (e && e.name === 'AbortError') return reply({});
          await setSession(msg.tabId, { status: 'error', error: e.message || String(e) });
          return reply({ error: e.message || String(e) });
        }
      case 'session': return reply({ session: await getSession(msg.tabId) });
      case 'stop':
        inflight.get(msg.tabId)?.abort();
        await toTab(msg.tabId, { type: 'guide:stop' }).catch(() => {});
        return reply({ session: await setSession(msg.tabId, null) });
      case 'go': {
        const s = await getSession(msg.tabId);
        if (!s) return reply({});
        await toTab(msg.tabId, s.status === 'running' ? { type: 'guide:go', index: msg.index } : { type: 'guide:start', steps: s.steps, index: msg.index, missingDelay: delayFor(s.source) });
        return reply({ session: await setSession(msg.tabId, { index: msg.index, status: 'running' }) });
      }
      case 'playbooks': return reply({ list: await getPlaybooks(msg.origin) });
      case 'playbook:save': {
        const list = await getPlaybooks(msg.origin);
        const pb = { id: crypto.randomUUID(), name: msg.name.trim().slice(0, 90), steps: msg.steps, created: Date.now(), runs: 0 };
        await setPlaybooks(msg.origin, [pb, ...list]);
        return reply({ playbook: pb });
      }
      case 'playbook:delete': {
        await setPlaybooks(msg.origin, (await getPlaybooks(msg.origin)).filter(p => p.id !== msg.id));
        return reply({ ok: true });
      }
      case 'playbook:run': {
        const pb = (await getPlaybooks(msg.origin)).find(p => p.id === msg.id);
        if (!pb) return reply({ error: 'Сценарий не найден' });
        await bumpRuns(msg.origin, pb.id);
        return reply({ session: await start(msg.tabId, { question: pb.name, answer: `Сценарий «${pb.name}»`, steps: pb.steps, source: 'playbook', playbookId: pb.id, ms: 0, origin: msg.origin }) });
      }
      case 'record:start':
        await toTab(msg.tabId, { type: 'record:start' });
        return reply({ session: await setSession(msg.tabId, { status: 'recording', recorded: [], steps: [], question: '', answer: '' }) });
      case 'record:stop': {
        const res = await toTab(msg.tabId, { type: 'record:stop' }).catch(() => ({ steps: [] }));
        const s = await getSession(msg.tabId);
        const steps = (s && s.recorded && s.recorded.length ? s.recorded : res.steps) || [];
        return reply({ steps, session: await setSession(msg.tabId, null) });
      }

      // from the page
      case 'resume': {
        if (!fromTab) return reply({});
        const s = await getSession(fromTab);
        if (s && s.status === 'recording') { await toTab(fromTab, { type: 'record:start' }); return reply({}); }
        return reply(s && s.status === 'running' && s.index < s.steps.length ? { steps: s.steps, index: s.index, missingDelay: delayFor(s.source) } : {});
      }
      case 'guide:change': {
        const s = await getSession(fromTab);
        if (!s) return reply({});
        const done = msg.index >= s.steps.length;
        return reply({ session: await setSession(fromTab, { index: Math.min(msg.index, s.steps.length), status: done ? 'done' : 'running' }) });
      }
      case 'guide:end': {
        const s = await getSession(fromTab);
        if (s) await setSession(fromTab, { status: msg.reason === 'done' ? 'done' : 'answered', index: msg.reason === 'done' ? s.steps.length : s.index });
        return reply({});
      }
      case 'guide:missing': {
        const s = await getSession(fromTab);
        if (s && s.source === 'claude') { replan(fromTab, msg.index, msg.page).catch(() => {}); return reply({ id: null }); }
        try { return reply(await heal(fromTab, msg.step, msg.page)); } catch (e) { return reply({ id: null }); }
      }
      case 'guide:healed': await storeHealed(fromTab, msg.index, msg.target); return reply({});
      case 'record:step': {
        const s = await getSession(fromTab);
        if (!s || s.status !== 'recording') return reply({});
        return reply({ session: await setSession(fromTab, { recorded: [...(s.recorded || []), msg.step] }) });
      }
      case 'learn:start': {
        const tab = await chrome.tabs.get(msg.tabId);
        if (!usable(tab.url)) return reply({ error: 'На этой странице браузер не даёт расширениям работать.' });
        await toTab(msg.tabId, { type: 'guide:stop' }).catch(() => {});
        await setLearn(originOf(tab.url), { status: 'exploring', views: 0, probes: 0, label: 'Начинаю', error: null });
        await toTab(msg.tabId, { type: 'explore:start' });
        return reply({ ok: true });
      }
      case 'learn:stop': await toTab(msg.tabId, { type: 'explore:stop' }).catch(() => {}); return reply({});
      case 'learn:state': return reply({ learn: (await chrome.storage.local.get(learnKey(msg.origin)))[learnKey(msg.origin)] || null, hasMap: !!(await getMap(msg.origin)) });
      case 'learn:forget':
        await chrome.storage.local.remove([mapKey(msg.origin), learnKey(msg.origin)]);
        await setPlaybooks(msg.origin, (await getPlaybooks(msg.origin)).filter(p => !p.learned));
        return reply({ ok: true });
      // explorer state lives here, so a page load in the middle of the walk resumes on the next page
      case 'explore:load': return reply({ st: (await chrome.storage.session.get(exploreKey(fromTab)))[exploreKey(fromTab)] || null });
      case 'explore:save': await chrome.storage.session.set({ [exploreKey(fromTab)]: msg.st }); return reply({});
      case 'explore:progress': await setLearn(originOf(sender.tab.url), { status: 'exploring', ...msg.p }); return reply({});
      case 'explore:done':
        await chrome.storage.session.remove(exploreKey(fromTab));
        learnFrom(originOf(sender.tab.url), msg.map);
        return reply({});
      case 'record:stop-request':
        chrome.runtime.sendMessage({ type: 'record:stop-request', tabId: fromTab }).catch(() => {});
        return reply({});
      default: return reply({});
    }
  })();
  return true;
});
