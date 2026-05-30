// src/setup/versions/index.ts
//
// Orchestrator for `claude switch versions`. Composes the three target
// detectors with the on-disk cache:
//
//   - cache fresh + not --force → return cached rows (per-target lookups
//     run for `current` only, no network)
//   - cache stale or --force    → run all three lookups in parallel, write
//                                 the cache, return the fresh rows
//
// Cache TTL = 6h (cache.ts CACHE_TTL_MS). Network failures are non-fatal:
// the failing target's `latest` ends up null and the row says
// "Could not check" in the GUI; the cache still writes whatever did
// succeed so a partial outage doesn't poison the next call.

import type { VersionTarget, VersionsReport } from '../../contract-versions.js';
import type { HttpPort } from '../../platform/http.js';
import type { ProcessPort } from '../../platform/process.js';

import { detectClaude, fromCache as fromCacheClaude } from './detect-claude.js';
import { detectGui, fromCache as fromCacheGui } from './detect-gui.js';
import { detectSwitch, fromCache as fromCacheSwitch } from './detect-switch.js';
import { isStale, readCache, writeCache, type VersionsCache } from './cache.js';

export interface VersionsOptions {
  /** Bypass the 6h cache. */
  force?: boolean;
  http?: HttpPort;
  process?: ProcessPort;
  now?: () => number;
}

export async function getVersionsReport(opts: VersionsOptions = {}): Promise<VersionsReport> {
  const now = opts.now ?? Date.now;
  const cache = readCache();
  const stale = opts.force || isStale(cache, now());

  if (!stale && cache) {
    return reportFromCache(cache, opts);
  }

  // Fresh lookup: parallel so the slowest endpoint sets the wall time.
  const [claude, sw, gui] = await Promise.all([
    detectClaude({ http: opts.http, process: opts.process, now }),
    detectSwitch({ http: opts.http, now }),
    detectGui({ http: opts.http, now }),
  ]);

  // Persist whatever we got. Per-target `latest === null` is a legitimate
  // value to cache — it means the lookup ran and the registry was
  // unreachable, and we don't want to thrash on the next call.
  const fresh: VersionsCache = {
    fetchedAt: now(),
    targets: {
      claude: { latest: claude.latest, source: claude.source, ...(claude.manualUrl ? { manualUrl: claude.manualUrl } : {}) },
      switch: { latest: sw.latest, source: sw.source, ...(sw.manualUrl ? { manualUrl: sw.manualUrl } : {}) },
      gui: { latest: gui.latest, source: gui.source, ...(gui.manualUrl ? { manualUrl: gui.manualUrl } : {}) },
    },
  };
  writeCache(fresh);

  return { claude, switch: sw, gui };
}

function reportFromCache(cache: VersionsCache, opts: VersionsOptions): VersionsReport {
  // Defensive fallbacks: a cache that's been hand-edited to drop one of the
  // targets shouldn't crash — fall through to a fresh detect for the missing
  // one. We choose the cheap path (current-only re-probe) when the cache
  // has the row, and the full async path when it doesn't. The async case is
  // exceptional, so a synchronous Promise.all branch is wasteful; instead
  // we mark missing targets with a stub the caller can detect.
  const t = cache.targets;
  const claude = t.claude
    ? fromCacheClaude(t.claude, cache.fetchedAt, { process: opts.process })
    : missing('claude', cache.fetchedAt);
  const sw = t.switch ? fromCacheSwitch(t.switch, cache.fetchedAt) : missing('switch', cache.fetchedAt);
  const gui = t.gui ? fromCacheGui(t.gui, cache.fetchedAt) : missing('gui', cache.fetchedAt);
  return { claude, switch: sw, gui };
}

function missing(_target: 'claude' | 'switch' | 'gui', fetchedAt: number): VersionTarget {
  // A row the cache didn't know about. We surface it as "unknown source,
  // no latest" so the GUI shows "Could not check" — the next --force call
  // will reconcile.
  return {
    current: null,
    latest: null,
    source: 'unknown' as const,
    upgradable: false,
    lastCheckedAt: new Date(fetchedAt).toISOString(),
  };
}
