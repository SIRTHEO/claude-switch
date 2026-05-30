// src/auto-fallback.ts
// Two complementary opt-in behaviours, both driven by the cached usage:
//
//   - **auto-revert** (existing): when fallback is ON and 5h+7d drop
//     below `revertThreshold`, flip fallback OFF. So you pay for API
//     credits only for the duration of the actual cap.
//
//   - **auto-engage** (new): when fallback is OFF and 5h or 7d crosses
//     `engageThreshold` upward (default 95%), flip fallback ON if the
//     active account has an API key saved. So you don't have to manually
//     toggle the moment you approach a rate limit.
//
// Together they form a "set it and forget it" hysteresis loop:
//   100% ─────●────────●─── (engage at 95%)
//   80%  ──●───────●─── (revert at 80%)
//   0%
//
// Auto-init: when an API key is saved for the first time (or on the first
// passthrough that finds a key but no config), smart fallback is enabled
// automatically via `maybeInitSmartFallback`. The config file acts as the
// opt-out sentinel — if it exists, the user's existing settings are kept.

import fs from 'node:fs';
import path from 'node:path';
import { isFallbackEnabled, setFallbackEnabledInLock } from './fallback.js';
import { getCurrent } from '../accounts/accounts.js';
import { getApiKey, setApiKey } from '../credentials/apikey.js';
import { readUsageCacheFor } from '../usage/usage.js';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import { withLock } from '../platform/lock.js';
import {
  AutoFallbackConfigSchema,
  DEFAULT_AUTO_FALLBACK_CONFIG,
  DEFAULT_REVERT_THRESHOLD,
  DEFAULT_ENGAGE_THRESHOLD,
  clampThreshold,
} from './auto-fallback-schema.js';
import type { AutoFallbackConfig } from './auto-fallback-schema.js';

// Re-exported so existing consumers (auto-fallback.tsx, fallback.ts) keep
// importing the type from this module.
export type { AutoFallbackConfig };

const CONFIG_FILE = '.auto-fallback.json';

function configPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, CONFIG_FILE);
}

export function getAutoFallbackConfig(accountsDirPath: string): AutoFallbackConfig {
  // Parse the on-disk config through the schema. Its per-field transforms apply
  // the [1,100] clamp and the read-time engageThreshold > threshold invariant
  // repair; a non-object payload fails the parse and a read / JSON error throws
  // — both fall through to the safe defaults.
  try {
    const parsed = AutoFallbackConfigSchema.safeParse(
      JSON.parse(fs.readFileSync(configPath(accountsDirPath), 'utf-8')),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // missing / corrupt config → defaults below
  }
  return { ...DEFAULT_AUTO_FALLBACK_CONFIG };
}

export function setAutoFallbackConfig(
  accountsDirPath: string,
  patch: Partial<AutoFallbackConfig>,
): AutoFallbackConfig {
  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });
  const current = getAutoFallbackConfig(accountsDirPath);
  const next: AutoFallbackConfig = {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    threshold: patch.threshold !== undefined
      ? clampThreshold(patch.threshold, DEFAULT_REVERT_THRESHOLD)
      : current.threshold,
    engageEnabled: patch.engageEnabled !== undefined ? patch.engageEnabled : current.engageEnabled,
    engageThreshold: patch.engageThreshold !== undefined
      ? clampThreshold(patch.engageThreshold, DEFAULT_ENGAGE_THRESHOLD)
      : current.engageThreshold,
  };
  // Sanity: engageThreshold should be > threshold to avoid oscillation.
  if (next.engageThreshold <= next.threshold) {
    throw new Error(
      `engageThreshold (${next.engageThreshold}%) must be strictly greater than the auto-revert threshold (${next.threshold}%) to avoid oscillation.`,
    );
  }
  writeJsonAtomic(configPath(accountsDirPath), next);
  return next;
}

/**
 * Write smart-fallback defaults (both auto-revert and auto-engage enabled)
 * when no config file exists yet. Called after `apikey set` and on the first
 * passthrough that finds a key. Idempotent: no-op if the config file already
 * exists (preserves deliberate opt-outs).
 */
export function maybeInitSmartFallback(accountsDirPath: string): boolean {
  if (fs.existsSync(configPath(accountsDirPath))) return false;
  setAutoFallbackConfig(accountsDirPath, { enabled: true, engageEnabled: true });
  return true;
}

/**
 * Save an API key for an account and, if smart-fallback has never been
 * configured before, opportunistically turn it on with sane defaults.
 * Two-step UX flow consolidated here so screens don't have to remember
 * to chain `setApiKey` → `maybeInitSmartFallback` (and the order between
 * lock-required vs lock-free calls).
 *
 * Returns `{ smartEnabled }` reflecting whether THIS call initialised
 * smart-fallback (false on every subsequent call once the config exists).
 */
export function saveApiKeyAndMaybeInit(
  email: string,
  key: string,
  accountsDirPath: string,
): { smartEnabled: boolean } {
  withLock(accountsDirPath, () => setApiKey(email, key, accountsDirPath));
  // Lock-free: maybeInitSmartFallback only writes the auto-fallback
  // config file (separate from the per-account state), so it doesn't
  // need to coordinate with the per-account write above.
  const smartEnabled = maybeInitSmartFallback(accountsDirPath);
  return { smartEnabled };
}

interface AutoDisableResult {
  /** True when this call disabled fallback. False when nothing was done. */
  disabled: boolean;
  fivePct?: number;
  sevenPct?: number;
  threshold: number;
}

/**
 * Decide whether the configured smart-switch should kick in. When all of
 * the conditions hold, this turns fallback OFF as a side effect:
 *   - smart-switch is enabled
 *   - fallback is currently ON
 *   - we have a cached usage payload for the active account
 *   - the cache is not in a 429 back-off window
 *   - both 5h and 7d utilisation are strictly below the threshold
 *     (7d is also checked so we don't bounce back to OAuth just to hit
 *     the weekly cap a few minutes later)
 */
export function maybeAutoDisableFallback(
  accountsDirPath: string,
  claudeJsonPath: string,
): AutoDisableResult {
  const config = getAutoFallbackConfig(accountsDirPath);
  const result: AutoDisableResult = { disabled: false, threshold: config.threshold };

  if (!config.enabled) return result;
  if (!isFallbackEnabled(accountsDirPath)) return result;

  const email = getCurrent(claudeJsonPath);
  if (!email) return result;

  const cache = readUsageCacheFor(accountsDirPath, email);
  if (!cache?.payload) return result;
  if (cache.rateLimitedUntil && cache.rateLimitedUntil > Date.now()) return result;

  const fivePct = cache.payload.five_hour?.utilization;
  const sevenPct = cache.payload.seven_day?.utilization;
  if (typeof fivePct !== 'number') return result;

  result.fivePct = fivePct;
  result.sevenPct = sevenPct;

  // Both windows must be present AND below threshold. If 7d is missing
  // from the payload (Anthropic stops including it, partial response, etc.)
  // we wait for a complete cache rather than risk bouncing back to OAuth
  // only to slam into the weekly cap minutes later.
  const fiveOk = fivePct < config.threshold;
  const sevenOk = typeof sevenPct === 'number' && sevenPct < config.threshold;
  if (fiveOk && sevenOk) {
    setFallbackEnabledInLock(accountsDirPath, false);
    result.disabled = true;
  }
  return result;
}

interface AutoEngageResult {
  /** True when this call enabled fallback. False when nothing was done. */
  engaged: boolean;
  fivePct?: number;
  sevenPct?: number;
  /** The window that crossed the threshold (5h or 7d), if engaged. */
  reason?: '5h' | '7d';
  threshold: number;
  /** Set to a human-readable explanation when we couldn't engage even
   *  though we wanted to (e.g. account has no API key saved). */
  blocked?: string;
}

/**
 * Mirror of maybeAutoDisableFallback: when fallback is OFF and either
 * 5h or 7d crosses the engage threshold (defaults to 95%), turn fallback
 * ON if the active account has an API key saved. So you don't end up
 * staring at "rate limit reached" inside a long session.
 *
 * Decisive differences from auto-revert:
 *   - either window crossing the threshold triggers (not both),
 *     because rate-limit pain is felt as soon as one of the caps hits,
 *   - account must have an API key to inject — we report it as
 *     `blocked: "no API key for <email>"` otherwise so the caller can
 *     surface the problem instead of silently doing nothing.
 */
export function maybeAutoEngageFallback(
  accountsDirPath: string,
  claudeJsonPath: string,
): AutoEngageResult {
  const config = getAutoFallbackConfig(accountsDirPath);
  const result: AutoEngageResult = { engaged: false, threshold: config.engageThreshold };

  if (!config.engageEnabled) return result;
  if (isFallbackEnabled(accountsDirPath)) return result; // already on, nothing to do

  const email = getCurrent(claudeJsonPath);
  if (!email) return result;

  const cache = readUsageCacheFor(accountsDirPath, email);
  if (!cache?.payload) return result;
  if (cache.rateLimitedUntil && cache.rateLimitedUntil > Date.now()) return result;

  const fivePct = cache.payload.five_hour?.utilization;
  const sevenPct = cache.payload.seven_day?.utilization;
  if (typeof fivePct !== 'number') return result;
  result.fivePct = fivePct;
  result.sevenPct = sevenPct;

  let reason: '5h' | '7d' | null = null;
  if (fivePct >= config.engageThreshold) reason = '5h';
  else if (typeof sevenPct === 'number' && sevenPct >= config.engageThreshold) reason = '7d';
  if (!reason) return result;

  // We want to engage. Verify there's actually a key to inject.
  const apiKey = getApiKey(email, accountsDirPath);
  if (!apiKey) {
    result.blocked = `${email} has no API key saved — run "claude switch apikey set" to enable auto-engage.`;
    return result;
  }

  setFallbackEnabledInLock(accountsDirPath, true, { byAutoEngage: true });
  result.engaged = true;
  result.reason = reason;
  return result;
}
