// src/api-proxy.ts
// Local HTTP proxy for live OAuth ↔ API-key handover within a single
// `claude` session.
//
// The claude binary respects ANTHROPIC_BASE_URL. We start a server on a
// random loopback port and set that env var before spawning the binary.
//
// Modes (controlled by the `mode` option):
//
//   'oauth-first':
//     Default for accounts that have BOTH a working OAuth token AND a saved
//     API key. Each request is sent with OAuth Bearer first; on a quota /
//     rate-limit failure (status 402/403/429 or a top-of-stream error
//     envelope) we retry that single request with the API key.
//
//     If we see N consecutive OAuth failures we enter a temporary
//     `api-burst` sub-state: subsequent requests skip the OAuth attempt and
//     go straight to the API key, except for a periodic OAuth probe (every
//     M minutes). When the probe succeeds we drop back to oauth-first.
//     This gives symmetric live recovery — subscription comes back online
//     and the running claude session resumes billing the subscription
//     without restart.
//
//   'api-first':
//     Forward every request with `x-api-key` directly. Never probes OAuth.
//     For users who explicitly want to bill API credits (or whose OAuth
//     subscription is unavailable). Equivalent to the old fallback-ON
//     mode in v3.x.
//
// `oauth-2025-04-20` is stripped from `anthropic-beta` whenever the proxy
// forwards with an API key, so Anthropic bills API credits not subscription.
//
// The proxy is started ONLY when the active account has a saved API key.
// Pure-OAuth accounts launch claude without the proxy at all.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_BURST_FAILURE_THRESHOLD = 3;
export const DEFAULT_BURST_PROBE_INTERVAL_MS = 5 * 60 * 1000;

/** Modes externally chosen by the caller (per-account `authMode`).
 *  `oauth-only` is not a proxy mode — when there's no API key the caller
 *  doesn't start the proxy at all. */
export type ProxyMode = 'oauth-first' | 'api-first';

/** Snapshot of the proxy's runtime state, exposed to callers for diagnostics
 *  and statusline display. */
export interface ProxyRuntimeState {
  mode: ProxyMode;
  /** True when oauth-first has temporarily downgraded to API key only after
   *  N consecutive OAuth failures. False in `api-first` mode (always). */
  burstActive: boolean;
  /** How many OAuth attempts in a row have failed without an intervening
   *  successful response. */
  consecutiveOauthFailures: number;
  /** Cumulative request counters since proxy start. Surfaced in
   *  `claude switch status` so the user can confirm whether the proxy
   *  has actually been routing (and how the OAuth ↔ API-key split is
   *  going) instead of having to trust a banner that shows up once. */
  counters: {
    totalRequests: number;
    oauthAttempts: number;
    oauthSuccesses: number;
    oauthFailures: number;
    apiKeyDirectRequests: number;
    apiKeyRetries: number;
    upstreamErrors: number;
    bodySniffsTriggered: number;
  };
  /** Reason of the most recent OAuth → API-key retry (e.g. "subscription
   *  returned 429" or "subscription error in response body"). Null when
   *  no retry has happened. */
  lastRetryReason: string | null;
}

export interface ProxyHandle {
  port: number;
  close: (cb?: () => void) => void;
  /** Read the current runtime state (mode + burst flag + counter). */
  state(): ProxyRuntimeState;
}

export interface BurstConfig {
  failureThreshold: number;
  probeIntervalMs: number;
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
  // Anthropic-internal error type tags (extracted from the production
  // claude binary v2.x — these appear inside the inner `error.type`
  // field, not the top-level one we already match above).
  if (/"rate_limit_error"|"overloaded_error"|"payment_required"|"usage_quota"/i.test(head)) {
    return true;
  }
  // Specific quota-exhausted phrasings actually emitted by the API in
  // the response body. Reverse-engineered from the production binary
  // — there are several variants and the previous regex only caught
  // the user-facing rendering, NOT the wire-level message.
  if (/extra usage credits exhausted/i.test(head)) return true;
  if (/extra usage disabled (by your organization|for your account)/i.test(head)) return true;
  if (/extra usage not available/i.test(head)) return true;
  // Legacy phrasing (kept for safety; matches the user-facing copy too).
  if (/out of (extra )?usage/i.test(head)) return true;
  // Generic rate-limit phrasing in any error envelope.
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

export interface StartFallbackProxyOptions {
  apiKey: string;
  mode: ProxyMode;
  upstreamBase?: string;
  maxRequestBodyBytes?: number;
  burstConfig?: Partial<BurstConfig>;
  /** Wall-clock provider for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** When set, the final state snapshot is persisted to this path on
   *  `close()` so the next `claude switch status` can render the
   *  most recent session's counters. */
  persistStatsTo?: string;
}

/**
 * Start the fallback proxy.
 *
 * In `oauth-first` mode the proxy implements live transitions in both
 * directions: it falls back to the API key on subscription failures, then
 * periodically probes OAuth so the running claude session can return to
 * subscription billing as soon as the rate limit clears — no restart.
 *
 * In `api-first` mode the proxy always uses the API key.
 */
export function startFallbackProxy(opts: StartFallbackProxyOptions): Promise<ProxyHandle> {
  const apiKey = opts.apiKey;
  const mode = opts.mode;
  const upstreamBase = opts.upstreamBase ?? DEFAULT_UPSTREAM;
  const maxRequestBodyBytes = opts.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const burstConfig: BurstConfig = {
    failureThreshold: opts.burstConfig?.failureThreshold ?? DEFAULT_BURST_FAILURE_THRESHOLD,
    probeIntervalMs: opts.burstConfig?.probeIntervalMs ?? DEFAULT_BURST_PROBE_INTERVAL_MS,
  };
  const now = opts.now ?? Date.now;

  // CLAUDE_SWITCH_PROXY_DEBUG=1 enables verbose diagnostic logging on
  // stderr — every request gets a method+path line, every retry
  // decision is annotated with the reason, and every body sniff prints
  // the first 256 bytes that triggered it (or didn't). Off by default
  // because the noise is significant; ON when investigating "why
  // didn't the proxy fall back?" type bugs (the same class that
  // shipped silently for months in v3.4 because we had no visibility).
  const debug = process.env.CLAUDE_SWITCH_PROXY_DEBUG === '1';
  const dbg = (msg: string): void => {
    if (debug) process.stderr.write(`[proxy-debug] ${msg}\n`);
  };

  // Mutable runtime state shared across requests. Only meaningful in
  // `oauth-first` mode — `api-first` ignores it.
  let burstActive = false;
  let consecutiveOauthFailures = 0;
  let lastOauthAttemptAt = 0;

  // Counters surfaced via the ProxyHandle.state() API for diagnostics
  // and visible in `claude switch status`. Untyped numbers are fine —
  // these are tally fields the consumer reads, not protocol values.
  const counters = {
    totalRequests: 0,
    oauthAttempts: 0,
    oauthSuccesses: 0,
    oauthFailures: 0,
    apiKeyDirectRequests: 0,  // api-first mode OR in-burst skip
    apiKeyRetries: 0,         // OAuth → API-key per-request retry
    upstreamErrors: 0,        // network failure connecting to upstream
    bodySniffsTriggered: 0,   // body matched looksLikeErrorBody on a 200
  };
  let lastRetryReason: string | null = null;

  const recordOauthFailure = (): void => {
    consecutiveOauthFailures++;
    counters.oauthFailures++;
    lastOauthAttemptAt = now();
    dbg(`oauth attempt failed (consecutive=${consecutiveOauthFailures})`);
    if (!burstActive && consecutiveOauthFailures >= burstConfig.failureThreshold) {
      burstActive = true;
      process.stderr.write(
        `\n⚡ claude-switch: OAuth failed ${consecutiveOauthFailures}× in a row — entering API-burst mode (probing OAuth every ${Math.round(burstConfig.probeIntervalMs / 60000)} min)\n\n`,
      );
    }
  };

  const recordOauthSuccess = (): void => {
    if (burstActive) {
      process.stderr.write(
        '\n⚡ claude-switch: OAuth probe succeeded — exiting API-burst, back to subscription\n\n',
      );
    }
    burstActive = false;
    consecutiveOauthFailures = 0;
    counters.oauthSuccesses++;
    lastOauthAttemptAt = now();
    dbg('oauth succeeded');
  };

  /** Decide whether THIS request should attempt OAuth, given oauth-first
   *  mode and the current burst state. */
  const shouldTryOauth = (): boolean => {
    if (!burstActive) return true;
    return now() - lastOauthAttemptAt >= burstConfig.probeIntervalMs;
  };
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
        counters.totalRequests++;
        dbg(`→ ${req.method ?? 'GET'} ${req.url ?? '/'} (body=${body.length}B, mode=${mode}, burstActive=${burstActive})`);

        // Pure API-first mode: never attempt OAuth, never probe.
        if (mode === 'api-first') {
          counters.apiKeyDirectRequests++;
          const headers = buildApiKeyHeaders(req.headers, apiKey);
          forward(headers, req.method, req.url, body,
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode!, proxyRes.headers as OutgoingHttpHeaders);
              proxyRes.pipe(res);
            },
            () => {
              counters.upstreamErrors++;
              dbg('upstream connection error → 502 to claude');
              if (!res.headersSent) { res.writeHead(502); res.end(); }
            },
          );
          return;
        }

        // OAuth-first mode. Two paths:
        //   - Outside burst (or probe interval elapsed): send OAuth, fall
        //     back to API key per-request on retryable error, track success
        //     to maintain the consecutive-failures counter.
        //   - Inside burst (probe interval not elapsed): skip OAuth entirely,
        //     forward straight with API key. The next probe will re-attempt
        //     OAuth and either confirm we're still over the limit (stays in
        //     burst) or recover us (exits burst).
        const oauthHeaders = buildPassthroughHeaders(req.headers);

        const tryOauth = shouldTryOauth();
        if (!tryOauth) {
          // API-burst sub-state, between probes — go straight to API key.
          counters.apiKeyDirectRequests++;
          dbg('skipping OAuth (in burst, probe interval not elapsed)');
          const headers = buildApiKeyHeaders(req.headers, apiKey);
          forward(headers, req.method, req.url, body,
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode!, proxyRes.headers as OutgoingHttpHeaders);
              proxyRes.pipe(res);
            },
            () => {
              counters.upstreamErrors++;
              dbg('upstream connection error → 502 to claude');
              if (!res.headersSent) { res.writeHead(502); res.end(); }
            },
          );
          return;
        }

        // We're attempting OAuth. Mark the timestamp so future probes are
        // paced correctly even if the request takes a while.
        lastOauthAttemptAt = now();
        counters.oauthAttempts++;

        const retryWithApiKey = (reason: string): void => {
          recordOauthFailure();
          counters.apiKeyRetries++;
          lastRetryReason = reason;
          process.stderr.write(
            `\n⚡ claude-switch: ${reason} — retrying with API key\n\n`,
          );
          dbg(`retry-with-api-key reason="${reason}"`);
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

            // HTTP 200 — peek the first N bytes to spot an SSE/JSON error
            // envelope ("extra usage credits exhausted" and friends arrive
            // this way). 16 KB is large enough that an error event after
            // a ping or message_start preamble still lands inside the
            // window, but small enough to keep streaming latency negligible.
            // Was 4 KB until v3.5 — surfaced as a fallback miss when an
            // error event followed a couple of warm-up SSE events that
            // already filled the smaller window.
            let decided = false;
            const peeked: Buffer[] = [];
            let peekedLen = 0;
            const PEEK_LIMIT = 16384;

            const flushAndPipe = (): void => {
              if (decided) return;
              decided = true;
              if (res.headersSent) return;
              // Reaching here means OAuth replied with a non-error 200 — the
              // subscription is healthy. Reset the burst state so the next
              // request goes straight at OAuth without probing logic.
              recordOauthSuccess();
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
                counters.bodySniffsTriggered++;
                dbg(`body sniff matched on 200 — head[0:256]=${JSON.stringify(head.slice(0, 256))}`);
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
      const persistStats = (): void => {
        if (!opts.persistStatsTo) return;
        try {
          fs.writeFileSync(opts.persistStatsTo, JSON.stringify({
            persistedAt: now(),
            mode,
            burstActive,
            consecutiveOauthFailures,
            counters,
            lastRetryReason,
          }, null, 2));
        } catch {
          /* best-effort — diagnostic data, not a hard requirement */
        }
      };

      resolve({
        port: addr.port,
        close: (cb) => {
          persistStats();
          server.close(cb);
        },
        state: () => ({
          mode,
          burstActive,
          consecutiveOauthFailures,
          counters: { ...counters },
          lastRetryReason,
        }),
      });
    });
  });
}
