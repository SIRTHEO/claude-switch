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

/** Auth mode for the local fallback proxy.
 *
 *  - `auto` (default): pick at startup based on token health + saved key.
 *      OAuth healthy AND key saved → effective `oauth-first`.
 *      OAuth healthy AND no key → effective `oauth-only`.
 *      OAuth broken AND key saved → effective `api-first` (token dead, no point probing).
 *      OAuth broken AND no key → error: no auth available.
 *
 *  - `oauth-first`: explicit. OAuth-first proxy with live retry on
 *      429/error envelopes; after N consecutive failures it enters a
 *      temporary `api-burst` sub-state and probes OAuth periodically;
 *      when probe returns OK it drops back to oauth-first. This gives
 *      symmetric live recovery in both directions within one `claude`
 *      session.
 *
 *  - `api-first`: explicit. Always uses the API key, never probes OAuth.
 *      For users who want to bill API credits deliberately, or whose
 *      OAuth subscription is unavailable.
 *
 *  Note: `oauth-only` exists as a runtime resolution in `auto` mode but
 *  is not exposed as a stored preference — choosing it explicitly is
 *  equivalent to `auto` with no saved API key.
 */
export type AuthMode = 'auto' | 'oauth-first' | 'api-first';

export interface AccountPrefs {
  /** Spawn `claude` automatically right after switching to this account. */
  autoLaunchOnSwitch: boolean;
  /** Reset the global fallback flag to match `hasApiKey` when this account becomes active. */
  autoFlipFallback: boolean;
  /** Always launch in isolated mode (per-terminal profile) instead of swapping the global account. */
  defaultIsolated: boolean;
  /** How the local fallback proxy should authenticate this account's traffic. */
  authMode: AuthMode;
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
    authMode: stored.authMode ?? 'auto',
  };
}

/** Stored per-account overrides only — `undefined` means "use global default". */
export interface StoredAccountPrefs {
  autoLaunchOnSwitch?: boolean;
  autoFlipFallback?: boolean;
  defaultIsolated?: boolean;
  authMode?: AuthMode;
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

/** Effective authentication mode at proxy startup. Same set as `AuthMode`
 *  plus `oauth-only` (proxy uses OAuth, no key fallback) and `error` (no
 *  working auth at all — caller should refuse to start). */
export type EffectiveAuthMode = 'oauth-first' | 'oauth-only' | 'api-first' | 'error';

/** Resolve the effective auth mode from the stored preference + the current
 *  token + key state. Pure function — easy to unit-test the matrix. */
export function resolveEffectiveAuthMode(input: {
  authMode: AuthMode;
  oauthHealthy: boolean;
  hasApiKey: boolean;
}): EffectiveAuthMode {
  const { authMode, oauthHealthy, hasApiKey } = input;
  if (authMode === 'oauth-first') {
    // Explicit OAuth-first only makes sense if OAuth works AND we have an
    // API key for the live retry/burst path. Without a key it degrades to
    // oauth-only; without OAuth it degrades to api-first if possible.
    if (oauthHealthy && hasApiKey) return 'oauth-first';
    if (oauthHealthy) return 'oauth-only';
    if (hasApiKey) return 'api-first';
    return 'error';
  }
  if (authMode === 'api-first') {
    if (hasApiKey) return 'api-first';
    if (oauthHealthy) return 'oauth-only';
    return 'error';
  }
  // auto
  if (oauthHealthy && hasApiKey) return 'oauth-first';
  if (oauthHealthy) return 'oauth-only';
  if (hasApiKey) return 'api-first';
  return 'error';
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
