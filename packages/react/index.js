'use client';
// @scopos/react: Scopos for React apps. No runtime dependencies (react is a peer).
//
//   import { ScoposProvider, useScopos } from '@scopos/react';
//
//   <ScoposProvider endpoint="/api/scopos" product="Ledgerly, счета и платежи">
//     <App />
//   </ScoposProvider>
//
//   const scopos = useScopos();
//   <button onClick={() => scopos.startGuide('Выставить счёт клиенту')}>Показать как</button>
//
// The provider adds the small loader (/scopos.js) once per page, after the first render; the rest of Scopos loads
// when the browser is idle or on first use. It draws its own launcher in a shadow root, outside your React tree,
// so it survives route changes and re-renders. Hook calls made before it is loaded wait and then run.
import { createContext, createElement, useContext, useEffect } from 'react';

let loading = null;

function inject(o) {
  if (typeof window === 'undefined') return new Promise(() => {});
  if (window.Scopos && window.Scopos.widget) return Promise.resolve(); // already on the page (e.g. a <script> tag)
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

const call = name => async (...args) => {
  if (!loading) loading = inject({});
  await loading;
  return window.Scopos.widget[name](...args);
};

const client = {
  open: call('open'),
  ask: async question => { await call('open')(); return call('ask')(question); },
  startGuide: call('startGuide'),
};

const Ctx = createContext(client);

/** Adds Scopos to the page once. Options are read on the first mount; later changes are ignored. */
export function ScoposProvider({ children, endpoint, product, src, label, playbooks, learn, learnToken, load, nonce }) {
  useEffect(() => {
    if (!loading) loading = inject({ endpoint, product, src, label, playbooks, learn, learnToken, load, nonce });
    loading.catch(e => console.warn(e.message));
    // No cleanup: Scopos keeps one widget per page and a running guide must outlive this component.
  }, []);
  return createElement(Ctx.Provider, { value: client }, children);
}

/** open(), ask(question), startGuide(nameOrId). Works inside or outside ScoposProvider. */
export function useScopos() {
  return useContext(Ctx);
}

export default ScoposProvider;
