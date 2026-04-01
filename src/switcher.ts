// src/switcher.ts
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { getCurrent, save, load, list } from './accounts.js';
import { ExitError } from './errors.js';

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
  const currentEmail = getCurrent(claudeJsonPath);

  if (targetEmail === currentEmail) {
    return `Already on ${targetEmail}`;
  }

  if (currentEmail) {
    save(currentEmail, claudeJsonPath, accountsDirPath);
  }

  load(targetEmail, claudeJsonPath, accountsDirPath);
  return `Switched to ${targetEmail}`;
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

export async function addAccount(claudeBin: string, claudeJsonPath: string, accountsDirPath: string): Promise<void> {
  const currentEmail = getCurrent(claudeJsonPath);
  const expectedEmail = await ask('Email to add (press Enter to skip): ');

  if (currentEmail) {
    save(currentEmail, claudeJsonPath, accountsDirPath);
  }

  console.log('\nLog in with the new account in your browser.\n');

  while (true) {
    spawnSync(claudeBin, ['auth', 'login'], { stdio: 'inherit' });

    const newEmail = getCurrent(claudeJsonPath);
    if (!newEmail) {
      if (currentEmail) {
        load(currentEmail, claudeJsonPath, accountsDirPath);
      }
      throw new ExitError('Login failed or cancelled.');
    }

    console.log(`\nAuthenticated: ${newEmail}`);
    save(newEmail, claudeJsonPath, accountsDirPath);
    console.log(`Saved: ${newEmail}`);

    if (list(accountsDirPath).length === 1) {
      console.log('\nFirst account saved! Add another with: claude switch add');
    }

    if (!expectedEmail || newEmail === expectedEmail) break;

    console.log(`\n(expected ${expectedEmail})`);
    const retry = await ask(`Retry login for ${expectedEmail}? [y/N]: `);
    if (retry.toLowerCase() !== 'y') break;

    console.log('\nLog in with the new account in your browser.\n');
  }
}
