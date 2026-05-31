// src/profiles/profiles-credentials.ts
// macOS Keychain credential helpers for profiles, split out of profiles.ts to
// keep that file within the size budget. `profileKeychainTrustedBins` resolves
// the real claude binary for the `security -T` ACL; `captureLiveCredentials...`
// copies the live default-Keychain blob into a profile's per-config-dir entry
// when the profile's account is the currently-active one. Both are consumed by
// the import / ensure flows that remain in profiles.ts.

import {
  readActiveCredentials,
  readProfileCredentials,
  writeProfileCredentials,
} from '../credentials/keychain.js';
import type { ClaudeAiOauth } from '../credentials/credential-store.js';
import { getCurrent } from '../accounts/accounts.js';
import { claudeJsonPath } from '../platform/paths.js';
import { errMessage, debugProfiles } from '../platform/errors.js';
import { findClaudeBinary } from '../setup/find-claude.js';

/**
 * The `oauthAccount` block when tokens must be embedded inline (non-darwin, OR
 * the credential vault disabled via CLAUDE_SWITCH_DISABLE_KEYCHAIN): there is no
 * `<configDir>/.credentials.json` for claude to read, so the access/refresh
 * tokens go directly into the identity block where the binary reads them inline.
 *
 * On the default (file-vault) path the tokens live in the vault file and this
 * block stays metadata-only — callers omit this call there. Shared by the
 * profile import flow (`importProfileFromAccount`) and the live-migration writer
 * (`migrateSession`) so the embed shape has a single definition.
 */
export function embedTokensInIdentity(
  identity: Record<string, unknown>,
  oauth: ClaudeAiOauth,
): Record<string, unknown> {
  return {
    ...identity,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
  };
}

/**
 * Trusted-bins list passed to `security -T` when writing a profile
 * Keychain entry. Resolves the real `claude` binary (native Mach-O) so
 * Claude Code can read its own Keychain entry without an interactive
 * prompt. Without this, the entry's ACL stays bound to the creating
 * process (claude-switch) and claude silently falls back to OAuth login.
 */
export function profileKeychainTrustedBins(): string[] {
  const bin = findClaudeBinary(import.meta.url);
  return bin ? [bin] : [];
}

// ───────────────────────────────────────────────────────────────────────────
// Live-credential capture for the currently-active account
//
// Backstory: claude binary refreshes its OAuth tokens in-process and
// writes the rotated blob to the default macOS Keychain entry
// (`Claude Code-credentials` keyed by username). The legacy snapshot
// at `~/.claude/accounts/<email>.json._keychain` is only updated when
// `claude switch save` runs explicitly OR when `syncActiveSnapshotIfStale`
// observes that `~/.claude.json` has been touched after the snapshot
// (the latter is fragile because token rotation doesn't always rewrite
// claude.json). Result: for an account that's currently active, the
// default Keychain is the source of truth and the legacy snapshot is
// a delayed copy that drifts over hours of use.
//
// When the user opens isolated on the active email, copy the live
// blob from the default Keychain directly into the profile's per-
// config-dir Keychain entry. Bypasses the legacy snapshot entirely
// for this case. Non-active emails still go through the snapshot —
// it's the only source of truth there.
//
// No-op on non-darwin (tokens live in JSON on those platforms — the
// legacy snapshot's `_keychain` block is already the live source) and
// when `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` is set (tests + opt-out).
// ───────────────────────────────────────────────────────────────────────────

export function captureLiveCredentialsForActiveAccount(
  email: string,
  profileDir: string,
): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') return false;

  let activeEmail = '';
  try {
    activeEmail = getCurrent(claudeJsonPath());
  } catch {
    // claude.json unreadable — silent return; ensureProfileForAccount
    // falls through to the legacy-snapshot path, which has its own
    // error surface. No reason to bubble here.
    return false;
  }
  const emailMatchActive = Boolean(activeEmail) && activeEmail === email;
  debugProfiles(`captureLive emailMatchActive=${emailMatchActive} profileDir=${profileDir}`);
  if (!emailMatchActive) return false;

  const live = readActiveCredentials();
  if (!live?.claudeAiOauth?.accessToken) return false;

  // Skip the write if the profile's entry already matches the live blob —
  // avoids a fork+exec to `security` on every isolated open. Comparing by
  // accessToken is sufficient: rotation always changes it.
  const existing = readProfileCredentials(profileDir);
  if (existing?.claudeAiOauth?.accessToken === live.claudeAiOauth.accessToken) {
    debugProfiles(`keychainWrite=skipped service=per-config-dir account=${profileDir} (already in sync)`);
    return true;
  }

  try {
    writeProfileCredentials(profileDir, live, profileKeychainTrustedBins());
    debugProfiles(`keychainWrite=success service=per-config-dir account=${profileDir} (live capture)`);
    return true;
  } catch (writeErr) {
    // Keychain write can fail if the user dismissed the auth dialog
    // (first-time use under a fresh `node` invocation). Fall back to
    // the legacy path — better than crashing the isolated open.
    debugProfiles(`keychainWrite=failed service=per-config-dir account=${profileDir} err=${errMessage(writeErr)}`);
    return false;
  }
}
