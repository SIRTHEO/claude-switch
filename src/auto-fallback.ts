// src/auto-fallback.ts
// Optional smart-switch behaviour: when the user has manually enabled
// fallback (because they hit a subscription limit), automatically turn it
// back off as soon as the cached subscription usage drops back below a
// configurable threshold. This way the user pays for API credits only
// for the duration of the actual cap, not for the rest of the session.
//
// Strictly opt-in (default OFF). Decision is made off the cached usage
// payload that the statusline / menu already keep fresh, so there is no
// extra network call in the passthrough hot path.

import fs from 'node:fs';
import path from 'node:path';
import { isFallbackEnabled, setFallbackEnabled } from './fallback.js';
import { getCurrent } from './accounts.js';
import { readUsageCacheFor } from './usage.js';

const CONFIG_FILE = '.auto-fallback.json';
const DEFAULT_THRESHOLD = 80;

export interface AutoFallbackConfig {
  enabled: boolean;
  /** Switch fallback OFF as soon as both 5h and 7d utilisation drop
   *  strictly below this percentage. Range [1, 100]. */
  threshold: number;
}

function configPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, CONFIG_FILE);
}

function clampThreshold(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

export function getAutoFallbackConfig(accountsDirPath: string): AutoFallbackConfig {
  try {
    const raw = fs.readFileSync(configPath(accountsDirPath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { enabled: false, threshold: DEFAULT_THRESHOLD };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      enabled: obj.enabled === true,
      threshold: clampThreshold(obj.threshold),
    };
  } catch {
    return { enabled: false, threshold: DEFAULT_THRESHOLD };
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
    threshold: patch.threshold !== undefined ? clampThreshold(patch.threshold) : current.threshold,
  };
  const file = configPath(accountsDirPath);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(tmp, 0o600);
  }
  fs.renameSync(tmp, file);
  return next;
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

  const fiveOk = fivePct < config.threshold;
  const sevenOk = sevenPct === undefined || sevenPct < config.threshold;
  if (fiveOk && sevenOk) {
    setFallbackEnabled(accountsDirPath, false);
    result.disabled = true;
  }
  return result;
}
