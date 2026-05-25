// src/switcher.ts
// Core account switching (lock-disciplined) plus the interactive switch/add
// flows. Pending-restore markers, the temporary `--as` runner, and re-auth
// live in sibling modules (switcher-pending / switcher-temporary /
// switcher-reauth) and are re-exported here so importers keep using
// `./switcher.js`.

import readline from 'node:readline';
import { getApiKey } from '../credentials/apikey.js';
import { getCurrent, list, load, save, syncActiveSnapshotIfStale } from '../accounts/accounts.js';
import { setAlias } from './aliases.js';
import { ExitError } from '../platform/errors.js';
import { isFallbackEnabled, setFallbackEnabledInLock } from '../fallback/fallback.js';
import { withLock } from '../platform/lock.js';
import { nodeProcessAdapter } from '../platform/process.js';
import { buildSpawnArgs } from '../proxy/proxy.js';
import { shouldTriggerUsageRefreshAfterSwitch, triggerBackgroundUsageRefresh } from '../usage/usage.js';
import type { SwitcherDeps } from './switcher-deps.js';

export type { SwitcherDeps } from './switcher-deps.js';
export { checkPendingRestore, clearPendingRestore, savePendingRestore } from './switcher-pending.js';
export { reAuthOutcome, reAuthenticate } from './switcher-reauth.js';
export { runTemporarySwitch } from './switcher-temporary.js';

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
