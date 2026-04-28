// src/ui/add-account.ts
// Polished flow for `claude switch add`.
//
// The actual OAuth login is delegated to the real claude binary
// (`claude auth login`) — we can't put a spinner in front of an
// interactive browser handshake, so we surface a clear "now log in"
// note instead.

import * as p from '@clack/prompts';
import { spawnSync } from 'node:child_process';
import { getCurrent, save, load, list } from '../accounts.js';
import { setAlias } from '../aliases.js';
import { buildSpawnArgs } from '../proxy.js';

export interface AddAccountResult {
  email: string | null;
  alias: string | null;
  cancelled: boolean;
}

export async function addAccountInteractive(
  claudeBin: string,
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<AddAccountResult> {
  p.intro('Add a new claude account');

  const currentEmail = getCurrent(claudeJsonPath);

  const expectedRaw = await p.text({
    message: 'Email of the account you are about to add',
    placeholder: 'work@company.com (press Enter to skip)',
    validate: (val) => {
      if (!val) return undefined; // empty is allowed
      if (!val.includes('@')) return 'That does not look like an email.';
      return undefined;
    },
  });
  if (p.isCancel(expectedRaw)) {
    p.cancel('Cancelled. No account added.');
    return { email: null, alias: null, cancelled: true };
  }
  const expectedEmail = expectedRaw.trim();

  // Save the current account snapshot before swapping it during auth login.
  if (currentEmail) {
    save(currentEmail, claudeJsonPath, accountsDirPath);
  }

  p.note(
    `A browser window will open shortly.\n` +
    `Sign in with the new account, then come back to this terminal.`,
    'Logging in',
  );

  // The actual login is interactive (browser handshake). We run the real
  // claude binary with full stdio passthrough so its prompts work normally.
  const { command, args: spawnArgs, options } = buildSpawnArgs(
    claudeBin, ['auth', 'login'], process.platform,
  );
  spawnSync(command, spawnArgs, options);

  const newEmail = getCurrent(claudeJsonPath);

  if (!newEmail) {
    // Login failed entirely. Restore the previous account so we don't leave
    // the user with no active session.
    if (currentEmail) {
      load(currentEmail, claudeJsonPath, accountsDirPath);
    }
    p.cancel('Login failed or was cancelled. No account added.');
    return { email: null, alias: null, cancelled: true };
  }

  if (newEmail === currentEmail) {
    p.cancel('Browser closed before sign-in finished. No account added.');
    return { email: null, alias: null, cancelled: true };
  }

  if (expectedEmail && newEmail !== expectedEmail) {
    p.note(
      `Expected: ${expectedEmail}\nGot:      ${newEmail}`,
      'Different account signed in',
    );
    const keep = await p.confirm({
      message: `Save the account that was actually signed in (${newEmail})?`,
      initialValue: true,
    });
    if (p.isCancel(keep) || !keep) {
      if (currentEmail) {
        load(currentEmail, claudeJsonPath, accountsDirPath);
      }
      p.cancel('Cancelled. No account added.');
      return { email: null, alias: null, cancelled: true };
    }
  }

  const saveSpin = p.spinner();
  saveSpin.start(`Saving ${newEmail}`);
  save(newEmail, claudeJsonPath, accountsDirPath);
  saveSpin.stop(`Saved: ${newEmail}`);

  if (list(accountsDirPath).length === 1) {
    p.note(
      'You can add more accounts later with: claude switch add',
      'First account saved',
    );
  }

  const aliasRaw = await p.text({
    message: 'Optional alias (a short nickname you can type instead of the email)',
    placeholder: 'work, personal, … (press Enter to skip)',
  });
  let savedAlias: string | null = null;
  if (!p.isCancel(aliasRaw)) {
    const aliasName = aliasRaw.trim();
    if (aliasName) {
      try {
        setAlias(aliasName, newEmail, accountsDirPath);
        savedAlias = aliasName;
      } catch (e) {
        p.note((e as Error).message, 'Alias not saved');
      }
    }
  }

  const summary = [`Email: ${newEmail}`];
  if (savedAlias) summary.push(`Alias: ${savedAlias}`);
  p.note(summary.join('\n'), 'Done');
  p.outro('Switch to it any time with: claude switch');

  return { email: newEmail, alias: savedAlias, cancelled: false };
}
