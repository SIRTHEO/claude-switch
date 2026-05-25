import fs from 'node:fs';
import type { KeychainData } from './keychain.js';
import { writeJsonAtomic } from './atomic-write.js';
import { withLock } from './lock.js';
import { errnoCode } from './errors.js';
import { isSafeEmail, resolvedAccountFile } from './account-paths.js';
import { type AccountRepository, fsAccountRepo } from './account-repository.js';
import { type CredentialStore, defaultCredentialStore } from './credential-store.js';
import type { AccountSnapshot } from './account-snapshot.js';

// Re-exported so existing importers (apikey.ts, profiles.ts, usage.ts,
// preferences.ts, commands/*) keep importing them from accounts.js unchanged.
export { isSafeEmail, resolvedAccountFile } from './account-paths.js';

export function getCurrent(claudeJsonPath: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    return data?.oauthAccount?.emailAddress || '';
  } catch (e) {
    // Distinguish "file missing / unparseable" (legitimate empty state) from
    // "permission denied" (operator misconfiguration). The latter would be
    // misleading if reported as "no account connected".
    if (errnoCode(e) === 'EACCES') {
      throw new Error(`Permission denied reading ${claudeJsonPath}. Check file permissions.`);
    }
    return '';
  }
}

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

export function list(accountsDirPath: string, deps?: { repo?: AccountRepository }): string[] {
  // repo.list already returns [] on any readdir failure (ENOENT first run,
  // permission, I/O) — surface "no accounts saved" rather than crash a status
  // read. The dispatcher's first-run path then guides the user into
  // `claude switch add` instead of dumping a stack trace.
  const files = (deps?.repo ?? fsAccountRepo).list(accountsDirPath);
  const candidates = files
    .filter(f => f.endsWith('.json') && !f.startsWith('.') && f !== 'aliases.json')
    .map(f => f.replace(/\.json$/, ''));
  const safe = candidates.filter(isSafeEmail);
  // Surface (don't silence) accounts that an older claude-switch saved
  // with characters now rejected by the tighter SAFE_EMAIL_CHARS allowlist
  // (RFC 5321 permits !, #, $, %, etc. in the local-part — we don't, to
  // keep them safe in shell completions). Without this warning the file
  // would still exist on disk but vanish from `list`, `status`, the
  // picker, etc., looking like data loss.
  if (safe.length !== candidates.length && process.env.CLAUDE_SWITCH_QUIET !== '1') {
    const dropped = candidates.filter(c => !safe.includes(c));
    process.stderr.write(
      `claude-switch: ${dropped.length} saved account(s) were skipped because their\n` +
      `  email contains characters not allowed in the current naming scheme:\n` +
      `    ${dropped.join(', ')}\n` +
      `  The files in ~/.claude/accounts/ are intact. Re-add the account with\n` +
      `  a simpler email or rename the file to recover it.\n\n`,
    );
  }
  return safe;
}

export function remove(email: string, accountsDirPath: string, deps?: { repo?: AccountRepository }): void {
  (deps?.repo ?? fsAccountRepo).remove(email, accountsDirPath);
}

/**
 * Remove an account, refusing to drop the currently-active one. The
 * "active?" check and the unlink share a single `withLock` so a switch
 * happening concurrently can't sneak through between the two reads.
 *
 * Throws if the target is the active account; this is a hard error,
 * not a silent no-op — callers want to surface "switch first" to the
 * user. ENOENT bubbles up unchanged from `remove()`.
 */
export function removeSafely(
  email: string,
  claudeJsonPath: string,
  accountsDirPath: string,
  deps?: { repo?: AccountRepository },
): void {
  withLock(accountsDirPath, () => {
    const currentNow = getCurrent(claudeJsonPath);
    if (currentNow === email) {
      throw new Error('Cannot remove the active account. Switch to another one first.');
    }
    remove(email, accountsDirPath, deps);
  });
}

/**
 * Re-save the active account's snapshot when `~/.claude.json` has been
 * mutated externally (typically by a `/login` issued from inside a
 * running claude session). Without this, the snapshot keeps the
 * tokens captured at the last `claude switch` and silently drifts —
 * a later `profile import <email>` would replay stale tokens, claude
 * would 401, user would re-login again, vicious loop.
 *
 * Idempotent: when the snapshot's mtime is at-or-after claude.json's,
 * this is a no-op. The save only runs when claude.json is the newer
 * source. Failures are silent — drift is a UX issue, not a hard error.
 */
export function syncActiveSnapshotIfStale(
  claudeJsonPath: string,
  accountsDirPath: string,
): boolean {
  // syncActiveSnapshotIfStale is a UX nicety, not a correctness path.
  // Every failure mode below silently no-ops because the worst-case
  // outcome (drift on legacy file) is recoverable on the next switch,
  // whereas a hard error here would crash flows that the user did
  // not explicitly opt into snapshot syncing.
  let activeEmail: string;
  try {
    activeEmail = getCurrent(claudeJsonPath);
  } catch {
    // Unreadable / corrupt claude.json — surfaced loudly by the next
    // explicit operation (status, switch, save). Sync is best-effort.
    return false;
  }
  if (!activeEmail) return false;

  let snapshotFile: string;
  try {
    snapshotFile = resolvedAccountFile(activeEmail, accountsDirPath);
  } catch {
    // Email contains characters that fail isSafeEmail (legacy account
    // saved by older permissive validation). Surface the proper error
    // when the user invokes a flow that REALLY needs the snapshot.
    return false;
  }

  const claudeJsonStat = fs.statSync(claudeJsonPath, { throwIfNoEntry: false });
  if (!claudeJsonStat) return false;
  const snapshotStat = fs.statSync(snapshotFile, { throwIfNoEntry: false });
  // No snapshot yet → nothing to drift from. The next save() call from
  // switch/save lifecycle will create it; we don't want to silently
  // create a snapshot for an account that was never explicitly added.
  if (!snapshotStat) return false;

  // Allow a 1-second skew — file systems and test fixtures sometimes
  // write the same mtime for two near-simultaneous writes, and we'd
  // rather no-op than re-save unnecessarily on every invocation.
  if (claudeJsonStat.mtimeMs <= snapshotStat.mtimeMs + 1000) return false;

  try {
    save(activeEmail, claudeJsonPath, accountsDirPath);
    return true;
  } catch {
    // save() can throw on JSON parse / Keychain write / disk-full /
    // permission. Silent here because the next explicit save (during
    // a real switch) will surface the same error in a context where
    // the user is paying attention. If we threw here we'd make a
    // best-effort sync into a hard failure of unrelated commands.
    return false;
  }
}

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
