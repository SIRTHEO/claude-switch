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
import { getCurrent } from './accounts.js';
import { getApiKey } from './apikey.js';
import { readUsageCacheFor } from './usage.js';
import { writeJsonAtomic } from './atomic-write.js';

const CONFIG_FILE = '.auto-fallback.json';
const DEFAULT_REVERT_THRESHOLD = 80;
const DEFAULT_ENGAGE_THRESHOLD = 95;

export interface AutoFallbackConfig {
  /** Auto-revert: fallback ON → OFF when usage drops. */
  enabled: boolean;
  /** Cutoff under which auto-revert flips fallback OFF. */
  threshold: number;
  /** Auto-engage: fallback OFF → ON when usage approaches the cap. */
  engageEnabled: boolean;
  /** Cutoff at/above which auto-engage flips fallback ON. */
  engageThreshold: number;
}

function configPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, CONFIG_FILE);
}

function clampThreshold(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

export function getAutoFallbackConfig(accountsDirPath: string): AutoFallbackConfig {
  const defaults: AutoFallbackConfig = {
    enabled: false,
    threshold: DEFAULT_REVERT_THRESHOLD,
    engageEnabled: false,
    engageThreshold: DEFAULT_ENGAGE_THRESHOLD,
  };
  try {
    const raw = fs.readFileSync(configPath(accountsDirPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaults;
    const obj = parsed as Record<string, unknown>;
    const threshold = clampThreshold(obj.threshold, DEFAULT_REVERT_THRESHOLD);
    let engageThreshold = clampThreshold(obj.engageThreshold, DEFAULT_ENGAGE_THRESHOLD);
    // Pre-2.7.x configs have only `threshold`. If a user set it above the
    // new default engage cutoff (e.g. threshold:99), combining old disk
    // state with new defaults violates the invariant engageThreshold > threshold,
    // which would let a single passthrough both disable AND re-engage in the
    // same call. Clamp on read so the rest of the code can rely on the
    // invariant unconditionally.
    if (engageThreshold <= threshold) engageThreshold = Math.min(100, threshold + 1);
    return {
      enabled: obj.enabled === true,
      threshold,
      engageEnabled: obj.engageEnabled === true,
      engageThreshold,
    };
  } catch {
    return defaults;
  }
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

export interface AutoDisableResult {
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

export interface AutoEngageResult {
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
