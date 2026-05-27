// src/profiles.ts
// Per-terminal isolated profiles for Claude Code.
//
// Each profile is a directory under ~/.claude/profiles/<name>/ that we
// pass as `CLAUDE_CONFIG_DIR` when spawning claude. Claude Code natively
// supports this env var (verified on v2.1.123) and gives every distinct
// dir its own userID, its own macOS Keychain entry, its own session
// state, etc.
//
// This is completely separate from the legacy `claude switch <account>`
// flow. The legacy flow rewrites global state (~/.claude.json + the
// default Keychain entry) and is shared across all terminals; profiles
// are isolated and per-terminal. Both can coexist on the same machine
// without interfering with each other.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import {
  readKeychain,
  readKeychainForConfigDir,
  writeKeychainForConfigDir,
} from '../credentials/keychain.js';
import { getCurrent, isSafeEmail, resolvedAccountFile, save, syncActiveSnapshotIfStale } from '../accounts/accounts.js';
import { claudeJsonPath } from '../platform/paths.js';
import { errMessage, debugProfiles } from '../platform/errors.js';
import type { AccountSnapshot } from '../accounts/account-snapshot.js';
import { findClaudeBinary } from '../setup/find-claude.js';

/**
 * Trusted-bins list passed to `security -T` when writing a profile
 * Keychain entry. Resolves the real `claude` binary (native Mach-O) so
 * Claude Code can read its own Keychain entry without an interactive
 * prompt. Without this, the entry's ACL stays bound to the creating
 * process (claude-switch) and claude silently falls back to OAuth login.
 */
function profileKeychainTrustedBins(): string[] {
  const bin = findClaudeBinary(import.meta.url);
  return bin ? [bin] : [];
}

// Conservative naming rules so a profile name is never ambiguous on
// disk, in shell completions, or in error messages. Letters, digits,
// underscore, hyphen — same alphabet as account aliases.
const PROFILE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Names that would be confusing if accepted (clash with subcommand names).
const RESERVED_NAMES = new Set(['list', 'ls', 'create', 'use', 'login', 'remove', 'rm', 'status', 'help']);

export function isValidProfileName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (!PROFILE_NAME_RE.test(name)) return false;
  if (RESERVED_NAMES.has(name)) return false;
  return true;
}

/** Root directory under which all profile dirs live. */
export function profilesDir(): string {
  return path.join(os.homedir(), '.claude', 'profiles');
}

/**
 * Resolve `<profilesDir>/<name>/`, refusing names that fail validation
 * or that would resolve outside the profiles dir (path traversal).
 */
export function profilePath(name: string): string {
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name "${name}". ` +
      `Use letters, digits, _ or - (max 64 chars). Reserved: list, ls, create, use, login, remove, rm, status, help.`,
    );
  }
  const base = path.resolve(profilesDir());
  const resolved = path.resolve(profilesDir(), name);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Profile "${name}" resolves outside the profiles directory.`);
  }
  return resolved;
}

export function profileExists(name: string): boolean {
  try {
    return fs.statSync(profilePath(name)).isDirectory();
  } catch { // profile dir absent → does not exist
    return false;
  }
}

export function listProfiles(): string[] {
  try {
    return fs.readdirSync(profilesDir())
      .filter(n => {
        if (!isValidProfileName(n)) return false;
        try { return fs.statSync(path.join(profilesDir(), n)).isDirectory(); }
        catch { return false; } // entry vanished mid-scan → not a profile dir
      })
      .sort();
  } catch {
    return []; // profiles dir missing/unreadable → no profiles
  }
}

/**
 * Create the profile directory. Throws if it already exists, so the
 * caller can decide whether to overwrite (typically: don't).
 */
export function createProfile(name: string): string {
  const p = profilePath(name);
  if (profileExists(name)) {
    throw new Error(`Profile "${name}" already exists at ${p}.`);
  }
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

export interface ProfileInfo {
  name: string;
  path: string;
  /** Stable random ID Claude Code generates per CONFIG_DIR. Becomes the
   *  Keychain entry's `account` field on macOS. Null until first run. */
  userID: string | null;
  /** Email of the account currently signed in to this profile, or null
   *  if no `auth login` has been completed yet. */
  emailAddress: string | null;
  /** True if oauthAccount is populated — best-effort signal that the
   *  profile is usable without re-login. */
  hasLogin: boolean;
}

/**
 * Read profile metadata without spawning claude. Used by `list` and
 * `status` to summarise profiles in the menu.
 */
export function readProfile(name: string): ProfileInfo {
  const p = profilePath(name);
  if (!profileExists(name)) {
    throw new Error(`Profile "${name}" does not exist.`);
  }
  let userID: string | null = null;
  let emailAddress: string | null = null;
  let hasLogin = false;
  try {
    const raw = fs.readFileSync(path.join(p, '.claude.json'), 'utf-8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof cfg.userID === 'string') userID = cfg.userID;
    const oauth = cfg.oauthAccount as Record<string, unknown> | undefined;
    if (oauth && typeof oauth.emailAddress === 'string') {
      emailAddress = oauth.emailAddress;
      hasLogin = true;
    }
  } catch {
    // Fresh profile (no .claude.json yet) or unreadable. Leave fields null.
  }
  // On macOS, OAuth tokens live in the Keychain — NOT in the .claude.json
  // file. The JSON's oauthAccount block is purely descriptive, so a stale
  // `emailAddress` can persist long after the Keychain entry has been
  // wiped/expired/never-written. We saw this break "Open account
  // isolated": the dispatcher trusted hasLogin=true from JSON, spawned
  // claude in the empty profile, and claude itself fell back to its
  // login picker. So on darwin we demote hasLogin to "JSON says yes AND
  // a Keychain entry actually resolves at the per-config-dir service
  // claude itself queries". The (service, account) pair is derived in
  // keychain.ts to match claude's `My("-credentials")` / `uV()` formula.
  if (
    hasLogin &&
    process.platform === 'darwin' &&
    process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN !== '1'
  ) {
    if (!readKeychainForConfigDir(p)) hasLogin = false;
  }
  return { name, path: p, userID, emailAddress, hasLogin };
}

/**
 * Remove the profile directory. Returns the userID of the now-removed
 * profile so the caller can also clean up the macOS Keychain entry that
 * was keyed by it (we don't do this automatically because the Keychain
 * write was done by Claude Code itself, not by us, and we don't want to
 * delete entries we didn't create without explicit user confirmation).
 */
export function removeProfile(name: string): { dir: string; userID: string | null } {
  const info = readProfile(name);
  fs.rmSync(info.path, { recursive: true, force: true });
  return { dir: info.path, userID: info.userID };
}

// ───────────────────────────────────────────────────────────────────────────
// Import an existing legacy account into a fresh profile.
//
// The legacy `claude switch` flow saves a snapshot of the macOS Keychain
// blob in `~/.claude/accounts/<email>.json` under the `_keychain` key.
// Since claude-switch v2.2 every saved account has this snapshot, we can
// re-inject it into a brand-new profile without forcing the user through
// another OAuth login in the browser.
//
// Strategy:
//   1. Generate a fresh userID (random 64-char hex).
//   2. Write `<profile>/.claude.json` with that userID and the email.
//   3. macOS only: write the saved Keychain blob into a Keychain entry
//      keyed by our chosen userID. (Linux/Windows store tokens in
//      .claude.json directly — see Note below.)
//
// Empirically verified: Claude Code does NOT regenerate userID if it
// already exists in .claude.json on first run. So the userID we pick
// becomes the persistent identifier for that profile's Keychain entry.
//
// NOTE on Linux/Windows: Claude Code stores the OAuth tokens inside
// .claude.json itself on those platforms. The legacy account file's
// `_keychain` field still contains the same blob shape, but the import
// must write it into the profile's .claude.json instead. We do this
// best-effort below.
// ───────────────────────────────────────────────────────────────────────────

function freshUserID(): string {
  // 32 bytes = 64 hex chars, matching the format Claude Code generates.
  return crypto.randomBytes(32).toString('hex');
}

function readLegacyAccount(email: string, accountsDirPath: string): AccountSnapshot {
  // Reject anything that isn't a safe email up front so we never feed a
  // raw `../../etc/passwd` into `path.join`. Mirrors the guard that
  // `accounts.ts` applies on its read/write paths.
  if (!email || !isSafeEmail(email)) {
    throw new Error(`Email contains characters unsafe for filenames: ${email}`);
  }
  const file = resolvedAccountFile(email, accountsDirPath);

  // Reject symlinks before opening — a local attacker who can write into
  // ~/.claude/accounts/ could otherwise plant a symlink to an arbitrary
  // file and have us parse it as account data. Same defence applied by
  // `accounts.load`.
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`No saved account for ${email}. List accounts with: claude switch list`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Account file for ${email} is a symbolic link and cannot be trusted`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${errMessage(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain an object.`);
  }
  return parsed as AccountSnapshot;
}

/**
 * If the legacy account's `_keychain.claudeAiOauth` access token is
 * expired (or about to expire), call the Anthropic OAuth refresh
 * endpoint and rewrite the snapshot in-place. Returns true when a
 * refresh actually happened, false otherwise (no _keychain, no
 * refresh_token, fresh tokens, or refresh failed).
 *
 * Called internally by `ensureProfileForAccount` before the sync
 * `importProfileFromAccount` flow, so the snapshot landing in the
 * Keychain / per-profile JSON is fresh by construction. Without this
 * pre-step, profiles dormant for hours/days would carry expired
 * access tokens straight to claude, which then 401s instead of
 * auto-refreshing (it doesn't auto-refresh in --print mode against
 * a non-default config dir).
 *
 * Failure is silent: we log nothing, return false, and let the caller
 * fall through to its existing "needsLogin" handling. Better UX than
 * surfacing a transient network error in the Open-Account-Isolated
 * hot path.
 */
export async function refreshLegacySnapshotIfStale(
  email: string,
  accountsDirPath: string,
): Promise<boolean> {
  // If the legacy snapshot is for the currently-active account AND
  // claude.json was mutated externally (e.g. /login from inside a
  // running claude session), capture the live state first — otherwise
  // we'd refresh stale tokens and re-store them, losing whatever
  // claude already rotated.
  syncActiveSnapshotIfStale(claudeJsonPath(), accountsDirPath);

  let legacy: AccountSnapshot;
  try {
    legacy = readLegacyAccount(email, accountsDirPath);
  } catch { // no readable legacy account → nothing to migrate
    return false;
  }
  const oauth = legacy._keychain?.claudeAiOauth;
  if (!oauth) return false;

  const { isAccessTokenStale, refreshAccessToken } = await import('../credentials/oauth-refresh.js');
  if (!isAccessTokenStale(oauth)) return false;
  if (!oauth.refreshToken) return false;

  const refreshed = await refreshAccessToken(oauth.refreshToken);
  if (!refreshed) return false;

  // Atomic-rewrite the legacy file with the refreshed snapshot. We preserve
  // every other field — only `_keychain.claudeAiOauth` is replaced, and within
  // it only the token-bearing fields change: merge the refreshed fields onto
  // the prior oauth so metadata the token endpoint doesn't echo back
  // (subscriptionType, rateLimitTier, scopes) survives the refresh. Other
  // blocks (`mcpOAuth` etc.) stay untouched.
  const next: AccountSnapshot = {
    ...legacy,
    _keychain: {
      ...legacy._keychain,
      claudeAiOauth: { ...oauth, ...refreshed, scopes: refreshed.scopes ?? oauth.scopes },
    },
  };
  writeJsonAtomic(resolvedAccountFile(email, accountsDirPath), next);
  return true;
}

interface ImportResult {
  profileName: string;
  profilePath: string;
  userID: string;
  emailAddress: string;
  /** True when we wrote credentials to the macOS Keychain.
   *  False when we wrote to the profile's .claude.json (Linux/Windows)
   *  or when no _keychain blob was present in the legacy account. */
  wroteToKeychain: boolean;
  /** True when no `_keychain` blob existed in the legacy account file
   *  — the profile is created with the email but the user will still
   *  need to `profile login` to authenticate. */
  needsLogin: boolean;
}

/**
 * Convert a legacy `claude switch` account into a fresh isolated profile.
 *
 * Default profile name is the local-part of the email (`work@x.com` →
 * `work`); pass an explicit `profileName` to override.
 */
export function importProfileFromAccount(
  email: string,
  accountsDirPath: string,
  profileName?: string,
): ImportResult {
  const account = readLegacyAccount(email, accountsDirPath);
  const finalName = profileName ?? (email.split('@')[0] ?? email).replace(/[^A-Za-z0-9_-]/g, '_');
  if (!isValidProfileName(finalName)) {
    throw new Error(
      `Computed profile name "${finalName}" is not valid. Pass an explicit name with --as <name>.`,
    );
  }

  const dir = createProfile(finalName); // throws if exists
  const userID = freshUserID();

  // Strip our internal _keychain key from the snapshot before persisting.
  const { _keychain, ...oauthFields } = account;

  // Determine whether we can fully populate the profile with credentials,
  // or whether the user has to `profile login` afterwards. Two paths:
  //
  //   macOS  →  if we have _keychain, write it to the Keychain at the
  //             per-config-dir service Claude Code derives from the
  //             profile path. Account field is the OS username, NOT the
  //             userID — newer claude (v2.x) ignores the userID for
  //             OAuth lookups and only honours
  //             `Claude Code-credentials-<sha256(configDir)[0:8]>` /
  //             `os.userInfo().username`. We still record userID in the
  //             JSON for our own bookkeeping (telemetry/debug).
  //
  //   other  →  Claude Code reads tokens from .claude.json itself, so we
  //             embed accessToken/refreshToken/expiresAt directly there.
  //
  // If we have no _keychain snapshot (pre-v2.2 legacy account), we write
  // ONLY the userID to the JSON — no oauthAccount. That way readProfile()
  // returns hasLogin=false and `profile use` correctly refuses to spawn
  // claude, prompting the user to run `profile login` first.
  // `hasCompletedOnboarding` is the gate Claude Code 2.x checks before
  // attempting to read OAuth tokens from the Keychain. Without it the
  // binary shows the full welcome wizard (theme picker → "Select login
  // method"), bypassing the Keychain entry entirely even when valid
  // credentials are present. Set it here so imported profiles enter
  // the REPL directly.
  const claudeJson: Record<string, unknown> = {
    userID,
    hasCompletedOnboarding: true,
  };
  let wroteToKeychain = false;
  let needsLogin = false;

  // CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 forces the JSON-embedding path even on
  // darwin. Used by the test suite (so `npm test` doesn't trigger Keychain
  // auth prompts) and by users who explicitly opt out of the Keychain
  // backend. The mock claude binary in test/fixtures honours the same
  // contract — JSON-embedded tokens are read directly.
  const useKeychain = process.platform === 'darwin'
    && process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN !== '1';

  debugProfiles(`importProfileFromAccount legacyKeychain=${Boolean(_keychain)} useKeychain=${useKeychain} profileDir=${dir}`);

  if (_keychain) {
    if (useKeychain) {
      try {
        writeKeychainForConfigDir(dir, _keychain, profileKeychainTrustedBins());
        wroteToKeychain = true;
        debugProfiles(`keychainWrite=success service=per-config-dir account=${dir} (import from snapshot)`);
      } catch (writeErr) {
        debugProfiles(`keychainWrite=failed service=per-config-dir account=${dir} err=${errMessage(writeErr)}`);
      }
      // Pre-populate oauthAccount so claude shows the right email even on
      // first run, before the Keychain lookup happens.
      claudeJson.oauthAccount = { ...oauthFields, emailAddress: email };
    } else if (_keychain.claudeAiOauth) {
      // Linux/Windows: embed tokens directly in JSON.
      debugProfiles(`keychainWrite=skipped service=per-config-dir (non-darwin or disable-flag) writing to JSON`);
      claudeJson.oauthAccount = {
        ...oauthFields,
        emailAddress: email,
        accessToken: _keychain.claudeAiOauth.accessToken,
        refreshToken: _keychain.claudeAiOauth.refreshToken,
        expiresAt: _keychain.claudeAiOauth.expiresAt,
      };
    } else {
      // _keychain present but missing claudeAiOauth — treat as login-required.
      debugProfiles(`keychainWrite=skipped legacyKeychain=true but no claudeAiOauth — needsLogin=true`);
      needsLogin = true;
    }
  } else {
    debugProfiles(`keychainWrite=skipped legacyKeychain=false — needsLogin=true`);
    needsLogin = true;
  }

  writeJsonAtomic(path.join(dir, '.claude.json'), claudeJson);

  // Carry the user's global statusLine config into the profile's
  // settings.json so the badge (e.g. `claude switch sl` + ccstatusline)
  // also renders inside isolated profile sessions. Without this, the
  // profile starts with no statusline and the user can't tell which
  // account the terminal is bound to. Best-effort: skip silently if
  // the global settings file is missing or unreadable.
  try {
    const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(globalSettingsPath)) {
      const raw = fs.readFileSync(globalSettingsPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.statusLine) {
        const profileSettingsPath = path.join(dir, 'settings.json');
        const existing = fs.existsSync(profileSettingsPath)
          ? (JSON.parse(fs.readFileSync(profileSettingsPath, 'utf8')) as Record<string, unknown>)
          : {};
        writeJsonAtomic(profileSettingsPath, { ...existing, statusLine: parsed.statusLine });
      }
    }
  } catch {
    /* best-effort — statusline propagation is non-critical */
  }

  // If the imported email is the currently-active account, overwrite
  // the Keychain entry we just wrote (from the legacy snapshot, which
  // may already be stale) with the live blob from the default Keychain.
  // No-op on non-darwin / disable flag / non-active email. Crucially
  // also fixes the case where the legacy snapshot had no `_keychain`
  // block at all — needsLogin was true above, but live capture makes
  // it false retroactively.
  if (captureLiveCredentialsForActiveAccount(email, dir)) {
    wroteToKeychain = true;
    needsLogin = false;
  }

  return {
    profileName: finalName,
    profilePath: dir,
    userID,
    emailAddress: email,
    wroteToKeychain,
    needsLogin,
  };
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

function captureLiveCredentialsForActiveAccount(
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

  const live = readKeychain();
  if (!live?.claudeAiOauth?.accessToken) return false;

  // Skip the write if the profile's entry already matches the live blob —
  // avoids a fork+exec to `security` on every isolated open. Comparing by
  // accessToken is sufficient: rotation always changes it.
  const existing = readKeychainForConfigDir(profileDir);
  if (existing?.claudeAiOauth?.accessToken === live.claudeAiOauth.accessToken) {
    debugProfiles(`keychainWrite=skipped service=per-config-dir account=${profileDir} (already in sync)`);
    return true;
  }

  try {
    writeKeychainForConfigDir(profileDir, live, profileKeychainTrustedBins());
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

// ───────────────────────────────────────────────────────────────────────────
// Idempotent "open account isolated" helper
// ───────────────────────────────────────────────────────────────────────────

interface EnsureProfileResult {
  profileName: string;
  profilePath: string;
  emailAddress: string;
  /** True when the profile exists but has no credentials — user must authenticate. */
  needsLogin: boolean;
  /** True when we created a new profile (as opposed to reusing an existing one). */
  created: boolean;
}

/**
 * Find or create an isolated profile for the given account email.
 *
 * If a profile already linked to `email` exists, it is returned as-is.
 * Otherwise the legacy saved account is imported into a fresh profile —
 * no browser re-login required when a Keychain snapshot is present.
 *
 * Internally calls `refreshLegacySnapshotIfStale` before any sync
 * credential-writing so the snapshot landing in the Keychain / per-profile
 * JSON is always fresh by construction. Refresh failure is silent — we
 * fall through to the existing "needsLogin" handling.
 */
export async function ensureProfileForAccount(
  email: string,
  accountsDirPath: string,
): Promise<EnsureProfileResult> {
  // Refresh the legacy snapshot's access token if stale BEFORE entering
  // the sync credential-writing path. Failure is silent — fall through
  // to the existing needsLogin handling.
  try {
    await refreshLegacySnapshotIfStale(email, accountsDirPath);
  } catch { /* network failure → fall through */ }
  // If we land on a profile that says "needs login" but the legacy
  // account file still carries a `_keychain` snapshot, opportunistically
  // re-write the missing Keychain entry at the per-config-dir service
  // claude itself queries. This rescues the "Open account isolated" UX
  // from a state where the profile JSON survived but the Keychain
  // entry got wiped (rotated tokens, manual deletion, machine restore,
  // OR — most commonly until this fix — claude-switch ≤3.4.x having
  // written the entry at the wrong service in the first place).
  // Returns true when a recovery write happened so the caller can flip
  // needsLogin to false.
  const tryRecoverFromLegacy = (profileDir: string): boolean => {
    if (process.platform !== 'darwin') return false;
    if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') return false;
    try {
      const legacy = readLegacyAccount(email, accountsDirPath);
      const hasKeychain = Boolean(legacy._keychain);
      // Detect whether the snapshot tokens are stale (expired) so the
      // maintainer can distinguish H2 from H4 in the debug output.
      // We do a simple synchronous expiresAt check — the async
      // refreshLegacySnapshotIfStale is called at the top of
      // ensureProfileForAccount, so if we reach here with stale tokens the
      // refresh either failed or returned without updating the snapshot.
      const oauthExp = legacy._keychain?.claudeAiOauth?.expiresAt;
      const isStale = oauthExp !== undefined && Date.now() >= Number(oauthExp);
      const hasLoginReason = isStale ? 'snapshot-stale' : (hasKeychain ? 'json-ok' : 'keychain-miss');
      debugProfiles(`recoveryAttempted=true legacyKeychain=${hasKeychain} reason=${hasLoginReason} profileDir=${profileDir}`);
      if (!legacy._keychain) return false;
      try {
        writeKeychainForConfigDir(profileDir, legacy._keychain, profileKeychainTrustedBins());
        debugProfiles(`keychainWrite=success service=per-config-dir account=${profileDir}`);
        return true;
      } catch (writeErr) {
        debugProfiles(`keychainWrite=failed service=per-config-dir account=${profileDir} err=${errMessage(writeErr)}`);
        return false;
      }
    } catch { // legacy account read failed → recovery unavailable (logged above)
      debugProfiles(`recoveryAttempted=true legacyKeychain=false profileDir=${profileDir} (readLegacyAccount failed)`);
      return false;
    }
  };

  debugProfiles(`ensureProfileForAccount email=<email> disableKeychain=${process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1'}`);

  // Check all profiles for an email match (covers logged-in profiles).
  for (const name of listProfiles()) {
    try {
      const info = readProfile(name);
      const emailMatch = info.emailAddress === email;
      if (emailMatch) {
        debugProfiles(`emailMatch=true profileFound=true path=${info.path}`);
        // Live-capture fast path: when the email coincides with the active
        // account, refresh the profile's Keychain entry from the default
        // Keychain. Handles the drift case where the profile entry was
        // valid at recovery time but has since gone stale (claude rotates
        // the default Keychain in-process). No-op on non-darwin / when
        // Keychain disabled / when email != active / when already in sync.
        captureLiveCredentialsForActiveAccount(email, info.path);
        // Re-read so hasLogin reflects any freshly-written entry.
        const fresh = readProfile(name);
        let needsLogin = !fresh.hasLogin;

        // Determine hasLogin reason for diagnostics.
        let hasLoginReason: string;
        if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') {
          hasLoginReason = 'disable-flag';
        } else if (process.platform === 'darwin' && !fresh.hasLogin) {
          hasLoginReason = 'keychain-miss';
        } else {
          hasLoginReason = 'json-ok';
        }
        debugProfiles(`hasLogin=${fresh.hasLogin} reason=${hasLoginReason}`);

        if (needsLogin && tryRecoverFromLegacy(fresh.path)) needsLogin = false;
        return {
          profileName: name,
          profilePath: fresh.path,
          emailAddress: email,
          needsLogin,
          created: false,
        };
      }
    } catch { /* skip unreadable profiles */ }
  }

  // Profiles imported without credentials don't have oauthAccount (and so
  // emailAddress is null). Fall back to the name that importProfileFromAccount
  // would derive — if that profile already exists, treat it as ours.
  const derivedName = (email.split('@')[0] ?? email).replace(/[^A-Za-z0-9_-]/g, '_');
  if (isValidProfileName(derivedName) && profileExists(derivedName)) {
    debugProfiles(`emailMatch=false profileFound=true path=${profilePath(derivedName)} (derivedName fallback)`);
    captureLiveCredentialsForActiveAccount(email, profilePath(derivedName));
    const info = readProfile(derivedName);
    let needsLogin = !info.hasLogin;

    let hasLoginReason: string;
    if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') {
      hasLoginReason = 'disable-flag';
    } else if (process.platform === 'darwin' && !info.hasLogin) {
      hasLoginReason = 'keychain-miss';
    } else {
      hasLoginReason = 'json-ok';
    }
    debugProfiles(`hasLogin=${info.hasLogin} reason=${hasLoginReason}`);

    if (needsLogin && tryRecoverFromLegacy(info.path)) needsLogin = false;
    return {
      profileName: derivedName,
      profilePath: info.path,
      emailAddress: email,
      needsLogin,
      created: false,
    };
  }

  // H1 — the account was authenticated directly (e.g. `claude /login`) and
  // never captured as a legacy snapshot, so `importProfileFromAccount` below
  // would throw "No saved account". When the email coincides with the active
  // account, capture an implicit snapshot from the live claude.json (+ default
  // Keychain) first, giving the import a source to read. This matches what an
  // explicit `claude switch save` would have produced. Opt-out via
  // CLAUDE_SWITCH_NO_IMPLICIT_SAVE=1 for one release of back-compat for anyone
  // relying on the previous throw behaviour.
  if (process.env.CLAUDE_SWITCH_NO_IMPLICIT_SAVE !== '1') {
    let legacyExists = false;
    try {
      legacyExists = fs.existsSync(resolvedAccountFile(email, accountsDirPath));
    } catch { /* unsafe email → let importProfileFromAccount surface it */ }
    if (!legacyExists) {
      let activeEmail = '';
      try {
        activeEmail = getCurrent(claudeJsonPath());
      } catch { /* claude.json unreadable → skip implicit save */ }
      if (activeEmail && activeEmail === email) {
        try {
          save(email, claudeJsonPath(), accountsDirPath);
          debugProfiles(`implicitSave=true reason=active-no-legacy profileDir=<accounts>`);
        } catch (saveErr) {
          debugProfiles(`implicitSave=failed err=${errMessage(saveErr)}`);
        }
      } else {
        debugProfiles(`implicitSave=skipped reason=${activeEmail ? 'email-not-active' : 'no-active-account'}`);
      }
    }
  }

  debugProfiles(`emailMatch=false profileFound=false importing from legacy account`);
  const result = importProfileFromAccount(email, accountsDirPath);
  debugProfiles(`profileFound=true path=${result.profilePath} needsLogin=${result.needsLogin} created=true`);
  return {
    profileName: result.profileName,
    profilePath: result.profilePath,
    emailAddress: email,
    needsLogin: result.needsLogin,
    created: true,
  };
}
