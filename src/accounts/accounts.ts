import fs from 'node:fs';
import { withLock } from '../platform/lock.js';
import { errnoCode } from '../platform/errors.js';
import { isSafeEmail, resolvedAccountFile } from './account-paths.js';
import { type AccountRepository, fsAccountRepo } from './account-repository.js';
import { save } from './accounts-save.js';

// Re-exported so existing importers (apikey.ts, profiles.ts, usage.ts,
// preferences.ts, commands/*) keep importing them from accounts.js unchanged.
// save() lives in accounts-save.ts and load() in accounts-load.ts; both are
// re-exported here so the public surface of accounts.js is unchanged.
export { isSafeEmail, resolvedAccountFile } from './account-paths.js';
export { save } from './accounts-save.js';
export { load } from './accounts-load.js';

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
