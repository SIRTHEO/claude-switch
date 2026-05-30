// src/accounts-snapshot-integrity.ts
// Cross-snapshot corruption probes used by load() to decide whether a saved
// `_keychain` block can be trusted for restore. Extracted from accounts-load.ts
// so the load() hot path stays focused on the restore sequence while this owns
// the "is another account's token hiding in here" scan.

import type { AccountRepository } from './account-repository.js';

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
export function findSnapshotsSharingAccessToken(
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
