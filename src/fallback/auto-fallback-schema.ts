// src/fallback/auto-fallback-schema.ts
// Schema + defaults for `.auto-fallback.json`, split out of auto-fallback.ts
// (which sits just under the file-size budget, so an inline schema would trip
// the gate). The schema is the single source of truth for the AutoFallbackConfig
// type (via z.infer) and for the lenient on-disk parse: every field collapses to
// its default when missing/malformed, and the cross-field invariant
// engageThreshold > threshold is repaired at READ time so a misconfigured file
// can't arm a nonsensical auto-engage. The write path (setAutoFallbackConfig)
// reuses clampThreshold but THROWS on an invariant violation instead of
// repairing — there it's a user error worth surfacing.

import { z } from 'zod';

export const DEFAULT_REVERT_THRESHOLD = 80;
export const DEFAULT_ENGAGE_THRESHOLD = 95;

/** Clamp to an integer in [1, 100], or `fallback` when not a finite number. */
export function clampThreshold(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

// All on-disk fields are optional + unknown so a partial / malformed file never
// throws; the transform does the real work, mirroring the historical reader
// exactly (a field-level transform would NOT run for an absent key, so the
// per-field defaults have to be applied here on the raw values): clamp each
// threshold to [1,100] (default when not a finite number), coerce the flags with
// a strict `=== true`, then repair the engageThreshold > threshold invariant. A
// non-object payload fails z.object and the caller treats that as "use defaults".
export const AutoFallbackConfigSchema = z
  .object({
    enabled: z.unknown(),
    threshold: z.unknown(),
    engageEnabled: z.unknown(),
    engageThreshold: z.unknown(),
  })
  .partial()
  .transform((raw) => {
    const threshold = clampThreshold(raw.threshold, DEFAULT_REVERT_THRESHOLD);
    let engageThreshold = clampThreshold(raw.engageThreshold, DEFAULT_ENGAGE_THRESHOLD);
    // Pre-2.7.x files (threshold only) and any misconfigured file are repaired
    // so a single passthrough can't both disable AND re-engage.
    if (engageThreshold <= threshold) engageThreshold = Math.min(100, threshold + 1);
    return {
      enabled: raw.enabled === true,
      threshold,
      engageEnabled: raw.engageEnabled === true,
      engageThreshold,
    };
  });

export type AutoFallbackConfig = z.infer<typeof AutoFallbackConfigSchema>;

export const DEFAULT_AUTO_FALLBACK_CONFIG: AutoFallbackConfig = {
  enabled: false,
  threshold: DEFAULT_REVERT_THRESHOLD,
  engageEnabled: false,
  engageThreshold: DEFAULT_ENGAGE_THRESHOLD,
};
