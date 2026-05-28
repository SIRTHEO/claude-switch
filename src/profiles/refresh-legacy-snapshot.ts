// src/profiles/refresh-legacy-snapshot.ts
//
// Refresh a legacy account snapshot's OAuth tokens before they are imported
// into a profile, and mirror the rotated tokens into the file vault when the
// snapshot belongs to the currently-active account.
//
// Extracted from `profiles.ts` (file-size ratchet) so the refresh helper and
// its dependencies (HttpPort, CredentialStore, mirrorActiveOauthVaultIfApplicable)
// live next to the function that uses them. `profiles.ts` re-exports the
// public name so callers don't notice.

import { syncActiveSnapshotIfStale, resolvedAccountFile } from '../accounts/accounts.js';
import type { AccountSnapshot } from '../accounts/account-snapshot.js';
import type { CredentialStore } from '../credentials/credential-store.js';
import type { HttpPort } from '../platform/http.js';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import { claudeJsonPath } from '../platform/paths.js';
import { mirrorActiveOauthVaultIfApplicable } from '../usage/active-vault-mirror.js';
import { readLegacyAccount } from './profiles-read.js';

/**
 * If the legacy account's `_keychain.claudeAiOauth` access token is expired
 * (or about to expire), call the Anthropic OAuth refresh endpoint and rewrite
 * the snapshot in-place. Returns true when a refresh actually happened, false
 * otherwise (no _keychain, no refresh_token, fresh tokens, or refresh failed).
 *
 * Called internally by `ensureProfileForAccount` before the sync
 * `importProfileFromAccount` flow, so the snapshot landing in the Keychain
 * / per-profile JSON is fresh by construction. Without this pre-step, profiles
 * dormant for hours/days would carry expired access tokens straight to claude,
 * which then 401s instead of auto-refreshing (it doesn't auto-refresh in
 * --print mode against a non-default config dir).
 *
 * Failure is silent: we log nothing, return false, and let the caller fall
 * through to its existing "needsLogin" handling.
 */
export async function refreshLegacySnapshotIfStale(
  email: string,
  accountsDirPath: string,
  deps?: {
    credentials?: CredentialStore;
    claudeJsonPath?: string;
    http?: HttpPort;
  },
): Promise<boolean> {
  // If the legacy snapshot is for the currently-active account AND claude.json
  // (or .credentials.json, per 46dad12) was mutated externally, capture the
  // live state first — otherwise we'd refresh stale tokens and re-store them,
  // losing whatever claude already rotated.
  const jsonPath = deps?.claudeJsonPath ?? claudeJsonPath();
  syncActiveSnapshotIfStale(jsonPath, accountsDirPath);

  let legacy: AccountSnapshot;
  try {
    legacy = readLegacyAccount(email, accountsDirPath);
  } catch {
    // no readable legacy account → nothing to migrate
    return false;
  }
  const oauth = legacy._keychain?.claudeAiOauth;
  if (!oauth) return false;

  const { isAccessTokenStale, refreshAccessToken } = await import('../credentials/oauth-refresh.js');
  if (!isAccessTokenStale(oauth)) return false;
  if (!oauth.refreshToken) return false;

  const refreshed = await refreshAccessToken(oauth.refreshToken, { http: deps?.http });
  if (!refreshed) return false;

  // Atomic-rewrite preserving every other field — only `_keychain.claudeAiOauth`
  // changes, and there we MERGE refreshed onto prior so metadata the token
  // endpoint omits (subscriptionType, rateLimitTier, scopes) survives.
  const merged = { ...oauth, ...refreshed, scopes: refreshed.scopes ?? oauth.scopes };
  const next: AccountSnapshot = {
    ...legacy,
    _keychain: { ...legacy._keychain, claudeAiOauth: merged },
  };
  writeJsonAtomic(resolvedAccountFile(email, accountsDirPath), next);

  // Phase-24 regression — second face of the bug fixed alongside in
  // `refreshUsageForAccount`. If `email` is the active account, the rotation
  // we just performed invalidated the refresh_token in the file vault Claude
  // Code reads at runtime. Mirror the refreshed block there too so the
  // running binary's next internal refresh doesn't 401 → /login. Best-effort.
  mirrorActiveOauthVaultIfApplicable(email, merged, {
    credentials: deps?.credentials,
    claudeJsonPath: jsonPath,
  });

  return true;
}
