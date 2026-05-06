// src/api-proxy.ts
// Local HTTP proxy for same-account OAuth → API key fallback within a session.
//
// The claude binary respects ANTHROPIC_BASE_URL. We start a server on a
// random loopback port and set that env var before spawning the binary.
//
// Normal flow (no rate limit):
//   claude → proxy → api.anthropic.com   (OAuth token forwarded unchanged)
//
// On 429 (subscription exhausted):
//   proxy retries the same request with the account's API key instead.
//   The `oauth-2025-04-20` beta flag is stripped on the retry so Anthropic
//   bills the request against API credits, not the subscription.
//
// No cross-account rotation happens unless the user explicitly configures it.
// Started when the active account has a saved API key.

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

/** Headers for the initial pass-through attempt (OAuth, unchanged). */
export function buildPassthroughHeaders(incoming: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (k.toLowerCase() === 'host') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Headers for the API-key retry after a 429.
 * Replaces Authorization with the API key and strips the OAuth billing marker.
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
 * Start the fallback proxy for a single account.
 *
 * Requests are forwarded with the original OAuth token. If the upstream
 * returns 429, the proxy retries once with the account's API key.
 */
export function startFallbackProxy(
  apiKey: string,
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
        const oauthHeaders = buildPassthroughHeaders(req.headers);

        // First attempt: OAuth (subscription)
        forward(oauthHeaders, req.method, req.url, body,
          (proxyRes) => {
            if (proxyRes.statusCode !== 429) {
              res.writeHead(proxyRes.statusCode!, proxyRes.headers as OutgoingHttpHeaders);
              proxyRes.pipe(res);
              return;
            }

            // 429 on OAuth → retry with API key
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
                () => {
                  if (!res.headersSent) {
                    res.writeHead(502);
                    res.end();
                  }
                },
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
