// src/switcher.ts
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getCurrent, save, load, list } from './accounts.js';
import { setAlias } from './aliases.js';
import { buildSpawnArgs } from './proxy.js';
import { ExitError } from './errors.js';
import { withLock } from './lock.js';

function ask(question: string): Promise<string> {
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
    const currentEmail = getCurrent(claudeJsonPath);

    if (targetEmail === currentEmail) {
      return `Already on ${targetEmail}`;
    }

    if (currentEmail) {
      save(currentEmail, claudeJsonPath, accountsDirPath);
    }

    const { keychainRestored } = load(targetEmail, claudeJsonPath, accountsDirPath);
    const warning = keychainRestored
      ? ''
      : '\nWarning: no saved credentials for this account — API tokens may be wrong.\nRun: claude switch add (to re-authenticate and capture tokens)';
    return `Switched to ${targetEmail}${warning}`;
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

export async function switchInteractive(claudeJsonPath: string, accountsDirPath: string): Promise<void> {
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

  if (isNaN(index) || index < 1 || index > accounts.length) {
    throw new ExitError('Invalid choice.');
  }

  console.log(switchTo(accounts[index - 1], claudeJsonPath, accountsDirPath));
}

export function savePendingRestore(email: string, accountsDirPath: string): void {
  const filePath = path.join(accountsDirPath, '.pending-restore');
  fs.mkdirSync(accountsDirPath, { recursive: true });
  fs.writeFileSync(filePath, email);
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
  }
}

export function checkPendingRestore(claudeJsonPath: string, accountsDirPath: string): string | null {
  const filePath = path.join(accountsDirPath, '.pending-restore');
  let email: string;
  try {
    email = fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return null;
  }
  if (!email) return null;

  // Drop the pending marker first, then attempt the restore. If the restore
  // throws, we don't want a stale marker to wedge subsequent invocations
  // into an infinite retry loop.
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }

  try {
    withLock(accountsDirPath, () => {
      load(email, claudeJsonPath, accountsDirPath);
    });
    return email;
  } catch {
    return null;
  }
}

export function clearPendingRestore(accountsDirPath: string): void {
  const filePath = path.join(accountsDirPath, '.pending-restore');
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

export async function runTemporarySwitch(
  claudeBin: string,
  targetEmail: string,
  args: string[],
  claudeJsonPath: string,
  accountsDirPath: string,
  extraEnv?: NodeJS.ProcessEnv | null,
): Promise<never> {
  const currentEmail = getCurrent(claudeJsonPath);

  if (targetEmail === currentEmail) {
    const { command, args: spawnArgs, options } = buildSpawnArgs(claudeBin, args, process.platform, extraEnv);
    const result = spawnSync(command, spawnArgs, options);
    if (result.error) {
      console.error(`Error: could not run claude: ${result.error.message}`);
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  }

  // Critical section: save current + load target must be atomic w.r.t. other
  // claude-switch processes. We acquire the lock, perform the swap, and
  // release before spawning (which can be long-running).
  let keychainRestored = false;
  withLock(accountsDirPath, () => {
    if (currentEmail) {
      savePendingRestore(currentEmail, accountsDirPath);
      save(currentEmail, claudeJsonPath, accountsDirPath);
    }
    const result = load(targetEmail, claudeJsonPath, accountsDirPath);
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
          load(currentEmail, claudeJsonPath, accountsDirPath);
        });
      } catch { /* best-effort */ }
      clearPendingRestore(accountsDirPath);
    }
  };

  process.once('SIGINT', () => {
    restoreOriginal();
    process.exit(130);
  });

  const { command, args: spawnArgs, options } = buildSpawnArgs(claudeBin, args, process.platform, extraEnv);
  const result = spawnSync(command, spawnArgs, options);

  restoreOriginal();

  if (result.error) {
    console.error(`Error: could not run claude: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

/**
 * Run `claude auth login` for the currently-active account to refresh its
 * Keychain tokens after expiry. Differs from addAccount in that we expect
 * the email to stay the same — we just want fresh tokens captured.
 *
 * Returns the email that's now active after the login, or null if login
 * failed entirely (no oauthAccount left in claude.json).
 */
export async function reAuthenticate(
  claudeBin: string,
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<string | null> {
  // Snapshot token state before login. If it was already broken and is
  // still broken after, the user closed the browser without completing —
  // claude.json keeps the stale account intact and getCurrent() would
  // otherwise lie that we refreshed something.
  const { getTokenHealth } = await import('./token.js');
  const before = getTokenHealth(claudeJsonPath);
  const wasBroken = !before || before.status === 'expired' || before.status === 'missing';

  const { command, args, options } = buildSpawnArgs(claudeBin, ['auth', 'login'], process.platform);
  spawnSync(command, args, options);

  const after = getCurrent(claudeJsonPath);
  if (!after) return null;

  const afterHealth = getTokenHealth(claudeJsonPath);
  const stillBroken = !afterHealth || afterHealth.status === 'expired' || afterHealth.status === 'missing';
  if (wasBroken && stillBroken) return null;

  withLock(accountsDirPath, () => save(after, claudeJsonPath, accountsDirPath));
  return after;
}

export async function addAccount(claudeBin: string, claudeJsonPath: string, accountsDirPath: string): Promise<void> {
  const currentEmail = getCurrent(claudeJsonPath);
  const expectedEmail = await ask('Email to add (press Enter to skip): ');

  if (currentEmail) {
    withLock(accountsDirPath, () => save(currentEmail, claudeJsonPath, accountsDirPath));
  }

  console.log('\nLog in with the new account in your browser.\n');

  while (true) {
    const { command: loginCmd, args: loginArgs, options: loginOpts } = buildSpawnArgs(claudeBin, ['auth', 'login'], process.platform);
    spawnSync(loginCmd, loginArgs, loginOpts);

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
