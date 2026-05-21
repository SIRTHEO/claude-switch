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

/**
 * Read a `Response` body with a hard size cap. Stops streaming as soon as
 * the cumulative bytes exceed `max` and cancels the reader — defence in
 * depth against an upstream (or a hijacked endpoint) that returns an
 * unbounded payload. Falls back to `text()` only when the platform doesn't
 * expose a readable stream on the response (rare).
 */
export async function readBodyCapped(
  res: Response,
  max: number,
): Promise<{ text: string; tooLarge: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return { text, tooLarge: text.length > max };
  }
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel();
      return { text, tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, tooLarge: false };
}
