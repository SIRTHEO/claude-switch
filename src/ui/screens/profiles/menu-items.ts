// src/ui/screens/profiles/menu-items.ts
// Menu metadata for the profiles home view, plus the small profile
// label helper. Pulled out of `profiles.tsx` so the orchestrator file
// can stay focused on the state machine + spawn lifecycle.

import { listProfiles, readProfile } from '../../../profiles.js';
import { list as listAccounts } from '../../../accounts.js';
import { readGlobalPrefs } from '../../../preferences.js';

export type Action =
  | 'isolated' | 'list' | 'use' | 'login' | 'create' | 'import' | 'remove' | 'back';

export interface MenuItem {
  value: Action;
  label: string;
  hint?: string;
}

/**
 * Build the visible profile-screen menu. The list shape depends on
 * what's already on disk (have any accounts? have any profiles?
 * is the manual-ops opt-out set?), so it isn't a static const.
 */
export function buildHomeItems(accountsDirPath: string): MenuItem[] {
  const profiles = listProfiles();
  const accounts = listAccounts(accountsDirPath);
  const hideManual = readGlobalPrefs(accountsDirPath).hideManualProfileOps;
  const items: MenuItem[] = [];

  if (accounts.length > 0) {
    items.push({ value: 'isolated', label: 'Open account isolated', hint: 'pick an account → launch in its own session' });
  }
  if (profiles.length > 0) {
    items.push({ value: 'use', label: 'Use saved profile', hint: 'launch claude with per-terminal isolation' });
    items.push({ value: 'list', label: 'List profiles', hint: `${profiles.length} saved` });
    items.push({ value: 'login', label: 'Authenticate profile', hint: 'browser login for a profile' });
    items.push({ value: 'remove', label: 'Remove profile', hint: 'delete a profile and its state' });
  }
  // Manual create / import are advanced ops — hidden by default since
  // "Open account isolated" auto-creates the matching profile on demand.
  // Re-enable from Settings → Global → "Hide manual profile ops" off.
  if (!hideManual) {
    items.push({ value: 'create', label: 'Create profile', hint: 'new isolated profile directory' });
    if (accounts.length > 0) {
      items.push({ value: 'import', label: 'Import account as profile', hint: 'no browser re-login needed' });
    }
  }
  items.push({ value: 'back', label: 'Back to main menu' });
  return items;
}

/**
 * Friendly label + hint for a profile name when the user picks one
 * from the per-profile sub-menu. Best-effort: if the JSON is
 * unreadable we still surface the name (hidden behind a hint that
 * says so).
 */
export function profileLabel(name: string): { label: string; hint: string } {
  try {
    const info = readProfile(name);
    return { label: name, hint: info.emailAddress ?? '(not logged in)' };
  } catch { // profile unreadable → show error hint
    return { label: name, hint: '(error reading)' };
  }
}
