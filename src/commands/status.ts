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

  // Render the most recent proxy session's counters when available.
  // The file is written by `startFallbackProxy.close()` after each
  // session, so it always reflects the LAST run of `claude` — not the
  // currently-running one. That's intentional: status is a
  // post-mortem surface, not a live monitor.
  renderProxyStats(accountsDirPath);
}

interface ProxyStatsFile {
  persistedAt?: number;
  mode?: string;
  burstActive?: boolean;
  consecutiveOauthFailures?: number;
  counters?: {
    totalRequests?: number;
    oauthAttempts?: number;
    oauthSuccesses?: number;
    oauthFailures?: number;
    apiKeyDirectRequests?: number;
    apiKeyRetries?: number;
    upstreamErrors?: number;
    bodySniffsTriggered?: number;
  };
  lastRetryReason?: string | null;
}

function renderProxyStats(accountsDirPath: string): void {
  const file = path.join(accountsDirPath, '.proxy-stats.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return; // no proxy session has run yet — silent
  }
  let stats: ProxyStatsFile;
  try {
    stats = JSON.parse(raw) as ProxyStatsFile;
  } catch { // corrupt proxy-stats file → show nothing
    return;
  }
  const c = stats.counters ?? {};
  const total = c.totalRequests ?? 0;
  if (total === 0) return; // proxy ran but received no requests — skip noise

  const ago = stats.persistedAt
    ? formatAgo(Date.now() - stats.persistedAt)
    : 'unknown';
  console.log('');
  console.log(`Proxy (last session, ${ago}):`);
  console.log(`  Mode:               ${stats.mode ?? '?'}`);
  console.log(`  Total requests:     ${total}`);
  console.log(`  OAuth attempts:     ${c.oauthAttempts ?? 0} (${c.oauthSuccesses ?? 0} ok, ${c.oauthFailures ?? 0} failed)`);
  console.log(`  API key retries:    ${c.apiKeyRetries ?? 0}`);
  console.log(`  API key direct:     ${c.apiKeyDirectRequests ?? 0}`);
  if ((c.bodySniffsTriggered ?? 0) > 0) {
    console.log(`  Body sniff hits:    ${c.bodySniffsTriggered}`);
  }
  if ((c.upstreamErrors ?? 0) > 0) {
    console.log(`  Upstream errors:    ${c.upstreamErrors}`);
  }
  if (stats.lastRetryReason) {
    console.log(`  Last retry reason:  ${stats.lastRetryReason}`);
  }
}

function formatAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
