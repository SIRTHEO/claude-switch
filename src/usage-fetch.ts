// src/usage-fetch.ts
// Network access to Anthropic's OAuth usage endpoint, plus the cache-aware
// wrapper. The endpoint is aggressively rate-limited (anthropics/claude-code
// #31021, #31637) — fetchUsageCached honours TTL + retry-after back-off.

import { type HttpPort, fetchHttpAdapter, hasGlobalFetch, readBodyCapped } from './http.js';
import { errMessage } from './errors.js';
import {
  type UsageCache,
  type UsagePayload,
  isUsagePayloadShaped,
  parseRetryAfter,
  readUsageCache,
  readUsageCacheForAccount,
  writeUsageCache,
} from './usage-cache.js';

const ENDPOINT_HOST = 'api.anthropic.com';
const ENDPOINT_PATH = '/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
// Cache TTL. Used to be 15 min when /api/oauth/usage was the only refresh
// path; lowered to 10 min once per-account caches (each account decays
// independently, no churn from A↔B switches) and header push from proxy
// (most refreshes happen for free as a side effect of regular API traffic)
// reduced endpoint pressure.
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 16 * 1024;

interface FetchResult {
  ok: true;
  payload: UsagePayload;
}
interface FetchRateLimited {
  ok: false;
  rateLimited: true;
  retryAfterSec: number;
}
interface FetchError {
  ok: false;
  rateLimited: false;
  error: string;
}
type FetchUsageOutcome = FetchResult | FetchRateLimited | FetchError;

/**
 * Fetch the subscription usage directly. Caller is responsible for caching —
 * see fetchUsageCached() for the cache-aware version. The HTTP call goes
 * through an injected `HttpPort` (defaults to the global fetch); tests inject
 * a fake via `deps.http`.
 */
export async function fetchUsage(
  accessToken: string,
  deps: { http?: HttpPort } = {},
): Promise<FetchUsageOutcome> {
  if (!deps.http && !hasGlobalFetch()) {
    return { ok: false, rateLimited: false, error: 'no fetch available' };
  }
  const http = deps.http ?? fetchHttpAdapter;

  let res: Response;
  try {
    res = await http(`https://${ENDPOINT_HOST}${ENDPOINT_PATH}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': BETA_HEADER,
        accept: 'application/json',
        'user-agent': 'claude-switch',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, rateLimited: false, error: 'timeout' };
    }
    return { ok: false, rateLimited: false, error: errMessage(e) };
  }

  if (res.status === 429) {
    return { ok: false, rateLimited: true, retryAfterSec: parseRetryAfter(res.headers.get('retry-after') ?? undefined) };
  }
  if (res.status !== 200) {
    return { ok: false, rateLimited: false, error: `HTTP ${res.status}` };
  }

  let read: { text: string; tooLarge: boolean };
  try {
    read = await readBodyCapped(res, MAX_BODY_BYTES);
  } catch (e) {
    return { ok: false, rateLimited: false, error: `read error: ${errMessage(e)}` };
  }
  if (read.tooLarge) {
    return { ok: false, rateLimited: false, error: 'response too large' };
  }

  try {
    const parsed: unknown = JSON.parse(read.text);
    if (isUsagePayloadShaped(parsed)) {
      return { ok: true, payload: parsed };
    }
    const preview = read.text.slice(0, 300).replace(/[\r\n]+/g, ' ');
    return { ok: false, rateLimited: false, error: `unexpected response shape: ${preview}` };
  } catch (e) {
    return { ok: false, rateLimited: false, error: `parse error: ${errMessage(e)}` };
  }
}

/**
 * Cache-aware variant. Returns the cached payload if fresh, otherwise fetches.
 * Honors any retry-after still in effect from a previous 429.
 *
 * `account` is the email associated with the access token, recorded in the
 * cache so consumers can tell whether the snapshot still belongs to the
 * currently-active account (different accounts = independent quotas).
 */
export async function fetchUsageCached(
  accountsDirPath: string,
  accessToken: string,
  opts: { force?: boolean; account?: string } = {},
): Promise<UsageCache> {
  const cache = opts.account
    ? readUsageCacheForAccount(accountsDirPath, opts.account)
    : readUsageCache(accountsDirPath);
  const now = Date.now();
  // A cache without `account` is from a pre-account-aware version. We can't
  // tell which account it belonged to, so treat it as a different account
  // when the caller has specified one — refetching is the safe default.
  const sameAccount = !opts.account
    ? true
    : !!cache?.account && cache.account === opts.account;

  // Rate-limit back-off is a hard barrier the caller can't override —
  // hammering the endpoint inside a 429 window only extends the back-off
  // (Anthropic resets retry-after on every hit). force=true lets the user
  // skip the TTL freshness check, not the rate-limit honour.
  if (cache?.rateLimitedUntil && cache.rateLimitedUntil > now && sameAccount) {
    return cache;
  }
  if (!opts.force && cache && sameAccount) {
    if (cache.payload && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache;
    }
  }

  const result = await fetchUsage(accessToken);
  let next: UsageCache;
  if (result.ok) {
    next = { fetchedAt: now, account: opts.account, payload: result.payload };
  } else if (result.rateLimited) {
    next = {
      fetchedAt: now,
      account: opts.account,
      rateLimitedUntil: now + result.retryAfterSec * 1000,
      payload: sameAccount ? cache?.payload : undefined,
    };
  } else {
    // Other errors: keep the previous payload only if it belonged to the
    // same account; otherwise drop it so we don't display stale cross-
    // account numbers.
    next = {
      fetchedAt: sameAccount ? (cache?.fetchedAt ?? now) : now,
      account: opts.account,
      payload: sameAccount ? cache?.payload : undefined,
    };
  }
  writeUsageCache(accountsDirPath, next);
  return next;
}
