// src/switcher-reauth.ts
// Re-authenticate the active account by running `claude auth login` and
// capturing the refreshed tokens — only when login actually produced a
// healthier token for the same account.

import { getCurrent, save } from './accounts.js';
import { withLock } from './lock.js';
import { nodeProcessAdapter } from './process.js';
import { buildSpawnArgs } from './proxy.js';
import type { SwitcherDeps } from './switcher-deps.js';

/**
 * Pure decision logic for whether a re-auth attempt actually refreshed
 * the tokens. Extracted so it can be unit-tested without spawning a
 * real `claude auth login`.
 *
 * Returns the email to save (success), or null when:
 *   - login left no active account (emailAfter empty),
 *   - login changed the active account (silent swap — don't trust),
 *   - token was broken before AND is still broken after (login cancelled).
 */
export function reAuthOutcome(
  emailBefore: string,
  healthBefore: { status: string } | null | undefined,
  emailAfter: string,
  healthAfter: { status: string } | null | undefined,
): string | null {
  if (!emailAfter) return null;
  if (emailBefore && emailAfter !== emailBefore) return null;
  const wasBroken = !healthBefore || healthBefore.status === 'expired' || healthBefore.status === 'missing';
  const stillBroken = !healthAfter || healthAfter.status === 'expired' || healthAfter.status === 'missing';
  if (wasBroken && stillBroken) return null;
  return emailAfter;
}

/**
 * Run `claude auth login` for the currently-active account to refresh its
 * Keychain tokens after expiry. Differs from addAccount in that we expect
 * the email to stay the same — we just want fresh tokens captured.
 *
 * Returns the email that's now active after the login, or null if login
 * failed entirely (no oauthAccount left in claude.json) or was cancelled.
 */
export async function reAuthenticate(
  claudeBin: string,
  claudeJsonPath: string,
  accountsDirPath: string,
  deps?: SwitcherDeps,
): Promise<string | null> {
  const doSpawnSync = (deps?.process ?? nodeProcessAdapter).spawnSync;
  const { getTokenHealth } = await import('./token.js');
  const getHealth = deps?.getTokenHealthFn ?? getTokenHealth;
  const emailBefore = getCurrent(claudeJsonPath);
  const healthBefore = getHealth(claudeJsonPath);

  const { command, args, options } = buildSpawnArgs(claudeBin, ['auth', 'login'], process.platform);
  doSpawnSync(command, args, options);

  const emailAfter = getCurrent(claudeJsonPath);
  const healthAfter = getHealth(claudeJsonPath);

  const outcome = reAuthOutcome(emailBefore, healthBefore, emailAfter, healthAfter);
  if (!outcome) return null;

  withLock(accountsDirPath, () => save(outcome, claudeJsonPath, accountsDirPath));
  return outcome;
}
