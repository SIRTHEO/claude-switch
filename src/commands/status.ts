// src/commands/status.ts
// `claude switch status` — active account + token health + fallback flag.
//
// Side effect: auto-saves the active account if it's not yet in the
// accounts dir, AND re-saves accounts whose file pre-dates Keychain
// support (no `_keychain` field). This is the migration path that keeps
// older installs from drifting silently.

import fs from 'node:fs';
import path from 'node:path';
import { getCurrent, save, list as listAccounts } from '../accounts.js';
import { getAliasesForEmail } from '../aliases.js';
import { withLock } from '../lock.js';
import { getApiKey, maskApiKey } from '../apikey.js';
import { isFallbackEnabled } from '../fallback.js';
import { getTokenHealth } from '../token.js';
import type { CommandContext } from './context.js';

export function handleStatus(ctx: CommandContext): void {
  const { claudeJsonPath, accountsDirPath } = ctx;
  const current = getCurrent(claudeJsonPath);
  if (!current) {
    console.log('No account connected. Run: claude switch add');
    return;
  }

  const savedAccounts = listAccounts(accountsDirPath);
  if (!savedAccounts.includes(current)) {
    withLock(accountsDirPath, () => save(current, claudeJsonPath, accountsDirPath));
    console.log(`Detected account: ${current} (saved automatically)\n`);
  } else {
    // Migrate old account files that lack _keychain by re-saving.
    const accountFile = path.join(accountsDirPath, `${current}.json`);
    try {
      const existing = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
      if (!existing._keychain) {
        withLock(accountsDirPath, () => save(current, claudeJsonPath, accountsDirPath));
      }
    } catch {
      /* ignore — best-effort migration */
    }
  }

  const health = getTokenHealth(claudeJsonPath);
  const emailAliases = getAliasesForEmail(current, accountsDirPath);

  console.log(`Active account: ${current}`);
  if (emailAliases.length > 0) {
    console.log(`  Alias: ${emailAliases.join(', ')}`);
  }

  switch (health.status) {
    case 'valid':
      console.log(`  Token: valid (expires ${health.expiresIn})`);
      break;
    case 'expired':
      console.log(`  Token: expired (${health.expiresIn}) — run: claude switch add`);
      break;
    case 'present':
      console.log('  Token: present');
      break;
    case 'missing':
      console.log('  Token: missing — run: claude switch add');
      break;
  }

  const apiKey = getApiKey(current, accountsDirPath);
  const fallbackOn = isFallbackEnabled(accountsDirPath);
  console.log(`  API key: ${apiKey ? maskApiKey(apiKey) : 'not set'}`);
  console.log(`  Fallback: ${fallbackOn ? 'on' : 'off'}`);
  if (fallbackOn && !apiKey) {
    console.log('  ⚠ fallback is on but no API key saved — claude will use OAuth');
  }
}
