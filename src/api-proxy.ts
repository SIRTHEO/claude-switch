// src/api-proxy.ts
// Local HTTP proxy that rotates among saved API keys on 429.
//
// The claude binary respects ANTHROPIC_BASE_URL, so we start a server on a
// random loopback port, set that env var, and forward every request to
// api.anthropic.com.
//
// On each request the proxy:
//   1. Replaces `Authorization` with the current account's API key.
//   2. Strips `oauth-2025-04-20` from `anthropic-beta` — that token tells
//      Anthropic's backend to treat the request as an OAuth session and bill
//      it against the subscription, which is the opposite of what we want.
//   3. On 429 rotates to the next account and retries with the same body.
//
// The full request body is buffered before forwarding so retries are possible.
// Typical size is ~170 KB; this is fine for in-memory buffering.
//
// Only started when 2+ accounts have saved API keys.

import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

export interface RotatingAccount {
  email: string;
  apiKey: string;
}

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

/** Build the outgoing headers for a forwarded request under `account`. */
export function buildForwardHeaders(
  incoming: IncomingHttpHeaders,
  apiKey: string,
): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (k.toLowerCase() === 'host') continue;
    out[k] = v;
  }

  // Replace OAuth token (sk-ant-oat01-…) with the API key (sk-ant-api03-…).
  out['authorization'] = `Bearer ${apiKey}`;

  // Remove the OAuth session marker so Anthropic bills API credits, not subscription.
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

export function startRotatingProxy(
  accounts: RotatingAccount[],
  upstreamBase = DEFAULT_UPSTREAM,
): Promise<ProxyHandle> {
  const upstream = new URL(upstreamBase);
  const isHttps = upstream.protocol === 'https:';
  const upstreamPort = upstream.port
    ? parseInt(upstream.port, 10)
    : isHttps ? 443 : 80;
  const requester = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => attempt(0, Buffer.concat(chunks)));
      req.on('error', () => {
        if (!res.headersSent) { res.writeHead(400); res.end(); }
      });

      function attempt(idx: number, body: Buffer): void {
        if (idx >= accounts.length) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'All accounts exhausted' },
          }));
          return;
        }

        const account = accounts[idx]!;

        if (idx > 0) {
          process.stderr.write(
            `\n⚡ claude-switch: rate limited on ${accounts[idx - 1]!.email} → rotating to ${account.email}\n\n`,
          );
        }

        const forwardHeaders = buildForwardHeaders(req.headers, account.apiKey);

        const proxyReq = (requester as typeof https).request(
          {
            hostname: upstream.hostname,
            port: upstreamPort,
            path: req.url,
            method: req.method,
            headers: forwardHeaders as OutgoingHttpHeaders,
          },
          (proxyRes) => {
            if (proxyRes.statusCode === 429) {
              proxyRes.resume();
              proxyRes.on('end', () => attempt(idx + 1, body));
              return;
            }
            res.writeHead(proxyRes.statusCode!, proxyRes.headers as OutgoingHttpHeaders);
            proxyRes.pipe(res);
          },
        );

        proxyReq.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Proxy upstream error' } }));
          }
        });

        proxyReq.end(body);
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, close: (cb) => server.close(cb) });
    });
  });
}
