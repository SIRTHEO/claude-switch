// src/commands/list.ts
// `claude switch list` — prints saved accounts with active marker + aliases.

import { getCurrent, list as listAccounts } from '../accounts.js';
import { getAliasesForEmail } from '../aliases.js';
import type { CommandContext } from './context.js';
import { errMessage } from '../errors.js';

export function handleList(ctx: CommandContext): void {
  const { claudeJsonPath, accountsDirPath } = ctx;
  const accounts = listAccounts(accountsDirPath);

  // EACCES on ~/.claude.json shouldn't break `list` — historically this
  // command returned the saved account list even if the active marker
  // was unreadable. Surface the issue on stderr but keep the listing.
  let current = '';
  try {
    current = getCurrent(claudeJsonPath);
  } catch (e) {
    process.stderr.write(`Note: could not determine active account — ${errMessage(e)}\n\n`);
  }

  if (accounts.length === 0) {
    console.log('No saved accounts. Run: claude switch add');
    return;
  }

  console.log('Saved accounts:\n');
  for (const email of accounts) {
    const isActive = email === current;
    const marker = isActive ? '  * ' : '    ';
    const activeLabel = isActive ? ' (active)' : '';
    const emailAliases = getAliasesForEmail(email, accountsDirPath);
    const aliasLabel = emailAliases.length > 0 ? ` [${emailAliases.join(', ')}]` : '';
    console.log(`${marker}${email}${activeLabel}${aliasLabel}`);
  }
}
