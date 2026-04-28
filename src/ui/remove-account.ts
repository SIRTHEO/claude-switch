// src/ui/remove-account.ts
// Confirmation flow for `claude switch remove <email>`.
//
// We show what the user is about to lose (saved tokens, alias, API key) so
// the deletion is never silent.

import * as p from '@clack/prompts';
import fs from 'node:fs';
import path from 'node:path';
import { remove as removeAccount, getCurrent } from '../accounts.js';
import { getAliasesForEmail } from '../aliases.js';
import { getApiKey, maskApiKey } from '../apikey.js';

export interface RemoveAccountResult {
  removed: boolean;
  cancelled: boolean;
}

export async function removeAccountInteractive(
  email: string,
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<RemoveAccountResult> {
  p.intro(`Remove ${email}`);

  // Refuse to remove the active account up front.
  const current = getCurrent(claudeJsonPath);
  if (current === email) {
    p.cancel('Cannot remove the active account. Switch to another one first.');
    return { removed: false, cancelled: true };
  }

  // Build a preview of what disappears.
  const preview: string[] = [];
  const accountFile = path.join(accountsDirPath, `${email}.json`);
  let hasKeychain = false;
  try {
    const data = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
    hasKeychain = !!data._keychain;
  } catch { /* file missing — handled below */ }
  if (!fs.existsSync(accountFile)) {
    p.cancel(`No saved account for ${email}.`);
    return { removed: false, cancelled: true };
  }

  if (hasKeychain) preview.push('• Saved OAuth tokens (Keychain snapshot)');
  preview.push(`• Account file ${accountFile}`);

  const aliases = getAliasesForEmail(email, accountsDirPath);
  if (aliases.length > 0) {
    preview.push(`• Aliases: ${aliases.join(', ')}`);
  }

  const apiKey = getApiKey(email, accountsDirPath);
  if (apiKey) preview.push(`• API key (${maskApiKey(apiKey)})`);

  p.note(preview.join('\n'), 'Will be deleted');

  const confirmed = await p.confirm({
    message: `Really remove ${email}?`,
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Cancelled. Nothing was removed.');
    return { removed: false, cancelled: true };
  }

  const spin = p.spinner();
  spin.start('Removing account');
  try {
    removeAccount(email, accountsDirPath);
    spin.stop('Removed');
  } catch (e) {
    spin.stop('Failed');
    p.cancel((e as Error).message);
    return { removed: false, cancelled: false };
  }

  if (aliases.length > 0) {
    p.note(
      `The aliases above still exist and now point at a deleted account.\n` +
      `Run "claude switch alias --remove <name>" if you want to clean them up.`,
      'Heads up',
    );
  }
  p.outro('Done.');
  return { removed: true, cancelled: false };
}
