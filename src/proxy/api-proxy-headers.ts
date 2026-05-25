// src/api-proxy-headers.ts
// Pure header/body helpers for the fallback proxy: retry classification,
// error-body sniffing, and the OAuth→API-key header rewrites. No I/O, no
// state — heavily unit-tested (see test/api-proxy*.test.ts).

import type { IncomingHttpHeaders } from 'node:http';

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
