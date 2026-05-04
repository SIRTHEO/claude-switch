// src/ui/main-menu.ts
// Persistent main menu. Each action returns to the menu instead of exiting,
// matching the convention of tools like `gh`, `lazygit`, etc.

import * as p from '@clack/prompts';
import { getCurrent, list as listAccounts } from '../accounts.js';
import { isFallbackEnabled, setFallbackEnabled } from '../fallback.js';
import { getAutoFallbackConfig } from '../auto-fallback.js';
import { getApiKey, removeApiKey } from '../apikey.js';
import { getAliasesForEmail, setAlias, removeAlias } from '../aliases.js';
import { withLock } from '../lock.js';
import { readUsageCache, isUsageCacheStale, fetchUsageCached, getAccessTokenFromKeychain } from '../usage.js';
import { selectAccountInteractive } from './select-account.js';
import { setApiKeyInteractive } from './set-apikey.js';
import { addAccountInteractive } from './add-account.js';
import { removeAccountInteractive } from './remove-account.js';
import { runSetupWizard } from './setup-wizard.js';
import { findClaudeBinary } from '../find-claude.js';
import { getTokenHealth } from '../token.js';
import { reAuthenticate } from '../switcher.js';
import { buildSpawnArgs } from '../proxy.js';
import { spawnSync } from 'node:child_process';
import { theme } from './theme.js';
import { buildStatusLines, buildAccountInfo } from './menu/status.js';
import { ALT_BUFFER_ENTER, ALT_BUFFER_EXIT, CLEAR_AND_HOME, altBufferSupported } from './menu/lifecycle.js';
import { runProfilesMenu } from './profiles-menu.js';
import { runAutoFallbackMenu } from './auto-fallback-menu.js';

type MenuAction =
  | 'switch'
  | 'reauth'
  | 'manage'
  | 'add'
  | 'remove'
  | 'apikey'
  | 'fallback'
  | 'auto-fallback'
  | 'profiles'
  | 'usage'
  | 'setup'
  | 'advanced'
  | 'exit';

type ManageAction =
  | 'apikey-set'
  | 'apikey-remove'
  | 'alias-add'
  | 'alias-remove'
  | 'remove'
  | 'back';

type AdvancedAction = 'add' | 'remove' | 'setup' | 'back';

async function pickAction(claudeJsonPath: string, accountsDirPath: string): Promise<MenuAction> {
  const current = getCurrent(claudeJsonPath);
  const accounts = listAccounts(accountsDirPath);
  const fallbackOn = isFallbackEnabled(accountsDirPath);
  const apiKey = current ? getApiKey(current, accountsDirPath) : null;
  const usingApi = fallbackOn && !!apiKey;
  const tokenHealth = current ? getTokenHealth(claudeJsonPath) : null;
  const tokenBroken = !!tokenHealth && (tokenHealth.status === 'expired' || tokenHealth.status === 'missing');

  // Daily-driver actions in the main menu; rare/destructive ones live behind
  // the "Advanced…" submenu so the surface stays uncluttered.
  const options: Array<{ value: MenuAction; label: string; hint?: string }> = [];

  // Re-auth surfaces at the top when OAuth is dead AND user is actually
  // relying on it (no API key fallback masking the problem). Spares the
  // user having to know that "Add account" is the recovery path.
  if (current && tokenBroken && !usingApi) {
    options.push({
      value: 'reauth',
      label: 'Re-authenticate (token expired)',
      hint: 're-login current account in browser',
    });
  }

  if (accounts.length >= 2) {
    options.push({ value: 'switch', label: 'Switch account', hint: 'pick another saved account' });
  }
  if (current) {
    options.push({
      value: 'fallback',
      label: fallbackOn ? 'Turn fallback OFF (use OAuth)' : 'Turn fallback ON (use API key)',
      hint: fallbackOn ? 'back to subscription' : 'use saved API key',
    });
    const autoCfg = getAutoFallbackConfig(accountsDirPath);
    const autoHint = [
      autoCfg.enabled ? `revert<${autoCfg.threshold}%` : 'revert:off',
      autoCfg.engageEnabled ? `engage≥${autoCfg.engageThreshold}%` : 'engage:off',
    ].join(' · ');
    options.push({
      value: 'auto-fallback',
      label: 'Auto-fallback settings…',
      hint: autoHint,
    });
    options.push({ value: 'apikey', label: 'Set API key', hint: 'for the active account' });
  }
  if (accounts.length >= 1) {
    options.push({
      value: 'manage',
      label: 'Manage account…',
      hint: 'edit API key / aliases for any saved account',
    });
  }
  options.push({ value: 'profiles', label: 'Profiles…', hint: 'per-terminal isolated sessions' });
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

async function pickManageAction(
  email: string,
  accountsDirPath: string,
  isActive: boolean,
): Promise<ManageAction> {
  const hasKey = !!getApiKey(email, accountsDirPath);
  const aliases = getAliasesForEmail(email, accountsDirPath);

  const options: Array<{ value: ManageAction; label: string; hint?: string }> = [];
  options.push({
    value: 'apikey-set',
    label: hasKey ? 'Replace API key' : 'Set API key',
    hint: hasKey ? 'overwrite the current key' : 'paste an Anthropic key',
  });
  if (hasKey) {
    options.push({ value: 'apikey-remove', label: 'Remove API key', hint: 'forget the saved key' });
  }
  options.push({ value: 'alias-add', label: 'Add alias', hint: 'short nickname for this account' });
  if (aliases.length > 0) {
    options.push({ value: 'alias-remove', label: 'Remove alias', hint: aliases.join(', ') });
  }
  if (!isActive) {
    options.push({
      value: 'remove',
      label: 'Remove account',
      hint: 'delete saved tokens, key, aliases',
    });
  }
  options.push({ value: 'back', label: 'Back', hint: 'return to main menu' });

  const choice = await p.select<ManageAction>({
    message: `Action for ${email}`,
    options,
  });
  if (p.isCancel(choice)) return 'back';
  return choice;
}

/**
 * Run the persistent main menu loop. Returns when the user picks Exit
 * or sends Ctrl+C.
 */
export async function runMainMenu(claudeJsonPath: string, accountsDirPath: string): Promise<void> {
  const useAltBuffer = altBufferSupported();
  // Register restore on every shutdown path BEFORE entering, so a panic /
  // SIGKILL doesn't leave the user stuck in the alt buffer.
  let cleaned = false;
  const restoreBuffer = (): void => {
    if (cleaned || !useAltBuffer) return;
    cleaned = true;
    process.stdout.write(ALT_BUFFER_EXIT);
  };
  // Track signal handlers so we can detach them when the menu exits
  // normally; otherwise they linger and pre-empt any handler the parent
  // process might register later.
  const sigintHandler = (): void => { restoreBuffer(); process.exit(130); };
  const sigtermHandler = (): void => { restoreBuffer(); process.exit(143); };
  if (useAltBuffer) {
    process.stdout.write(ALT_BUFFER_ENTER + CLEAR_AND_HOME);
    process.once('exit', restoreBuffer);
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
  }

  try {
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
    // Wipe the alt buffer at the top of each iteration so the menu always
    // looks like a single live screen instead of a growing transcript.
    if (useAltBuffer) process.stdout.write(CLEAR_AND_HOME);
    p.note(buildStatusLines(claudeJsonPath, accountsDirPath), 'Status');
    const action = await pickAction(claudeJsonPath, accountsDirPath);

    if (action === 'exit') {
      p.outro('See you.');
      return;
    }

    try {
      switch (action) {
        case 'switch': {
          const before = getCurrent(claudeJsonPath);
          const after = await selectAccountInteractive(claudeJsonPath, accountsDirPath);
          // If a real switch happened (different from the previous active),
          // exit the menu and hand control to claude immediately. The user
          // came here to use that account; making them exit and type
          // `claude` again is friction.
          if (after && after !== before) {
            const bin = findClaudeBinary(import.meta.url);
            if (bin) {
              restoreBuffer();
              const { command, args, options } = buildSpawnArgs(bin, [], process.platform);
              const result = spawnSync(command, args, options);
              if (result.error) {
                process.stderr.write(`Error: could not launch claude: ${result.error.message}\n`);
                process.exit(1);
              }
              process.exit(result.status ?? 0);
            }
          }
          break;
        }
        case 'reauth': {
          const bin = findClaudeBinary(import.meta.url);
          if (!bin) {
            p.note('Could not find claude binary — run setup first.', 'Setup needed');
            break;
          }
          // No spinner here — claude auth login runs with stdio:'inherit'
          // and prints its own URL/prompts. A spinner running on the same
          // TTY would corrupt that output.
          p.note(
            'A browser window will open. Complete the login and return here.',
            'Re-authenticating',
          );
          try {
            const result = await reAuthenticate(bin, claudeJsonPath, accountsDirPath);
            p.note(
              result ? `Tokens refreshed for ${result}` : 'Login did not complete — token state unchanged.',
              result ? 'Done' : 'Cancelled',
            );
          } catch (e) {
            p.note((e as Error).message, 'Re-authentication failed');
          }
          break;
        }
        case 'manage': {
          const target = await pickAccount('Manage which account?', accountsDirPath);
          if (!target) break;
          // Sub-loop so the user can chain multiple edits on the same
          // account without re-picking it. Exits on Back / Esc / remove.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (useAltBuffer) process.stdout.write(CLEAR_AND_HOME);
            const isActive = getCurrent(claudeJsonPath) === target;
            p.note(buildAccountInfo(target, accountsDirPath, isActive), 'Account');
            const sub = await pickManageAction(target, accountsDirPath, isActive);
            if (sub === 'back') break;
            try {
              if (sub === 'apikey-set') {
                await setApiKeyInteractive(target, accountsDirPath);
              } else if (sub === 'apikey-remove') {
                const ok = await p.confirm({
                  message: `Remove the saved API key for ${target}?`,
                  initialValue: false,
                });
                if (!p.isCancel(ok) && ok) {
                  const removed = withLock(accountsDirPath, () => removeApiKey(target, accountsDirPath));
                  p.note(removed ? 'API key removed.' : 'No key was saved.', 'Done');
                }
              } else if (sub === 'alias-add') {
                const aliasRaw = await p.text({
                  message: 'New alias',
                  placeholder: 'work, personal, …',
                  validate: (val) => !val ? 'Alias cannot be empty.' : undefined,
                });
                if (!p.isCancel(aliasRaw)) {
                  const name = aliasRaw.trim();
                  if (name) {
                    setAlias(name, target, accountsDirPath);
                    p.note(`Alias set: ${name} → ${target}`, 'Done');
                  }
                }
              } else if (sub === 'alias-remove') {
                const aliases = getAliasesForEmail(target, accountsDirPath);
                if (aliases.length === 0) {
                  p.note('No aliases on this account.', 'Empty');
                  break;
                }
                const pick = await p.select<string>({
                  message: 'Remove which alias?',
                  options: aliases.map(a => ({ value: a, label: a })),
                });
                if (!p.isCancel(pick)) {
                  removeAlias(pick, accountsDirPath);
                  p.note(`Alias removed: ${pick}`, 'Done');
                }
              } else if (sub === 'remove') {
                const result = await removeAccountInteractive(target, claudeJsonPath, accountsDirPath);
                if (result.removed) {
                  // Account is gone — back to main menu.
                  break;
                }
              }
            } catch (e) {
              p.note((e as Error).message, 'Error');
            }
          }
          break;
        }
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
            // Block the user from disarming fallback if their OAuth is dead —
            // that would leave them with no working auth at all.
            const current = getCurrent(claudeJsonPath);
            const health = current ? getTokenHealth(claudeJsonPath) : null;
            if (health && (health.status === 'expired' || health.status === 'missing')) {
              p.note(
                `OAuth token is ${health.status === 'expired' ? 'EXPIRED' : 'missing'}.\n` +
                `Turning fallback OFF now means claude has no working auth until you\n` +
                `re-authenticate with "Add account".`,
                'Heads up',
              );
              const proceed = await p.confirm({
                message: 'Turn fallback OFF anyway?',
                initialValue: false,
              });
              if (p.isCancel(proceed) || !proceed) break;
            }
            setFallbackEnabled(accountsDirPath, false);
            p.note('Fallback OFF. The next claude run will use OAuth subscription.', 'Done');
          }
          break;
        }
        case 'auto-fallback': {
          await runAutoFallbackMenu(accountsDirPath);
          break;
        }
        case 'profiles': {
          const bin = findClaudeBinary(import.meta.url);
          if (!bin) {
            p.note('Could not find the real claude binary — run setup first.', 'Setup needed');
            break;
          }
          await runProfilesMenu(accountsDirPath, bin, restoreBuffer);
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
  } finally {
    restoreBuffer();
    if (useAltBuffer) {
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
    }
  }
}
