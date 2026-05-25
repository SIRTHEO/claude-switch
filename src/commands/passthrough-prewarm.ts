// src/commands/passthrough-prewarm.ts
// Synchronously refresh the usage cache when the active account is on the
// verge of needing auto-engage, so the engage decision in the passthrough
// hot path is based on the actual current quota state rather than a stale
// reading. Silent on every failure mode — the cache-based path takes over.

import { getCurrent } from '../accounts.js';
import { getApiKey } from '../apikey.js';
import { isFallbackEnabled } from '../fallback.js';
import {
  fetchUsageCached,
  getAccessTokenFromKeychain,
  isUsageCacheStale,
  readUsageCacheForAccount,
} from '../usage.js';

/**
 * Synchronously refresh the usage cache when the active account is on
 * the verge of needing auto-engage. Returns silently on every failure
 * mode (no token, network down, rate-limited): the existing
 * cache-based path takes over and behaviour is identical to before.
 *
 * Gated behind a precise predicate so we don't pay the round-trip on
 * the 99% of invocations where the cache is fresh OR fallback is
 * already on OR there's no key to engage anyway.
 */
export async function preWarmUsageForAutoEngage(
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<void> {
  // Already on fallback — auto-engage would no-op even with fresh data.
  if (isFallbackEnabled(accountsDirPath)) return;

  // No active account or active account has no key — engage can't trigger.
  let email: string;
  try {
    email = getCurrent(claudeJsonPath);
  } catch { return; } // no resolvable active account → nothing to auto-engage
  if (!email) return;
  if (!getApiKey(email, accountsDirPath)) return;

  // Cache fresh enough — let the existing path read it as-is. We
  // intentionally use the same `isUsageCacheStale` predicate the
  // statusline uses, so behaviour is consistent across surfaces.
  const cache = readUsageCacheForAccount(accountsDirPath, email);
  if (!isUsageCacheStale(cache, email)) return;

  // We need to force-fetch. Requires an OAuth access token —
  // getAccessTokenFromKeychain reads from `~/.claude.json` on
  // non-darwin or queries the Keychain on darwin. If we can't get one,
  // we silently fall through (the existing flow uses a stale cache).
  const token = getAccessTokenFromKeychain(claudeJsonPath);
  if (!token) return;

  try {
    await fetchUsageCached(accountsDirPath, token, { force: true, account: email });
  } catch {
    /* network down / 5xx / 429 — leave the existing cache untouched */
  }
}
