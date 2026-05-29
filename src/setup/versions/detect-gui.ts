// src/setup/versions/detect-gui.ts
//
// Detect the claude-switch-gui (Tauri app) target. The CLI has no reliable
// way to know which GUI build the user is running — `current` is always null
// here; the GUI overrides it from its own `package.json` version in the
// useVersions hook (brief §9 "GUI current-version source").
//
// `latest` comes from the GitHub Releases API (unauth, rate-limited 60/h
// per IP — the 6h cache makes this a non-issue per user).
//
// `source` is always `'manual'` in v1: there's no automated install path
// from CLI for the GUI bundle. SH-UPD-5 introduces tauri-plugin-updater
// inside the app itself, at which point this target's source becomes
// `'manual'` or `'tauri-updater'` depending on platform.

import type { VersionTarget } from '../../contract.js';
import type { HttpPort } from '../../platform/http.js';
import { fetchGitHubReleaseLatest } from './registry.js';
import type { TargetCache } from './cache.js';

const GH_OWNER = 'SIRTHEO';
const GH_REPO = 'claude-switch-gui';
const RELEASES_URL = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest`;

interface DetectDeps {
  http?: HttpPort;
  now?: () => number;
}

export async function detectGui(deps: DetectDeps = {}): Promise<VersionTarget> {
  const now = deps.now ?? Date.now;
  const latest = await fetchGitHubReleaseLatest(GH_OWNER, GH_REPO, { http: deps.http });
  return {
    current: null,
    latest,
    source: 'manual',
    // The GUI hook layer recomputes upgradable once it knows the running
    // build's `current` — false here is correct given current=null.
    upgradable: false,
    lastCheckedAt: new Date(now()).toISOString(),
    manualUrl: RELEASES_URL,
  };
}

export function fromCache(cached: TargetCache, fetchedAt: number): VersionTarget {
  return {
    current: null,
    latest: cached.latest,
    source: cached.source,
    upgradable: false,
    lastCheckedAt: new Date(fetchedAt).toISOString(),
    manualUrl: cached.manualUrl ?? RELEASES_URL,
  };
}
