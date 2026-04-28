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
import { readKeychain } from './keychain.js';

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
  payload?: UsagePayload;
  // Set when the last fetch returned 429; used to back off until this time.
  rateLimitedUntil?: number;
}

function cachePath(accountsDirPath: string): string {
  return path.join(accountsDirPath, '.usage-cache.json');
}

export function readUsageCache(accountsDirPath: string): UsageCache | null {
  try {
    const raw = fs.readFileSync(cachePath(accountsDirPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { fetchedAt?: unknown }).fetchedAt === 'number') {
      return parsed as UsageCache;
    }
  } catch { /* no cache */ }
  return null;
}

function writeUsageCache(accountsDirPath: string, cache: UsageCache): void {
  try {
    const file = cachePath(accountsDirPath);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(cache));
    if (process.platform !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
    }
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
            const retryHeader = res.headers['retry-after'];
            const retryAfterSec = typeof retryHeader === 'string' ? parseInt(retryHeader, 10) || 300 : 300;
            resolve({ ok: false, rateLimited: true, retryAfterSec });
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
            resolve({ ok: false, rateLimited: false, error: `parse error: ${(e as Error).message}` });
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
 */
export async function fetchUsageCached(
  accountsDirPath: string,
  accessToken: string,
  opts: { force?: boolean } = {},
): Promise<UsageCache> {
  const cache = readUsageCache(accountsDirPath);
  const now = Date.now();

  if (!opts.force && cache) {
    if (cache.rateLimitedUntil && cache.rateLimitedUntil > now) {
      return cache;
    }
    if (cache.payload && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache;
    }
  }

  const result = await fetchUsage(accessToken);
  let next: UsageCache;
  if (result.ok) {
    next = { fetchedAt: now, payload: result.payload };
  } else if (result.rateLimited) {
    next = { fetchedAt: now, rateLimitedUntil: now + result.retryAfterSec * 1000, payload: cache?.payload };
  } else {
    // Other errors: keep the previous payload but bump fetchedAt only modestly
    // so the next call retries soon.
    next = { fetchedAt: cache?.fetchedAt ?? now, payload: cache?.payload };
  }
  writeUsageCache(accountsDirPath, next);
  return next;
}

/** Pull the OAuth access token from the macOS Keychain. Returns null on non-darwin or if missing. */
export function getAccessTokenFromKeychain(): string | null {
  const data = readKeychain();
  const token = data?.claudeAiOauth?.accessToken;
  return typeof token === 'string' && token ? token : null;
}

/**
 * Returns true if the cache is missing, missing a payload, or older than
 * STATUSLINE_REFRESH_AFTER_MS. Always false while a recorded rate-limit
 * back-off is still in effect, since refreshing into a 429 makes nothing
 * better.
 */
export function isUsageCacheStale(cache: UsageCache | null): boolean {
  if (!cache) return true;
  const now = Date.now();
  if (cache.rateLimitedUntil && cache.rateLimitedUntil > now) return false;
  if (!cache.payload) return true;
  return now - cache.fetchedAt > STATUSLINE_REFRESH_AFTER_MS;
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
