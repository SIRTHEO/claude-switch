// src/ui/main-menu.ts
// Persistent main menu. Each action returns to the menu instead of exiting,
// matching the convention of tools like `gh`, `lazygit`, etc.

import * as p from '@clack/prompts';
import { getCurrent, list as listAccounts } from '../accounts.js';
import { isFallbackEnabled, setFallbackEnabled } from '../fallback.js';
import { getApiKey } from '../apikey.js';
import { readUsageCache, readUsageCacheFor, isUsageCacheStale, triggerBackgroundUsageRefresh, fetchUsageCached, getAccessTokenFromKeychain } from '../usage.js';
import { selectAccountInteractive } from './select-account.js';
import { setApiKeyInteractive } from './set-apikey.js';
import { addAccountInteractive } from './add-account.js';
import { removeAccountInteractive } from './remove-account.js';
import { runSetupWizard } from './setup-wizard.js';
import { findClaudeBinary } from '../find-claude.js';
import { getTokenHealth } from '../token.js';
import { theme } from './theme.js';

type MenuAction =
  | 'switch'
  | 'add'
  | 'remove'
  | 'apikey'
  | 'fallback'
  | 'usage'
  | 'setup'
  | 'advanced'
  | 'exit';

type AdvancedAction = 'add' | 'remove' | 'setup' | 'back';

function buildStatusLines(claudeJsonPath: string, accountsDirPath: string): string {
  const current = getCurrent(claudeJsonPath);
  const fallbackOn = isFallbackEnabled(accountsDirPath);
  const apiKey = current ? getApiKey(current, accountsDirPath) : null;
  const usingApi = fallbackOn && !!apiKey;
  const cache = current ? readUsageCacheFor(accountsDirPath, current) : null;
  const five = cache?.payload?.five_hour?.utilization;
  const seven = cache?.payload?.seven_day?.utilization;
  const tokenHealth = current ? getTokenHealth(claudeJsonPath) : null;

  const lines: string[] = [];

  // Account
  lines.push(`${theme.brand('Account')}    ${current || theme.dim('(none — add one with “Add”)')}`);

  // Auth mode + warning if fallback ON but no key
  let authMode = usingApi ? 'API key (fallback on)' : 'OAuth subscription';
  if (fallbackOn && !apiKey && current) {
    authMode = `OAuth subscription  ${theme.brand('⚠ fallback ON but no key — has no effect')}`;
  }
  lines.push(`${theme.brand('Auth mode')}  ${authMode}`);

  // Token expiry — warn if expired or expiring soon
  if (tokenHealth) {
    let tokenLine: string;
    switch (tokenHealth.status) {
      case 'valid': {
        const ms = tokenHealth.expiresAt ? tokenHealth.expiresAt.getTime() - Date.now() : 0;
        if (ms < 60 * 60 * 1000) {
          tokenLine = `${theme.brand('expires soon')} (${tokenHealth.expiresIn}) — re-login if you plan to use this account`;
        } else {
          tokenLine = `valid (${tokenHealth.expiresIn})`;
        }
        break;
      }
      case 'expired':
        tokenLine = `${theme.brand('EXPIRED')} (${tokenHealth.expiresIn}) — run "Add account" to re-authenticate`;
        break;
      case 'present':
        tokenLine = 'present';
        break;
      case 'missing':
        tokenLine = `${theme.brand('missing')} — run "Add account" to log in`;
        break;
    }
    lines.push(`${theme.brand('Token')}      ${tokenLine}`);
  }

  // Usage
  if (five !== undefined) {
    const sevenStr = seven !== undefined ? `, 7d ${seven.toFixed(0)}%` : '';
    const warn = five >= 90 ? '  ⚠ near limit' : '';
    lines.push(`${theme.brand('Usage')}      5h ${five.toFixed(0)}%${sevenStr}${warn}`);
  } else {
    lines.push(`${theme.brand('Usage')}      ${theme.dim('unavailable')}`);
  }

  return lines.join('\n');
}

async function pickAction(claudeJsonPath: string, accountsDirPath: string): Promise<MenuAction> {
  const current = getCurrent(claudeJsonPath);
  const accounts = listAccounts(accountsDirPath);
  const fallbackOn = isFallbackEnabled(accountsDirPath);

  // Daily-driver actions in the main menu; rare/destructive ones live behind
  // the "Advanced…" submenu so the surface stays uncluttered.
  const options: Array<{ value: MenuAction; label: string; hint?: string }> = [];

  if (accounts.length >= 2) {
    options.push({ value: 'switch', label: 'Switch account', hint: 'pick another saved account' });
  }
  if (current) {
    options.push({
      value: 'fallback',
      label: fallbackOn ? 'Turn fallback OFF (use OAuth)' : 'Turn fallback ON (use API key)',
      hint: fallbackOn ? 'back to subscription' : 'use saved API key',
    });
    options.push({ value: 'apikey', label: 'Set API key', hint: 'for the active account' });
  }
  options.push({ value: 'usage', label: 'Refresh usage', hint: 'force-fetch + per-model breakdown' });
  options.push({ value: 'advanced', label: 'Advanced…', hint: 'add / remove / setup' });
  options.push({ value: 'exit', label: 'Exit', hint: 'or press Ctrl+C / Esc' });

  const choice = await p.select<MenuAction>({
    message: 'What would you like to do?',
    options,
  });

  if (p.isCancel(choice)) return 'exit';
  return choice;
}

async function pickAdvancedAction(accountsDirPath: string): Promise<AdvancedAction> {
  const accounts = listAccounts(accountsDirPath);
  const options: Array<{ value: AdvancedAction; label: string; hint?: string }> = [];
  options.push({ value: 'add', label: 'Add account', hint: 'log in with a new email' });
  if (accounts.length > 0) {
    options.push({ value: 'remove', label: 'Remove account', hint: 'pick one to delete' });
  }
  options.push({ value: 'setup', label: 'Re-run setup wizard', hint: 'fix the claude binary path / shell PATH' });
  options.push({ value: 'back', label: 'Back to main menu' });

  const choice = await p.select<AdvancedAction>({ message: 'Advanced', options });
  if (p.isCancel(choice)) return 'back';
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
  p.intro(theme.heading('claude-switch'));

  // Fetch usage synchronously on entry so the status header has real numbers
  // — users were confused by "not fetched yet, try Show usage". We only
  // foreground-block if the cache is stale or for a different account; if
  // it's already fresh we skip the call entirely.
  const currentForRefresh = getCurrent(claudeJsonPath);
  if (currentForRefresh && isUsageCacheStale(readUsageCache(accountsDirPath), currentForRefresh)) {
    const token = getAccessTokenFromKeychain(claudeJsonPath);
    if (token) {
      const spin = p.spinner();
      spin.start('Fetching subscription usage');
      try {
        await fetchUsageCached(accountsDirPath, token, { force: true, account: currentForRefresh });
        spin.stop('Usage updated');
      } catch {
        spin.stop('Could not fetch usage — continuing');
      }
    }
  }

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
        case 'advanced': {
          const adv = await pickAdvancedAction(accountsDirPath);
          if (adv === 'back') break;
          if (adv === 'add') {
            const bin = findClaudeBinary(import.meta.url);
            if (!bin) {
              p.note('Could not find the real claude binary — run setup first.', 'Setup needed');
              break;
            }
            await addAccountInteractive(bin, claudeJsonPath, accountsDirPath);
          } else if (adv === 'remove') {
            const target = await pickAccount('Remove which account?', accountsDirPath, getCurrent(claudeJsonPath));
            if (target) {
              await removeAccountInteractive(target, claudeJsonPath, accountsDirPath);
            }
          } else if (adv === 'setup') {
            await runSetupWizard(process.argv[1] ?? '');
          }
          break;
        }
        case 'add': {
          // Direct entry point preserved for completeness, but the menu
          // funnels users via 'advanced'. Keeping the handler avoids a
          // dead switch case if the routing changes.
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
          const wasOn = isFallbackEnabled(accountsDirPath);
          const next = !wasOn;
          if (next) {
            // Don't silently enable fallback for an account with no key —
            // the toggle would be a no-op and the user would think it's
            // broken (this is a real bug we hit in testing).
            const current = getCurrent(claudeJsonPath);
            const currentKey = current ? getApiKey(current, accountsDirPath) : null;
            if (!current) {
              p.note('No active account. Add or switch to one first.', 'Cannot enable fallback');
              break;
            }
            if (!currentKey) {
              p.note(
                `The active account ${current} has no saved API key, so turning ` +
                `fallback ON would have no effect (claude would still use OAuth).`,
                'Cannot enable fallback',
              );
              const setNow = await p.confirm({
                message: 'Set an API key for this account now?',
                initialValue: true,
              });
              if (!p.isCancel(setNow) && setNow) {
                await setApiKeyInteractive(current, accountsDirPath);
                // Re-check: if a key was actually saved, proceed with toggle.
                if (!getApiKey(current, accountsDirPath)) break;
              } else {
                break;
              }
            }
            setFallbackEnabled(accountsDirPath, true);
            p.note(
              `Fallback ON. The next "claude" run will inject the saved API key as\n` +
              `ANTHROPIC_API_KEY. The first time, Claude Code will prompt:\n\n` +
              `    "Use this API key? [y/N]"\n\n` +
              `→ Press y to approve. Your choice is remembered.\n` +
              `→ If you press N or miss the prompt, claude silently keeps using\n` +
              `  OAuth and the fallback looks broken.`,
              'Important',
            );
          } else {
            setFallbackEnabled(accountsDirPath, false);
            p.note('Fallback OFF. The next claude run will use OAuth subscription.', 'Done');
          }
          break;
        }
        case 'usage': {
          // Force a foreground refresh so the user sees fresh numbers without
          // waiting for the background job. We import dynamically to avoid
          // pulling https into the menu hot-path.
          const { fetchUsageCached, getAccessTokenFromKeychain } = await import('../usage.js');
          const token = getAccessTokenFromKeychain(claudeJsonPath);
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
