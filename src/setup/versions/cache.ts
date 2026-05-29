// src/setup/versions/cache.ts
//
// On-disk cache for the multi-target versions report.
//
// File: ~/.claude/switch/update-cache.json. Independent from the legacy
// single-target cache at ~/.claude/accounts/.update-check.json (the latter
// still drives the startup banner via setup/update-check.ts). SH-UPD-2 will
// reconcile the two — for now they coexist so this slice ships read-only and
// doesn't touch the banner code path.
//
// Shape:
//   { fetchedAt: <ms>, targets: { [target]: { latest, source, manualUrl? } } }
//
// `fetchedAt` is per-cache, not per-target: all three lookups happen in the
// same orchestrator pass, so one timestamp keeps the file small and the
// staleness check trivial.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeJsonAtomic } from '../../platform/atomic-write.js';
import type { VersionSource } from '../../contract.js';

/** Per-target cache row. `latest === null` means the lookup ran but the
 *  registry was unreachable — we still cache the negative result for the TTL
 *  so a flaky network doesn't trigger a request every CLI invocation. */
export interface TargetCache {
  latest: string | null;
  source: VersionSource;
  manualUrl?: string;
}

export interface VersionsCache {
  fetchedAt: number;
  targets: Partial<Record<'claude' | 'switch' | 'gui', TargetCache>>;
}

/** 6 hours — Linear/Discord cadence, matches the brief's
 *  §10 "Cache TTL of 6h" decision. Exported as a default for `isStale`
 *  but not re-imported by any caller — keep `export` off until needed. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function cachePath(): string {
  return path.join(os.homedir(), '.claude', 'switch', 'update-cache.json');
}

function isVersionSource(v: unknown): v is VersionSource {
  return v === 'npm' || v === 'brew' || v === 'manual' || v === 'unknown';
}

function isTargetCacheShaped(v: unknown): v is TargetCache {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!(o.latest === null || typeof o.latest === 'string')) return false;
  if (!isVersionSource(o.source)) return false;
  if (o.manualUrl !== undefined && typeof o.manualUrl !== 'string') return false;
  return true;
}

function isCacheShaped(v: unknown): v is VersionsCache {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.fetchedAt !== 'number') return false;
  if (typeof o.targets !== 'object' || o.targets === null) return false;
  const t = o.targets as Record<string, unknown>;
  for (const k of ['claude', 'switch', 'gui']) {
    if (k in t && !isTargetCacheShaped(t[k])) return false;
  }
  return true;
}

export function readCache(): VersionsCache | null {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isCacheShaped(parsed) ? parsed : null;
  } catch {
    // ENOENT / malformed JSON / parse-error — treat as no cache, lookup
    // will run fresh. The negative case is identical for the caller.
    return null;
  }
}

export function writeCache(cache: VersionsCache): void {
  try {
    const filePath = cachePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeJsonAtomic(filePath, cache, 0);
  } catch {
    // best-effort: the report works without the cache, the next call just
    // re-fetches. Never let a cache-write failure surface to the user.
  }
}

/** True when the cache is too old to trust — caller refetches. */
export function isStale(cache: VersionsCache | null, now: number, ttlMs = CACHE_TTL_MS): boolean {
  if (!cache) return true;
  return now - cache.fetchedAt > ttlMs;
}
