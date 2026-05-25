// src/commands/usage.ts
// `claude switch usage [--force | --refresh-only]` — show Anthropic
// subscription utilization (5h / 7d windows + per-model breakdown).
//
// `--refresh-only` is an internal flag the statusline uses to refresh the
// cache asynchronously without producing any output.

import { ExitError, errMessage } from '../platform/errors.js';
import { withLock } from '../platform/lock.js';
import { getCurrent } from '../accounts/accounts.js';
import {
  getAccessTokenFromKeychain,
  fetchUsageCached,
  refreshUsageForAccount,
} from '../usage/usage.js';
import type { CommandContext } from './context.js';

export async function handleUsage(
  ctx: CommandContext,
  options: { force: boolean; refreshOnly: boolean; account?: string },
): Promise<void> {
  const { claudeJsonPath, accountsDirPath } = ctx;

  // `--account <email>` refreshes the cached usage for an account
  // regardless of which account is currently active. Loads tokens from
  // that account's snapshot file, refreshes them if expired, hits the
  // Anthropic usage endpoint with them. Used by the GUI to refresh a
  // non-active account without forcing the user to switch first.
  if (options.account) {
    try {
      const cache = await refreshUsageForAccount(options.account, accountsDirPath);
      if (cache.rateLimitedUntil && cache.rateLimitedUntil > Date.now()) {
        const waitSec = Math.ceil((cache.rateLimitedUntil - Date.now()) / 1000);
        console.log(
          `Anthropic's usage endpoint is rate-limiting ${options.account}. Retry in ~${waitSec}s.`,
        );
        return;
      }
      if (cache.payload) {
        const ageMin = Math.round((Date.now() - cache.fetchedAt) / 60_000);
        console.log(
          `Refreshed usage for ${options.account} (${ageMin} min ago):\n` +
            `  5-hour window:    ${cache.payload.five_hour.utilization.toFixed(1)}%\n` +
            `  7-day window:     ${cache.payload.seven_day.utilization.toFixed(1)}%`,
        );
        return;
      }
      console.log(`No usage payload returned for ${options.account}.`);
      return;
    } catch (e) {
      throw new ExitError(errMessage(e));
    }
  }

  // Snapshot (token, account) atomically. A concurrent `claude switch B`
  // between these two reads would otherwise pair token-of-A with
  // account-label-of-B, and we'd cache A's quota under B's name.
  const { token, currentAccount } = withLock(accountsDirPath, () => ({
    token: getAccessTokenFromKeychain(claudeJsonPath),
    currentAccount: getCurrent(claudeJsonPath) || undefined,
  }));

  if (!token) {
    if (options.refreshOnly) return; // background refresh: silently no-op
    throw new ExitError(
      'No OAuth access token available — only Max/Pro subscribers can use this. ' +
      'Make sure you are logged in: claude switch status',
    );
  }

  // refresh-only: just hit the endpoint and update the cache, no output.
  if (options.refreshOnly) {
    await fetchUsageCached(accountsDirPath, token, { force: true, account: currentAccount });
    return;
  }

  // When forcing, surface the raw fetch error so failures are diagnosable
  // (the cached path silently swallows non-429 errors to keep noise low).
  if (options.force) {
    const { fetchUsage: rawFetch } = await import('../usage/usage.js');
    const raw = await rawFetch(token);
    if (!raw.ok && !raw.rateLimited) {
      console.log(`Fetch error: ${raw.error}`);
    }
  }

  const cache = await fetchUsageCached(accountsDirPath, token, { force: options.force, account: currentAccount });
  if (cache.rateLimitedUntil && cache.rateLimitedUntil > Date.now()) {
    const waitSec = Math.ceil((cache.rateLimitedUntil - Date.now()) / 1000);
    console.log(
      `Anthropic's usage endpoint is rate-limiting us. ` +
      `Retry in ~${waitSec}s${cache.payload ? ' (showing last cached values below)' : ''}.`,
    );
  }

  if (cache.payload) {
    const ageMin = Math.round((Date.now() - cache.fetchedAt) / 60_000);
    const fmtReset = (iso?: string): string => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      const min = Math.round((d.getTime() - Date.now()) / 60_000);
      if (min < 60) return ` (resets in ${min}m)`;
      if (min < 60 * 24) return ` (resets in ${Math.round(min / 60)}h)`;
      return ` (resets in ${Math.round(min / 60 / 24)}d)`;
    };
    const five = cache.payload.five_hour;
    const seven = cache.payload.seven_day;
    const opus = cache.payload.seven_day_opus;
    const sonnet = cache.payload.seven_day_sonnet;
    console.log(`Subscription usage (cached ${ageMin} min ago):`);
    console.log(`  5-hour window:    ${five.utilization.toFixed(1)}%${fmtReset(five.resets_at)}`);
    console.log(`  7-day window:     ${seven.utilization.toFixed(1)}%${fmtReset(seven.resets_at)}`);
    if (opus) console.log(`    └ Opus 7d:      ${opus.utilization.toFixed(1)}%`);
    if (sonnet) console.log(`    └ Sonnet 7d:    ${sonnet.utilization.toFixed(1)}%`);
    if (five.utilization >= 85) {
      console.log('\n⚠ 5-hour window near limit. Consider:  claude switch fallback on');
    }
  } else if (!cache.rateLimitedUntil) {
    console.log('Could not fetch usage — endpoint unreachable. Try again later.');
  }
}
