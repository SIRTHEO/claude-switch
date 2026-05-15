// src/ui/run-app.ts
// Orchestrator for the Ink-based persistent menu. Replaces the clack
// `runMainMenu`. Loops over the home screen; each home action is dispatched
// to the right sub-screen / spawn / inline prompt, then the loop continues
// with an optional "notice" to surface on the next render.
//
// Keeping the orchestrator outside React keeps spawn handling and process
// exits straightforward — Ink owns rendering, this owns control flow.

import { spawnSync } from 'node:child_process';

import { getCurrent } from '../accounts.js';
import { ExitError } from '../errors.js';
import { isFallbackEnabled, setFallbackEnabled } from '../fallback.js';
import { getApiKey } from '../apikey.js';
import {
  readUsageCacheForAccount,
  isUsageCacheStale,
  fetchUsageCached,
  getAccessTokenFromKeychain,
} from '../usage.js';
import { findClaudeBinary } from '../find-claude.js';
import { getTokenHealth } from '../token.js';
import { reAuthenticate } from '../switcher.js';
import { buildSpawnArgs } from '../proxy.js';
import { runSetupWizardScreen } from './screens/setup-wizard.js';

import { renderHome, type HomeExit } from './screens/home.js';
import { runApikeyScreen } from './screens/set-apikey.js';
import { runAddAccountScreen } from './screens/add-account.js';
import { runRemoveAccountScreen } from './screens/remove-account.js';
import { runProfilesScreen } from './screens/profiles.js';
import { runAutoFallbackScreen } from './screens/auto-fallback.js';
import { runManageAccount } from './screens/manage-account.js';
import { runConfirm } from './screens/confirm.js';
import { runPickAccount } from './screens/pick-account.js';
import { runSettingsScreen } from './screens/settings.js';
import { ALT_BUFFER_ENTER, ALT_BUFFER_EXIT, altBufferSupported } from './screen-buffer.js';
import { readGlobalPrefs } from '../preferences.js';

type Notice = Parameters<typeof renderHome>[2];

/**
 * Internal handlers exposed for the unit-test suite. Production code
 * calls them via `runApp()`, which wires the alt-buffer + signal
 * lifecycle around the dispatcher loop. The tests skip that envelope
 * and verify each handler's pure I/O contract against a tmpdir
 * fixture. Renaming or removing any of these breaks tests but not
 * production.
 */
/**
 * Factory for the SIGINT handler installed by runApp(). Exposed for testing
 * so the signal lifecycle can be verified without spawning a subprocess or
 * requiring a real TTY.
 *
 * @internal
 */
function makeSigintHandler(restoreBuffer: () => void): () => never {
  return (): never => {
    restoreBuffer();
    process.exit(130);
  };
}

/**
 * Factory for the SIGTERM handler installed by runApp(). Exposed for testing.
 *
 * @internal
 */
function makeSigtermHandler(restoreBuffer: () => void): () => never {
  return (): never => {
    restoreBuffer();
    process.exit(143);
  };
}

export const _internal = {
  refreshUsageOnEntry,
  handleSwitched,
  handleAdd,
  handleApikey,
  handleFallbackToggle,
  handleReauth,
  handleRemove,
  handleProfiles,
  handleUsage,
  makeSigintHandler,
  makeSigtermHandler,
};

/**
 * Exposed for testing: runs the home-screen dispatch loop with a
 * caller-supplied `renderHome` stub. Production code uses `runApp()`,
 * which wires `renderHome` from `./screens/home.js`. Zero behavior
 * difference — only the rendering dependency is injected.
 *
 * @internal
 */
export async function _runDispatchLoop(
  claudeJsonPath: string,
  accountsDirPath: string,
  renderHomeFn: typeof renderHome,
): Promise<void> {
  let notice: Notice = null;
  while (true) {
    const r: HomeExit = await renderHomeFn(claudeJsonPath, accountsDirPath, notice);
    notice = null;

    try {
      switch (r.action) {
        case 'exit':
          return;
        case 'switched':
          if (r.payload) {
            const sw = await handleSwitched(r.payload, accountsDirPath);
            if (sw) notice = sw;
          }
          break;
        case 'add':
          notice = await handleAdd(claudeJsonPath, accountsDirPath);
          break;
        case 'manage':
          await runManageAccount(claudeJsonPath, accountsDirPath);
          break;
        case 'apikey':
          notice = await handleApikey(claudeJsonPath, accountsDirPath);
          break;
        case 'fallback-toggle':
          notice = await handleFallbackToggle(claudeJsonPath, accountsDirPath);
          break;
        case 'auto-fallback':
          await runAutoFallbackScreen(accountsDirPath);
          break;
        case 'profiles':
          notice = await handleProfiles(accountsDirPath);
          break;
        case 'usage':
          notice = await handleUsage(claudeJsonPath, accountsDirPath);
          break;
        case 'reauth':
          notice = await handleReauth(claudeJsonPath, accountsDirPath);
          break;
        case 'remove':
          notice = await handleRemove(claudeJsonPath, accountsDirPath);
          break;
        case 'setup':
          await runSetupWizardScreen(process.argv[1] ?? '');
          break;
        case 'settings':
          await runSettingsScreen(accountsDirPath, getCurrent(claudeJsonPath) || null);
          break;
      }
    } catch (e) {
      if (e instanceof ExitError) throw e;
      notice = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
    }
  }
}

async function refreshUsageOnEntry(claudeJsonPath: string, accountsDirPath: string): Promise<void> {
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

async function handleSwitched(
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
      const { ensureProfileForAccount } = await import('../profiles.js');
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

  const { command, args, options } = buildSpawnArgs(bin, [], process.platform, extraEnv);
  const result = spawnSync(command, args, options);
  if (result.error) {
    throw new ExitError(`Error: could not launch claude: ${result.error.message}`, 1);
  }
  throw new ExitError('', result.status ?? 0);
}

async function handleAdd(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
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

async function handleApikey(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
  const current = getCurrent(claudeJsonPath);
  if (!current) return { kind: 'error', text: 'No active account. Add or switch to one first.' };
  const result = await runApikeyScreen(current, accountsDirPath);
  if (result.saved) return { kind: 'success', text: `API key saved for ${current}.` };
  if (result.cancelled) return { kind: 'info', text: 'API key unchanged.' };
  return { kind: 'error', text: 'API key save failed.' };
}

async function handleFallbackToggle(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
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

async function handleReauth(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
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

async function handleRemove(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
  const target = await runPickAccount('Remove which account?', accountsDirPath, getCurrent(claudeJsonPath));
  if (!target) return { kind: 'info', text: 'Removal cancelled.' };
  const result = await runRemoveAccountScreen(target, claudeJsonPath, accountsDirPath);
  if (result.removed) return { kind: 'success', text: `Removed ${target}.` };
  if (result.cancelled) return { kind: 'info', text: 'Removal cancelled.' };
  return { kind: 'error', text: `Could not remove ${target}.` };
}

async function handleProfiles(accountsDirPath: string): Promise<Notice> {
  const bin = findClaudeBinary(import.meta.url);
  if (!bin) return { kind: 'error', text: 'Could not find the real claude binary — run setup first.' };
  // The profiles screen owns its own buffer + spawn lifecycle (it may
  // throw ExitError to launch claude in an isolated session). The no-op
  // restoreBuffer is fine since Ink already restores its own buffer when
  // it unmounts.
  await runProfilesScreen(accountsDirPath, bin, () => undefined);
  return null;
}

async function handleUsage(claudeJsonPath: string, accountsDirPath: string): Promise<Notice> {
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

export async function runApp(claudeJsonPath: string, accountsDirPath: string): Promise<void> {
  // Wrap the whole session in the alt buffer so each Ink mount/unmount
  // doesn't leave a stack of stale frames in the user's scrollback. The
  // restore handler runs on every shutdown path (normal exit, SIGINT,
  // SIGTERM) so a panic doesn't strand the user inside the alt buffer.
  const useAlt = altBufferSupported() && readGlobalPrefs(accountsDirPath).useAltBuffer;
  let cleaned = false;
  const restoreBuffer = (): void => {
    if (cleaned || !useAlt) return;
    cleaned = true;
    process.stdout.write(ALT_BUFFER_EXIT);
  };
  const sigintHandler = (): void => { restoreBuffer(); process.exit(130); };
  const sigtermHandler = (): void => { restoreBuffer(); process.exit(143); };
  if (useAlt) {
    process.stdout.write(ALT_BUFFER_ENTER);
    process.once('exit', restoreBuffer);
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
  }

  try {
  await refreshUsageOnEntry(claudeJsonPath, accountsDirPath);
  await _runDispatchLoop(claudeJsonPath, accountsDirPath, renderHome);
  } finally {
    restoreBuffer();
    if (useAlt) {
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
      process.removeListener('exit', restoreBuffer);
    }
  }
}
