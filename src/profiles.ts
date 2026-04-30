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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
