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
import { isProcessAlive } from '../platform/lock.js';
import { ensureDirSymlink } from '../profiles/link-dir.js';
import { PROFILE_DATA_CONTAINERS, ensureProfileDataContainers } from '../profiles/overlay.js';
import { profileKeychainTrustedBins } from '../profiles/profiles-credentials.js';

/**
 * Push a token the session rotated in its work dir back to the canonical store,
 * newest-wins by `expiresAt`. claude's in-session refresh lands in the work dir's
 * own credential file; without this the canonical goes stale and a later DIRECT
 * launch of that account 401s until its own refresh. Dead-simple: if the work
 * dir's token is newer than the canonical's (or the canonical has none), copy it
 * back. A crash before exit loses the last rotation — the full bidirectional
 * reconcile + the usage-poll guard are later work. Best-effort.
 *
 * ASSUMPTION (verify with a real token before relying on this — the (e) gate):
 * claude writes its in-session refreshed token to `<configDir>/.credentials.json`
 * (the file it reads). claude's refresh endpoint is a fixed external host, so the
 * write path can't be exercised with a local mock; if claude instead persists the
 * refresh elsewhere on macOS, reconcile no-ops and the canonical stays stale until
 * the next explicit refresh — the same gap step (e) closes completely.
 */
/** Coerce `expiresAt` (typed `number | string`) to an epoch for comparison.
 *  Numeric values pass through; a numeric string parses; an ISO string falls
 *  back to Date.parse — so a string form can't silently become NaN and freeze
 *  the newest-wins compare (which would make reconcile never fire). */
function toEpoch(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : Date.parse(v);
}

export function reconcileWorkDirToCanonical(
  workDir: string,
  canonicalDir: string,
  credentials: CredentialStore = defaultCredentialStore,
): void {
  const fresh = credentials.readOAuthForConfigDir(workDir)?.claudeAiOauth;
  if (!fresh) return; // no creds in the work dir → nothing to push back
  const canon = credentials.readOAuthForConfigDir(canonicalDir)?.claudeAiOauth;
  const canonEpoch = canon ? toEpoch(canon.expiresAt) : NaN;
  const freshEpoch = toEpoch(fresh.expiresAt);
  // Push back when the canonical lacks a usable expiry OR the work dir's token is
  // strictly newer. If the work dir's own expiry is unparseable, don't overwrite
  // a valid canonical (can't prove it's newer).
  if (!Number.isFinite(canonEpoch) || (Number.isFinite(freshEpoch) && freshEpoch > canonEpoch)) {
    credentials.writeOAuthForConfigDir(canonicalDir, { claudeAiOauth: fresh }, profileKeychainTrustedBins());
  }
}

/** Work dirs THIS process created, drained on a clean exit (reconcile-then-rm).
 *  A single shared `process.on('exit')` listener (registered lazily) drains the
 *  map — one listener per seed would trip the MaxListeners warning under tests
 *  that seed many dirs in one process. The value carries what reconcile needs. */
const pendingWorkDirCleanups = new Map<string, { canonicalDir: string; credentials: CredentialStore }>();
let cleanupRegistered = false;

/** Reconcile each scheduled work dir back to its canonical (newest-wins), then
 *  remove it. `fs.rmSync` removes the link ENTRIES, never following the symlinks
 *  into the canonical/global targets, so this can't delete shared user data.
 *  Exported for tests (the real call is the exit listener). */
export function cleanupPendingWorkDirs(): void {
  for (const [workDir, { canonicalDir, credentials }] of pendingWorkDirCleanups) {
    try { reconcileWorkDirToCanonical(workDir, canonicalDir, credentials); } catch { /* best-effort: stale on exit */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort: stale on exit */ }
  }
  pendingWorkDirCleanups.clear();
}

function scheduleWorkDirCleanup(workDir: string, canonicalDir: string, credentials: CredentialStore): void {
  pendingWorkDirCleanups.set(workDir, { canonicalDir, credentials });
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on('exit', cleanupPendingWorkDirs);
  }
}

/**
 * Remove orphaned work dirs whose owning pid is dead — the robust backstop for
 * the immediate exit cleanup (which a crash / SIGKILL bypasses). Each work dir is
 * named `<profile>.<pid>`; an entry whose pid is not alive is removed. Best-effort
 * per entry; `fs.rmSync` never follows the container symlinks. Runs opportunistically
 * at every seed, so a new session reclaims the previous ones' leftovers.
 */
export function sweepStaleWorkDirs(globalConfigDir: string, deps: { isAlive?: (pid: number) => boolean } = {}): void {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const root = path.join(globalConfigDir, 'session-dirs');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return; // no session-dirs yet → nothing to sweep
  }
  for (const entry of entries) {
    const pid = Number(entry.match(/\.(\d+)$/)?.[1]);
    if (!Number.isInteger(pid) || isAlive(pid)) continue; // not ours / still live → leave it
    try { fs.rmSync(path.join(root, entry), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Per-session private files — copied, never symlinked (see header).
 *  `.credentials.json` is NOT here: it goes through the credential port below.
 *  The shared data containers come from `PROFILE_DATA_CONTAINERS` (SSOT). */
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
  // Opportunistic cleanup: reclaim work dirs whose owning session has died
  // (crash / SIGKILL bypass the exit listener) before creating a new one.
  sweepStaleWorkDirs(globalConfigDir);
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

  // Fix the canonical's container topology first (overlay → symlink to the
  // global; classic → real dir) — this also migrates an older overlay that
  // predates the full container set — then link the work dir's entries to the
  // canonical's.
  ensureProfileDataContainers(canonicalDir, globalConfigDir);
  for (const sub of PROFILE_DATA_CONTAINERS) {
    ensureDirSymlink(path.join(workDir, sub), path.resolve(canonicalDir, sub));
  }

  // Remove this dir when the process exits cleanly (the sweep above is the
  // crash/SIGKILL backstop), reconciling any in-session token rotation back to
  // the canonical first.
  scheduleWorkDirCleanup(workDir, canonicalDir, credentials);
  return workDir;
}
