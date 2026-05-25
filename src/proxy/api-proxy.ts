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
import { parseUsageHeadersIfPresent, updateUsageCacheFromHeaders } from '../usage/usage.js';
import { writeProxyMode, clearProxyMode } from './proxy-mode.js';
import {
  buildApiKeyHeaders,
  buildPassthroughHeaders,
  isRetryableStatus,
  looksLikeErrorBody,
} from './api-proxy-headers.js';
import type {
  BurstConfig,
  ProxyHandle,
  StartFallbackProxyOptions,
} from './api-proxy-types.js';

export {
  buildApiKeyHeaders,
  buildPassthroughHeaders,
  isRetryableStatus,
  looksLikeErrorBody,
  stripOauthBeta,
} from './api-proxy-headers.js';

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_BURST_FAILURE_THRESHOLD = 3;
const DEFAULT_BURST_PROBE_INTERVAL_MS = 5 * 60 * 1000;

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
    rejectedAuth: 0,          // request blocked by Host/Origin auth check
  };

  // Populated in the listen callback once the OS-assigned port is known.
  // The set covers the literal Host headers a legitimate caller can send;
  // anything else (e.g. a DNS-rebinding browser using `Host: evil.com`) is
  // rejected before the body is read. See the auth check at the top of the
  // request handler below.
  let allowedHostHeaders: Set<string> = new Set();
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
      // Runtime mode marker for the statusline. Only emit on
      // state transitions; individual OAuth failures before the threshold
      // don't move the marker.
      if (opts.accountsDirPath) {
        writeProxyMode(opts.accountsDirPath, 'oauth-burst',
          `${consecutiveOauthFailures} consecutive OAuth failures`);
      }
    }
  };

  const recordOauthSuccess = (): void => {
    const wasInBurst = burstActive;
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
    // Flip back to oauth-first only when we were actually in burst.
    // Plain successes don't change the persisted mode.
    if (wasInBurst && opts.accountsDirPath) {
      writeProxyMode(opts.accountsDirPath, 'oauth-first',
        'OAuth probe succeeded — burst exited');
    }
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

  // Realtime usage update from upstream response headers.
  // Only fires when the caller wired both accountsDirPath + account at
  // proxy startup. Best-effort: parse failures, missing headers, and
  // cache write errors are all swallowed inside updateUsageCacheFromHeaders.
  const recordUsageFromResponse = (proxyRes: http.IncomingMessage): void => {
    if (!opts.accountsDirPath || !opts.account) return;
    const status = proxyRes.statusCode ?? 0;
    if (status < 200 || status >= 300) return;
    const parsed = parseUsageHeadersIfPresent(proxyRes.headers);
    if (!parsed) return;
    updateUsageCacheFromHeaders(
      opts.accountsDirPath,
      opts.account,
      parsed.fiveHourPct,
      parsed.sevenDayPct,
    );
  };

  function forward(
    headers: IncomingHttpHeaders,
    method: string | undefined,
    path: string | undefined,
    body: Buffer,
    onResponse: (res: http.IncomingMessage) => void,
    onError: () => void,
  ): void {
    const req = (requester as typeof https).request( // safe: requester is either http or https; both expose .request with the same signature
      {
        hostname: upstream.hostname,
        port: upstreamPort,
        path: path ?? '/',
        method: method ?? 'GET',
        headers: headers as OutgoingHttpHeaders, // safe: IncomingHttpHeaders ↔ OutgoingHttpHeaders are structurally compatible; Node typings keep them separate
      },
      onResponse,
    );
    req.on('error', onError);
    req.end(body);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Auth gate — runs BEFORE we touch the body. Closes two specific
      // exposures of a loopback HTTP server that forwards the user's API
      // key upstream:
      //   1. Cross-origin browser fetches (incl. DNS rebinding where a
      //      malicious site resolves its domain to 127.0.0.1). Browsers
      //      always send Origin on cross-origin requests; the claude CLI
      //      doesn't send Origin at all. So an Origin header at all is a
      //      reliable "this came from a browser" signal.
      //   2. Host-header mismatches (the other half of the DNS-rebinding
      //      defence — even when CORS is bypassed via no-cors mode, the
      //      browser still sends the original site's hostname in Host).
      // Same-user local processes mimicking the claude CLI exactly can
      // still pass these checks; that residual is documented in SECURITY.md.
      const reqOrigin = req.headers['origin'];
      const reqHost = req.headers['host'];
      const authOk =
        reqOrigin === undefined &&
        typeof reqHost === 'string' &&
        allowedHostHeaders.has(reqHost);
      if (!authOk) {
        counters.rejectedAuth++;
        dbg(`auth-reject: host=${String(reqHost)} origin=${String(reqOrigin)}`);
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'forbidden',
            message: 'claude-switch proxy: request rejected (unexpected Host or Origin header)',
          },
        }));
        // Drain the request to keep the connection healthy for any
        // follow-up retry from a legitimate client.
        req.resume();
        return;
      }

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

        // Shared api-key fast-path callbacks (api-first + burst probe bypass).
        const onApiKeyResponse = (proxyRes: http.IncomingMessage): void => {
          recordUsageFromResponse(proxyRes);
          res.writeHead(proxyRes.statusCode!, proxyRes.headers as OutgoingHttpHeaders); // safe: passthrough headers, Node keeps IncomingHttpHeaders ↔ OutgoingHttpHeaders separate but they're structurally the same for forward proxying
          proxyRes.pipe(res);
        };
        const onUpstreamError = (): void => {
          counters.upstreamErrors++;
          dbg('upstream connection error → 502 to claude');
          if (!res.headersSent) { res.writeHead(502); res.end(); }
        };

        // Pure API-first mode: never attempt OAuth, never probe.
        if (mode === 'api-first') {
          counters.apiKeyDirectRequests++;
          const headers = buildApiKeyHeaders(req.headers, apiKey);
          forward(headers, req.method, req.url, body, onApiKeyResponse, onUpstreamError);
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
          forward(headers, req.method, req.url, body, onApiKeyResponse, onUpstreamError);
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
              recordUsageFromResponse(retryRes);
              res.writeHead(retryRes.statusCode!, retryRes.headers as OutgoingHttpHeaders); // safe: passthrough headers, structurally identical for forward proxying
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
              recordUsageFromResponse(proxyRes);
              res.writeHead(proxyRes.statusCode!, proxyRes.headers as OutgoingHttpHeaders); // safe: passthrough headers, structurally identical for forward proxying
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
      const addr = server.address() as AddressInfo; // safe: server is bound to a TCP address, never a pipe, so address() is always AddressInfo here
      // Build the allow-list of Host headers a legitimate client may send.
      // claude is configured with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
      // so it will always send `127.0.0.1:<port>`. `localhost:<port>` is
      // accepted too because some HTTP clients normalise loopback to it; a
      // browser doing DNS rebinding would send the attacker's domain
      // instead, which we drop.
      allowedHostHeaders = new Set([`127.0.0.1:${addr.port}`, `localhost:${addr.port}`]);
      // Emit initial runtime mode marker. `oauth-burst` is only entered
      // after threshold failures, never at startup; we always boot in
      // either `oauth-first` or `api-first`.
      if (opts.accountsDirPath) {
        const initialMode = mode === 'api-first' ? 'api-first' : 'oauth-first';
        writeProxyMode(opts.accountsDirPath, initialMode, `proxy started in ${mode} mode`);
      }
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
          // Clear the runtime mode marker on clean shutdown so the next
          // statusline read falls back to the persistent flag instead of
          // sticky-displaying a stale mode.
          if (opts.accountsDirPath) clearProxyMode(opts.accountsDirPath);
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
