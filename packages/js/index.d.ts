export interface ScoposOptions {
  /** Your server route that holds the Claude key (the Scopos server or your proxy to it). Default '/api/scopos'. */
  endpoint?: string;
  /** Product name and a few words about it; shown in the panel and sent with questions. */
  product?: string;
  /** Where the loader is served from. Default '/scopos.js' (the Scopos server, or your proxy to it). */
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

export interface ScoposClient {
  /** Resolves once the loader is on the page. */
  readonly ready: Promise<void>;
  /** Opens the Scopos panel. */
  open(): Promise<void>;
  /** Opens the panel and asks a question. */
  ask(question: string): Promise<void>;
  /** Runs a ready-made guide by name or id; false if there is none. */
  startGuide(nameOrId: string): Promise<boolean>;
}

/** Starts Scopos on this page (once per page; later calls return the same client). */
export function init(options?: ScoposOptions): ScoposClient;
export const client: ScoposClient;
declare const _default: { init: typeof init; client: ScoposClient };
export default _default;

declare global {
  interface Window {
    Scopos?: {
      widget?: {
        open(): void | Promise<void>;
        ask(question: string): void | Promise<void>;
        startGuide(nameOrId: string): Promise<boolean>;
        cfg: { endpoint: string; product: string; learn: boolean };
      };
      [key: string]: unknown;
    };
  }
}
