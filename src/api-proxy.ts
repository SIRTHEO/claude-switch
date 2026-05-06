// src/api-proxy.ts
// Local HTTP proxy for same-account OAuth → API key fallback within a session.
//
// The claude binary respects ANTHROPIC_BASE_URL. We start a server on a
// random loopback port and set that env var before spawning the binary.
//
// Two modes, controlled by the `startWithOAuth` parameter:
//
//   startWithOAuth = true  (fallback OFF, key saved):
//     OAuth first → [429] → retry with API key.
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

export interface ProxyHandle {
  port: number;
  close: (cb?: () => void) => void;
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
 * Headers for an API-key request: replaces `authorization` with the key and
 * strips `oauth-2025-04-20` from `anthropic-beta` so Anthropic bills credits.
 */
export function buildApiKeyHeaders(
  incoming: IncomingHttpHeaders,
  apiKey: string,
): IncomingHttpHeaders {
  const out = buildPassthroughHeaders(incoming);

  out['authorization'] = `Bearer ${apiKey}`;

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
 *   `true`  — forward with OAuth first; retry with API key only on 429.
 *             Use when `fallback` is OFF. Statusline shows "OAuth".
 *   `false` — use the API key from the very first request.
 *             Use when `fallback` is ON. Statusline shows "API".
 * @param upstreamBase Upstream base URL (override for testing).
 */
export function startFallbackProxy(
  apiKey: string,
  startWithOAuth = true,
  upstreamBase = DEFAULT_UPSTREAM,
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
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('error', () => { if (!res.headersSent) { res.writeHead(400); res.end(); } });
      req.on('end', () => {
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
        // key on 429.
        const oauthHeaders = buildPassthroughHeaders(req.headers);
        forward(oauthHeaders, req.method, req.url, body,
          (proxyRes) => {
            if (proxyRes.statusCode !== 429) {
              res.writeHead(proxyRes.statusCode!, proxyRes.headers as OutgoingHttpHeaders);
              proxyRes.pipe(res);
              return;
            }

            proxyRes.resume();
            proxyRes.on('end', () => {
              process.stderr.write(
                '\n⚡ claude-switch: subscription limit hit — retrying with API key\n\n',
              );
              const keyHeaders = buildApiKeyHeaders(req.headers, apiKey);
              forward(keyHeaders, req.method, req.url, body,
                (retryRes) => {
                  res.writeHead(retryRes.statusCode!, retryRes.headers as OutgoingHttpHeaders);
                  retryRes.pipe(res);
                },
                () => { if (!res.headersSent) { res.writeHead(502); res.end(); } },
              );
            });
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
