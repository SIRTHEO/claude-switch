// src/update-check.ts
// Update checking and self-update logic.
//
// Strategy for background notification:
//   1. On every non-passthrough invocation, read the cached check result (sync, fast).
//   2. If the cache is stale (> CHECK_INTERVAL_MS), kick off an async background
//      HTTP request — unref'd so it never blocks process exit.
//   3. The caller decides whether to prompt or just notify based on TTY state.
//
// Strategy for `claude switch update` (explicit command):
//   Fetch the latest version synchronously, compare, and run the install if confirmed.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import { PACKAGE_NAME, detectInstallCommand, type UpdateInfo } from './update-notice.js';

// Re-export the user-facing notice/install helpers (split into update-notice.ts
// to stay under the file-size gate) so existing importers keep using
// `./update-check.js` unchanged.
export { detectInstallCommand, performUpdate, formatUpdateNotice, type UpdateInfo } from './update-notice.js';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
// Lightweight dist-tags endpoint (~20 bytes vs ~2 KB for /latest). Returns
// `{ "latest": "x.y.z", "minsafe"?: "x.y.z" }`. The `minsafe` tag is published
// by the release pipeline on a security/data-loss release: any version BELOW
// it carries a known-unsafe bug, so the client escalates the update notice
// from a quiet hint to a critical banner. Absent tag → no escalation.
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
const MIN_SAFE_TAG = 'minsafe';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

interface CheckCache {
  checkedAt: number;
  latestVersion: string;
  /** The `minsafe` dist-tag, when published. Absent on caches written before
   *  the critical channel existed, and whenever the tag isn't set. */
  minSafeVersion?: string;
}

function cacheFilePath(): string {
  return path.join(os.homedir(), '.claude', 'accounts', '.update-check.json');
}

/** Extract a string `version` field from an unknown JSON value without a cast. */
function extractVersion(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const ver = (v as { version?: unknown }).version; // safe: structural probe on unknown object; TS cannot narrow arbitrary field names without an intermediate cast
  return typeof ver === 'string' ? ver : undefined;
}

function isCheckCacheShaped(v: unknown): v is CheckCache {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as { checkedAt?: unknown }).checkedAt === 'number' && // safe: structural probe on unknown object
    typeof (v as { latestVersion?: unknown }).latestVersion === 'string' // safe: structural probe on unknown object
  );
}

function readCache(): CheckCache | null {
  try {
    const raw = fs.readFileSync(cacheFilePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isCheckCacheShaped(parsed)) {
      return parsed;
    }
  } catch { /* no cache yet */ }
  return null;
}

export function writeUpdateCache(latestVersion: string): void {
  writeCache({ checkedAt: Date.now(), latestVersion });
}

function writeCache(cache: CheckCache): void {
  try {
    const filePath = cacheFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeJsonAtomic(filePath, cache, 0);
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Returns true if `latest` is strictly newer than `current`.
 *
 * We never propose pre-release versions (`x.y.z-rc.1`, `x.y.z-beta`) as updates
 * — users running stable should not be auto-bumped to a pre-release.
 */
export function isNewer(current: string, latest: string): boolean {
  const stripped = (v: string): string => v.replace(/^v/, '').split('-')[0] ?? '';
  const isPreRelease = (v: string): boolean => v.replace(/^v/, '').includes('-');
  if (isPreRelease(latest)) return false;
  const parse = (v: string): number[] =>
    stripped(v).split('.').map(n => parseInt(n, 10) || 0);
  // Default each component to 0 so `2.3` compares as `2.3.0`.
  const [ca = 0, cb = 0, cc = 0] = parse(current);
  const [la = 0, lb = 0, lc = 0] = parse(latest);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  if (lc !== cc) return lc > cc;
  // Same base version — but per semver, a pre-release is "less than" its
  // matching stable release (1.0.0-rc.1 < 1.0.0), so users on rc.1 should
  // be notified when the stable lands.
  return isPreRelease(current) && !isPreRelease(latest);
}

/** True when `v` is a string shaped like a semver version (optional `v`
 *  prefix, optional pre-release). Sanitizer for registry-fetched dist-tags:
 *  only version-like strings are ever written to the cache, so a
 *  compromised/MITM registry can't persist arbitrary content. */
function isVersionLike(v: unknown): v is string {
  return typeof v === 'string' && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);
}

// ---------------------------------------------------------------------------
// Registry fetch — background (unref'd)
// ---------------------------------------------------------------------------

function fetchLatestVersionBackground(): void {
  const req = https.get(DIST_TAGS_URL, { timeout: 5000 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return; }
    let body = '';
    let aborted = false;
    res.on('data', (chunk: Buffer) => {
      if (aborted) return;
      body += chunk.toString();
      // Cap response size — the dist-tags doc is a handful of bytes, anything
      // more is suspect (compromised registry or MITM). 64 KB is generous.
      if (body.length > 64 * 1024) {
        aborted = true;
        res.destroy();
      }
    });
    res.on('end', () => {
      try {
        // dist-tags shape: { "latest": "x.y.z", "minsafe"?: "x.y.z" }.
        const parsed: unknown = JSON.parse(body);
        const tags = (typeof parsed === 'object' && parsed !== null)
          ? (parsed as Record<string, unknown>)
          : {};
        // Validate the shape before persisting: only ever cache strings that
        // look like a semver version. A compromised/MITM registry must not be
        // able to write arbitrary content into our cache file, and downstream
        // version comparison only makes sense on version-like values.
        const latest = tags['latest'];
        if (!isVersionLike(latest)) return;
        const minSafe = tags[MIN_SAFE_TAG];
        writeCache({
          checkedAt: Date.now(),
          latestVersion: latest,
          ...(isVersionLike(minSafe) ? { minSafeVersion: minSafe } : {}),
        });
      } catch { /* ignore */ }
    });
  });
  req.on('error', () => { /* ignore */ });
  req.on('timeout', () => { req.destroy(); });
  req.socket?.unref();
  req.on('socket', (socket) => { socket.unref(); });
}

// ---------------------------------------------------------------------------
// Registry fetch — foreground (blocking Promise, for explicit update command)
// ---------------------------------------------------------------------------

export function fetchLatestVersionSync(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(REGISTRY_URL, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 64 * 1024) { res.destroy(); resolve(null); }
      });
      res.on('end', () => {
        try {
          resolve(extractVersion(JSON.parse(body)) ?? null);
        } catch { resolve(null); } // malformed registry response → no update info
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ---------------------------------------------------------------------------
// Startup check (called on every non-passthrough invocation)
// ---------------------------------------------------------------------------

/**
 * Call once at CLI startup.
 * - Returns UpdateInfo if a newer version is cached, otherwise null.
 * - Kicks off a background registry check if the cache is stale.
 */
/**
 * Opt out of the update check entirely. Honoured for:
 *   - CLAUDE_SWITCH_NO_UPDATE_CHECK=1 — explicit user/dev opt-out (e.g. a
 *     local `npm link` build whose version is intentionally behind npm).
 *   - CI=true — the de-facto CI marker; nagging or hitting the registry in a
 *     pipeline is noise, and a managed/pinned install can't act on it anyway.
 * Returning early also skips the background registry fetch, so opting out is a
 * true no-op (no network, no banner).
 */
function updateCheckDisabled(): boolean {
  return process.env.CLAUDE_SWITCH_NO_UPDATE_CHECK === '1' || process.env.CI === 'true';
}

export function checkForUpdate(currentVersion: string): UpdateInfo | null {
  if (updateCheckDisabled()) return null;
  const cache = readCache();
  const now = Date.now();

  if (!cache || now - cache.checkedAt > CHECK_INTERVAL_MS) {
    setImmediate(fetchLatestVersionBackground).unref();
  }

  if (cache && isNewer(currentVersion, cache.latestVersion)) {
    const [cmd, ...args] = detectInstallCommand();
    // Critical when the installed version is below the published minsafe tag.
    // Reuses isNewer (minSafe newer than current ⇒ current is below minSafe).
    // Fail-open: no tag in cache ⇒ not critical, routine hint only.
    const critical = typeof cache.minSafeVersion === 'string'
      && isNewer(currentVersion, cache.minSafeVersion);
    return {
      latestVersion: cache.latestVersion,
      installCommand: [cmd, ...args].join(' '),
      critical,
    };
  }

  return null;
}
