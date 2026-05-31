// src/switcher.ts
// Core account switching (lock-disciplined) plus the interactive switch/add
// flows. The pending-restore migration marker and re-auth live in sibling
// modules (switcher-pending / switcher-reauth) and are re-exported here so
// importers keep using `./switcher.js`.

import readline from 'node:readline';
import { getCurrent, list, load, save } from '../accounts/accounts.js';
import { setAlias } from './aliases.js';
import { ExitError } from '../platform/errors.js';
import { withLock } from '../platform/lock.js';
import { nodeProcessAdapter } from '../platform/process.js';
import { buildSpawnArgs } from '../proxy/proxy.js';
import type { SwitcherDeps } from './switcher-deps.js';

export type { SwitcherDeps } from './switcher-deps.js';
export { checkPendingRestore } from './switcher-pending.js';
export { reAuthOutcome, reAuthenticate } from './switcher-reauth.js';

function defaultAsk(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
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

  const { repointToDefault } = await import('./repoint.js');
  console.log((await repointToDefault(accounts[index - 1]!, claudeJsonPath, accountsDirPath)).message);
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
