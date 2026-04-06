// src/update-check.ts
// Lightweight update-notifier without runtime dependencies.
// Strategy:
//   1. On every invocation, read the cached check result synchronously (fast).
//   2. If the cached result is stale (> CHECK_INTERVAL_MS), kick off an async
//      background HTTP request — unref'd so it never blocks process exit.
//   3. The notification is shown synchronously from the cache on the NEXT run
//      after a newer version is detected.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PACKAGE_NAME = '@sirtheo/claude-switch';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

interface CheckCache {
  checkedAt: number;
  latestVersion: string;
}

function cacheFilePath(): string {
  return path.join(os.homedir(), '.claude', 'accounts', '.update-check.json');
}

function readCache(): CheckCache | null {
  try {
    const raw = fs.readFileSync(cacheFilePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as Record<string, unknown>).checkedAt === 'number' &&
      typeof (parsed as Record<string, unknown>).latestVersion === 'string'
    ) {
      return parsed as CheckCache;
    }
  } catch { /* no cache yet */ }
  return null;
}

function writeCache(cache: CheckCache): void {
  try {
    const filePath = cacheFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache));
  } catch { /* best-effort */ }
}

function fetchLatestVersion(): void {
  const req = https.get(REGISTRY_URL, { timeout: 5000 }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return;
    }
    let body = '';
    res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    res.on('end', () => {
      try {
        const data: unknown = JSON.parse(body);
        const version = (data as Record<string, unknown>).version;
        if (typeof version === 'string') {
          writeCache({ checkedAt: Date.now(), latestVersion: version });
        }
      } catch { /* ignore malformed response */ }
    });
  });

  req.on('error', () => { /* ignore network errors */ });
  req.on('timeout', () => { req.destroy(); });

  // Unref so this request never prevents process exit.
  req.socket?.unref();
  req.on('socket', (socket) => { socket.unref(); });
}

/** Compares two semver strings. Returns true if `b` is strictly newer than `a`. */
function isNewer(current: string, latest: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const [ca, cb, cc] = parse(current);
  const [la, lb, lc] = parse(latest);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

/**
 * Call once at CLI startup.
 * - Returns a notification string if a newer version is cached, otherwise null.
 * - Kicks off a background check if the cache is stale.
 */
export function checkForUpdate(currentVersion: string): string | null {
  const cache = readCache();
  const now = Date.now();

  // Schedule a background fetch if there is no cache or it is stale.
  if (!cache || now - cache.checkedAt > CHECK_INTERVAL_MS) {
    // Use setImmediate so the fetch starts after the current tick, then is
    // unref'd so it cannot delay process.exit() called by passthrough commands.
    setImmediate(fetchLatestVersion).unref();
  }

  if (cache && isNewer(currentVersion, cache.latestVersion)) {
    return (
      `\n  Update available: ${currentVersion} → ${cache.latestVersion}\n` +
      `  Run: npm install -g ${PACKAGE_NAME}\n`
    );
  }

  return null;
}
