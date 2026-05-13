// src/usage.ts
// Read subscription usage from Anthropic's OAuth usage endpoint.
//
// Endpoint:    GET https://api.anthropic.com/api/oauth/usage
// Auth:        Bearer <accessToken from claudeAiOauth in Keychain>
// Beta header: anthropic-beta: oauth-2025-04-20
// Response:    { "five_hour": <pct>, "seven_day": <pct> }
//
// IMPORTANT: this endpoint is aggressively rate-limited by Anthropic itself
// (see anthropics/claude-code#31021, #31637). Retries within seconds of a
// 429 keep returning 429 indefinitely. We cache responses for 15 minutes by
// default and skip fetching while the cache is fresh.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readKeychain } from './keychain.js';
import { writeJsonAtomic } from './atomic-write.js';
import { errMessage } from './errors.js';

const ENDPOINT_HOST = 'api.anthropic.com';
const ENDPOINT_PATH = '/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — endpoint is aggressively throttled
// How stale the cache can get before the statusline kicks off a background
// refresh. Slightly tighter than CACHE_TTL_MS so the user sees fresher numbers
// while still respecting the endpoint's rate limit.
const STATUSLINE_REFRESH_AFTER_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 16 * 1024;

export interface UsageWindow {
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
 * Read the legacy global cache file. Kept for back-compat — new callers
 * should prefer `readUsageCacheForAccount(dir, email)` which checks the
 * per-account file first.
 */
export function readUsageCache(accountsDirPath: string): UsageCache | null {
  try {
    const raw = fs.readFileSync(cachePathLegacy(accountsDirPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { fetchedAt?: unknown }).fetchedAt === 'number') {
      return parsed as UsageCache;
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
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { fetchedAt?: unknown }).fetchedAt === 'number') {
      return parsed as UsageCache;
    }
  } catch { /* per-account miss → try legacy */ }
  try {
    const raw = fs.readFileSync(cachePathLegacy(accountsDirPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof (parsed as { fetchedAt?: unknown }).fetchedAt === 'number'
      && (parsed as { account?: unknown }).account === email
    ) {
      return parsed as UsageCache;
    }
  } catch { /* legacy miss too */ }
  return null;
}

function writeUsageCache(accountsDirPath: string, cache: UsageCache): void {
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
export type FetchUsageOutcome = FetchResult | FetchRateLimited | FetchError;

/**
 * Fetch the subscription usage directly. Caller is responsible for caching —
 * see fetchUsageCached() for the cache-aware version.
 */
export function fetchUsage(accessToken: string): Promise<FetchUsageOutcome> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: ENDPOINT_HOST,
        path: ENDPOINT_PATH,
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'anthropic-beta': BETA_HEADER,
          accept: 'application/json',
          'user-agent': 'claude-switch',
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        let aborted = false;
        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          body += chunk.toString();
          if (body.length > MAX_BODY_BYTES) {
            aborted = true;
            res.destroy();
          }
        });
        res.on('end', () => {
          if (res.statusCode === 429) {
            resolve({ ok: false, rateLimited: true, retryAfterSec: parseRetryAfter(res.headers['retry-after']) });
            return;
          }
          if (res.statusCode !== 200) {
            resolve({ ok: false, rateLimited: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          try {
            const parsed: unknown = JSON.parse(body);
            const isWindow = (v: unknown): v is UsageWindow =>
              typeof v === 'object' && v !== null &&
              typeof (v as Record<string, unknown>).utilization === 'number';
            if (
              typeof parsed === 'object' && parsed !== null &&
              isWindow((parsed as Record<string, unknown>).five_hour) &&
              isWindow((parsed as Record<string, unknown>).seven_day)
            ) {
              resolve({ ok: true, payload: parsed as UsagePayload });
            } else {
              const preview = body.slice(0, 300).replace(/[\r\n]+/g, ' ');
              resolve({ ok: false, rateLimited: false, error: `unexpected response shape: ${preview}` });
            }
          } catch (e) {
            resolve({ ok: false, rateLimited: false, error: `parse error: ${errMessage(e)}` });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ ok: false, rateLimited: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, rateLimited: false, error: 'timeout' }); });
    req.end();
  });
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

/**
 * Pull the OAuth access token. On macOS this comes from the login Keychain;
 * on Linux/Windows it lives in `~/.claude.json` under `oauthAccount.accessToken`
 * (Claude Code does not use a system credential store there).
 */
export function getAccessTokenFromKeychain(claudeJsonPathStr?: string): string | null {
  const data = readKeychain();
  const token = data?.claudeAiOauth?.accessToken;
  if (typeof token === 'string' && token) return token;

  if (process.platform !== 'darwin' && claudeJsonPathStr) {
    try {
      const raw = JSON.parse(fs.readFileSync(claudeJsonPathStr, 'utf-8')) as Record<string, unknown>;
      const oauth = raw?.oauthAccount as Record<string, unknown> | undefined;
      const t = oauth?.accessToken;
      return typeof t === 'string' && t ? t : null;
    } catch { return null; }
  }
  return null;
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
 * Decision helper for the "pre-fetch on switch" path (Phase 13.3): returns
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

/**
 * Spawn a fully-detached background process that refreshes the usage cache,
 * then exits. Used by the statusline so the foreground call can return
 * immediately — Claude Code renders the line as soon as we return, and the
 * next redraw picks up the freshly-written cache.
 */
export function triggerBackgroundUsageRefresh(): void {
  let selfPath: string;
  try {
    selfPath = fileURLToPath(import.meta.url);
  } catch {
    return;
  }
  // selfPath is .../dist/src/usage.js; the CLI entry sits at .../dist/bin/cli.js
  const cliPath = path.resolve(path.dirname(selfPath), '..', 'bin', 'cli.js');
  try {
    const child = spawn(process.execPath, [cliPath, 'switch', 'usage', '--refresh-only'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}
