// src/setup/versions/detect-switch.ts
//
// Detect the claude-switch (this CLI) target. We always know `current` —
// it's the VERSION constant baked into the build — and we always assume
// `source: 'npm'` because there is no brew formula / cask for claude-switch
// in v1 (see brief §9 "Resolved facts"). The latest comes from the npm
// registry through the generic fetcher in registry.ts.

import { VERSION } from '../version.js';
import type { VersionTarget } from '../../contract-versions.js';
import type { TargetCache } from './cache.js';
import { fetchNpmLatest, isNewer } from './registry.js';
import type { HttpPort } from '../../platform/http.js';

// Scoped npm package — must match package.json `name`. The unscoped
// `claude-switch` name exists on npm but is a different (legacy) project.
const NPM_PACKAGE = '@sirtheo/claude-switch';

interface DetectDeps {
  http?: HttpPort;
  /** Inject a now() so the same call's `lastCheckedAt` stays deterministic
   *  across all three targets. Default = Date.now. */
  now?: () => number;
}

/** Run a fresh lookup. The orchestrator handles cache reuse. */
export async function detectSwitch(deps: DetectDeps = {}): Promise<VersionTarget> {
  const now = deps.now ?? Date.now;
  const latest = await fetchNpmLatest(NPM_PACKAGE, { http: deps.http });
  return {
    current: VERSION,
    latest,
    source: 'npm',
    upgradable: latest !== null && isNewer(VERSION, latest),
    lastCheckedAt: new Date(now()).toISOString(),
  };
}

/** Build a VersionTarget from a cached row — current is always fresh
 *  (VERSION is bundled), latest/source come from the cache. */
export function fromCache(cached: TargetCache, fetchedAt: number): VersionTarget {
  const latest = cached.latest;
  return {
    current: VERSION,
    latest,
    source: cached.source,
    upgradable: latest !== null && isNewer(VERSION, latest),
    lastCheckedAt: new Date(fetchedAt).toISOString(),
    ...(cached.manualUrl ? { manualUrl: cached.manualUrl } : {}),
  };
}
