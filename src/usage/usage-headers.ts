// src/usage-headers.ts
// Realtime usage push from proxy response headers.
//
// The api-proxy intercepts every Claude API response when fallback is in
// path. Anthropic includes per-account usage signals as response headers;
// we parse them and update the per-account cache without a separate
// network call to /api/oauth/usage (which is aggressively rate-limited).
//
// Header names: the canonical names are not fully documented and may
// evolve. We probe a small list of candidates so the parser keeps working
// if Anthropic renames; spotted-in-the-wild names go at the top. When
// none match, the parser returns null and the proxy treats the response
// as a no-op for usage tracking — fail-open semantics, never crashes a
// user request because we can't extract a sidecar metric.
//
// To verify the actual header names in production: `curl -v` a
// /v1/messages request with a Pro/Max OAuth token and inspect response
// headers. If a header name we don't list here appears, append it to the
// candidate lists below — no other code changes needed.

import { type UsageCache, readUsageCacheForAccount, writeUsageCache } from './usage-cache.js';

const FIVE_HOUR_HEADER_CANDIDATES = [
  'anthropic-ratelimit-five-hour-percent-used',
  'anthropic-priority-five-hour-percent-used',
];
const SEVEN_DAY_HEADER_CANDIDATES = [
  'anthropic-ratelimit-seven-day-percent-used',
  'anthropic-priority-seven-day-percent-used',
];

function parsePercent(raw: string | string[] | undefined): number | undefined {
  if (raw == null) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().replace(/%$/, '');
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return undefined;
  if (num < 0 || num > 100) return undefined;
  return num;
}

/**
 * Extract 5h / 7d percent-used from a response headers object. Returns
 * null when neither header is present so callers can early-return without
 * touching the cache. Header lookup is case-insensitive against the
 * candidate names listed above.
 */
export function parseUsageHeadersIfPresent(
  headers: Record<string, string | string[] | undefined>,
): { fiveHourPct?: number; sevenDayPct?: number } | null {
  // Node lowercases incoming header names, but be defensive: also try the
  // raw casing in case a caller hands us a non-Node headers map (tests,
  // hand-built fixtures).
  const lookup = (candidates: readonly string[]): number | undefined => {
    for (const name of candidates) {
      const v = headers[name] ?? headers[name.toLowerCase()];
      const parsed = parsePercent(v);
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  };
  const fiveHourPct = lookup(FIVE_HOUR_HEADER_CANDIDATES);
  const sevenDayPct = lookup(SEVEN_DAY_HEADER_CANDIDATES);
  if (fiveHourPct === undefined && sevenDayPct === undefined) return null;
  return { fiveHourPct, sevenDayPct };
}

/**
 * Merge a partial usage observation (5h and/or 7d) into the per-account
 * cache. Preserves any window the caller didn't observe — e.g. if only
 * the 5h header was in the response, the 7d value from the prior cache
 * survives. `resets_at` is intentionally not synthesised here; we only
 * have it from the /api/oauth/usage endpoint body, never from headers.
 *
 * No-op when both inputs are undefined. Best-effort write; failures are
 * swallowed (same policy as writeUsageCache — usage telemetry must never
 * cascade into a request error).
 */
export function updateUsageCacheFromHeaders(
  accountsDirPath: string,
  email: string,
  fiveHourPct: number | undefined,
  sevenDayPct: number | undefined,
): void {
  if (fiveHourPct === undefined && sevenDayPct === undefined) return;
  if (!email) return;
  const existing = readUsageCacheForAccount(accountsDirPath, email);
  const now = Date.now();
  const priorFive = existing?.payload?.five_hour;
  const priorSeven = existing?.payload?.seven_day;
  const next: UsageCache = {
    fetchedAt: now,
    account: email,
    payload: {
      five_hour: fiveHourPct !== undefined
        ? { utilization: fiveHourPct }
        : (priorFive ?? { utilization: 0 }),
      seven_day: sevenDayPct !== undefined
        ? { utilization: sevenDayPct }
        : (priorSeven ?? { utilization: 0 }),
    },
  };
  // Preserve rateLimitedUntil from the prior cache — header-derived
  // observations don't override an active 429 back-off (which lives on
  // a separate dimension: request rate, not subscription quota).
  if (existing?.rateLimitedUntil) next.rateLimitedUntil = existing.rateLimitedUntil;
  writeUsageCache(accountsDirPath, next);
}
