// src/preferences.ts
// Global + per-account user preferences. Smart defaults — every flag is
// ON by default; the user opts out via the settings screen.
//
// Storage:
//   global  → ~/.claude/.user-prefs.json
//   account → embedded in accounts/<email>.json under `_prefs`
//
// The accounts.ts save/load already strips `_*` fields out of the live
// claude.json, so per-account prefs ride along with the existing snapshot
// without any extra round-trips.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolvedAccountFile } from './accounts.js';
import { withLock } from './lock.js';

// ---------------------------------------------------------------------------
// Global preferences
// ---------------------------------------------------------------------------

export interface GlobalPrefs {
  /** Foreground-fetch usage when the menu opens. Default: true. */
  refreshUsageOnEntry: boolean;
  /** Show the alt-buffer (full-screen menu) vs scroll-back render. Default: true. */
  useAltBuffer: boolean;
  /** Default for `autoLaunchOnSwitch` when an account has no per-account override. */
  defaultAutoLaunchOnSwitch: boolean;
  /** Default for `autoFlipFallback` when an account has no per-account override. */
  defaultAutoFlipFallback: boolean;
  /** Hide the legacy "Create profile / Import as profile" rows from the profiles screen. Default: true. */
  hideManualProfileOps: boolean;
}

export const DEFAULT_GLOBAL_PREFS: GlobalPrefs = {
  refreshUsageOnEntry: true,
  useAltBuffer: true,
  defaultAutoLaunchOnSwitch: true,
  defaultAutoFlipFallback: true,
  hideManualProfileOps: true,
};

function globalPrefsPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, '.user-prefs.json');
}

export function readGlobalPrefs(accountsDirPath: string): GlobalPrefs {
  try {
    const raw = JSON.parse(fs.readFileSync(globalPrefsPath(accountsDirPath), 'utf-8'));
    return { ...DEFAULT_GLOBAL_PREFS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULT_GLOBAL_PREFS };
  }
}

export function writeGlobalPrefs(accountsDirPath: string, partial: Partial<GlobalPrefs>): GlobalPrefs {
  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });
  return withLock(accountsDirPath, () => {
    // Re-read inside the lock so concurrent toggles compose instead of
    // last-writer-wins clobbering each other.
    const next = { ...readGlobalPrefs(accountsDirPath), ...partial };
    writeJsonAtomic(globalPrefsPath(accountsDirPath), next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Per-account preferences
// ---------------------------------------------------------------------------

export interface AccountPrefs {
  /** Spawn `claude` automatically right after switching to this account. */
  autoLaunchOnSwitch: boolean;
  /** Reset the global fallback flag to match `hasApiKey` when this account becomes active. */
  autoFlipFallback: boolean;
  /** Always launch in isolated mode (per-terminal profile) instead of swapping the global account. */
  defaultIsolated: boolean;
}

/** Resolve the effective preferences by composing globals + per-account overrides. */
export function resolveAccountPrefs(
  email: string,
  accountsDirPath: string,
): AccountPrefs {
  const global = readGlobalPrefs(accountsDirPath);
  const stored = readStoredAccountPrefs(email, accountsDirPath);
  return {
    autoLaunchOnSwitch: stored.autoLaunchOnSwitch ?? global.defaultAutoLaunchOnSwitch,
    autoFlipFallback: stored.autoFlipFallback ?? global.defaultAutoFlipFallback,
    defaultIsolated: stored.defaultIsolated ?? false,
  };
}

/** Stored per-account overrides only — `undefined` means "use global default". */
export interface StoredAccountPrefs {
  autoLaunchOnSwitch?: boolean;
  autoFlipFallback?: boolean;
  defaultIsolated?: boolean;
}

export function readStoredAccountPrefs(email: string, accountsDirPath: string): StoredAccountPrefs {
  try {
    const file = resolvedAccountFile(email, accountsDirPath);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const prefs = raw?._prefs;
    if (!prefs || typeof prefs !== 'object') return {};
    return prefs as StoredAccountPrefs;
  } catch {
    return {};
  }
}

export function writeStoredAccountPrefs(
  email: string,
  accountsDirPath: string,
  partial: StoredAccountPrefs,
): StoredAccountPrefs {
  const file = resolvedAccountFile(email, accountsDirPath);
  // The whole read-modify-write must be atomic relative to switcher.save()
  // and other preferences writers — otherwise a concurrent switch can
  // overwrite the `_prefs` snapshot we just merged, or vice versa.
  return withLock(accountsDirPath, () => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      throw new Error(`No saved account for ${email}`);
    }
    const existing = (data._prefs && typeof data._prefs === 'object')
      ? (data._prefs as StoredAccountPrefs)
      : {};
    const merged: StoredAccountPrefs = { ...existing, ...partial };
    for (const k of Object.keys(merged) as Array<keyof StoredAccountPrefs>) {
      if (merged[k] === undefined) delete merged[k];
    }
    data._prefs = merged;
    writeJsonAtomic(file, data);
    return merged;
  });
}
