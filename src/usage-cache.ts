// src/usage-cache.ts
// The per-account usage-cache layer: types, cache-file paths, shape guards,
// read/write, and staleness predicates. No network — the foundation the
// fetch / header-push / account-refresh modules build on.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from './atomic-write.js';

// How stale the cache can get before the statusline kicks off a background
// refresh. Slightly tighter than CACHE_TTL_MS so the user sees fresher
// numbers while still respecting the endpoint's rate limit. Was 10 min;
// dropped to 5 min for the same reasons as above.
const STATUSLINE_REFRESH_AFTER_MS = 5 * 60 * 1000;

interface UsageWindow {
  utilization: number;
  resets_at?: string; // ISO 8601 timestamp
}

export interface UsagePayload {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
}

export interface UsageCache {
  fetchedAt: number;
  /** Email of the account whose token produced this snapshot. Different
   *  accounts have completely independent quotas, so a cache from account
   *  A must never be displayed while account B is active. */
  account?: string;
  payload?: UsagePayload;
  // Set when the last fetch returned 429; used to back off until this time.
  rateLimitedUntil?: number;
}

/**
 * Legacy global cache path. Kept readable for one release cycle so users
 * upgrading from pre-13.2 don't lose their last cached values during the
 * first post-upgrade switch. New writes always go through `cachePathFor`.
 */
function cachePathLegacy(accountsDirPath: string): string {
  return path.join(accountsDirPath, '.usage-cache.json');
}

/**
 * Per-account cache path. Email is hashed (sha256[:16] = 64 bits, ~4B
 * birthday bound) so the filename is never user-controlled — the email
 * itself isn't safe to interpolate into a path (`..`, `/`, OS reserved
 * chars). Different accounts get independent files, so switching A→B→A
 * doesn't churn a single shared file and force re-fetches.
 */
function cachePathFor(accountsDirPath: string, email: string): string {
  const hash = createHash('sha256').update(email).digest('hex').slice(0, 16);
  return path.join(accountsDirPath, `.usage-cache.${hash}.json`);
}

/**
 * Parse the Retry-After header value into seconds. Defaults to 300s only when
 * the header is missing/unparseable — `Retry-After: 0` is valid (retry now).
 */
export function parseRetryAfter(header: string | string[] | undefined): number {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return 300;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300;
}

/**
 * Minimal structural check for a stored usage cache object.
 * Only validates the required `fetchedAt` discriminant — optional fields
 * (payload, rateLimitedUntil, account) are checked lazily by callers.
 */
function isUsageCacheShaped(v: unknown): v is UsageCache {
  if (typeof v !== 'object' || v === null) return false;
  return typeof (v as { fetchedAt?: unknown }).fetchedAt === 'number'; // safe: structural probe on unknown object; TS cannot narrow arbitrary field names without an intermediate cast
}

/** Type predicate for `UsageWindow` — checks the `utilization: number` discriminant. */
function isUsageWindow(v: unknown): v is UsageWindow {
  if (typeof v !== 'object' || v === null) return false;
  return typeof (v as { utilization?: unknown }).utilization === 'number'; // safe: structural probe on unknown object
}

/** Type predicate for `UsagePayload` — validates both mandatory window fields. */
export function isUsagePayloadShaped(v: unknown): v is UsagePayload {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>; // safe: narrowed to object above; cast needed to index by string field name
  return isUsageWindow(obj.five_hour) && isUsageWindow(obj.seven_day);
}

/**
 * Read the legacy global cache file. Kept for back-compat — new callers
 * should prefer `readUsageCacheForAccount(dir, email)` which checks the
 * per-account file first.
 */
export function readUsageCache(accountsDirPath: string): UsageCache | null {
  try {
    const raw = fs.readFileSync(cachePathLegacy(accountsDirPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isUsageCacheShaped(parsed)) {
      return parsed;
    }
  } catch { /* no cache */ }
  return null;
}

/**
 * Read the per-account cache for the given email. Falls back to the
 * legacy global cache ONLY when (a) the per-account file doesn't exist
 * AND (b) the legacy file's `account` field matches the requested
 * email — preserves cached numbers across the v3.7 upgrade without
 * leaking another account's cache.
 */
export function readUsageCacheForAccount(
  accountsDirPath: string,
  email: string,
): UsageCache | null {
  try {
    const raw = fs.readFileSync(cachePathFor(accountsDirPath, email), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isUsageCacheShaped(parsed)) {
      return parsed;
    }
  } catch { /* per-account miss → try legacy */ }
  try {
    const raw = fs.readFileSync(cachePathLegacy(accountsDirPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isUsageCacheShaped(parsed) && parsed.account === email) {
      return parsed;
    }
  } catch { /* legacy miss too */ }
  return null;
}

export function writeUsageCache(accountsDirPath: string, cache: UsageCache): void {
  try {
    // Write to the per-account path when account is set (the normal case
    // since the cache shape gained `account` in pre-3.x). Fall back to
    // the legacy path only when account is unknown — defensive; current
    // call sites always set `cache.account`.
    const file = cache.account
      ? cachePathFor(accountsDirPath, cache.account)
      : cachePathLegacy(accountsDirPath);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // indent=0 keeps the cache compact (writes happen on every fetch).
    writeJsonAtomic(file, cache, 0);
  } catch { /* best-effort */ }
}

/**
 * Returns true if the cache is missing, missing a payload, older than
 * STATUSLINE_REFRESH_AFTER_MS, or belongs to a different account than the
 * one currently active. Always false while a recorded rate-limit back-off
 * is still in effect, since refreshing into a 429 makes nothing better.
 */
export function isUsageCacheStale(cache: UsageCache | null, currentAccount?: string): boolean {
  if (!cache) return true;
  const now = Date.now();
  if (cache.rateLimitedUntil && cache.rateLimitedUntil > now) return false;
  if (!cache.payload) return true;
  if (currentAccount && cache.account && cache.account !== currentAccount) return true;
  return now - cache.fetchedAt > STATUSLINE_REFRESH_AFTER_MS;
}

/**
 * Returns the cache only if it belongs to the given account. Used by display
 * code (statusline, status) to avoid showing numbers from a different
 * account's quota.
 */
export function readUsageCacheFor(
  accountsDirPath: string,
  account: string,
): UsageCache | null {
  // Path-keyed by account hash; legacy fallback covered inside the helper.
  // The defensive account-match below catches the (rare) case where a
  // legacy file happens to have a matching account field but came from
  // a buggy older write — we never display the wrong account's quota.
  const cache = readUsageCacheForAccount(accountsDirPath, account);
  if (!cache) return null;
  if (!cache.account) return null;
  if (cache.account !== account) return null;
  return cache;
}

/**
 * Decision helper for the "pre-fetch on switch" path: returns
 * true when the target account's cache is missing or stale, false when it
 * is fresh enough that an immediate refresh would be wasted. Kept as a
 * pure predicate so switcher.ts can call it without pulling in the
 * spawn/IO side effects.
 */
export function shouldTriggerUsageRefreshAfterSwitch(
  accountsDirPath: string,
  email: string,
): boolean {
  return isUsageCacheStale(readUsageCacheForAccount(accountsDirPath, email), email);
}
