// src/ui/menu/status.ts
// Pure helpers that render the menu's status panel + per-account info.
//
// Extracted from `main-menu.ts` during the 5.2 split. These functions
// have no @clack/prompts dependency — they format strings only — so
// they're easy to evolve without touching the menu's interactive loop.

import { getCurrent } from '../../accounts.js';
import { isFallbackEnabled } from '../../fallback.js';
import { getAutoFallbackConfig } from '../../auto-fallback.js';
import { getApiKey, maskApiKey } from '../../apikey.js';
import { getAliasesForEmail } from '../../aliases.js';
import { readUsageCacheFor } from '../../usage.js';
import { getTokenHealth } from '../../token.js';
import { theme } from '../theme.js';

/**
 * Render the multi-line "Status" panel shown at the top of every menu
 * iteration: account, auth mode, token health, usage.
 */
export function buildStatusLines(claudeJsonPath: string, accountsDirPath: string): string {
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
    authMode += `  ${theme.dim(`(auto-revert armed: fallback OFF when 5h+7d < ${autoCfg.threshold}%)`)}`;
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

/**
 * Render the per-account "Account" panel shown when the user picks
 * "Manage account…" from the main menu.
 */
export function buildAccountInfo(email: string, accountsDirPath: string, isActive: boolean): string {
  const aliases = getAliasesForEmail(email, accountsDirPath);
  const apiKey = getApiKey(email, accountsDirPath);
  const lines: string[] = [
    `${theme.brand('Email')}    ${email}${isActive ? theme.dim('  (active)') : ''}`,
    `${theme.brand('Aliases')}  ${aliases.length ? aliases.join(', ') : theme.dim('(none)')}`,
    `${theme.brand('API key')}  ${apiKey ? maskApiKey(apiKey) : theme.dim('(not set)')}`,
  ];
  return lines.join('\n');
}
