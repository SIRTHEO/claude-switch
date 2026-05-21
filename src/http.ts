// src/http.ts
// HttpPort — the single outbound-HTTP seam for the domain. Adapters implement
// it; domain functions take it via `deps` so tests inject a fake without
// touching the network. Narrower than the full Fetch API on purpose: it
// exposes only what the callers actually use, so the contract an adapter must
// satisfy stays small and obvious.

/** Request options the domain needs from an HTTP call. */
export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Performs one HTTP request and resolves to a Response. */
export type HttpPort = (url: string, init?: HttpRequestInit) => Promise<Response>;

/** Production adapter over the global fetch (Node 18+). */
export const fetchHttpAdapter: HttpPort = (url, init) => globalThis.fetch(url, init);

/** Whether a usable global fetch exists. Lets callers keep their
 *  "no fetch available → give up" path without touching globalThis directly. */
export function hasGlobalFetch(): boolean {
  return typeof globalThis.fetch === 'function';
}
