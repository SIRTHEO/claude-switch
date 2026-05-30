// src/ui/run-app.ts
// Orchestrator for the Ink-based persistent menu. Replaces the clack
// `runMainMenu`. Loops over the home screen; each home action is dispatched
// to the right sub-screen / spawn / inline prompt, then the loop continues
// with an optional "notice" to surface on the next render.
//
// Keeping the orchestrator outside React keeps spawn handling and process
// exits straightforward — Ink owns rendering, this owns control flow. The
// per-action handlers live in run-app-handlers.ts; this file owns the
// dispatch loop and the alt-buffer / signal lifecycle.

import { getCurrent } from '../accounts/accounts.js';
import { ExitError } from '../platform/errors.js';
import { runSetupWizardScreen } from './screens/setup-wizard.js';

import { renderHome, type HomeExit } from './screens/home.js';
import { runAutoFallbackScreen } from './screens/auto-fallback.js';
import { runManageAccount } from './screens/manage-account.js';
import { runSettingsScreen } from './screens/settings.js';
import { ALT_BUFFER_ENTER, ALT_BUFFER_EXIT, altBufferSupported } from './screen-buffer.js';
import { readGlobalPrefs } from '../switching/preferences.js';
import {
  refreshUsageOnEntry,
  handleSwitched,
  handleAdd,
  handleApikey,
  handleFallbackToggle,
  handleReauth,
  handleRemove,
  handleProfiles,
  handleUsage,
  type Notice,
} from './run-app-handlers.js';

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

/**
 * Internal handlers exposed for the unit-test suite. Production code calls the
 * handlers via `runApp()` → `_runDispatchLoop`; the tests skip that envelope
 * and verify each handler's pure I/O contract against a tmpdir fixture. The
 * handlers themselves live in run-app-handlers.ts. Renaming or removing any of
 * these breaks tests but not production.
 */
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
