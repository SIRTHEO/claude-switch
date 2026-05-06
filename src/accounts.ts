import fs from 'node:fs';
import path from 'node:path';
import { readKeychain, writeKeychain, type KeychainData } from './keychain.js';
import { writeJsonAtomic } from './atomic-write.js';

// Whitelist of characters allowed in account names. RFC 5321 email local-part
// can contain more than this, but accepting only [A-Za-z0-9._+@-] covers ~all
// real-world emails and blocks shell metacharacters ($, `, (, ), ;, &, |,
// space, newline, etc.) that would otherwise allow command injection through
// downstream consumers like shell completions (compgen -W).
export const SAFE_EMAIL_CHARS = /^[A-Za-z0-9._+@-]+$/;

export function isSafeEmail(email: string): boolean {
  return SAFE_EMAIL_CHARS.test(email);
}

/**
 * Resolve `<email>.json` inside `accountsDirPath`, refusing any value that
 * escapes the directory (path traversal). Used by accounts.ts and apikey.ts
 * — both produce files in the same dir with the same naming scheme.
 */
export function resolvedAccountFile(email: string, accountsDirPath: string): string {
  const base = path.resolve(accountsDirPath);
  const resolved = path.resolve(accountsDirPath, `${email}.json`);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Email resolves outside accounts directory: ${email}`);
  }
  return resolved;
}

export function getCurrent(claudeJsonPath: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    return data?.oauthAccount?.emailAddress || '';
  } catch (e) {
    // Distinguish "file missing / unparseable" (legitimate empty state) from
    // "permission denied" (operator misconfiguration). The latter would be
    // misleading if reported as "no account connected".
    if ((e as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(`Permission denied reading ${claudeJsonPath}. Check file permissions.`);
    }
    return '';
  }
}

export function save(email: string, claudeJsonPath: string, accountsDirPath: string): void {
  if (!email || !isSafeEmail(email)) {
    throw new Error(`Email contains characters unsafe for filenames: ${email}`);
  }

  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${claudeJsonPath} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }

  // Include Keychain credentials so they can be restored when switching back.
  const keychainData = readKeychain();
  const accountPayload: Record<string, unknown> = { ...(data.oauthAccount || {}) };
  if (keychainData) {
    accountPayload._keychain = keychainData;
  }

  // Snapshot the API-key acceptance state so it does NOT leak across
  // accounts. Claude Code writes `customApiKeyResponses.approved` (and
  // sometimes `apiKey`) directly into ~/.claude.json the first time the
  // user answers "Use this API key? [Y/n]". Without this snapshot, the
  // approval array stays in the file across a `claude switch`, so the
  // newly-active account inherits the previous account's approved key
  // and silently uses it instead of OAuth — observed in the wild on
  // 2026-05-06: switched sirtheo → claude still billed tech's key.
  if (data.customApiKeyResponses) {
    accountPayload._customApiKeyResponses = data.customApiKeyResponses;
  }
  if (typeof data.apiKey === 'string' && data.apiKey) {
    accountPayload._claudeJsonApiKey = data.apiKey;
  }

  // Preserve any per-account API key (used for fallback when subscription
  // limits are hit) AND per-account preferences across re-saves, since
  // save() rewrites the whole file.
  const accountFile = resolvedAccountFile(email, accountsDirPath);
  try {
    const existing = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
    if (typeof existing._apiKey === 'string' && existing._apiKey) {
      accountPayload._apiKey = existing._apiKey;
    }
    if (existing._prefs && typeof existing._prefs === 'object') {
      accountPayload._prefs = existing._prefs;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    // ENOENT: first save for this account — nothing to preserve.
  }

  writeJsonAtomic(accountFile, accountPayload);
}

export function list(accountsDirPath: string): string[] {
  try {
    const files = fs.readdirSync(accountsDirPath);
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
  } catch {
    return [];
  }
}

export function remove(email: string, accountsDirPath: string): void {
  const accountFile = resolvedAccountFile(email, accountsDirPath);
  try {
    fs.unlinkSync(accountFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No saved account for ${email}`);
    }
    throw e;
  }
}

export function load(email: string, claudeJsonPath: string, accountsDirPath: string): { keychainRestored: boolean } {
  const accountFile = resolvedAccountFile(email, accountsDirPath);

  // Reject symlinks to prevent symlink-based file read attacks
  const fileStat = fs.lstatSync(accountFile, { throwIfNoEntry: false });
  if (!fileStat) {
    throw new Error(`No saved account for ${email}`);
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`Account file for ${email} is a symbolic link and cannot be trusted`);
  }

  let accountData: Record<string, unknown>;
  try {
    accountData = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${accountFile} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }

  // Strip internal fields so they never leak into ~/.claude.json.
  const {
    _keychain,
    _apiKey: _ignored,
    _prefs: _ignoredPrefs,
    _customApiKeyResponses,
    _claudeJsonApiKey,
    ...oauthAccount
  } = accountData;
  const keychainRestored = !!(_keychain && typeof _keychain === 'object');

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${claudeJsonPath} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }
  // Snapshot the previous oauthAccount so we can roll the JSON back if the
  // Keychain write fails afterwards (keeps the two sources of truth in sync).
  const previousOauthAccount = data.oauthAccount;
  data.oauthAccount = oauthAccount;

  // Restore (or actively CLEAR) the API-key acceptance state. Clearing is
  // the load-bearing part: without it, a previously-approved API key from
  // another account would carry over into ~/.claude.json and Claude Code
  // would silently use it instead of OAuth, billing the wrong account.
  // The user gets re-prompted "Use this API key? [Y/n]" on first use of
  // a key under the new account — that's the correct UX after a switch.
  if (_customApiKeyResponses && typeof _customApiKeyResponses === 'object') {
    data.customApiKeyResponses = _customApiKeyResponses;
  } else {
    delete data.customApiKeyResponses;
  }
  if (typeof _claudeJsonApiKey === 'string' && _claudeJsonApiKey) {
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
  if (keychainRestored) {
    try {
      writeKeychain(_keychain as KeychainData);
    } catch (e) {
      try {
        writeJson({ ...data, oauthAccount: previousOauthAccount });
      } catch { /* best-effort rollback */ }
      throw e;
    }
  }

  return { keychainRestored };
}
