/*
 * Scopos brain: the one Claude request behind every answer.
 *
 * Shared by the extension's service worker (importScripts), the embeddable SDK
 * (bundled) and the Node proxy (require). It only builds the request body and
 * parses the reply; whoever owns the API key sends it.
 *
 * The model never sees pixels. It gets a compact text map of the page: every
 * visible control with a numeric id, its role, its accessible name and the
 * section it sits in. It answers with ordered steps that point at those ids,
 * plus the element's visible text so the step can be found again after a
 * navigation or a release that reshuffles the DOM.
 */
(function (root) {
  const MODEL = 'claude-opus-5-5';
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2023-06-01';
  // Refusals are retried server-side on the model Anthropic recommends for that category.
  const BETA = 'server-side-fallback-2026-07-01';

  const SYSTEM = `you are Scopos, a product guide that lives inside a web app and helps its users get things done.

you get a map of the page the user is looking at: one line per visible control, as
[id] role "name" · section · state
plus the page title, url and headings. the user asks how to do something, or asks a question about the product.

ANSWER AS STEPS
- break the task into the actions the user performs, in order, one action per step.
- if the right control is not on this page yet, the first steps are how to get there (open a menu, a tab, a link).
- each instruction is one short sentence phrased as an action, naming the control the way it is labeled on screen: "Нажмите «Новый счёт»", "Click Save at the bottom".
- element_id is the id from the map for that step's control, or null when the control is not on this page. never invent an id; a wrong pointer is worse than none.
- element_text is the visible label of the control (also for steps on later pages, as your best expectation of its label), or null.
- action: click, type (fill a field), select (pick an option), or look (just read something).
- value: what to type or select, only when the user told you or it is obvious; otherwise null.
- if the user only asks a question, answer it in "answer" and return an empty steps list.

"answer" is one or two plain sentences: what the user will achieve, or the answer to their question.
reply in the user's language. no markdown.`;

  const SCHEMA = {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            instruction: { type: 'string' },
            element_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            element_text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            action: { type: 'string', enum: ['click', 'type', 'select', 'look'] },
            value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['instruction', 'element_id', 'element_text', 'action', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['answer', 'steps'],
    additionalProperties: false,
  };

  // A smaller request used to re-find one control after the UI changed.
  const LOCATE_SCHEMA = {
    type: 'object',
    properties: { element_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
    required: ['element_id'],
    additionalProperties: false,
  };

  function pageText(page) {
    const head = [
      `title: ${page.title || ''}`,
      `url: ${page.url || ''}`,
      page.headings && page.headings.length ? `headings: ${page.headings.join(' | ')}` : '',
    ].filter(Boolean).join('\n');
    return `${head}\n\ncontrols:\n${page.lines.join('\n')}`;
  }

  /**
   * progress: instructions the user already completed. The page map is then the page they reached,
   * and the model plans only the remaining steps from here (used when a guessed control isn't on the new page).
   */
  function buildAsk({ question, page, history = [], product = '', progress = [] }) {
    const messages = history.slice(-6).map(t => ({ role: t.role, content: t.content }));
    const done = progress.length
      ? `\n\nthe user is in the middle of this task and already did:\n${progress.map((p, i) => `${i + 1}. ${p}`).join('\n')}\nthe map above is the page they are on now. return only the remaining steps, starting from this page.`
      : '';
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: (product ? `product: ${product}\n` : '') + pageText(page) },
        { type: 'text', text: question + done },
      ],
    });
    return body(SYSTEM, messages, SCHEMA, 'low');
  }

  function buildLocate({ instruction, oldText, page }) {
    const messages = [{
      role: 'user',
      content: `${pageText(page)}\n\nwhich control on this page does this step mean? step: "${instruction}". it used to be labeled "${oldText || ''}". answer with its id, or null if it is not on this page.`,
    }];
    return body('you match a guide step to a control on a web page. answer only with the id from the map.', messages, LOCATE_SCHEMA, 'low');
  }

  // ---------------- product map: learned once by the explorer ----------------

  const REF_STEP = {
    type: 'object',
    properties: {
      instruction: { type: 'string' },
      element_ref: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      action: { type: 'string', enum: ['click', 'type', 'select', 'look'] },
      value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['instruction', 'element_ref', 'action', 'value'],
    additionalProperties: false,
  };
  const MAP_ASK_SCHEMA = {
    type: 'object',
    properties: { answer: { type: 'string' }, steps: { type: 'array', items: REF_STEP } },
    required: ['answer', 'steps'],
    additionalProperties: false,
  };
  const LEARN_SCHEMA = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      guides: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, steps: { type: 'array', items: REF_STEP } },
          required: ['name', 'steps'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'guides'],
    additionalProperties: false,
  };

  const MAP_RULES = `the product map lists every screen (page), dialog and panel of the product, as
VIEW <id> <kind> "<title>" <address>
  <ref> <role> "<name>" · <section> · <state> → <id of the view it opens>
controls listed under GLOBAL are on every page (navigation). a control with → opens that view.
to reach a view, follow the → links from where the user is. dialogs and panels open from their opener control.

STEPS
- one action per step, in the order the user performs them, starting from the user's current view.
- element_ref is the ref of the control for that step (for example "V3.4"), taken only from the map. null only for a step with no control.
- instruction is one short sentence naming the control the way it is labeled: "Нажмите «Новый счёт»".
- action: click, type, select, or look.
- value: when the user named what to enter, put it here: for a select, the matching option exactly as written in its options list; for a text field, the text. otherwise null.
- in a form, include the fields the user has to fill and the button that finishes the task.
write in the product's interface language. no markdown.`;

  /** Compact text form of a product map. Navigation repeated on every page is listed once as GLOBAL. */
  function mapText(map) {
    const pages = map.views.filter(v => v.kind === 'page');
    const sig = c => `${c.role}|${c.name}|${c.to || ''}`;
    const count = {};
    pages.forEach(v => new Set(v.controls.map(sig)).forEach(k => { count[k] = (count[k] || 0) + 1; }));
    const global = new Set(pages.length > 2 ? Object.keys(count).filter(k => count[k] >= Math.ceil(pages.length * 0.7)) : []);
    const line = c => `  ${c.ref} ${c.role} "${c.name}"${c.section ? ' · ' + c.section : ''}${c.state ? ' · ' + c.state : ''}${c.options && c.options.length ? ' · options: ' + c.options.join(' | ') : ''}${c.to ? ' → ' + c.to : ''}`;
    const out = [];
    if (global.size) {
      const first = pages.find(v => v.controls.some(c => global.has(sig(c))));
      out.push('GLOBAL (on every page, refs from ' + first.id + ')');
      first.controls.filter(c => global.has(sig(c))).forEach(c => out.push(line(c)));
    }
    for (const v of map.views) {
      const where = v.kind === 'page' ? v.key : `opens from ${v.opener} on ${v.parent}`;
      out.push(`VIEW ${v.id} ${v.kind} "${v.title}" ${where}`);
      v.controls.filter(c => v.kind !== 'page' || !global.has(sig(c))).forEach(c => out.push(line(c)));
    }
    return out.join('\n');
  }

  const mapSystem = (lead, map, product) => [
    { type: 'text', text: `${lead}\n\n${MAP_RULES}` },
    // The map is the large, stable part of every request: cache it.
    { type: 'text', text: `${product ? 'product: ' + product + '\n' : ''}PRODUCT MAP\n${mapText(map)}`, cache_control: { type: 'ephemeral' } },
  ];

  /** Writes the ready-made guides for the product's main tasks from the map. */
  function buildLearn({ map, product = '' }) {
    const system = mapSystem('you are Scopos. you studied a software product by walking through every screen, and now you write the in-product guides its users need most.', map, product);
    const messages = [{ role: 'user', content: 'write guides for the 8 to 15 most common tasks a user of this product does (creating the main records, inviting people, changing settings, finding things). name each guide as the task in the user\'s words, for example "Выставить счёт клиенту". each guide starts on the first page of the map. also give a one-sentence summary of what the product is.' }];
    return body(system, messages, LEARN_SCHEMA, 'medium');
  }

  /** Answers a question from the whole map: steps across pages point at known controls, nothing is guessed. */
  function buildAskMap({ question, map, current, history = [], product = '' }) {
    const system = mapSystem('you are Scopos, a product guide inside a web app. the user asks how to do something or asks about the product.', map, product);
    const messages = history.slice(-6).map(t => ({ role: t.role, content: t.content }));
    messages.push({ role: 'user', content: `the user is on view ${current || 'unknown'}.\n${question}\n\nif it is a question rather than a task, answer it in "answer" and return no steps.` });
    return body(system, messages, MAP_ASK_SCHEMA, 'low');
  }

  /** Turns ref-based steps into runnable steps with element descriptors. */
  function refSteps(steps, map) {
    const byRef = {};
    map.views.forEach(v => v.controls.forEach(c => { byRef[c.ref] = c; }));
    return steps.map(s => {
      const c = s.element_ref && byRef[s.element_ref];
      return { instruction: s.instruction, action: s.action, value: s.value, target: c ? { ...c.d, text: c.d.text || c.name, role: c.d.role || c.role } : null };
    });
  }

  /** Which map view the user is on now, by address. */
  function viewOf(map, url) {
    try {
      const u = new URL(url);
      const key = u.pathname + (u.hash && u.hash !== '#' && u.hash !== '#/' ? u.hash : '');
      const v = map.views.find(x => x.kind === 'page' && x.key === key);
      return v ? v.id : null;
    } catch (e) { return null; }
  }

  function body(system, messages, schema, effort) {
    return {
      model: MODEL,
      max_tokens: 16000,
      system,
      messages,
      thinking: { type: 'adaptive' },
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
    };
  }

  function headers(apiKey, fromBrowser) {
    const h = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-beta': BETA,
    };
    // Calls from an extension or page carry an Origin; the API asks callers to opt in explicitly.
    if (fromBrowser) h['anthropic-dangerous-direct-browser-access'] = 'true';
    return h;
  }

  /** Turns a Messages API response into the parsed JSON object, or throws a readable error. */
  function parse(data) {
    if (data.stop_reason === 'refusal') throw new Error('Claude отказался отвечать на этот вопрос. Переформулируйте его.');
    if (data.stop_reason === 'max_tokens') throw new Error('Ответ получился слишком длинным. Спросите про одно действие за раз.');
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    try { return JSON.parse(text); } catch (e) { throw new Error('Не удалось разобрать ответ модели.'); }
  }

  async function call(requestBody, apiKey, { fromBrowser = true, signal } = {}) {
    let res;
    try {
      res = await fetch(API_URL, { method: 'POST', headers: headers(apiKey, fromBrowser), body: JSON.stringify(requestBody), signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error('Нет связи с Claude API. Проверьте интернет.');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('Ключ API не подошёл. Замените его в настройках.');
      if (res.status === 429) throw new Error('Слишком много запросов. Подождите минуту.');
      if (res.status === 400 && /credit/i.test(detail)) throw new Error('На аккаунте Anthropic закончились средства.');
      throw new Error(`Claude API ответил ошибкой ${res.status}.`);
    }
    return parse(await res.json());
  }

  const Brain = { MODEL, buildAsk, buildLocate, buildLearn, buildAskMap, mapText, refSteps, viewOf, call, parse, headers, API_URL };
  if (typeof module === 'object' && module.exports) module.exports = Brain;
  root.ScoposBrain = Brain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
