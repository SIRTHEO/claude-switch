// src/accounts-load.ts
// load(): restore a saved account snapshot into ~/.claude.json + the Keychain.
// Carries the snapshot-token-collision / provenance defences (23.5/23.6), the
// silent-billing api-key purge, and the JSON-first / Keychain-rollback order.

import fs from 'node:fs';
import type { KeychainData } from '../credentials/keychain.js';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import { type AccountRepository, fsAccountRepo } from './account-repository.js';
import { type CredentialStore, defaultCredentialStore } from '../credentials/credential-store.js';
import { findSnapshotsSharingAccessToken } from './accounts-snapshot-integrity.js';

export function load(
  email: string,
  claudeJsonPath: string,
  accountsDirPath: string,
  deps?: { repo?: AccountRepository; credentials?: CredentialStore },
): { keychainRestored: boolean } {
  const repo = deps?.repo ?? fsAccountRepo;
  const credentials = deps?.credentials ?? defaultCredentialStore;

  // loadRaw rejects symlinked account files and a missing file with explicit
  // errors, and surfaces invalid JSON — the same security-critical sequence
  // accounts.ts performed inline before the repository extraction.
  const accountData = repo.loadRaw(email, accountsDirPath);


  // Strip internal fields so they never leak into ~/.claude.json.
  const {
    _keychain,
    _apiKey: _apiKeyLegacy,
    _prefs: _ignoredPrefs,
    _customApiKeyResponses,
    _claudeJsonApiKey,
    _capturedFrom,
    ...oauthAccount
  } = accountData;

  // Provenance check (23.6). When save() captured _keychain it stamped the
  // UUID of the account that the tokens actually belong to (read from
  // claude.json.oauthAccount.accountUuid at capture time). If that stamp
  // disagrees with the snapshot's own accountUuid, the snapshot is poisoned:
  // a pre-23.5 save() wrote account X's tokens into account Y's snapshot.
  // Skip the Keychain restore — the symptom otherwise is a fresh browser
  // OAuth login when the user expected a seamless swap.
  //
  // Snapshots written before 23.6 have no _capturedFrom; they fall back to
  // the older collision detector below (siblings-share-same-accessToken).
  const snapshotUuid = (oauthAccount as { accountUuid?: unknown }).accountUuid;
  const capturedFromRecord = _capturedFrom as { accountUuid?: unknown } | undefined;
  const provenancePoisoned = typeof snapshotUuid === 'string'
    && typeof capturedFromRecord?.accountUuid === 'string'
    && snapshotUuid !== capturedFromRecord.accountUuid;
  if (provenancePoisoned) {
    process.stderr.write(
      `claude-switch: snapshot for ${email} carries a _keychain captured under ` +
      `accountUuid ${capturedFromRecord!.accountUuid as string} but the ` +
      `snapshot itself is for accountUuid ${snapshotUuid as string} — corrupted ` +
      `(see docs/reports/2026-05-22-snapshot-token-collision.md). Skipping ` +
      `Keychain restore; you will be asked to log in once and the corruption ` +
      `will clear on the next save.\n`,
    );
  }

  // Snapshot-token-collision detection (23.5). When a previous version of
  // claude-switch corrupted a snapshot by capturing the wrong account's live
  // Keychain (see save()'s guard above + the 2026-05-22 report), two
  // snapshots end up sharing the same OAuth accessToken. Restoring that
  // shared token into the Keychain replays account A's session under
  // account B's identity — the server rejects, and Claude Code falls
  // through to a fresh browser OAuth login.
  //
  // OAuth access tokens are server-issued and account-bound, so two
  // snapshots sharing one is impossible in healthy state. Treat it as
  // poisoned: skip the Keychain restore (degrades to the "no saved
  // credentials" warning that the switcher already emits when
  // keychainRestored=false). The user then logs in once, save() captures
  // the fresh tokens under the correct email, and the corruption is
  // cleared on the next swap.
  const sharedAccessToken = (
    _keychain as { claudeAiOauth?: { accessToken?: unknown } } | null | undefined
  )?.claudeAiOauth?.accessToken;
  const collisionEmails = typeof sharedAccessToken === 'string' && sharedAccessToken
    ? findSnapshotsSharingAccessToken(email, accountsDirPath, sharedAccessToken, repo)
    : [];
  if (collisionEmails.length > 0) {
    process.stderr.write(
      `claude-switch: snapshot for ${email} shares its OAuth access token with ` +
      `${collisionEmails.join(', ')} — impossible in healthy state, indicates a ` +
      `corrupted snapshot (see docs/reports/2026-05-22-snapshot-token-collision.md). ` +
      `Skipping Keychain restore; you will be asked to log in once and the ` +
      `corruption will clear on the next swap.\n`,
    );
  }
  // Tier guard — load-side defence in depth. Anthropic stamps the plan tier
  // into both the snapshot's account identity (organizationRateLimitTier) and
  // its saved token (rateLimitTier). If they disagree the snapshot holds a
  // different account's token (the snapshot-token-tier-mismatch class), and
  // restoring it would put a wrong-account token live under this email —
  // silently billing the other account. Skip the restore so the user logs in
  // once and save() re-captures the correct token. Both tiers must be present
  // and differ; a legacy snapshot missing either falls through (never blocks a
  // real swap). Tier separates plans, not same-tier accounts.
  const snapshotTier = (oauthAccount as { organizationRateLimitTier?: unknown }).organizationRateLimitTier;
  const tokenTier = (
    _keychain as { claudeAiOauth?: { rateLimitTier?: unknown } } | null | undefined
  )?.claudeAiOauth?.rateLimitTier;
  const tierPoisoned = typeof snapshotTier === 'string'
    && typeof tokenTier === 'string'
    && snapshotTier !== ''
    && tokenTier !== ''
    && snapshotTier !== tokenTier;
  if (tierPoisoned) {
    process.stderr.write(
      `claude-switch: snapshot for ${email} holds a '${tokenTier as string}' token but ` +
      `the account is '${snapshotTier as string}' — the token belongs to a different ` +
      `account. Skipping Keychain restore; you will be asked to log in once and the ` +
      `corruption will clear on the next save.\n`,
    );
  }
  const keychainRestored = !!(_keychain && typeof _keychain === 'object')
    && collisionEmails.length === 0
    && !provenancePoisoned
    && !tierPoisoned;

  // Silent-billing leak prevention.
  //
  // Two snapshot fields can resuscitate an API-key authorization that
  // claude-switch doesn't track:
  //   - `_claudeJsonApiKey` — the actual key, written by claude binary
  //     into ~/.claude.json.apiKey when the user accepts "Use this API
  //     key? [Y/n]" and captured by save() on the next snapshot
  //   - `_customApiKeyResponses` — the hash of an approved key; claude
  //     binary uses it to skip the prompt if a matching key shows up
  //     via env or another path
  //
  // Both were originally snapshotted to prevent CROSS-account leak
  // (account A's approval surviving a switch to B). But once captured,
  // they survive forever — including the case where the user never
  // intentionally configured an API key via claude-switch and just
  // happened to once have ANTHROPIC_API_KEY exported. Subsequent
  // switches to that account silently re-inject the key into
  // claude.json and claude binary uses it, billing the API tier
  // instead of the subscription. claude-switch CLI has no visibility
  // because getApiKey() reads from a different storage.
  //
  // Defense: if claude-switch ITSELF doesn't track an apikey for this
  // account (no `_apiKey` in snapshot AND no entry in
  // claude-switch-apikey Keychain), discard both fields on restore.
  // The next time the user wants the key, they get the standard
  // "Use this API key? [Y/n]" prompt — same UX as a fresh setup,
  // explicit consent restored.
  //
  // Env escape: CLAUDE_SWITCH_KEEP_UNTRACKED_APIKEY=1 preserves the
  // pre-14.2 behavior for one release cycle in case a user discovers
  // they relied on the silent persistence.
  const claudeSwitchTracksApiKey = (() => {
    if (typeof _apiKeyLegacy === 'string' && _apiKeyLegacy) return true;
    if (credentials.available() && process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN !== '1') {
      return credentials.readApiKey(email) !== null;
    }
    return false;
  })();
  const purgeUntracked = !claudeSwitchTracksApiKey
    && process.env.CLAUDE_SWITCH_KEEP_UNTRACKED_APIKEY !== '1';

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${claudeJsonPath} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }
  // Snapshot the WHOLE pre-load claude.json so we can roll it back if the
  // Keychain write fails afterwards (keeps the two sources of truth in sync).
  // Capturing the full object — not just oauthAccount — is load-bearing:
  // load() also rewrites `apiKey` / `customApiKeyResponses` below, so an
  // oauthAccount-only restore left the new account's api-key state behind,
  // a silent disalignment between claude.json and the Keychain.
  const originalClaudeJson = structuredClone(data);
  data.oauthAccount = oauthAccount;

  // Restore (or actively CLEAR) the API-key acceptance state. Clearing is
  // the load-bearing part: without it, a previously-approved API key from
  // another account would carry over into ~/.claude.json and Claude Code
  // would silently use it instead of OAuth, billing the wrong account.
  // The user gets re-prompted "Use this API key? [Y/n]" on first use of
  // a key under the new account — that's the correct UX after a switch.
  //
  // In addition to the cross-account leak prevention above, we ALSO
  // refuse to restore snapshot api-key state for accounts where
  // claude-switch doesn't track a key (see `purgeUntracked` derivation
  // above). Prevents the silent-billing class where a one-time
  // ANTHROPIC_API_KEY env approval becomes permanent for the account
  // without the user's continued consent.
  if (_customApiKeyResponses && typeof _customApiKeyResponses === 'object' && !purgeUntracked) {
    data.customApiKeyResponses = _customApiKeyResponses;
  } else {
    delete data.customApiKeyResponses;
  }
  if (typeof _claudeJsonApiKey === 'string' && _claudeJsonApiKey && !purgeUntracked) {
    data.apiKey = _claudeJsonApiKey;
  } else {
    delete data.apiKey;
  }

  // Write JSON first (cheaper, more recoverable). If this fails, the Keychain
  // is untouched and state stays consistent.
  const writeJson = (payload: unknown): void => writeJsonAtomic(claudeJsonPath, payload);
  writeJson(data);

  // Then update Keychain. If this fails, roll the JSON back to its previous
  // oauthAccount so the two sources of truth don't drift.
  // CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 forces the JSON-only path — used by
  // the test suite and the marketing GIF renderer to keep `npm test` /
  // `npm run gif` non-interactive (a Keychain write from `node` would
  // otherwise prompt for authorization and either block forever or fail).
  if (keychainRestored && process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN !== '1') {
    try {
      credentials.writeOAuth(_keychain as KeychainData);
    } catch (e) {
      // Keychain write failed AFTER claude.json was rewritten. Restore the
      // whole pre-load claude.json so the two sources don't drift.
      try {
        writeJson(originalClaudeJson);
      } catch (rollbackErr) {
        // The rollback ITSELF failed: claude.json may now be inconsistent with
        // the Keychain and we cannot repair it. Surface it (never silent) so
        // the user can recover manually. The _keychain payload (tokens) is
        // never logged — only the generic fs/Keychain error messages.
        process.stderr.write(
          `claude-switch: failed to roll back ${claudeJsonPath} after a Keychain ` +
          `write error — credentials may be inconsistent. ` +
          `Keychain error: ${e instanceof Error ? e.message : String(e)}. ` +
          `Rollback error: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}.\n`,
        );
      }
      throw e;
    }
  }

  return { keychainRestored };
}
