// src/commands/passthrough-warn.ts
// Transitional one-shot warning for an API key in ~/.claude.json that
// claude-switch does not track. Fires BEFORE accounts.load() purges the key
// on the next switch. To be removed in a future minor release.

import fs from 'node:fs';
import { getApiKey } from '../apikey.js';

let _warnedUntrackedApiKey = false;

/** Reset internal one-shot guard — exported for tests only. */
export function __resetWarnedOnceForTests(): void {
  _warnedUntrackedApiKey = false;
}

/**
 * Emit a one-time stderr banner when ~/.claude.json carries an apiKey that
 * claude-switch does not track. The banner fires BEFORE the key is purged
 * by accounts.load() on the next switch.
 *
 * Suppressed when NODE_ENV=test or CLAUDE_SWITCH_TESTING=1.
 */
export function warnUntrackedApiKeyIfNeeded(
  claudeJsonPath: string,
  accountsDirPath: string,
): void {
  if (_warnedUntrackedApiKey) return;
  if (process.env.NODE_ENV === 'test' || process.env.CLAUDE_SWITCH_TESTING === '1') return;

  let data: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(claudeJsonPath, 'utf-8');
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return; // unreadable / missing file — no-op
  }

  if (typeof data.apiKey !== 'string' || !data.apiKey) return;

  // Identify the active account so we can check whether claude-switch
  // tracks a key for it.
  const email = (data.oauthAccount as Record<string, unknown> | undefined)?.emailAddress;
  if (typeof email !== 'string' || !email) return;

  let tracked: string | null;
  try {
    tracked = getApiKey(email, accountsDirPath);
  } catch {
    return; // best-effort: don't crash passthrough on warning failure (e.g. unsafe email)
  }
  if (tracked !== null) return; // tracked — no warning

  _warnedUntrackedApiKey = true;
  process.stderr.write(
    '⚠ claude-switch: ~/.claude.json carries an API key NOT tracked by claude-switch.\n' +
    '  This will be removed on next account switch to prevent silent API billing.\n' +
    '  See: https://github.com/sirtheo/claude-switch (Security Advisory).\n\n',
  );
}
