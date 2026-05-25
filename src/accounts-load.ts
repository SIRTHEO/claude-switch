// src/accounts-load.ts
// load(): restore a saved account snapshot into ~/.claude.json + the Keychain.
// Carries the snapshot-token-collision / provenance defences (23.5/23.6), the
// silent-billing api-key purge, and the JSON-first / Keychain-rollback order.

import fs from 'node:fs';
import type { KeychainData } from './keychain.js';
import { writeJsonAtomic } from './atomic-write.js';
import { type AccountRepository, fsAccountRepo } from './account-repository.js';
import { type CredentialStore, defaultCredentialStore } from './credential-store.js';

/**
 * Scan every other snapshot in `accountsDirPath` for one whose
 * `_keychain.claudeAiOauth.accessToken` matches `accessToken`. Returns the
 * list of colliding emails (empty when healthy). OAuth access tokens are
 * server-issued and account-bound, so a non-empty result is always a sign
 * of snapshot corruption — see the 2026-05-22 report.
 *
 * Reads via `repo.list` + `repo.read` to keep the dependency surface narrow
 * (no fs touch beyond the repository) and to bypass `list()`'s
 * legacy-email stderr warning. Read failures on a single sibling are
 * tolerated: we treat the file as "no recognisable token" rather than
 * abort the whole collision check.
 */
function findSnapshotsSharingAccessToken(
  email: string,
  accountsDirPath: string,
  accessToken: string,
  repo: AccountRepository,
): string[] {
  let files: string[];
  try {
    files = repo.list(accountsDirPath);
  } catch { // accounts dir absent/unreadable → no other accounts
    return [];
  }
  const out: string[] = [];
  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('.') || file === 'aliases.json') continue;
    const otherEmail = file.replace(/\.json$/, '');
    if (otherEmail === email) continue;
    let other: unknown;
    try {
      other = repo.read(otherEmail, accountsDirPath);
    } catch { // unreadable/corrupt sibling account → skip it
      continue;
    }
    const otherToken = (
      other as { _keychain?: { claudeAiOauth?: { accessToken?: unknown } } } | null
    )?._keychain?.claudeAiOauth?.accessToken;
    if (typeof otherToken === 'string' && otherToken === accessToken) {
      out.push(otherEmail);
    }
  }
  return out;
}

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
  const keychainRestored = !!(_keychain && typeof _keychain === 'object')
    && collisionEmails.length === 0
    && !provenancePoisoned;

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
