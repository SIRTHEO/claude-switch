// src/usage-account.ts
// Per-account OAuth-token access for usage refresh: read a saved account's
// tokens from its snapshot (without touching the active-account state),
// refresh them if stale, and pull the access token from the Keychain / file
// vault for the active account.

import fs from 'node:fs';
import path from 'node:path';
import { isSafeEmail } from '../accounts/accounts.js';
import type { AccountSnapshot } from '../accounts/account-snapshot.js';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import { readKeychain } from '../credentials/keychain.js';
import type { CredentialStore } from '../credentials/credential-store.js';
import type { HttpPort } from '../platform/http.js';
import { mirrorActiveOauthVaultIfApplicable } from './active-vault-mirror.js';
import type { UsageCache } from './usage-cache.js';
import { fetchUsageCached } from './usage-fetch.js';

// Re-export the mirror helper from the path tests have always imported the
// usage-account surface from. Production callers reach it via
// `refreshUsageForAccount` so the re-export is mostly a test-ergonomics seam.
export { mirrorActiveOauthVaultIfApplicable };

/**
 * Read the OAuth tokens (accessToken / refreshToken / expiresAt) for a
 * specific account from its saved snapshot file, without touching the
 * active-account state in `~/.claude.json` or the Keychain.
 *
 * Used by per-account usage refresh so we can hit the Anthropic usage
 * endpoint on behalf of a NON-active account — e.g. to refresh the GUI's
 * cached numbers for the second account in a multi-account setup
 * without forcing the user to switch into it first.
 *
 * Returns null if the account file doesn't exist, isn't parseable, or
 * doesn't carry an accessToken.
 */
export function readAccountOauth(
  email: string,
  accountsDirPath: string,
): { accessToken: string; refreshToken?: string; expiresAt?: number | string } | null {
  if (!isSafeEmail(email)) return null;
  const accountFile = path.join(accountsDirPath, `${email}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(accountFile, 'utf-8');
  } catch { // account file absent → no usage snapshot
    return null;
  }
  let parsed: AccountSnapshot;
  try {
    parsed = JSON.parse(raw) as AccountSnapshot;
  } catch { // corrupt account file → no usage
    return null;
  }
  // Tokens live in one of three places depending on platform + snapshot
  // generation:
  //
  //   1. macOS: snapshot has `_keychain.claudeAiOauth.{accessToken,…}` —
  //      the active claude binary keeps live tokens in the Keychain, and
  //      save() copies that block into the file at snapshot time.
  //   2. Linux / Windows: snapshot has the tokens directly at the top
  //      level (claude.json's `oauthAccount` spread by save()).
  //   3. Legacy: tokens nested under an explicit `oauthAccount` object.
  //
  // Probe all three. The first one with a usable accessToken wins.
  const top = parsed;
  const nested = parsed.oauthAccount as Record<string, unknown> | undefined;
  const keychainBlock = parsed._keychain;
  const keychainOauth = keychainBlock?.claudeAiOauth;

  const accessToken =
    typeof keychainOauth?.accessToken === 'string'
      ? (keychainOauth.accessToken as string)
      : typeof top.accessToken === 'string'
        ? (top.accessToken as string)
        : typeof nested?.accessToken === 'string'
          ? (nested.accessToken as string)
          : null;
  if (!accessToken) return null;

  const refreshToken =
    typeof keychainOauth?.refreshToken === 'string'
      ? (keychainOauth.refreshToken as string)
      : typeof top.refreshToken === 'string'
        ? (top.refreshToken as string)
        : typeof nested?.refreshToken === 'string'
          ? (nested.refreshToken as string)
          : undefined;

  const expiresAtRaw =
    keychainOauth?.expiresAt ?? top.expiresAt ?? nested?.expiresAt;
  const expiresAt =
    typeof expiresAtRaw === 'number' || typeof expiresAtRaw === 'string'
      ? expiresAtRaw
      : undefined;

  return { accessToken, refreshToken, expiresAt };
}

/**
 * Persist a refreshed OAuth bundle back to the account file so the next
 * read sees the new (non-stale) tokens. Writes the tokens to BOTH locations
 * `readAccountOauth` probes: the top-level fields AND the
 * `_keychain.claudeAiOauth` block. The latter is read FIRST, so writing only
 * the top-level fields would leave the stale `_keychain` token shadowing the
 * refreshed one and force a re-refresh on every call. Updating `_keychain`
 * also keeps the block `load()` would restore current. Everything else in the
 * snapshot (apiKey, prefs) is preserved.
 */
export function persistRefreshedOauth(
  email: string,
  accountsDirPath: string,
  oauth: { accessToken: string; refreshToken?: string; expiresAt: number },
): void {
  if (!isSafeEmail(email)) return;
  const accountFile = path.join(accountsDirPath, `${email}.json`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(accountFile, 'utf-8')) as Record<string, unknown>;
  } catch { // missing/corrupt account file → nothing to update
    return;
  }
  parsed.accessToken = oauth.accessToken;
  if (oauth.refreshToken) parsed.refreshToken = oauth.refreshToken;
  parsed.expiresAt = oauth.expiresAt;

  // Mirror into `_keychain.claudeAiOauth` when present — readAccountOauth
  // reads it before the top-level fields, so the refresh has to land here too
  // or it never sticks (the macOS / snapshot-with-keychain path).
  const keychain = parsed._keychain as { claudeAiOauth?: Record<string, unknown> } | undefined;
  if (keychain?.claudeAiOauth && typeof keychain.claudeAiOauth === 'object') {
    keychain.claudeAiOauth.accessToken = oauth.accessToken;
    if (oauth.refreshToken) keychain.claudeAiOauth.refreshToken = oauth.refreshToken;
    keychain.claudeAiOauth.expiresAt = oauth.expiresAt;
  }

  try {
    writeJsonAtomic(accountFile, parsed);
  } catch {
    // Persisting fresh tokens is best-effort — the in-memory token is
    // still usable for the current refresh call.
  }
}

/**
 * Refresh the cached usage snapshot for any saved account (active or
 * not). Loads that account's OAuth tokens from its snapshot file,
 * refreshes them via the Anthropic OAuth endpoint if expired, then
 * calls fetchUsage and writes the per-account cache.
 *
 * Throws when the account isn't saved or has no usable refresh token.
 * Network failures fall through and surface via the returned cache's
 * shape (no payload, no rateLimitedUntil — the caller can decide).
 */
export async function refreshUsageForAccount(
  email: string,
  accountsDirPath: string,
  deps?: {
    credentials?: CredentialStore;
    claudeJsonPath?: string;
    http?: HttpPort;
  },
): Promise<UsageCache> {
  const tokens = readAccountOauth(email, accountsDirPath);
  if (!tokens) {
    throw new Error(
      `No usable OAuth tokens for ${email}. The account snapshot is missing or pre-dates the per-account refresh path.`,
    );
  }
  const { refreshIfStale } = await import('../credentials/oauth-refresh.js');
  const refreshed = await refreshIfStale(
    {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresAt: tokens.expiresAt ?? 0,
    },
    { http: deps?.http },
  );
  if (!refreshed) {
    throw new Error(
      `Could not refresh OAuth token for ${email}. Sign in again: claude switch ${email} then claude (browser flow).`,
    );
  }
  // If refreshIfStale actually rotated the access token, persist it.
  if (refreshed.accessToken !== tokens.accessToken) {
    persistRefreshedOauth(email, accountsDirPath, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: typeof refreshed.expiresAt === 'number'
        ? refreshed.expiresAt
        : Number(refreshed.expiresAt),
    });
    // Phase-24 regression fix: when `email` is the active account, the
    // rotation we just did at Anthropic also invalidated the refresh_token
    // sitting in the file vault that Claude Code reads. Mirror the refreshed
    // block there too so the binary's next internal refresh sees the new
    // token instead of the rotated-away one (which would 401 → /login).
    mirrorActiveOauthVaultIfApplicable(email, refreshed, deps);
  }
  return fetchUsageCached(accountsDirPath, refreshed.accessToken, {
    force: true,
    account: email,
  });
}

/**
 * Pull the OAuth access token. On macOS this comes from the login Keychain;
 * on Linux/Windows it lives in `~/.claude.json` under `oauthAccount.accessToken`
 * (Claude Code does not use a system credential store there).
 */
export function getAccessTokenFromKeychain(claudeJsonPathStr?: string): string | null {
  const data = readKeychain();
  const token = data?.claudeAiOauth?.accessToken;
  if (typeof token === 'string' && token) return token;

  if (process.platform !== 'darwin' && claudeJsonPathStr) {
    try {
      const raw = JSON.parse(fs.readFileSync(claudeJsonPathStr, 'utf-8')) as Record<string, unknown>; // safe: JSON.parse returns unknown; shape validated by accessor below
      const oauth = raw?.oauthAccount as Record<string, unknown> | undefined; // safe: nested unknown field, type narrowed before use
      const t = oauth?.accessToken;
      return typeof t === 'string' && t ? t : null;
    } catch { return null; } // missing/corrupt claude.json → no token available
  }
  return null;
}
