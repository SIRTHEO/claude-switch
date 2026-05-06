// src/api-proxy.ts
// Local HTTP proxy for same-account OAuth → API key fallback within a session.
//
// The claude binary respects ANTHROPIC_BASE_URL. We start a server on a
// random loopback port and set that env var before spawning the binary.
//
// Two modes, controlled by the `startWithOAuth` parameter:
//
//   startWithOAuth = true  (fallback OFF, key saved):
//     OAuth first → [quota/rate-limit failure] → retry with API key.
//     Statusline shows "OAuth". The subscription is used until it hits the
//     rate limit, then API credits kick in transparently.
//
//   startWithOAuth = false  (fallback ON, key saved):
//     API key from the first request, no OAuth attempt.
//     Statusline shows "API". Equivalent to the old ANTHROPIC_API_KEY inject
//     but routed through the proxy so future rotation can be added.
//
// In both modes `oauth-2025-04-20` is stripped from `anthropic-beta` when
// forwarding with an API key, so Anthropic bills API credits not subscription.
//
// No cross-account rotation happens. Started when the active account has a
// saved API key.

import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

export interface ProxyHandle {
  port: number;
  close: (cb?: () => void) => void;
}

/**
 * HTTP status codes that warrant retrying with the API key.
 *
 * 402 — Payment Required ("out of extra usage", subscription credits gone).
 * 403 — Forbidden (sometimes used for quota exhaustion).
 * 429 — Rate Limited (5h window cap).
 *
 * Intentionally excludes 5xx/529. Retrying a POST after an ambiguous server
 * failure can duplicate work/cost if the upstream already started processing.
 */
export function isRetryableStatus(code: number | undefined): boolean {
  if (code === undefined) return false;
  return code === 402 || code === 403 || code === 429;
}

/**
 * Peek the first chunk of an SSE/JSON body to detect an Anthropic error
 * envelope (`{"type":"error", ...}` or `event: error\ndata: ...`).
 *
 * Anthropic sometimes returns HTTP 200 with an SSE stream whose first event
 * is an error (notably for `out of extra usage`). The proxy must look at
 * the body to know it's an error, not the status code.
 */
export function looksLikeErrorBody(head: string): boolean {
  // SSE error event
  if (/^event:\s*error/m.test(head)) return true;
  // Top-level JSON error envelope
  if (/"type"\s*:\s*"error"/.test(head)) return true;
  // Specific quota exhausted phrasing seen in the wild
  if (/out of (extra )?usage/i.test(head)) return true;
  if (/rate[_ ]?limit/i.test(head) && /"error"/.test(head)) return true;
  return false;
}

/** Strip `oauth-2025-04-20` from a comma-separated `anthropic-beta` value. */
export function stripOauthBeta(value: string): string {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== 'oauth-2025-04-20')
    .join(',');
}

/** Headers for a pass-through attempt: forwarded as-is, only `host` dropped. */
export function buildPassthroughHeaders(incoming: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (k.toLowerCase() === 'host') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Headers for an API-key request: replaces OAuth auth with `x-api-key` and
 * strips `oauth-2025-04-20` from `anthropic-beta` so Anthropic bills credits.
 */
export function buildApiKeyHeaders(
  incoming: IncomingHttpHeaders,
  apiKey: string,
): IncomingHttpHeaders {
  const out = buildPassthroughHeaders(incoming);

  delete out['authorization'];
  out['x-api-key'] = apiKey;

  const beta = out['anthropic-beta'];
  if (typeof beta === 'string') {
    const cleaned = stripOauthBeta(beta);
    if (cleaned) {
      out['anthropic-beta'] = cleaned;
    } else {
      delete out['anthropic-beta'];
    }
  }

  return out;
}

/**
 * Start the fallback proxy.
 *
 * @param apiKey       The account's saved API key.
 * @param startWithOAuth
 *   `true`  — forward with OAuth first; retry with API key only on
 *             subscription quota/rate-limit failures.
 *             Use when `fallback` is OFF. Statusline shows "OAuth".
 *   `false` — use the API key from the very first request.
 *             Use when `fallback` is ON. Statusline shows "API".
 * @param upstreamBase Upstream base URL (override for testing).
 * @param maxRequestBodyBytes Hard cap before forwarding to upstream.
 */
export function startFallbackProxy(
  apiKey: string,
  startWithOAuth = true,
  upstreamBase = DEFAULT_UPSTREAM,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<ProxyHandle> {
  const upstream = new URL(upstreamBase);
  const isHttps = upstream.protocol === 'https:';
  const upstreamPort = upstream.port
    ? parseInt(upstream.port, 10)
    : isHttps ? 443 : 80;
  const requester = isHttps ? https : http;

  function forward(
    headers: IncomingHttpHeaders,
    method: string | undefined,
    path: string | undefined,
    body: Buffer,
    onResponse: (res: http.IncomingMessage) => void,
    onError: () => void,
  ): void {
    const req = (requester as typeof https).request(
      {
        hostname: upstream.hostname,
        port: upstreamPort,
        path: path ?? '/',
        method: method ?? 'GET',
        headers: headers as OutgoingHttpHeaders,
      },
      onResponse,
    );
    req.on('error', onError);
    req.end(body);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      let receivedLen = 0;
      let requestTooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (requestTooLarge) return;
        receivedLen += chunk.length;
        if (receivedLen > maxRequestBodyBytes) {
          requestTooLarge = true;
          chunks.length = 0;
          if (!res.headersSent) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: {
                type: 'request_too_large',
                message: `Request body exceeds ${maxRequestBodyBytes} bytes`,
              },
            }));
          }
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => { if (!res.headersSent) { res.writeHead(400); res.end(); } });
      req.on('end', () => {
        if (requestTooLarge) return;
        const body = Buffer.concat(chunks);

        if (!startWithOAuth) {
          // API-key-first mode (fallback ON): no OAuth attempt, just forward
          // with the API key. Pass 429 through if it occurs.
          const headers = buildApiKeyHeaders(req.headers, apiKey);
          forward(headers, req.method, req.url, body,
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode!, proxyRes.headers as OutgoingHttpHeaders);
              proxyRes.pipe(res);
            },
            () => {
              if (!res.headersSent) { res.writeHead(502); res.end(); }
            },
          );
          return;
        }

        // OAuth-first mode (fallback OFF): try subscription, retry with API
        // key on quota/rate-limit failures (status code OR error envelope
        // inside a 200 body — Anthropic returns "out of extra usage" via
        // the body, not via status).
        const oauthHeaders = buildPassthroughHeaders(req.headers);

        const retryWithApiKey = (reason: string): void => {
          process.stderr.write(
            `\n⚡ claude-switch: ${reason} — retrying with API key\n\n`,
          );
          const keyHeaders = buildApiKeyHeaders(req.headers, apiKey);
          forward(keyHeaders, req.method, req.url, body,
            (retryRes) => {
              if (res.headersSent) return;
              res.writeHead(retryRes.statusCode!, retryRes.headers as OutgoingHttpHeaders);
              retryRes.pipe(res);
            },
            () => { if (!res.headersSent) { res.writeHead(502); res.end(); } },
          );
        };

        forward(oauthHeaders, req.method, req.url, body,
          (proxyRes) => {
            if (isRetryableStatus(proxyRes.statusCode)) {
              proxyRes.resume();
              proxyRes.on('end', () => retryWithApiKey(`subscription returned ${proxyRes.statusCode}`));
              return;
            }

            // HTTP 200 — peek the first chunk to spot an SSE/JSON error
            // envelope ("out of extra usage" arrives this way). Buffer up
            // to 4 KB before deciding; that's enough to see the first SSE
            // event without holding the full streaming response.
            let decided = false;
            const peeked: Buffer[] = [];
            let peekedLen = 0;
            const PEEK_LIMIT = 4096;

            const flushAndPipe = (): void => {
              if (decided) return;
              decided = true;
              if (res.headersSent) return;
              res.writeHead(proxyRes.statusCode!, proxyRes.headers as OutgoingHttpHeaders);
              for (const c of peeked) res.write(c);
              proxyRes.pipe(res);
            };

            const onData = (chunk: Buffer): void => {
              if (decided) return;
              peeked.push(chunk);
              peekedLen += chunk.length;
              const head = Buffer.concat(peeked).toString('utf8');
              if (looksLikeErrorBody(head)) {
                decided = true;
                proxyRes.removeListener('data', onData);
                proxyRes.removeListener('end', onEnd);
                proxyRes.resume();
                proxyRes.on('end', () => retryWithApiKey('subscription error in response body'));
                return;
              }
              if (peekedLen >= PEEK_LIMIT) flushAndPipe();
            };

            const onEnd = (): void => { flushAndPipe(); };

            proxyRes.on('data', onData);
            proxyRes.on('end', onEnd);
          },
          () => {
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Proxy upstream error' } }));
            }
          },
        );
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, close: (cb) => server.close(cb) });
    });
  });
}
