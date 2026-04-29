// src/ui/main-menu.ts
// Persistent main menu. Each action returns to the menu instead of exiting,
// matching the convention of tools like `gh`, `lazygit`, etc.

import * as p from '@clack/prompts';
import { getCurrent, list as listAccounts } from '../accounts.js';
import { isFallbackEnabled, setFallbackEnabled } from '../fallback.js';
import { getAutoFallbackConfig, setAutoFallbackConfig } from '../auto-fallback.js';
import { getApiKey } from '../apikey.js';
import { readUsageCache, readUsageCacheFor, isUsageCacheStale, triggerBackgroundUsageRefresh, fetchUsageCached, getAccessTokenFromKeychain } from '../usage.js';
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

type MenuAction =
  | 'switch'
  | 'reauth'
  | 'add'
  | 'remove'
  | 'apikey'
  | 'fallback'
  | 'auto-fallback'
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
  // Hint that smart-switch is armed — explains why fallback might flip OFF
  // unexpectedly the next time the user runs claude.
  const autoCfg = getAutoFallbackConfig(accountsDirPath);
  if (autoCfg.enabled && fallbackOn) {
    authMode += `  ${theme.dim(`(smart-switch armed: <${autoCfg.threshold}%)`)}`;
  }
  lines.push(`${theme.brand('Auth mode')}  ${authMode}`);

  // Token expiry. Only urgent when the user is actually using OAuth — if
  // fallback is on with a saved key, all calls go through the API key and
  // the OAuth token's state is irrelevant.
  if (tokenHealth) {
    let tokenLine: string;
    if (usingApi) {
      // We're not using OAuth; demote any token issue to dim parenthetical.
      switch (tokenHealth.status) {
        case 'valid':
          tokenLine = theme.dim(`valid (${tokenHealth.expiresIn}) — not in use while fallback is on`);
          break;
        case 'expired':
          tokenLine = theme.dim(`expired (${tokenHealth.expiresIn}) — not in use while fallback is on`);
          break;
        case 'present':
          tokenLine = theme.dim('present — not in use while fallback is on');
          break;
        case 'missing':
          tokenLine = theme.dim('missing — not in use while fallback is on');
          break;
      }
    } else {
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
    options.push({
      value: 'auto-fallback',
      label: autoCfg.enabled ? 'Disable smart-switch' : 'Enable smart-switch',
      hint: autoCfg.enabled
        ? `auto-OFF when 5h+7d < ${autoCfg.threshold}%`
        : 'auto-OFF fallback when subscription has room',
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

// Alternate-screen buffer control codes. Entering swaps the terminal to a
// fresh canvas (preserving the user's scrollback); exiting restores the
// original view. Without this, every menu iteration leaves a trail of
// status panels in the user's terminal history, which is what the menu
// is trying to NOT do — it should feel like a single live screen.
const ALT_BUFFER_ENTER = '\x1b[?1049h';
const ALT_BUFFER_EXIT  = '\x1b[?1049l';
const CLEAR_AND_HOME   = '\x1b[2J\x1b[H';

function altBufferSupported(): boolean {
  // Only meaningful on a real TTY. CI / piped output should fall through.
  return !!process.stdout.isTTY && process.env.TERM !== 'dumb';
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
  if (useAltBuffer) {
    process.stdout.write(ALT_BUFFER_ENTER + CLEAR_AND_HOME);
    process.once('exit', restoreBuffer);
    process.once('SIGINT', () => { restoreBuffer(); process.exit(130); });
    process.once('SIGTERM', () => { restoreBuffer(); process.exit(143); });
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
          const cfg = getAutoFallbackConfig(accountsDirPath);
          if (cfg.enabled) {
            setAutoFallbackConfig(accountsDirPath, { enabled: false });
            p.note('Smart-switch OFF. Fallback toggle is fully manual again.', 'Done');
            break;
          }
          // Enabling — let the user confirm or change the threshold.
          const tRaw = await p.text({
            message: 'Threshold (% — fallback flips OFF when both 5h and 7d are below this)',
            placeholder: String(cfg.threshold),
            initialValue: String(cfg.threshold),
            validate: (val) => {
              if (!val) return undefined;
              const n = parseInt(val, 10);
              if (!Number.isFinite(n) || n < 1 || n > 100) return 'Pick a number between 1 and 100.';
              return undefined;
            },
          });
          if (p.isCancel(tRaw)) break;
          const t = tRaw ? parseInt(tRaw, 10) : cfg.threshold;
          const next = setAutoFallbackConfig(accountsDirPath, { enabled: true, threshold: t });
          p.note(
            `Smart-switch ON (threshold ${next.threshold}%).\n\n` +
            `When fallback is on, the next "claude" run will turn it back off\n` +
            `as soon as both 5h and 7d utilisation drop below ${next.threshold}% — saving\n` +
            `your API credits the moment your subscription has headroom again.`,
            'Done',
          );
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
  }
}
