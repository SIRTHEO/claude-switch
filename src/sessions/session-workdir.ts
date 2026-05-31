// src/sessions/session-workdir.ts
// Per-session work-dir seeder (the per-session-dir model).
//
// A running claude session must NOT run in its account's canonical profile dir:
// that dir doubles as the account's credential store, so a live migration that
// rewrites it would corrupt the account (and reintroduce token mixing). Instead
// each session runs in a DISPOSABLE per-session copy under
// `<~/.claude>/session-dirs/<profile>.<pid>` (outside the profiles tree). This
// seeds that copy and returns its path; the launch sites set CLAUDE_CONFIG_DIR
// to it (a later step), and migration rewrites the copy, never the canonical.
//
// What is per-session vs shared:
//   COPY (private to the session)  — `.claude.json` (identity + userID + onboarding/
//     trust), the OAuth credential (via the credential port, backend-aware), and
//     `settings.json`. Files are COPIED not symlinked: claude rewrites them via
//     atomic temp+rename, which would replace a symlink with a regular file and
//     silently break the share + lose the write on cleanup.
//   SYMLINK (shared user data) — the dir containers (`projects`, `sessions`, …)
//     link to the canonical, which for an `as-global` overlay links them on up to
//     the global home. So history/sessions are shared exactly as the profile type
//     dictates; the seeder is type-agnostic (Level B), the overlay topology is
//     Level A (`ensureProfileContainer`).

import fs from 'node:fs';
import path from 'node:path';
import { type CredentialStore, defaultCredentialStore } from '../credentials/credential-store.js';
import { ensureDirSymlink } from '../profiles/link-dir.js';
import { ensureProfileContainer } from '../profiles/overlay.js';
import { profileKeychainTrustedBins } from '../profiles/profiles-credentials.js';

/** Dir containers holding user data — symlinked to the canonical (DIRs only;
 *  single-file accumulators like `history.jsonl` are handled by reconcile, not a
 *  fragile file-symlink). */
const LINKED_CONTAINERS = ['projects', 'sessions', 'skills', 'shell-snapshots', 'file-history', 'todos'];
/** Per-session private files — copied, never symlinked (see header).
 *  `.credentials.json` is NOT here: it goes through the credential port below. */
const COPIED_FILES = ['.claude.json', 'settings.json'];

/** Internal — callers pass `deps` as an object literal (structurally checked),
 *  so this name needn't be exported. */
interface PrepareWorkDirDeps {
  credentials?: CredentialStore;
}

/** True when `<file>`'s `oauthAccount` carries an inline access token (the
 *  DISABLE_KEYCHAIN / non-darwin embed path). Used by the no-creds guard. */
function hasEmbeddedToken(claudeJsonPath: string): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>;
    const oauth = cfg.oauthAccount as Record<string, unknown> | undefined;
    return Boolean(oauth && typeof oauth.accessToken === 'string' && oauth.accessToken);
  } catch {
    return false; // unreadable / absent → no embedded token
  }
}

/**
 * Seed a per-session work dir from `canonicalDir` and return its path. Throws if
 * the result would have no usable credentials (a broken, login-prompting
 * session) rather than returning a half-seeded dir.
 *
 * `accountsDirPath` roots the global config dir (`dirname` of it). The returned
 * string is the canonical, resolved work-dir path — pass it VERBATIM as the
 * spawn's CLAUDE_CONFIG_DIR (the opt-in Keychain service is SHA256(NFC(dir)), so
 * the spawn path must be byte-identical to this string).
 */
export function prepareSessionWorkDir(
  canonicalDir: string,
  accountsDirPath: string,
  deps: PrepareWorkDirDeps = {},
): string {
  const credentials = deps.credentials ?? defaultCredentialStore;
  const globalConfigDir = path.dirname(accountsDirPath); // ~/.claude
  const name = path.basename(path.resolve(canonicalDir));
  const workDir = path.resolve(globalConfigDir, 'session-dirs', `${name}.${process.pid}`);

  // Recycle a stale dir from a reused pid. fs.rmSync does NOT follow symlinks —
  // it removes the link ENTRIES, never traversing into the canonical/global
  // targets, so this can never delete shared user data.
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });

  // Copy the per-session private files (identity + config).
  for (const f of COPIED_FILES) {
    const src = path.join(canonicalDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(workDir, f));
  }

  // Credentials via the port (backend-aware): the file vault copies the file
  // through the port; DISABLE_KEYCHAIN no-ops (the token rides in the copied
  // `.claude.json`); opt-in Keychain copies Keychain→Keychain at the work dir's
  // own per-config-dir service, with the real-claude ACL so it can read it.
  const creds = credentials.readOAuthForConfigDir(canonicalDir);
  if (creds) credentials.writeOAuthForConfigDir(workDir, creds, profileKeychainTrustedBins());

  // No-creds guard: neither a vault credential nor an embedded token means the
  // session would fall through to a login prompt. Fail the seed loudly.
  if (!creds && !hasEmbeddedToken(path.join(workDir, '.claude.json'))) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw new Error(
      `Cannot seed a session work dir from ${canonicalDir}: no resolvable credentials ` +
        `(empty vault and no embedded token). Log the profile in first.`,
    );
  }

  // Link the data containers to the canonical. ensureProfileContainer fixes the
  // canonical's topology first (overlay → symlink to the global; classic → real
  // dir) so the seeder and the overlay builder never disagree on a container's
  // shape; then we link the work dir's entry to the canonical's.
  for (const sub of LINKED_CONTAINERS) {
    ensureProfileContainer(canonicalDir, sub, globalConfigDir);
    ensureDirSymlink(path.join(workDir, sub), path.resolve(canonicalDir, sub));
  }

  return workDir;
}
