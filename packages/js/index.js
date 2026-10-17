// @scopos/js: Scopos for apps without React. Zero dependencies, ESM.
//
//   import { init } from '@scopos/js';
//   const scopos = init({ endpoint: '/api/scopos', product: 'Ledgerly, счета и платежи' });
//   scopos.startGuide('Выставить счёт клиенту');
//
// init() adds the small loader (/scopos.js from your Scopos server) once; the rest of Scopos loads when the
// browser is idle or on the first use. Calls made before that wait and then run.

let loading = null;

/** Adds the loader's <script> once per page. Resolves when Scopos.widget (the loader's stub or the real one) exists. */
function inject(o) {
  if (typeof window === 'undefined') return new Promise(() => {}); // server rendering: nothing to do
  if (window.Scopos && window.Scopos.widget) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = o.src || '/scopos.js';
    s.async = true;
    const d = s.dataset;
    d.endpoint = o.endpoint || '/api/scopos';
    if (o.product) d.product = o.product;
    if (o.label) d.label = o.label;
    if (o.playbooks) d.playbooks = o.playbooks;
    if (o.load) d.load = o.load;
    // Learn mode works only on localhost or with a learn token, whatever is set here.
    if (o.learn) d.learn = '';
    if (o.learnToken) d.learnToken = o.learnToken;
    if (o.nonce) s.nonce = o.nonce;
    s.onload = () => resolve();
    s.onerror = () => { loading = null; s.remove(); reject(new Error(`Scopos: не загрузился ${s.src}`)); };
    (document.head || document.documentElement).appendChild(s);
  });
}

const widget = () => window.Scopos && window.Scopos.widget;

/**
 * Starts Scopos on this page (once; later calls return the same client and ignore new options).
 * @param {import('./index').ScoposOptions} [options]
 * @returns {import('./index').ScoposClient}
 */
export function init(options = {}) {
  if (!loading) loading = inject(options);
  return client;
}

const call = name => async (...args) => {
  if (!loading) loading = inject({});
  await loading;
  return widget()[name](...args);
};

export const client = {
  get ready() { return loading || Promise.resolve(); },
  open: call('open'),
  /** Opens the panel and asks; a question that names a ready-made guide runs it without the server. */
  ask: async question => { await call('open')(); return call('ask')(question); },
  /** Runs a ready-made guide by its name or id; resolves to false if there is no such guide. */
  startGuide: call('startGuide'),
};

export default { init, client };
