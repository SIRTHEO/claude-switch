// src/proxy-mode.ts
// Phase 13.6 — ephemeral proxy runtime-mode marker.
//
// The api-proxy decides per-request whether to forward via OAuth (subscription
// billing) or API key (API credits). Its in-process state — burst sub-state,
// last-probe timestamp, last-retry reason — is invisible to anything outside
// the process. The statusline used to derive "OAuth" vs "API" from the
// PERSISTENT fallback flag (`.fallback-enabled`), which only captures the
// boot-time choice, not the runtime reality. Result: during an api-burst
// the user saw "OAuth" while every request was billed to API for up to 5
// minutes.
//
// This module is the bridge: the proxy writes its current effective mode
// to `<accountsDir>/.proxy-mode.json` on every transition. The statusline
// reads it. When the file is missing or stale (proxy died / hasn't booted
// yet), the statusline falls back to the persistent flag — back-compat.
//
// Format is intentionally trivial: one tiny JSON file, atomic writes,
// best-effort everywhere. Telemetry must never make a request fail.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { errnoCode } from './errors.js';

export type ProxyRuntimeMode =
  | 'oauth-first'    // proxy started in oauth-first, no burst active
  | 'oauth-burst'    // 3+ OAuth failures in a row → routing through API key with periodic probe
  | 'api-first';     // explicit api-first mode (per-account `authMode='api-first'`)

export interface ProxyModeMarker {
  mode: ProxyRuntimeMode;
  updatedAt: number;
  /** Why the last transition happened. Useful for `claude switch status`
   *  diagnostics and for the statusline tooltip later. Free-form. */
  lastReason?: string;
  /** Optional: pid of the proxy process. Lets a future cleaner detect
   *  zombie markers from crashed proxies — not used today. */
  pid?: number;
}

/**
 * How long after the last `updatedAt` we still trust the marker. Beyond this
 * the proxy is almost certainly dead and we should fall back to the
 * persistent flag rather than show stale info. Generous default — the
 * proxy writes on every transition, but a quiet session might go minutes
 * between writes (no transitions happen on silent successful OAuth requests
 * because `recordOauthSuccess` only writes when it's changing state).
 */
export const PROXY_MODE_STALE_MS = 10 * 60 * 1000;

function markerPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, '.proxy-mode.json');
}

/**
 * Write the marker. Best-effort: failures are swallowed (telemetry must
 * never cascade into a request error). Atomic write so a partial file
 * can't be observed by a concurrently-running statusline read.
 */
export function writeProxyMode(
  accountsDirPath: string,
  mode: ProxyRuntimeMode,
  lastReason?: string,
): void {
  try {
    fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });
    const marker: ProxyModeMarker = {
      mode,
      updatedAt: Date.now(),
      pid: process.pid,
    };
    if (lastReason) marker.lastReason = lastReason;
    writeJsonAtomic(markerPath(accountsDirPath), marker, 0);
  } catch { /* best-effort */ }
}

/**
 * Delete the marker. Called from proxy `close()` so the statusline knows
 * the proxy is no longer running.
 */
export function clearProxyMode(accountsDirPath: string): void {
  try {
    fs.unlinkSync(markerPath(accountsDirPath));
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') {
      /* file existed but couldn't be removed — best-effort, swallow */
    }
  }
}

/**
 * Read the marker. Returns null when:
 *   - the file doesn't exist (no proxy ever ran),
 *   - the JSON is malformed (corrupted write),
 *   - the marker is older than `PROXY_MODE_STALE_MS` (proxy probably
 *     died — fall back to the persistent flag).
 *
 * The staleness check makes the marker self-healing: a crashed proxy
 * leaves a marker that the next statusline read ignores, instead of
 * sticky-displaying a wrong mode forever.
 */
export function readProxyMode(accountsDirPath: string): ProxyModeMarker | null {
  try {
    const raw = fs.readFileSync(markerPath(accountsDirPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.mode !== 'string') return null;
    if (typeof obj.updatedAt !== 'number') return null;
    const mode = obj.mode as ProxyRuntimeMode;
    if (mode !== 'oauth-first' && mode !== 'oauth-burst' && mode !== 'api-first') return null;
    if (Date.now() - obj.updatedAt > PROXY_MODE_STALE_MS) return null;
    const out: ProxyModeMarker = { mode, updatedAt: obj.updatedAt };
    if (typeof obj.lastReason === 'string') out.lastReason = obj.lastReason;
    if (typeof obj.pid === 'number') out.pid = obj.pid;
    return out;
  } catch {
    return null;
  }
}
