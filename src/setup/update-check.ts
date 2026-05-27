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
import { fileURLToPath } from 'node:url';
import { type ProcessPort, nodeProcessAdapter } from '../platform/process.js';
import { writeJsonAtomic } from '../platform/atomic-write.js';

const PACKAGE_NAME = '@sirtheo/claude-switch';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

interface CheckCache {
  checkedAt: number;
  latestVersion: string;
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

// ---------------------------------------------------------------------------
// Registry fetch — background (unref'd)
// ---------------------------------------------------------------------------

function fetchLatestVersionBackground(): void {
  const req = https.get(REGISTRY_URL, { timeout: 5000 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return; }
    let body = '';
    let aborted = false;
    res.on('data', (chunk: Buffer) => {
      if (aborted) return;
      body += chunk.toString();
      // Cap response size — npm /latest is ~2 KB, anything more is suspect
      // (compromised registry or MITM). 64 KB is generous.
      if (body.length > 64 * 1024) {
        aborted = true;
        res.destroy();
      }
    });
    res.on('end', () => {
      try {
        const version = extractVersion(JSON.parse(body));
        if (typeof version === 'string') {
          writeCache({ checkedAt: Date.now(), latestVersion: version });
        }
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
// Install command detection
// ---------------------------------------------------------------------------

/**
 * Returns the command array to update the package, based on how it is
 * currently installed (detected from the binary path).
 */
export function detectInstallCommand(): string[] {
  // Resolve the path of the currently-running CLI entry point.
  let selfDir = '';
  try {
    selfDir = path.dirname(fileURLToPath(import.meta.url));
  } catch { /* import.meta unavailable in some test contexts */ }

  const binaryPath = selfDir || process.execPath;
  // Match against path segments, not raw substring — otherwise a user
  // whose home directory contains "volta" or whose project is in a
  // "pnpm-workspace" folder would be misclassified.
  const segments = binaryPath.split(path.sep);
  const hasSeg = (...names: string[]): boolean =>
    segments.some(s => names.includes(s));

  // Volta — manages its own shims
  if (hasSeg('.volta', 'volta')) {
    return ['volta', 'install', PACKAGE_NAME];
  }

  // pnpm global
  if (hasSeg('pnpm', '.pnpm', 'pnpm-global')) {
    return ['pnpm', 'add', '-g', PACKAGE_NAME];
  }

  // yarn global (v1)
  if (hasSeg('yarn', '.yarn')) {
    return ['yarn', 'global', 'add', PACKAGE_NAME];
  }

  // Default: npm (covers homebrew-managed node, nvm, system node, etc.)
  return ['npm', 'install', '-g', PACKAGE_NAME];
}

// ---------------------------------------------------------------------------
// Perform update
// ---------------------------------------------------------------------------

/**
 * Runs the detected install command with live stdio.
 * Returns true if the process exited successfully.
 */
export function performUpdate(deps?: { process?: ProcessPort }): boolean {
  const [cmd, ...args] = detectInstallCommand();
  if (!cmd) {
    console.error('Could not detect install command for self-update.');
    return false;
  }
  console.log(`Running: ${cmd} ${args.join(' ')}\n`);
  const result = (deps?.process ?? nodeProcessAdapter).spawnSync(cmd, args, { stdio: 'inherit' });
  return result.status === 0 && !result.error;
}

// ---------------------------------------------------------------------------
// Startup check (called on every non-passthrough invocation)
// ---------------------------------------------------------------------------

export interface UpdateInfo {
  latestVersion: string;
  installCommand: string;
}

/**
 * Call once at CLI startup.
 * - Returns UpdateInfo if a newer version is cached, otherwise null.
 * - Kicks off a background registry check if the cache is stale.
 */
export function checkForUpdate(currentVersion: string): UpdateInfo | null {
  const cache = readCache();
  const now = Date.now();

  if (!cache || now - cache.checkedAt > CHECK_INTERVAL_MS) {
    setImmediate(fetchLatestVersionBackground).unref();
  }

  if (cache && isNewer(currentVersion, cache.latestVersion)) {
    const [cmd, ...args] = detectInstallCommand();
    return {
      latestVersion: cache.latestVersion,
      installCommand: [cmd, ...args].join(' '),
    };
  }

  return null;
}
