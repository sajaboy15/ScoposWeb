import type { ReactNode, ReactElement } from 'react';

export interface ScoposProviderProps {
  children?: ReactNode;
  /** Your server route that holds the Claude key (the Scopos server or your proxy to it). Default '/api/scopos'. */
  endpoint?: string;
  /** Product name and a few words about it; shown in the panel and sent with questions. */
  product?: string;
  /** Where the loader is served from. Default '/scopos.js'. */
  src?: string;
  /** Launcher text. Default 'Спросить'. */
  label?: string;
  /** URL of a JSON array of recorded guides (from the extension). */
  playbooks?: string;
  /** Allow learn mode. Works only on localhost / *.localhost, or together with learnToken. */
  learn?: boolean;
  /** The server's SCOPOS_LEARN_TOKEN, for learn mode on a staging host. Never ship it to production users. */
  learnToken?: string;
  /** When to load the core: 'idle' (default), 'click' (only on first use), 'eager' (right away). */
  load?: 'idle' | 'click' | 'eager';
  /** CSP nonce for the loader and its chunks. */
  nonce?: string;
}

export interface Scopos {
  /** Opens the Scopos panel. */
  open(): Promise<void>;
  /** Opens the panel and asks a question. */
  ask(question: string): Promise<void>;
  /** Runs a ready-made guide by name or id; false if there is none. */
  startGuide(nameOrId: string): Promise<boolean>;
}

/** Adds Scopos to the page once. Options are read on the first mount. */
export function ScoposProvider(props: ScoposProviderProps): ReactElement;
/** The Scopos API; works inside or outside ScoposProvider. */
export function useScopos(): Scopos;
export default ScoposProvider;
