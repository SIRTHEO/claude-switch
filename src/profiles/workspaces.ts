// src/profiles/workspaces.ts
// Unified workspace listing: the isolated profiles PLUS the global `~/.claude`,
// surfaced as a first-class read-only `default` entry. This is the listing
// foundation of the unified-profile model — it changes no switch/launch
// behaviour, only presents the global alongside the profiles uniformly so a
// caller can render every workspace from one list.

import path from 'node:path';
import { getCurrent } from '../accounts/accounts.js';
import { listProfiles, readProfile } from './profiles.js';
import { isOverlayProfile } from './overlay.js';
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
