// src/accounts-save.ts
// save(): snapshot the active account (oauthAccount + Keychain creds + api-key
// acceptance state + per-account prefs) into the accounts dir. Includes the
// snapshot-token-collision guard (23.5) and provenance stamping (23.6).

import fs from 'node:fs';
import { isSafeEmail } from './account-paths.js';
import { type AccountRepository, fsAccountRepo } from './account-repository.js';
import type { AccountSnapshot } from './account-snapshot.js';
import { type CredentialStore, defaultCredentialStore } from './credential-store.js';

export function save(
  email: string,
  claudeJsonPath: string,
  accountsDirPath: string,
  deps?: { repo?: AccountRepository; credentials?: CredentialStore },
): void {
  if (!email || !isSafeEmail(email)) {
    throw new Error(`Email contains characters unsafe for filenames: ${email}`);
  }

  const repo = deps?.repo ?? fsAccountRepo;
  const credentials = deps?.credentials ?? defaultCredentialStore;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${claudeJsonPath} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }

  // CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 forces the JSON-only path (used by the
  // test suite + the marketing GIF renderer to keep `npm test` /
  // `npm run gif` non-interactive). In that mode we preserve any
  // pre-existing `_keychain` from the previous snapshot of THIS email so
  // a save() round-trip doesn't accidentally erase it; the keychainRestored
  // contract on subsequent loads stays correct.
  const keychainDisabled = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1';

  // Defensive guard against the snapshot-token-collision class (23.5).
  // save() reads the LIVE Keychain via credentials.readOAuth() and writes the
  // result into the named snapshot. If the named snapshot is NOT the currently
  // active account (per ~/.claude.json.oauthAccount.emailAddress) the result
  // is a snapshot for account X that carries account Y's OAuth tokens.
  // The next `load(X)` then replays Y's tokens into the Keychain, the server
  // rejects them (token UUID ≠ requested account UUID), and Claude Code falls
  // through to a fresh browser OAuth login — exactly the regression reported
  // 2026-05-22 (see .claude/docs/reports/2026-05-22-snapshot-token-collision.md).
  //
  // The current call sites (switcher, syncActiveSnapshotIfStale, passthrough,
  // addAccount, reAuthenticate, status) all save the email returned by
  // getCurrent() or freshly-set as the active account — so this guard is a
  // non-event for them. It exists to catch a future regression: any new caller
  // that hands save() an email that isn't the active oauthAccount fails loudly
  // here instead of silently corrupting the snapshot.
  //
  // Skip when:
  //  - oauthAccount is absent / has no emailAddress (first save, or
  //    newer-Claude-Code-doesn't-write-oauthAccount — separate bug);
  //  - CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 (no live Keychain read, no possible
  //    collision; test fixtures intentionally save under email ≠ oauthAccount).
  if (!keychainDisabled) {
    const oauthAccountRecord = data.oauthAccount as { emailAddress?: unknown } | undefined;
    const activeEmail = typeof oauthAccountRecord?.emailAddress === 'string'
      ? oauthAccountRecord.emailAddress
      : '';
    if (activeEmail && activeEmail !== email) {
      throw new Error(
        `Refusing to save snapshot for ${email}: the active account in ` +
        `${claudeJsonPath} is ${activeEmail}. Saving now would capture ` +
        `${activeEmail}'s Keychain tokens into ${email}'s snapshot ` +
        `(snapshot-token-collision; see docs/reports/2026-05-22-snapshot-token-collision.md).`,
      );
    }
  }

  // Include Keychain credentials so they can be restored when switching back.
  const keychainData = keychainDisabled ? null : credentials.readOAuth();
  const accountPayload: AccountSnapshot = { ...(data.oauthAccount || {}) };
  if (keychainData) {
    accountPayload._keychain = keychainData;
    // Record provenance (23.6): the Keychain payload was captured WHILE
    // claude.json said the active account was `data.oauthAccount`. Stamping
    // it lets load() detect snapshots whose _keychain belongs to a different
    // accountUuid than the snapshot itself claims — the late-stage signature
    // of the collision class that the save() guard above closes for new
    // writes. Snapshots written before this stamp simply lack the field;
    // load() treats absent _capturedFrom as "legacy, trust the file".
    const provenanceSource = data.oauthAccount as {
      emailAddress?: unknown;
      accountUuid?: unknown;
    } | undefined;
    accountPayload._capturedFrom = {
      emailAddress: typeof provenanceSource?.emailAddress === 'string'
        ? provenanceSource.emailAddress
        : undefined,
      accountUuid: typeof provenanceSource?.accountUuid === 'string'
        ? provenanceSource.accountUuid
        : undefined,
      capturedAt: Date.now(),
    };
  } else if (keychainDisabled) {
    // Preserve an existing snapshot's _keychain block when running under
    // the disable flag — better than overwriting it with "absent". Carry
    // _capturedFrom along too: it documents the provenance of the _keychain
    // we just preserved, not of this synthetic re-save.
    try {
      const existing = repo.read(email, accountsDirPath);
      if (existing && typeof existing === 'object' && existing._keychain) {
        accountPayload._keychain = existing._keychain;
        if (existing._capturedFrom && typeof existing._capturedFrom === 'object') {
          accountPayload._capturedFrom = existing._capturedFrom as AccountSnapshot['_capturedFrom'];
        }
      }
    } catch { /* unreadable / unparseable — leave _keychain absent */ }
  }

  // Snapshot the API-key acceptance state so it does NOT leak across
  // accounts. Claude Code writes `customApiKeyResponses.approved` (and
  // sometimes `apiKey`) directly into ~/.claude.json the first time the
  // user answers "Use this API key? [Y/n]". Without this snapshot, the
  // approval array stays in the file across a `claude switch`, so the
  // newly-active account inherits the previous account's approved key
  // and silently uses it instead of OAuth — observed in the wild
  // when an account that had previously approved an API key was
  // switched away from, and the next account ended up with the
  // previous one's `customApiKeyResponses.approved` entry still live
  // in `~/.claude.json`.
  if (data.customApiKeyResponses) {
    accountPayload._customApiKeyResponses = data.customApiKeyResponses;
  }
  if (typeof data.apiKey === 'string' && data.apiKey) {
    accountPayload._claudeJsonApiKey = data.apiKey;
  }

  // Preserve any per-account API key (used for fallback when subscription
  // limits are hit) AND per-account preferences across re-saves, since
  // save() rewrites the whole file. repo.read returns null for a first save
  // (ENOENT) and rethrows parse / non-ENOENT errors, matching the previous
  // behaviour.
  const existing = repo.read(email, accountsDirPath);
  if (existing) {
    if (typeof existing._apiKey === 'string' && existing._apiKey) {
      accountPayload._apiKey = existing._apiKey;
    }
    if (existing._prefs && typeof existing._prefs === 'object') {
      accountPayload._prefs = existing._prefs;
    }
  }

  repo.write(email, accountsDirPath, accountPayload);
}
