// src/ui/hooks/use-snapshot.ts
// Domain snapshot hook: gathers everything the dashboard renders in one pass.
// `refresh()` re-runs the read after a mutating action (switch, add, fallback toggle).

import { useCallback, useState } from 'react';

import { getCurrent, list as listAccounts } from '../../accounts/accounts.js';
import { isFallbackEnabled } from '../../fallback/fallback.js';
import { getApiKey, maskApiKey } from '../../credentials/apikey.js';
import { getAliasesForEmail } from '../../switching/aliases.js';
import { getTokenHealth } from '../../credentials/token.js';
import { readUsageCacheFor } from '../../usage/usage.js';
import { resolveAccountPrefs } from '../../switching/preferences.js';

export interface AccountRow {
  email: string;
  active: boolean;
  alias: string | undefined;
  aliases: string[];
  hasApiKey: boolean;
  apiKeyMasked: string | undefined;
  defaultIsolated: boolean;
  autoLaunchOnSwitch: boolean;
  /** Cached subscription usage for this row (only present when the cache
   *  is tagged for this account — i.e. typically the active one). */
  usage5h: number | undefined;
  usageWeek: number | undefined;
}

export interface Snapshot {
  rows: AccountRow[];
  current: string;
  fallbackOn: boolean;
  tokenHealth: ReturnType<typeof getTokenHealth> | null;
  usage5h: number | undefined;
  usageWeek: number | undefined;
}

export function loadSnapshot(claudeJsonPath: string, accountsDirPath: string): Snapshot {
  const current = getCurrent(claudeJsonPath);
  const emails = listAccounts(accountsDirPath);
  const fallbackOn = isFallbackEnabled(accountsDirPath);
  const tokenHealth = current ? getTokenHealth(claudeJsonPath) : null;

  const rows: AccountRow[] = emails.map((email) => {
    const aliases = getAliasesForEmail(email, accountsDirPath);
    const apiKey = getApiKey(email, accountsDirPath);
    const prefs = resolveAccountPrefs(email, accountsDirPath);
    // Per-account usage is read from the per-row cache if available. The
    // cache file is shared but tagged with the account it was fetched for,
    // so most non-active rows return null here — that's expected.
    const rowCache = readUsageCacheFor(accountsDirPath, email);
    return {
      email,
      active: email === current,
      alias: aliases[0],
      aliases,
      hasApiKey: !!apiKey,
      apiKeyMasked: apiKey ? maskApiKey(apiKey) : undefined,
      defaultIsolated: prefs.defaultIsolated,
      autoLaunchOnSwitch: prefs.autoLaunchOnSwitch,
      usage5h: rowCache?.payload?.five_hour?.utilization,
      usageWeek: rowCache?.payload?.seven_day?.utilization,
    };
  });

  const cache = current ? readUsageCacheFor(accountsDirPath, current) : null;
  const usage5h = cache?.payload?.five_hour?.utilization;
  const usageWeek = cache?.payload?.seven_day?.utilization;

  return { rows, current, fallbackOn, tokenHealth, usage5h, usageWeek };
}

export interface UseSnapshot {
  snap: Snapshot;
  refresh: () => void;
}

export function useSnapshot(claudeJsonPath: string, accountsDirPath: string): UseSnapshot {
  const [snap, setSnap] = useState<Snapshot>(() => loadSnapshot(claudeJsonPath, accountsDirPath));
  const refresh = useCallback(() => {
    setSnap(loadSnapshot(claudeJsonPath, accountsDirPath));
  }, [claudeJsonPath, accountsDirPath]);
  return { snap, refresh };
}
