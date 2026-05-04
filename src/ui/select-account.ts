// src/ui/select-account.ts
// Interactive account picker for `claude switch` (no args).
//
// Falls back to the legacy numbered list when stdout is not a TTY (CI,
// piped output) so scripts and dumb terminals still work.

import * as p from '@clack/prompts';
import { getCurrent, list } from '../accounts.js';
import { switchTo } from '../switcher.js';
import { getAliasesForEmail } from '../aliases.js';
import { getApiKey } from '../apikey.js';
import { isFallbackEnabled } from '../fallback.js';
import { readUsageCache } from '../usage.js';

interface AccountRow {
  email: string;
  active: boolean;
  aliases: string[];
}

function buildRows(accounts: string[], active: string, accountsDirPath: string): AccountRow[] {
  return accounts.map(email => ({
    email,
    active: email === active,
    aliases: getAliasesForEmail(email, accountsDirPath),
  }));
}

function formatLabel(row: AccountRow): string {
  const aliasesPart = row.aliases.length ? `  [${row.aliases.join(', ')}]` : '';
  return `${row.email}${aliasesPart}`;
}

function formatHint(row: AccountRow, accountsDirPath: string): string | undefined {
  if (row.active) return 'active';
  if (getApiKey(row.email, accountsDirPath)) return 'API key saved';
  return undefined;
}

/**
 * Interactive account switcher. Returns the new active email if a switch
 * happened, the current email if the user picked the active one, or null
 * if cancelled.
 */
export async function selectAccountInteractive(
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<string | null> {
  const accounts = list(accountsDirPath);
  const current = getCurrent(claudeJsonPath);

  if (accounts.length === 0) {
    p.intro('claude-switch');
    p.note('No saved accounts yet.\nRun: claude switch add', 'Empty');
    p.outro('Nothing to switch to.');
    return null;
  }

  if (accounts.length < 2) {
    p.intro('claude-switch');
    p.note(
      `Only one saved account: ${accounts[0]}\nAdd a second one with: claude switch add`,
      'Single account',
    );
    p.outro('Nothing to switch to.');
    return null;
  }

  // Surface global state above the picker so the user has context.
  const fallbackOn = isFallbackEnabled(accountsDirPath);
  const usage = readUsageCache(accountsDirPath);
  const fivePct = usage?.payload?.five_hour?.utilization;
  const sevenPct = usage?.payload?.seven_day?.utilization;

  const status: string[] = [];
  if (current) status.push(`Active: ${current}`);
  status.push(`Fallback: ${fallbackOn ? 'on (uses API key)' : 'off (uses OAuth)'}`);
  if (fivePct !== undefined) {
    status.push(`5-hour usage: ${fivePct.toFixed(0)}%`);
  }
  if (sevenPct !== undefined) {
    status.push(`7-day usage: ${sevenPct.toFixed(0)}%`);
  }

  p.intro('claude-switch');
  p.note(status.join('\n'), 'Status');

  const rows = buildRows(accounts, current, accountsDirPath);
  const choice = await p.select<string>({
    message: 'Pick an account',
    initialValue: rows.find(r => r.active)?.email ?? rows[0]?.email,
    options: rows.map(r => ({
      value: r.email,
      label: formatLabel(r),
      hint: formatHint(r, accountsDirPath),
    })),
  });

  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return null;
  }

  if (choice === current) {
    p.outro(`Already on ${current}.`);
    return current;
  }

  // Warn if other claude sessions are running. Doesn't block — the user
  // sees the warning, then we proceed. Dynamic import keeps this module
  // free of the child_process dependency for testing.
  try {
    const { countActiveClaudeSessions, buildActiveSessionsWarning } = await import('../active-sessions.js');
    const { getSavedClaudeBin } = await import('../setup.js');
    const sessions = countActiveClaudeSessions(getSavedClaudeBin());
    const warning = buildActiveSessionsWarning(sessions.count);
    if (warning) p.note(warning, 'Heads up');
  } catch { /* detection is best-effort */ }

  const spin = p.spinner();
  spin.start(`Switching to ${choice}`);
  try {
    const message = switchTo(choice, claudeJsonPath, accountsDirPath);
    spin.stop(message);
  } catch (e) {
    spin.stop('Switch failed');
    p.cancel((e as Error).message);
    return null;
  }

  p.outro(`Now active: ${choice}`);
  return choice;
}
