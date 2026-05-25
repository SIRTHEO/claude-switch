// src/switcher-temporary.ts
// `claude --as <account> -- <cmd>`: run a single command as another account,
// then restore the original — even on Ctrl-C. The save/load swap is atomic
// w.r.t. other claude-switch processes; the spawn happens after the lock is
// released.

import { getCurrent, load, save } from './accounts.js';
import { withLock } from './lock.js';
import { nodeProcessAdapter } from './process.js';
import { buildSpawnArgs } from './proxy.js';
import type { SwitcherDeps } from './switcher-deps.js';
import { clearPendingRestore, savePendingRestoreInLock } from './switcher-pending.js';

export async function runTemporarySwitch(
  claudeBin: string,
  targetEmail: string,
  args: string[],
  claudeJsonPath: string,
  accountsDirPath: string,
  extraEnv?: NodeJS.ProcessEnv | null,
  deps?: SwitcherDeps,
): Promise<never> {
  const doSpawnSync = (deps?.process ?? nodeProcessAdapter).spawnSync;
  const doExit: (code: number) => never = deps?.exitFn ?? ((code: number) => process.exit(code));
  const doSave = deps?.saveFn ?? save;
  const doLoad = deps?.loadFn ?? load;
  const currentEmail = getCurrent(claudeJsonPath);

  if (targetEmail === currentEmail) {
    const { command, args: spawnArgs, options } = buildSpawnArgs(claudeBin, args, process.platform, extraEnv);
    const result = doSpawnSync(command, spawnArgs, options);
    if (result.error) {
      console.error(`Error: could not run claude: ${result.error.message}`);
      doExit(1);
    }
    doExit(result.status ?? 1);
  }

  // Critical section: save current + load target must be atomic w.r.t. other
  // claude-switch processes. We acquire the lock, perform the swap, and
  // release before spawning (which can be long-running).
  let keychainRestored = false;
  withLock(accountsDirPath, () => {
    if (currentEmail) {
      savePendingRestoreInLock(currentEmail, accountsDirPath);
      doSave(currentEmail, claudeJsonPath, accountsDirPath);
    }
    const result = doLoad(targetEmail, claudeJsonPath, accountsDirPath);
    keychainRestored = result.keychainRestored;
  });

  if (!keychainRestored && process.platform === 'darwin') {
    process.stderr.write(`Warning: no saved credentials for ${targetEmail} — API tokens may belong to a different account.\nRun: claude switch add (to re-authenticate and capture tokens)\n\n`);
  }
  // Banner on stderr to keep stdout clean for structured output.
  process.stderr.write(`🔑 ${targetEmail} (temporary)\n\n`);

  // Register SIGINT handler so we restore the original account even on Ctrl-C.
  // spawnSync is a blocking call: when SIGINT arrives the OS delivers it to
  // the whole process group (child exits first, then spawnSync returns), and
  // Node.js then fires this handler synchronously before process.exit runs.
  let restored = false;
  const restoreOriginal = (): void => {
    if (restored) return;
    restored = true;
    if (currentEmail) {
      try {
        withLock(accountsDirPath, () => {
          doLoad(currentEmail, claudeJsonPath, accountsDirPath);
        });
      } catch { /* best-effort */ }
      clearPendingRestore(accountsDirPath);
    }
  };

  process.once('SIGINT', () => {
    restoreOriginal();
    doExit(130);
  });

  const { command, args: spawnArgs, options } = buildSpawnArgs(claudeBin, args, process.platform, extraEnv);
  const result = doSpawnSync(command, spawnArgs, options);

  restoreOriginal();

  if (result.error) {
    console.error(`Error: could not run claude: ${result.error.message}`);
    doExit(1);
  }
  doExit(result.status ?? 1);
}
