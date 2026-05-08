// src/ui/screens/home/menu-items.ts
// Static + dynamic menu definitions for the home screen. Pulled out
// of `home.tsx` so the orchestrator file can stay focused on state
// machine + render wiring.

import type { AccountRow } from '../../hooks/use-snapshot.js';

export interface MenuItem<V extends string> {
  value: V;
  label: string;
  hotkey: string;
  hint: string;
}

export type AccountActionValue =
  | 'switch'
  | 'apikey'
  | 'manage'
  | 'fallback-toggle'
  | 'reauth'
  | 'remove';

export type GlobalActionValue =
  | 'add'
  | 'settings'
  | 'profiles'
  | 'auto-fallback'
  | 'usage'
  | 'setup'
  | 'quit';

export const GLOBAL_ITEMS: MenuItem<GlobalActionValue>[] = [
  { value: 'add',           label: 'Add account',         hotkey: 'a', hint: 'log in with a new email' },
  { value: 'settings',      label: 'Settings',            hotkey: 'g', hint: 'global + per-account preferences' },
  { value: 'profiles',      label: 'Profiles',            hotkey: 'p', hint: 'isolated per-terminal sessions' },
  { value: 'auto-fallback', label: 'Auto-fallback',       hotkey: 'F', hint: 'thresholds for auto-engage / auto-revert' },
  { value: 'usage',         label: 'Refresh usage',       hotkey: 'u', hint: 'force-fetch from Anthropic' },
  { value: 'setup',         label: 'Setup wizard',        hotkey: 's', hint: 'fix claude binary / shell PATH' },
  { value: 'quit',          label: 'Quit',                hotkey: 'q', hint: 'or press esc' },
];

/**
 * Build the per-account action set. The list shape depends on the
 * highlighted row's state (active vs idle, key-bearing vs not), so
 * it can't be a static const.
 */
export function buildAccountItems(row: AccountRow | null): MenuItem<AccountActionValue>[] {
  if (!row) return [];
  const items: MenuItem<AccountActionValue>[] = [];
  items.push({
    value: 'switch',
    label: row.active ? 'Launch claude (already active)' : 'Switch & launch claude',
    hotkey: '↵',
    hint: row.active ? 'open a session on this account' : 'swap then run claude',
  });
  items.push({
    value: 'apikey',
    label: row.hasApiKey ? 'Replace API key' : 'Set API key',
    hotkey: 'k',
    hint: row.hasApiKey ? `currently ${row.apiKeyMasked}` : 'paste an Anthropic key',
  });
  items.push({
    value: 'manage',
    label: 'Manage (alias · key · remove)',
    hotkey: 'm',
    hint: 'detailed account operations',
  });
  items.push({
    value: 'fallback-toggle',
    label: 'Toggle fallback',
    hotkey: 'f',
    hint: 'flip OAuth ↔ API key globally',
  });
  if (row.active) {
    items.push({
      value: 'reauth',
      label: 'Re-authenticate',
      hotkey: 'c',
      hint: 'browser re-login (current account)',
    });
  }
  items.push({
    value: 'remove',
    label: 'Remove account',
    hotkey: 'd',
    hint: 'delete saved tokens, key, aliases',
  });
  return items;
}
