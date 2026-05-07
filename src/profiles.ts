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
import { writeJsonAtomic } from './atomic-write.js';
import {
  readKeychainForConfigDir,
  writeKeychainForConfigDir,
  type KeychainData,
} from './keychain.js';
import { isSafeEmail, resolvedAccountFile } from './accounts.js';

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
  } catch {
    return false;
  }
}

export function listProfiles(): string[] {
  try {
    return fs.readdirSync(profilesDir())
      .filter(n => {
        if (!isValidProfileName(n)) return false;
        try { return fs.statSync(path.join(profilesDir(), n)).isDirectory(); }
        catch { return false; }
      })
      .sort();
  } catch {
    return [];
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

interface LegacyAccountFile {
  emailAddress?: string;
  _keychain?: KeychainData;
  // …other oauthAccount fields (accountUuid, organization, etc.)
  [k: string]: unknown;
}

function readLegacyAccount(email: string, accountsDirPath: string): LegacyAccountFile {
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
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain an object.`);
  }
  return parsed as LegacyAccountFile;
}

export interface ImportResult {
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
  const claudeJson: Record<string, unknown> = { userID };
  let wroteToKeychain = false;
  let needsLogin = false;

  if (_keychain) {
    if (process.platform === 'darwin') {
      writeKeychainForConfigDir(dir, _keychain);
      wroteToKeychain = true;
      // Pre-populate oauthAccount so claude shows the right email even on
      // first run, before the Keychain lookup happens.
      claudeJson.oauthAccount = { ...oauthFields, emailAddress: email };
    } else if (_keychain.claudeAiOauth) {
      claudeJson.oauthAccount = {
        ...oauthFields,
        emailAddress: email,
        accessToken: _keychain.claudeAiOauth.accessToken,
        refreshToken: _keychain.claudeAiOauth.refreshToken,
        expiresAt: _keychain.claudeAiOauth.expiresAt,
      };
    } else {
      // _keychain present but missing claudeAiOauth — treat as login-required.
      needsLogin = true;
    }
  } else {
    needsLogin = true;
  }

  writeJsonAtomic(path.join(dir, '.claude.json'), claudeJson);

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
// Idempotent "open account isolated" helper
// ───────────────────────────────────────────────────────────────────────────

export interface EnsureProfileResult {
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
 */
export function ensureProfileForAccount(
  email: string,
  accountsDirPath: string,
): EnsureProfileResult {
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
    try {
      const legacy = readLegacyAccount(email, accountsDirPath);
      if (!legacy._keychain) return false;
      writeKeychainForConfigDir(profileDir, legacy._keychain);
      return true;
    } catch {
      return false;
    }
  };

  // Check all profiles for an email match (covers logged-in profiles).
  for (const name of listProfiles()) {
    try {
      const info = readProfile(name);
      if (info.emailAddress === email) {
        let needsLogin = !info.hasLogin;
        if (needsLogin && tryRecoverFromLegacy(info.path)) needsLogin = false;
        return {
          profileName: name,
          profilePath: info.path,
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
    const info = readProfile(derivedName);
    let needsLogin = !info.hasLogin;
    if (needsLogin && tryRecoverFromLegacy(info.path)) needsLogin = false;
    return {
      profileName: derivedName,
      profilePath: info.path,
      emailAddress: email,
      needsLogin,
      created: false,
    };
  }

  const result = importProfileFromAccount(email, accountsDirPath);
  return {
    profileName: result.profileName,
    profilePath: result.profilePath,
    emailAddress: email,
    needsLogin: result.needsLogin,
    created: true,
  };
}
