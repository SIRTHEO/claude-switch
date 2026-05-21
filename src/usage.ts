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
import { type ProcessPort, nodeProcessAdapter } from './process.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readKeychain } from './keychain.js';
import { writeJsonAtomic } from './atomic-write.js';
import { errMessage } from './errors.js';
import { isSafeEmail } from './accounts.js';
import type { AccountSnapshot } from './account-snapshot.js';

const ENDPOINT_HOST = 'api.anthropic.com';
const ENDPOINT_PATH = '/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
// Cache TTL. Used to be 15 min when /api/oauth/usage was the only refresh
// path; lowered to 10 min once per-account caches (each account decays
// independently, no churn from A↔B switches) and header push from proxy
// (most refreshes happen for free as a side effect of regular API traffic)
// reduced endpoint pressure.
const CACHE_TTL_MS = 10 * 60 * 1000;
// How stale the cache can get before the statusline kicks off a background
// refresh. Slightly tighter than CACHE_TTL_MS so the user sees fresher
// numbers while still respecting the endpoint's rate limit. Was 10 min;
// dropped to 5 min for the same reasons as above.
const STATUSLINE_REFRESH_AFTER_MS = 5 * 60 * 1000;
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
function isUsagePayloadShaped(v: unknown): v is UsagePayload {
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
            if (isUsagePayloadShaped(parsed)) {
              resolve({ ok: true, payload: parsed });
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
 * Read the OAuth tokens (accessToken / refreshToken / expiresAt) for a
 * specific account from its saved snapshot file, without touching the
 * active-account state in `~/.claude.json` or the Keychain.
 *
 * Used by per-account usage refresh so we can hit the Anthropic usage
 * endpoint on behalf of a NON-active account — e.g. to refresh the GUI's
 * cached numbers for the second account in a multi-account setup
 * without forcing the user to switch into it first.
 *
 * Returns null if the account file doesn't exist, isn't parseable, or
 * doesn't carry an accessToken.
 */
function readAccountOauth(
  email: string,
  accountsDirPath: string,
): { accessToken: string; refreshToken?: string; expiresAt?: number | string } | null {
  if (!isSafeEmail(email)) return null;
  const accountFile = path.join(accountsDirPath, `${email}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(accountFile, 'utf-8');
  } catch {
    return null;
  }
  let parsed: AccountSnapshot;
  try {
    parsed = JSON.parse(raw) as AccountSnapshot;
  } catch {
    return null;
  }
  // Tokens live in one of three places depending on platform + snapshot
  // generation:
  //
  //   1. macOS: snapshot has `_keychain.claudeAiOauth.{accessToken,…}` —
  //      the active claude binary keeps live tokens in the Keychain, and
  //      save() copies that block into the file at snapshot time.
  //   2. Linux / Windows: snapshot has the tokens directly at the top
  //      level (claude.json's `oauthAccount` spread by save()).
  //   3. Legacy: tokens nested under an explicit `oauthAccount` object.
  //
  // Probe all three. The first one with a usable accessToken wins.
  const top = parsed;
  const nested = parsed.oauthAccount as Record<string, unknown> | undefined;
  const keychainBlock = parsed._keychain;
  const keychainOauth = keychainBlock?.claudeAiOauth;

  const accessToken =
    typeof keychainOauth?.accessToken === 'string'
      ? (keychainOauth.accessToken as string)
      : typeof top.accessToken === 'string'
        ? (top.accessToken as string)
        : typeof nested?.accessToken === 'string'
          ? (nested.accessToken as string)
          : null;
  if (!accessToken) return null;

  const refreshToken =
    typeof keychainOauth?.refreshToken === 'string'
      ? (keychainOauth.refreshToken as string)
      : typeof top.refreshToken === 'string'
        ? (top.refreshToken as string)
        : typeof nested?.refreshToken === 'string'
          ? (nested.refreshToken as string)
          : undefined;

  const expiresAtRaw =
    keychainOauth?.expiresAt ?? top.expiresAt ?? nested?.expiresAt;
  const expiresAt =
    typeof expiresAtRaw === 'number' || typeof expiresAtRaw === 'string'
      ? expiresAtRaw
      : undefined;

  return { accessToken, refreshToken, expiresAt };
}

/**
 * Persist a refreshed OAuth bundle back to the account file so the next
 * read sees the new (non-stale) tokens. Only writes the three OAuth
 * fields — the rest of the snapshot (apiKey, prefs, _keychain backup)
 * is preserved.
 */
function persistRefreshedOauth(
  email: string,
  accountsDirPath: string,
  oauth: { accessToken: string; refreshToken?: string; expiresAt: number },
): void {
  if (!isSafeEmail(email)) return;
  const accountFile = path.join(accountsDirPath, `${email}.json`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(accountFile, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }
  parsed.accessToken = oauth.accessToken;
  if (oauth.refreshToken) parsed.refreshToken = oauth.refreshToken;
  parsed.expiresAt = oauth.expiresAt;
  try {
    writeJsonAtomic(accountFile, parsed);
  } catch {
    // Persisting fresh tokens is best-effort — the in-memory token is
    // still usable for the current refresh call.
  }
}

/**
 * Refresh the cached usage snapshot for any saved account (active or
 * not). Loads that account's OAuth tokens from its snapshot file,
 * refreshes them via the Anthropic OAuth endpoint if expired, then
 * calls fetchUsage and writes the per-account cache.
 *
 * Throws when the account isn't saved or has no usable refresh token.
 * Network failures fall through and surface via the returned cache's
 * shape (no payload, no rateLimitedUntil — the caller can decide).
 */
export async function refreshUsageForAccount(
  email: string,
  accountsDirPath: string,
): Promise<UsageCache> {
  const tokens = readAccountOauth(email, accountsDirPath);
  if (!tokens) {
    throw new Error(
      `No usable OAuth tokens for ${email}. The account snapshot is missing or pre-dates the per-account refresh path.`,
    );
  }
  const { refreshIfStale } = await import('./oauth-refresh.js');
  const refreshed = await refreshIfStale({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? '',
    expiresAt: tokens.expiresAt ?? 0,
  });
  if (!refreshed) {
    throw new Error(
      `Could not refresh OAuth token for ${email}. Sign in again: claude switch ${email} then claude (browser flow).`,
    );
  }
  // If refreshIfStale actually rotated the access token, persist it.
  if (refreshed.accessToken !== tokens.accessToken) {
    persistRefreshedOauth(email, accountsDirPath, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: typeof refreshed.expiresAt === 'number'
        ? refreshed.expiresAt
        : Number(refreshed.expiresAt),
    });
  }
  return fetchUsageCached(accountsDirPath, refreshed.accessToken, {
    force: true,
    account: email,
  });
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
      const raw = JSON.parse(fs.readFileSync(claudeJsonPathStr, 'utf-8')) as Record<string, unknown>; // safe: JSON.parse returns unknown; shape validated by accessor below
      const oauth = raw?.oauthAccount as Record<string, unknown> | undefined; // safe: nested unknown field, type narrowed before use
      const t = oauth?.accessToken;
      return typeof t === 'string' && t ? t : null;
    } catch { return null; } // missing/corrupt claude.json → no token available
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

// ---------------------------------------------------------------------------
// Realtime usage push from proxy response headers
// ---------------------------------------------------------------------------
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

/**
 * Spawn a fully-detached background process that refreshes the usage cache,
 * then exits. Used by the statusline so the foreground call can return
 * immediately — Claude Code renders the line as soon as we return, and the
 * next redraw picks up the freshly-written cache.
 */
export function triggerBackgroundUsageRefresh(deps: { process?: ProcessPort } = {}): void {
  let selfPath: string;
  try {
    selfPath = fileURLToPath(import.meta.url);
  } catch {
    return;
  }
  // selfPath is .../dist/src/usage.js; the CLI entry sits at .../dist/bin/cli.js
  const cliPath = path.resolve(path.dirname(selfPath), '..', 'bin', 'cli.js');
  const proc = deps.process ?? nodeProcessAdapter;
  try {
    const child = proc.spawn(process.execPath, [cliPath, 'switch', 'usage', '--refresh-only'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}
