// src/commands/list.ts
// `claude switch list` — prints saved accounts with active marker + aliases.
//
// Two output modes:
//   - default: human-readable text (with the active marker and [aliases])
//   - --json:  machine-readable AccountSummary[] for the GUI bridge
//
// The GUI prefers JSON because the human format ordering shifted between
// CLI releases and broke text parsers downstream. The JSON contract is
// the single source of truth.

import { getCurrent, list as listAccounts } from '../accounts.js';
import { getAliasesForEmail } from '../aliases.js';
import type { CommandContext } from './context.js';
import { errMessage } from '../errors.js';
import type { AccountSummary } from '../contract.js';

interface ListOptions {
  json: boolean;
}

export function handleList(ctx: CommandContext, opts: ListOptions = { json: false }): void {
  const { claudeJsonPath, accountsDirPath } = ctx;
  const accounts = listAccounts(accountsDirPath);

  let current = '';
  try {
    current = getCurrent(claudeJsonPath);
  } catch (e) {
    if (!opts.json) {
      process.stderr.write(`Note: could not determine active account — ${errMessage(e)}\n\n`);
    }
  }

  if (opts.json) {
    const payload: AccountSummary[] = accounts.map((email) => {
      const aliases = getAliasesForEmail(email, accountsDirPath);
      return {
        email,
        alias: aliases[0] ?? null,
        aliases,
        active: email === current,
      };
    });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
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
