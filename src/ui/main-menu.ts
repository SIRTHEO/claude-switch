// src/ui/main-menu.ts
// Persistent main menu. Each action returns to the menu instead of exiting,
// matching the convention of tools like `gh`, `lazygit`, etc.

import * as p from '@clack/prompts';
import { getCurrent, list as listAccounts } from '../accounts.js';
import { isFallbackEnabled, setFallbackEnabled } from '../fallback.js';
import { getApiKey } from '../apikey.js';
import { readUsageCache, readUsageCacheFor, isUsageCacheStale, triggerBackgroundUsageRefresh } from '../usage.js';
import { selectAccountInteractive } from './select-account.js';
import { setApiKeyInteractive } from './set-apikey.js';
import { addAccountInteractive } from './add-account.js';
import { removeAccountInteractive } from './remove-account.js';
import { runSetupWizard } from './setup-wizard.js';
import { findClaudeBinary } from '../find-claude.js';
import { theme } from './theme.js';

type MenuAction =
  | 'switch'
  | 'add'
  | 'remove'
  | 'apikey'
  | 'fallback'
  | 'usage'
  | 'setup'
  | 'exit';

function buildStatusLines(claudeJsonPath: string, accountsDirPath: string): string {
  const current = getCurrent(claudeJsonPath);
  const fallbackOn = isFallbackEnabled(accountsDirPath);
  const apiKey = current ? getApiKey(current, accountsDirPath) : null;
  const usingApi = fallbackOn && !!apiKey;
  const cache = current ? readUsageCacheFor(accountsDirPath, current) : null;
  const five = cache?.payload?.five_hour?.utilization;
  const seven = cache?.payload?.seven_day?.utilization;

  const lines: string[] = [];
  lines.push(`${theme.brand('Account')}    ${current || theme.dim('(none — add one with “Add”)')}`);
  lines.push(`${theme.brand('Auth mode')}  ${usingApi ? 'API key (fallback on)' : 'OAuth subscription'}`);
  if (five !== undefined) {
    const sevenStr = seven !== undefined ? `, 7d ${seven.toFixed(0)}%` : '';
    lines.push(`${theme.brand('Usage')}      5h ${five.toFixed(0)}%${sevenStr}`);
  } else {
    lines.push(`${theme.brand('Usage')}      ${theme.dim('not fetched yet — try “Show usage”')}`);
  }
  return lines.join('\n');
}

async function pickAction(claudeJsonPath: string, accountsDirPath: string): Promise<MenuAction> {
  const current = getCurrent(claudeJsonPath);
  const accounts = listAccounts(accountsDirPath);
  const fallbackOn = isFallbackEnabled(accountsDirPath);

  const options: Array<{ value: MenuAction; label: string; hint?: string }> = [];

  if (accounts.length >= 2) {
    options.push({ value: 'switch', label: 'Switch account', hint: 'pick another saved account' });
  }
  options.push({ value: 'add', label: 'Add account', hint: 'log in with a new email' });
  if (current) {
    options.push({ value: 'apikey', label: 'Set API key for active account', hint: 'enables fallback billing' });
    options.push({
      value: 'fallback',
      label: fallbackOn ? 'Turn fallback OFF (use OAuth)' : 'Turn fallback ON (use API key)',
    });
  }
  options.push({ value: 'usage', label: 'Show usage', hint: 'live 5h / 7d %' });
  if (accounts.length > 0) {
    options.push({ value: 'remove', label: 'Remove account…' });
  }
  options.push({ value: 'setup', label: 'Re-run setup wizard' });
  options.push({ value: 'exit', label: 'Exit', hint: 'or press Ctrl+C / Esc' });

  const choice = await p.select<MenuAction>({
    message: 'What would you like to do?',
    options,
  });

  if (p.isCancel(choice)) return 'exit';
  return choice;
}

async function pickAccount(prompt: string, accountsDirPath: string, exclude?: string): Promise<string | null> {
  const accounts = listAccounts(accountsDirPath).filter(a => a !== exclude);
  if (accounts.length === 0) {
    p.note('No matching accounts.', 'Empty');
    return null;
  }
  const choice = await p.select<string>({
    message: prompt,
    options: accounts.map(a => ({ value: a, label: a })),
  });
  if (p.isCancel(choice)) return null;
  return choice;
}

/**
 * Run the persistent main menu loop. Returns when the user picks Exit
 * or sends Ctrl+C.
 */
export async function runMainMenu(claudeJsonPath: string, accountsDirPath: string): Promise<void> {
  // Background-refresh usage on entry so the status header is up to date.
  const currentForRefresh = getCurrent(claudeJsonPath);
  if (isUsageCacheStale(readUsageCache(accountsDirPath), currentForRefresh)) {
    triggerBackgroundUsageRefresh();
  }

  p.intro(theme.heading('claude-switch'));

  // Loop until exit.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    p.note(buildStatusLines(claudeJsonPath, accountsDirPath), 'Status');
    const action = await pickAction(claudeJsonPath, accountsDirPath);

    if (action === 'exit') {
      p.outro('See you.');
      return;
    }

    try {
      switch (action) {
        case 'switch':
          await selectAccountInteractive(claudeJsonPath, accountsDirPath);
          break;
        case 'add': {
          const bin = findClaudeBinary(import.meta.url);
          if (!bin) {
            p.note('Could not find the real claude binary — run setup first.', 'Setup needed');
            break;
          }
          await addAccountInteractive(bin, claudeJsonPath, accountsDirPath);
          break;
        }
        case 'remove': {
          const target = await pickAccount('Remove which account?', accountsDirPath, getCurrent(claudeJsonPath));
          if (target) {
            await removeAccountInteractive(target, claudeJsonPath, accountsDirPath);
          }
          break;
        }
        case 'apikey': {
          const current = getCurrent(claudeJsonPath);
          if (!current) {
            p.note('No active account.', 'Cannot continue');
            break;
          }
          await setApiKeyInteractive(current, accountsDirPath);
          break;
        }
        case 'fallback': {
          const next = !isFallbackEnabled(accountsDirPath);
          setFallbackEnabled(accountsDirPath, next);
          p.note(
            next ? 'Fallback turned ON. The next claude run will use the saved API key.'
                 : 'Fallback turned OFF. The next claude run will use OAuth.',
            'Done',
          );
          break;
        }
        case 'usage': {
          // Force a foreground refresh so the user sees fresh numbers without
          // waiting for the background job. We import dynamically to avoid
          // pulling https into the menu hot-path.
          const { fetchUsageCached, getAccessTokenFromKeychain } = await import('../usage.js');
          const token = getAccessTokenFromKeychain();
          if (!token) {
            p.note('No OAuth access token available — only Max/Pro subscribers.', 'Cannot fetch');
            break;
          }
          const currentForUsage = getCurrent(claudeJsonPath) || undefined;
          const spin = p.spinner();
          spin.start('Fetching latest usage');
          const cache = await fetchUsageCached(accountsDirPath, token, { force: true, account: currentForUsage });
          spin.stop('Done');
          if (cache.rateLimitedUntil && cache.rateLimitedUntil > Date.now()) {
            const wait = Math.ceil((cache.rateLimitedUntil - Date.now()) / 1000);
            p.note(`Anthropic's usage endpoint is rate-limiting us. Retry in ~${wait}s.`, 'Rate limited');
          } else if (cache.payload) {
            const five = cache.payload.five_hour.utilization;
            const seven = cache.payload.seven_day.utilization;
            const opus = cache.payload.seven_day_opus?.utilization;
            const sonnet = cache.payload.seven_day_sonnet?.utilization;
            const lines = [
              `5-hour:  ${five.toFixed(1)}%`,
              `7-day:   ${seven.toFixed(1)}%`,
            ];
            if (opus !== undefined) lines.push(`  Opus:   ${opus.toFixed(1)}%`);
            if (sonnet !== undefined) lines.push(`  Sonnet: ${sonnet.toFixed(1)}%`);
            p.note(lines.join('\n'), 'Subscription usage');
          } else {
            p.note('Endpoint unreachable. Try again later.', 'Could not fetch');
          }
          break;
        }
        case 'setup':
          await runSetupWizard(process.argv[1] ?? '');
          break;
      }
    } catch (e) {
      p.note((e as Error).message, 'Error');
    }
  }
}
