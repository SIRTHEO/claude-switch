// src/ui/run-app-handlers.ts
// Home-action handlers for the Ink menu, extracted from run-app.ts (the
// orchestrator) to keep that file within the size budget. Each handler runs
// one menu action and returns a Notice to surface on the next render. They are
// exposed individually so the unit suite can exercise each handler's pure I/O
// contract; run-app re-exports them via `_internal`.

import { nodeProcessAdapter } from '../platform/process.js';

import { getCurrent } from '../accounts/accounts.js';
import { ExitError } from '../platform/errors.js';
import { isFallbackEnabled, setFallbackEnabled } from '../fallback/fallback.js';
import { getApiKey } from '../credentials/apikey.js';
import {
  readUsageCacheForAccount,
  isUsageCacheStale,
  fetchUsageCached,
  getAccessTokenFromKeychain,
} from '../usage/usage.js';
import { findClaudeBinary } from '../setup/find-claude.js';
import { markSessionLive } from '../sessions/session-registry.js';
import { getTokenHealth } from '../credentials/token.js';
import { reAuthenticate } from '../switching/switcher.js';
import { buildSpawnArgs } from '../proxy/proxy.js';
import type { renderHome } from './screens/home.js';
import { runApikeyScreen } from './screens/set-apikey.js';
import { runAddAccountScreen } from './screens/add-account.js';
import { runRemoveAccountScreen } from './screens/remove-account.js';
import { runProfilesScreen } from './screens/profiles.js';
import { runConfirm } from './screens/confirm.js';
import { runPickAccount } from './screens/pick-account.js';
import { readGlobalPrefs } from '../switching/preferences.js';

/** The "notice" surfaced on the next home render — the third arg renderHome
 *  takes. Shared return type for every handler below. */
export type Notice = Parameters<typeof renderHome>[2];

export async function refreshUsageOnEntry(claudeJsonPath: string, accountsDirPath: string): Promise<void> {
  if (!readGlobalPrefs(accountsDirPath).refreshUsageOnEntry) return;
  const current = getCurrent(claudeJsonPath);
  if (!current) return;
  if (!isUsageCacheStale(readUsageCacheForAccount(accountsDirPath, current), current)) return;
  const token = getAccessTokenFromKeychain(claudeJsonPath);
  if (!token) return;
  try {
    process.stderr.write('Fetching subscription usage…\n');
    await fetchUsageCached(accountsDirPath, token, { force: true, account: current });
  } catch {
    /* best effort — the home screen handles missing usage */
  }
}

export async function handleSwitched(
  payload: {
    switchedFrom: string | null;
    switchedTo: string;
    autoLaunch: boolean;
    defaultIsolated: boolean;
  },
  accountsDirPath: string,
): Promise<Notice> {
  if (payload.switchedFrom === payload.switchedTo) {
    return { kind: 'info', text: `Already on ${payload.switchedTo}` };
  }
  if (!payload.autoLaunch) {
    return { kind: 'success', text: `Switched to ${payload.switchedTo}` };
  }
  const bin = findClaudeBinary(import.meta.url);
  if (!bin) {
    return { kind: 'success', text: `Switched to ${payload.switchedTo}` };
  }

  // Default-isolated: run inside a per-terminal profile (auto-created on
  // demand) instead of using the global swap. Avoids polluting other open
  // terminals with the new account.
  let extraEnv: NodeJS.ProcessEnv | undefined;
  if (payload.defaultIsolated) {
    try {
      const { ensureProfileForAccount } = await import('../profiles/profiles.js');
      // ensureProfileForAccount is async and handles the legacy-snapshot
      // refresh internally.
      const ensured = await ensureProfileForAccount(payload.switchedTo, accountsDirPath);
      if (ensured.needsLogin) {
        return {
          kind: 'warning',
          text: `Profile "${ensured.profileName}" needs a one-time browser login. Run: claude switch profile login ${ensured.profileName}`,
        };
      }
      extraEnv = { CLAUDE_CONFIG_DIR: ensured.profilePath };
      process.stderr.write(`🔑 ${payload.switchedTo} (isolated · profile: ${ensured.profileName})\n\n`);
    } catch (e) {
      return { kind: 'error', text: e instanceof Error ? e.message : String(e) };
    }
  }

  // Record the launch in the live-session registry. `extraEnv` carries
  // CLAUDE_CONFIG_DIR only for the default-isolated path; otherwise this is a
  // global-bound session. Best-effort; prune-on-read reclaims it on exit.
  markSessionLive(accountsDirPath, {
    account: payload.switchedTo,
    configDir: extraEnv?.CLAUDE_CONFIG_DIR ?? null,
    cwd: process.cwd(),
  });

  const { command, args, options } = buildSpawnArgs(bin, [], process.platform, extraEnv);
  const result = nodeProcessAdapter.spawnSync(command, args, options);
  if (result.error) {
    throw new ExitError(`Error: could not launch claude: ${result.error.message}`, 1);
  }
  throw new ExitError('', result.status ?? 0);
}

export async function handleAdd(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
  const bin = findClaudeBinary(import.meta.url);
  if (!bin) return { kind: 'error', text: 'Could not find the real claude binary — run setup first.' };
  const result = await runAddAccountScreen(bin, claudeJsonPath, accountsDirPath);
  if (result.cancelled) return { kind: 'info', text: 'No account added.' };
  if (result.email) {
    return {
      kind: 'success',
      text: result.alias ? `Added ${result.email} (alias: ${result.alias})` : `Added ${result.email}`,
    };
  }
  return null;
}

export async function handleApikey(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
  const current = getCurrent(claudeJsonPath);
  if (!current) return { kind: 'error', text: 'No active account. Add or switch to one first.' };
  const result = await runApikeyScreen(current, accountsDirPath);
  if (result.saved) return { kind: 'success', text: `API key saved for ${current}.` };
  if (result.cancelled) return { kind: 'info', text: 'API key unchanged.' };
  return { kind: 'error', text: 'API key save failed.' };
}

export async function handleFallbackToggle(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
  const wasOn = isFallbackEnabled(accountsDirPath);
  if (!wasOn) {
    // Trying to turn ON.
    const current = getCurrent(claudeJsonPath);
    if (!current) return { kind: 'error', text: 'No active account. Add or switch to one first.' };
    const currentKey = getApiKey(current, accountsDirPath);
    if (!currentKey) {
      const setNow = await runConfirm(
        'No API key for active account',
        `${current} has no saved API key — enabling fallback would do nothing.\nSet one now?`,
        true,
      );
      if (!setNow) return { kind: 'info', text: 'Fallback unchanged.' };
      const result = await runApikeyScreen(current, accountsDirPath);
      if (!result.saved || !getApiKey(current, accountsDirPath)) {
        return { kind: 'info', text: 'Fallback unchanged (no key saved).' };
      }
    }
    setFallbackEnabled(accountsDirPath, true);
    return {
      kind: 'success',
      text: 'Fallback ON. First "claude" run will prompt "Use this API key? [y/N]" — press y.',
    };
  }
  // Trying to turn OFF.
  const current = getCurrent(claudeJsonPath);
  const health = current ? getTokenHealth(claudeJsonPath) : null;
  if (health && (health.status === 'expired' || health.status === 'missing')) {
    const proceed = await runConfirm(
      'OAuth dead',
      `OAuth token is ${health.status === 'expired' ? 'EXPIRED' : 'missing'}.\nDisabling fallback now leaves no working auth until you re-authenticate.\nTurn fallback OFF anyway?`,
      false,
    );
    if (!proceed) return { kind: 'info', text: 'Fallback still ON.' };
  }
  setFallbackEnabled(accountsDirPath, false);
  return { kind: 'success', text: 'Fallback OFF. Next claude run uses OAuth subscription.' };
}

export async function handleReauth(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
  const bin = findClaudeBinary(import.meta.url);
  if (!bin) return { kind: 'error', text: 'Could not find claude binary — run setup first.' };
  process.stderr.write('\nA browser window will open. Complete the login and return here.\n\n');
  try {
    const result = await reAuthenticate(bin, claudeJsonPath, accountsDirPath);
    return result
      ? { kind: 'success', text: `Tokens refreshed for ${result}` }
      : { kind: 'info', text: 'Login did not complete — token state unchanged.' };
  } catch (e) {
    return { kind: 'error', text: e instanceof Error ? e.message : String(e) };
  }
}

export async function handleRemove(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
  const target = await runPickAccount('Remove which account?', accountsDirPath, getCurrent(claudeJsonPath));
  if (!target) return { kind: 'info', text: 'Removal cancelled.' };
  const result = await runRemoveAccountScreen(target, claudeJsonPath, accountsDirPath);
  if (result.removed) return { kind: 'success', text: `Removed ${target}.` };
  if (result.cancelled) return { kind: 'info', text: 'Removal cancelled.' };
  return { kind: 'error', text: `Could not remove ${target}.` };
}

export async function handleProfiles(accountsDirPath: string): Promise<Notice> {
  const bin = findClaudeBinary(import.meta.url);
  if (!bin) return { kind: 'error', text: 'Could not find the real claude binary — run setup first.' };
  // The profiles screen owns its own buffer + spawn lifecycle (it may
  // throw ExitError to launch claude in an isolated session). The no-op
  // restoreBuffer is fine since Ink already restores its own buffer when
  // it unmounts.
  await runProfilesScreen(accountsDirPath, bin, () => undefined);
  return null;
}

export async function handleUsage(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
  const token = getAccessTokenFromKeychain(claudeJsonPath);
  if (!token) {
    return { kind: 'error', text: 'No OAuth access token available — only Max/Pro subscribers.' };
  }
  process.stderr.write('Fetching latest usage…\n');
  const account = getCurrent(claudeJsonPath) || undefined;
  const cache = await fetchUsageCached(accountsDirPath, token, { force: true, account });
  if (cache.rateLimitedUntil && cache.rateLimitedUntil > Date.now()) {
    const wait = Math.ceil((cache.rateLimitedUntil - Date.now()) / 1000);
    return { kind: 'warning', text: `Rate-limited. Retry in ~${wait}s.` };
  }
  if (cache.payload) {
    const five = cache.payload.five_hour.utilization.toFixed(1);
    const seven = cache.payload.seven_day.utilization.toFixed(1);
    return { kind: 'success', text: `Usage refreshed — 5h ${five}% · 7d ${seven}%` };
  }
  return { kind: 'error', text: 'Endpoint unreachable. Try again later.' };
}
