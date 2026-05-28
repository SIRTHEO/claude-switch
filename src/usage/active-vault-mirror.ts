// src/usage/active-vault-mirror.ts
//
// Mirror a refreshed OAuth block into the file vault when the email being
// refreshed is the currently-active account. Phase-24 regression fix:
//
// When the per-account usage refresh path
// (`refreshUsageForAccount` → `refreshIfStale` → POST to platform.claude.com)
// rotates the OAuth refresh_token at Anthropic for the active account, the
// server invalidates the previous refresh_token immediately. Before this
// mirror, the rotation only landed in the per-account snapshot — the
// `~/.claude/.credentials.json` file vault the running `claude` binary reads
// kept the rotated-away refresh_token. The binary's next internal refresh
// then sent the invalidated token and the server replied 401, surfacing as
// "Please run /login" mid-session.
//
// Lives in `usage/` because it is the trailing step of the usage-refresh
// flow; the credentials port itself is unaware of "which account is active".
// Exposed for direct unit tests of the mirror semantics — production code
// reaches it through `refreshUsageForAccount`.

import { getCurrent } from '../accounts/accounts.js';
import {
  type ClaudeAiOauth,
  type CredentialStore,
  defaultCredentialStore,
  type KeychainData,
} from '../credentials/credential-store.js';
import { claudeJsonPath as defaultClaudeJsonPath } from '../platform/paths.js';

/**
 * Mirror `refreshed` into `deps.credentials` (the file vault by default) when
 * `email` matches the active account in `deps.claudeJsonPath` (defaults to the
 * real `~/.claude.json`).
 *
 * Best-effort: every failure mode silently no-ops. The snapshot already carries
 * the refreshed tokens by the time this is called; a vault-write failure
 * leaves Claude Code in the pre-fix behaviour (next refresh hits 401 and
 * prompts /login), not in a worse state.
 */
export function mirrorActiveOauthVaultIfApplicable(
  email: string,
  refreshed: ClaudeAiOauth,
  deps?: { credentials?: CredentialStore; claudeJsonPath?: string },
): void {
  const jsonPath = deps?.claudeJsonPath ?? defaultClaudeJsonPath();
  let active = '';
  try {
    active = getCurrent(jsonPath);
  } catch {
    // claude.json missing / unreadable → can't decide active account; skip.
    return;
  }
  if (!active || active !== email) return;
  const store = deps?.credentials ?? defaultCredentialStore;
  let existing: KeychainData | null = null;
  try {
    existing = store.readOAuth();
  } catch {
    // vault read failure → write a fresh `claudeAiOauth` block below.
  }
  const merged: KeychainData = {
    ...(existing ?? {}),
    claudeAiOauth: {
      ...(existing?.claudeAiOauth ?? {}),
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      // refreshIfStale already merges these from the prior block onto the
      // refreshed one (the OAuth refresh endpoint omits them), so passing
      // them through preserves subscriptionType / rateLimitTier / scopes.
      ...(refreshed.scopes !== undefined ? { scopes: refreshed.scopes } : {}),
      ...(refreshed.subscriptionType !== undefined
        ? { subscriptionType: refreshed.subscriptionType }
        : {}),
      ...(refreshed.rateLimitTier !== undefined
        ? { rateLimitTier: refreshed.rateLimitTier }
        : {}),
    },
  };
  try {
    store.writeOAuth(merged);
  } catch {
    // best-effort — see module header.
  }
}
