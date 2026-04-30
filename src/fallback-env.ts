// src/fallback-env.ts
// Decide whether to inject ANTHROPIC_API_KEY when spawning claude.
//
// The flag is global (`.fallback-enabled` marker file) and the key is
// per-account. The composition is: fallback ON + account has key →
// inject. Otherwise null and the spawn proceeds with claude's normal
// OAuth subscription auth.
//
// Extracted from bin/cli.ts so the multi-account hot-path decision is
// testable in isolation.

import { isFallbackEnabled } from './fallback.js';
import { getApiKey } from './apikey.js';

/**
 * Returns the env addition for spawning claude under the given account,
 * or null if no API-key fallback should kick in. The returned env is
 * **additive** — the caller is responsible for merging it with `process.env`.
 */
export function fallbackEnvFor(email: string, accountsDirPath: string): NodeJS.ProcessEnv | null {
  if (!isFallbackEnabled(accountsDirPath)) return null;
  const key = getApiKey(email, accountsDirPath);
  if (!key) return null;
  return { ANTHROPIC_API_KEY: key };
}
