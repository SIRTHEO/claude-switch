// src/switcher.ts
import readline from 'node:readline';
import fs from 'node:fs';
import { type ProcessPort, nodeProcessAdapter } from './process.js';
import { getCurrent, save, load, list, syncActiveSnapshotIfStale } from './accounts.js';
import { setAlias } from './aliases.js';
import { buildSpawnArgs } from './proxy.js';
import { ExitError } from './errors.js';
import { withLock } from './lock.js';
import { getApiKey } from './apikey.js';
import { isFallbackEnabled, setFallbackEnabledInLock } from './fallback.js';
import { updateState, updateStateInLock } from './state-store.js';
import { shouldTriggerUsageRefreshAfterSwitch, triggerBackgroundUsageRefresh } from './usage.js';

export interface SwitcherDeps {
  process?: ProcessPort;
  askFn?: (question: string) => Promise<string>;
  exitFn?: (code: number) => never;
  getTokenHealthFn?: (claudeJsonPath: string) => { status: string } | null;
  saveFn?: (email: string, claudeJsonPath: string, accountsDirPath: string) => void;
  loadFn?: (email: string, claudeJsonPath: string, accountsDirPath: string) => { keychainRestored: boolean };
}

function defaultAsk(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function switchTo(targetEmail: string, claudeJsonPath: string, accountsDirPath: string): string {
  return withLock(accountsDirPath, () => {
    // Re-save the active snapshot if claude itself rotated tokens
    // since the last switch (typically: user did `/login` inside a
    // claude session). Without this the next switch would capture
    // STALE state into the file we already saved.
    syncActiveSnapshotIfStale(claudeJsonPath, accountsDirPath);

    const currentEmail = getCurrent(claudeJsonPath);

    if (targetEmail === currentEmail) {
      return `Already on ${targetEmail}`;
    }

    if (currentEmail) {
      save(currentEmail, claudeJsonPath, accountsDirPath);
    }

    const { keychainRestored } = load(targetEmail, claudeJsonPath, accountsDirPath);

    // Pre-fetch usage for the target so the next statusline redraw doesn't
    // show "no badge" while the in-band stale check spawns its own refresh.
    // Cheap detached spawn; only fires when the target account's per-account
    // cache is missing or stale.
    if (shouldTriggerUsageRefreshAfterSwitch(accountsDirPath, targetEmail)) {
      triggerBackgroundUsageRefresh();
    }

    const warning = keychainRestored
      ? ''
      : '\nWarning: no saved credentials for this account — API tokens may be wrong.\nRun: claude switch add (to re-authenticate and capture tokens)';
    return `Switched to ${targetEmail}${warning}`;
  });
}

interface SwitchOutcome {
  /** Human-readable status line (already includes any warning). */
  message: string;
  /** Whether the new account has a saved API key. */
  hasApiKey: boolean;
  /** Whether the fallback flag was actually flipped during this call. */
  fallbackFlipped: boolean;
}

/**
 * Switch + atomically reconcile the global fallback flag with the new
 * account's API-key capability, all under one `withLock`. The single-lock
 * invariant is what protects against this race: caller A reads `hasKey`
 * for account B, B becomes active, A's deferred `setFallbackEnabled(true)`
 * lands and the system is now `active=B / fallback=ON / B has no key`.
 *
 * Bundling the read and write here closes the window. Mirrors the lock
 * pattern in `bin/cli.ts:1263` (`passthrough` snapshot).
 */
export function switchToAndSyncFallback(
  targetEmail: string,
  claudeJsonPath: string,
  accountsDirPath: string,
  options: { autoFlipFallback: boolean },
): SwitchOutcome {
  return withLock(accountsDirPath, () => {
    // Same drift-prevention as switchTo: capture in-flight token
    // rotations from a `/login` issued inside a running claude session.
    syncActiveSnapshotIfStale(claudeJsonPath, accountsDirPath);

    const currentEmail = getCurrent(claudeJsonPath);

    if (targetEmail === currentEmail) {
      const hasApiKey = !!getApiKey(targetEmail, accountsDirPath);
      return { message: `Already on ${targetEmail}`, hasApiKey, fallbackFlipped: false };
    }

    if (currentEmail) {
      save(currentEmail, claudeJsonPath, accountsDirPath);
    }

    const { keychainRestored } = load(targetEmail, claudeJsonPath, accountsDirPath);
    const hasApiKey = !!getApiKey(targetEmail, accountsDirPath);
    // `keychainRestored` doubles as our "the target account has OAuth
    // creds available" signal — `load()` only reports it when the
    // account file carried a `_keychain` snapshot.
    const hasOAuth = keychainRestored;

    let fallbackFlipped = false;
    if (options.autoFlipFallback) {
      // Auto-flip semantics: fallback should be ON only when the target
      // account has API key AND no OAuth (key-only account — proxy has
      // no other auth source). Accounts with OAuth + saved key should
      // default to OAuth, with the API key kept as a manual emergency
      // toggle. Pre-3.6 this flipped purely on `hasApiKey`, which
      // silently routed every request through the API key (Anthropic
      // Console billing) on accounts that had a perfectly good
      // subscription OAuth — the exact regression that caused users to
      // bleed credit after a routine `claude switch`.
      const wantedFallback = hasApiKey && !hasOAuth;
      const wasOn = isFallbackEnabled(accountsDirPath);
      if (wasOn !== wantedFallback) {
        setFallbackEnabledInLock(accountsDirPath, wantedFallback);
        fallbackFlipped = true;
      }
    }

    // Pre-fetch usage for the new account (same pattern as switchTo above).
    // Fires only when the target's per-account cache is stale so
    // back-to-back switches between two fresh-cached accounts don't waste
    // network calls.
    if (shouldTriggerUsageRefreshAfterSwitch(accountsDirPath, targetEmail)) {
      triggerBackgroundUsageRefresh();
    }

    const warning = keychainRestored
      ? ''
      : '\nWarning: no saved credentials for this account — API tokens may be wrong.\nRun: claude switch add (to re-authenticate and capture tokens)';
    return { message: `Switched to ${targetEmail}${warning}`, hasApiKey, fallbackFlipped };
  });
}

export function fuzzyMatch(input: string, accounts: string[]): string[] {
  const lower = input.toLowerCase();

  // Exact match first
  const exact = accounts.find(a => a === input);
  if (exact) return [exact];

  // Partial match (case-insensitive)
  return accounts.filter(a => a.toLowerCase().includes(lower));
}

export async function switchInteractive(claudeJsonPath: string, accountsDirPath: string, deps?: SwitcherDeps): Promise<void> {
  const ask = deps?.askFn ?? defaultAsk;
  const accounts = list(accountsDirPath);
  const currentEmail = getCurrent(claudeJsonPath);

  if (accounts.length === 0) {
    console.log('No saved accounts. Run: claude switch add');
    return;
  }

  if (accounts.length < 2) {
    console.log('Only one account saved. Run: claude switch add');
    return;
  }

  console.log('Accounts:\n');
  accounts.forEach((email, i) => {
    const marker = email === currentEmail ? ' (active)' : '';
    console.log(`  ${i + 1}) ${email}${marker}`);
  });

  const choice = await ask(`\nSwitch to [1-${accounts.length}]: `);
  const index = parseInt(choice, 10);

  if (Number.isNaN(index) || index < 1 || index > accounts.length) {
    throw new ExitError('Invalid choice.');
  }

  console.log(switchTo(accounts[index - 1]!, claudeJsonPath, accountsDirPath));
}

/** Save a pending-restore marker. Acquires the lock itself.
 *  Use from contexts with no surrounding `withLock`. */
export function savePendingRestore(email: string, accountsDirPath: string): void {
  fs.mkdirSync(accountsDirPath, { recursive: true });
  updateState(accountsDirPath, (state) => ({ ...state, pendingRestore: email }));
}

/** Save a pending-restore marker INSIDE an existing `withLock`. */
function savePendingRestoreInLock(email: string, accountsDirPath: string): void {
  fs.mkdirSync(accountsDirPath, { recursive: true });
  updateStateInLock(accountsDirPath, (state) => ({ ...state, pendingRestore: email }));
}

export function checkPendingRestore(claudeJsonPath: string, accountsDirPath: string): string | null {
  // Atomically: read the pending email AND clear it in one locked pass.
  // If we read first and clear later, two concurrent claude-switch
  // processes could both consume the same restore. The lambda captures
  // the prior value into a closure variable before returning the cleared
  // state to the writer.
  let extracted: string | undefined;
  updateState(accountsDirPath, (state) => {
    extracted = state.pendingRestore;
    if (!extracted) return state;
    const { pendingRestore: _drop, ...rest } = state;
    return rest as typeof state;
  });
  if (!extracted) return null;

  // The restore step takes its own lock — the marker has been cleared
  // already so a failed restore won't loop on the next invocation.
  try {
    withLock(accountsDirPath, () => {
      load(extracted!, claudeJsonPath, accountsDirPath);
    });
    return extracted;
  } catch {
    return null;
  }
}

export function clearPendingRestore(accountsDirPath: string): void {
  // No-op when the state file doesn't exist yet — readState returns
  // EMPTY_STATE, the patch removes a field that wasn't there.
  if (!fs.existsSync(accountsDirPath)) return;
  updateState(accountsDirPath, (state) => {
    const { pendingRestore: _drop, ...rest } = state;
    return rest as typeof state;
  });
}

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

/**
 * Pure decision logic for whether a re-auth attempt actually refreshed
 * the tokens. Extracted so it can be unit-tested without spawning a
 * real `claude auth login`.
 *
 * Returns the email to save (success), or null when:
 *   - login left no active account (emailAfter empty),
 *   - login changed the active account (silent swap — don't trust),
 *   - token was broken before AND is still broken after (login cancelled).
 */
export function reAuthOutcome(
  emailBefore: string,
  healthBefore: { status: string } | null | undefined,
  emailAfter: string,
  healthAfter: { status: string } | null | undefined,
): string | null {
  if (!emailAfter) return null;
  if (emailBefore && emailAfter !== emailBefore) return null;
  const wasBroken = !healthBefore || healthBefore.status === 'expired' || healthBefore.status === 'missing';
  const stillBroken = !healthAfter || healthAfter.status === 'expired' || healthAfter.status === 'missing';
  if (wasBroken && stillBroken) return null;
  return emailAfter;
}

/**
 * Run `claude auth login` for the currently-active account to refresh its
 * Keychain tokens after expiry. Differs from addAccount in that we expect
 * the email to stay the same — we just want fresh tokens captured.
 *
 * Returns the email that's now active after the login, or null if login
 * failed entirely (no oauthAccount left in claude.json) or was cancelled.
 */
export async function reAuthenticate(
  claudeBin: string,
  claudeJsonPath: string,
  accountsDirPath: string,
  deps?: SwitcherDeps,
): Promise<string | null> {
  const doSpawnSync = (deps?.process ?? nodeProcessAdapter).spawnSync;
  const { getTokenHealth } = await import('./token.js');
  const getHealth = deps?.getTokenHealthFn ?? getTokenHealth;
  const emailBefore = getCurrent(claudeJsonPath);
  const healthBefore = getHealth(claudeJsonPath);

  const { command, args, options } = buildSpawnArgs(claudeBin, ['auth', 'login'], process.platform);
  doSpawnSync(command, args, options);

  const emailAfter = getCurrent(claudeJsonPath);
  const healthAfter = getHealth(claudeJsonPath);

  const outcome = reAuthOutcome(emailBefore, healthBefore, emailAfter, healthAfter);
  if (!outcome) return null;

  withLock(accountsDirPath, () => save(outcome, claudeJsonPath, accountsDirPath));
  return outcome;
}

export async function addAccount(claudeBin: string, claudeJsonPath: string, accountsDirPath: string, deps?: SwitcherDeps): Promise<void> {
  const ask = deps?.askFn ?? defaultAsk;
  const doSpawnSync = (deps?.process ?? nodeProcessAdapter).spawnSync;
  const currentEmail = getCurrent(claudeJsonPath);
  const expectedEmail = await ask('Email to add (press Enter to skip): ');

  if (currentEmail) {
    withLock(accountsDirPath, () => save(currentEmail, claudeJsonPath, accountsDirPath));
  }

  console.log('\nLog in with the new account in your browser.\n');

  while (true) {
    const { command: loginCmd, args: loginArgs, options: loginOpts } = buildSpawnArgs(claudeBin, ['auth', 'login'], process.platform);
    doSpawnSync(loginCmd, loginArgs, loginOpts);

    const newEmail = getCurrent(claudeJsonPath);
    if (!newEmail) {
      if (currentEmail) {
        withLock(accountsDirPath, () => load(currentEmail, claudeJsonPath, accountsDirPath));
      }
      throw new ExitError('Login failed or cancelled.');
    }

    // If email didn't change, login was cancelled (browser closed)
    if (newEmail === currentEmail) {
      console.log('\nLogin cancelled (account unchanged).');
      return;
    }

    console.log(`\nAuthenticated: ${newEmail}`);
    // Save immediately after login so the Keychain tokens are captured.
    withLock(accountsDirPath, () => save(newEmail, claudeJsonPath, accountsDirPath));
    console.log(`Saved: ${newEmail}`);

    if (list(accountsDirPath).length === 1) {
      console.log('\nFirst account saved! Add another with: claude switch add');
    }

    const aliasName = await ask('Alias (press Enter to skip): ');
    if (aliasName) {
      setAlias(aliasName, newEmail, accountsDirPath);
      console.log(`Alias set: ${aliasName} → ${newEmail}`);
    }

    if (!expectedEmail || newEmail === expectedEmail) break;

    console.log(`\n(expected ${expectedEmail})`);
    const retry = await ask(`Retry login for ${expectedEmail}? [y/N]: `);
    if (retry.toLowerCase() !== 'y') break;

    console.log('\nLog in with the new account in your browser.\n');
  }
}
