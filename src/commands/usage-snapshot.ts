// src/commands/usage-snapshot.ts
// `claude switch usage-snapshot <email> [--json]` — read-only per-account
// cached usage. No network, no token required: emits whatever the
// per-account cache file currently holds, so callers (notably the GUI)
// can paint usage for non-active accounts without forcing a fetch.
//
// JSON shape mirrors the on-disk cache so consumers stay one schema.

import { readUsageCacheForAccount, type UsageCache } from '../usage/usage.js';
import { isSafeEmail } from '../accounts/accounts.js';
import { ExitError } from '../platform/errors.js';
import type { CommandContext } from './context.js';
import type { UsageSnapshot } from '../contract.js';

function shape(email: string, cache: UsageCache | null): UsageSnapshot {
  if (!cache?.payload) {
    return {
      account: email,
      fetchedAt: cache?.fetchedAt ?? null,
      ageSec: null,
      fiveHourPct: null,
      sevenDayPct: null,
      sevenDayOpusPct: null,
      sevenDaySonnetPct: null,
      rateLimitedUntil: cache?.rateLimitedUntil ?? null,
    };
  }
  return {
    account: email,
    fetchedAt: cache.fetchedAt,
    ageSec: Math.max(0, Math.round((Date.now() - cache.fetchedAt) / 1000)),
    fiveHourPct: cache.payload.five_hour?.utilization ?? null,
    sevenDayPct: cache.payload.seven_day?.utilization ?? null,
    sevenDayOpusPct: cache.payload.seven_day_opus?.utilization ?? null,
    sevenDaySonnetPct: cache.payload.seven_day_sonnet?.utilization ?? null,
    rateLimitedUntil: cache.rateLimitedUntil ?? null,
  };
}

export async function handleUsageSnapshot(
  ctx: CommandContext,
  options: { email: string; json: boolean },
): Promise<void> {
  const { accountsDirPath } = ctx;
  const email = options.email.trim();
  if (!isSafeEmail(email)) {
    throw new ExitError(`Invalid email: ${email}`);
  }
  const cache = readUsageCacheForAccount(accountsDirPath, email);
  const snap = shape(email, cache);

  if (options.json) {
    console.log(JSON.stringify(snap));
    return;
  }

  if (snap.fiveHourPct == null) {
    console.log(`No cached usage for ${email}.`);
    return;
  }
  const ageMin = snap.ageSec != null ? Math.round(snap.ageSec / 60) : null;
  console.log(`Cached usage for ${email}${ageMin != null ? ` (${ageMin} min ago)` : ''}:`);
  console.log(`  5-hour window:    ${snap.fiveHourPct.toFixed(1)}%`);
  if (snap.sevenDayPct != null) {
    console.log(`  7-day window:     ${snap.sevenDayPct.toFixed(1)}%`);
  }
  if (snap.sevenDayOpusPct != null) {
    console.log(`    └ Opus 7d:      ${snap.sevenDayOpusPct.toFixed(1)}%`);
  }
  if (snap.sevenDaySonnetPct != null) {
    console.log(`    └ Sonnet 7d:    ${snap.sevenDaySonnetPct.toFixed(1)}%`);
  }
}
