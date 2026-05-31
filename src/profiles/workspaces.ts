// src/profiles/workspaces.ts
// Unified workspace listing: the isolated profiles PLUS the global `~/.claude`,
// surfaced as a first-class read-only `default` entry. This is the listing
// foundation of the unified-profile model — it changes no switch/launch
// behaviour, only presents the global alongside the profiles uniformly so a
// caller can render every workspace from one list.

import path from 'node:path';
import { getCurrent } from '../accounts/accounts.js';
import { listProfiles, readProfile, profileExists, profilePath } from './profiles.js';
import { isOverlayProfile } from './overlay.js';
import { readState } from '../switching/state-store.js';
import type { ProfileEntry } from '../contract.js';

/** The isolated profiles as ProfileEntry rows. Never marked `isDefault`. */
export function profileEntries(): ProfileEntry[] {
  return listProfiles().map((name) => {
    const info = readProfile(name);
    return {
      name,
      account: info.hasLogin ? info.emailAddress ?? null : null,
      hasLogin: info.hasLogin,
      path: info.path,
      overlay: isOverlayProfile(name),
    };
  });
}

/**
 * The global `~/.claude` as a read-only `default` workspace entry. `path` is the
 * global config dir (the parent of the accounts dir), matching how the session
 * registry derives the global dir. A missing or corrupt global `.claude.json`
 * degrades to account=null / hasLogin=false rather than throwing — the unified
 * listing must never fail on a broken global.
 */
export function defaultWorkspaceEntry(claudeJsonPath: string, accountsDirPath: string): ProfileEntry {
  let account: string | null = null;
  try {
    account = getCurrent(claudeJsonPath) || null;
  } catch {
    // unreadable / corrupt global claude.json → no active account
    account = null;
  }
  return {
    name: 'default',
    account,
    hasLogin: account !== null,
    path: path.dirname(accountsDirPath),
    overlay: false,
    isDefault: true,
  };
}

/** The unified listing: the read-only `default` workspace first, then the
 *  isolated profiles (in listProfiles' sorted order). */
export function listWorkspaces(claudeJsonPath: string, accountsDirPath: string): ProfileEntry[] {
  return [defaultWorkspaceEntry(claudeJsonPath, accountsDirPath), ...profileEntries()];
}

/** Sentinel pointer value meaning "the global `~/.claude`" (not a real profile
 *  dir). `'default'` is also reserved in profiles' RESERVED_NAMES so a disk
 *  profile can never collide with it. */
const DEFAULT_POINTER = 'default';

/**
 * The persisted default-pointer: which workspace bare `claude` launches.
 * `'default'` (or absent on older state / pre-unified installs) → the global
 * `~/.claude`.
 */
export function readDefaultPointer(accountsDirPath: string): string {
  return readState(accountsDirPath).defaultPointer ?? DEFAULT_POINTER;
}

interface ResolvedDefaultWorkspace {
  /** The pointer as resolved — `'default'` when it points at the global or
   *  falls back from a vanished profile, else the profile name. */
  name: string;
  /** Absolute config dir bare `claude` should run in. */
  configDir: string;
  /** True for the global `~/.claude` (the `'default'` sentinel, or a stale
   *  pointer to a profile that no longer exists). */
  isDefault: boolean;
}

/**
 * Resolve the default-pointer to the config dir bare `claude` should launch in.
 * `'default'`, or a pointer to a profile that no longer exists, → the global
 * `~/.claude` (`isDefault: true`); it never throws and never resolves to a
 * missing dir, so a stale pointer degrades to today's behaviour instead of
 * breaking launch. A pointer to an existing profile → that profile's dir.
 *
 * NB — this slice only READS + RESOLVES the pointer. Nothing on the launch hot
 * path injects `CLAUDE_CONFIG_DIR` from it yet: that wiring, and the
 * `claude switch X` writer that lets the pointer become non-`'default'`, land
 * together in the re-point slice where the behaviour change is
 * characterization-tested end to end. Injecting for the `'default'` case in
 * particular is deferred deliberately — a nested `claude→claude` re-entry
 * through this wrapper would otherwise see `CLAUDE_CONFIG_DIR` set and skip
 * routing / record the session as isolated (see passthrough-routing + the
 * design doc's always-inject constraint).
 */
export function resolveDefaultWorkspace(accountsDirPath: string): ResolvedDefaultWorkspace {
  const pointer = readDefaultPointer(accountsDirPath);
  if (pointer !== DEFAULT_POINTER && profileExists(pointer)) {
    return { name: pointer, configDir: profilePath(pointer), isDefault: false };
  }
  return { name: DEFAULT_POINTER, configDir: path.dirname(accountsDirPath), isDefault: true };
}
