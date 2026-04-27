import fs from 'node:fs';
import path from 'node:path';
import { readKeychain, writeKeychain, type KeychainData } from './keychain.js';

const UNSAFE_FILENAME_CHARS = /[/\\:*?"<>|]/;

function resolvedAccountFile(email: string, accountsDirPath: string): string {
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
  } catch {
    return '';
  }
}

export function save(email: string, claudeJsonPath: string, accountsDirPath: string): void {
  if (!email || UNSAFE_FILENAME_CHARS.test(email)) {
    throw new Error(`Email contains characters unsafe for filenames: ${email}`);
  }

  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });

  let data;
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

  // Preserve any per-account API key (used for fallback when subscription
  // limits are hit) across re-saves, since save() rewrites the whole file.
  const accountFile = resolvedAccountFile(email, accountsDirPath);
  try {
    const existing = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
    if (typeof existing._apiKey === 'string' && existing._apiKey) {
      accountPayload._apiKey = existing._apiKey;
    }
  } catch {
    // No existing file or unreadable: nothing to preserve.
  }

  const tmp = accountFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(accountPayload, null, 2));
  if (process.platform !== 'win32') {
    fs.chmodSync(tmp, 0o600);
  }
  fs.renameSync(tmp, accountFile);
}

export function list(accountsDirPath: string): string[] {
  try {
    const files = fs.readdirSync(accountsDirPath);
    return files
      .filter(f => f.endsWith('.json') && !f.startsWith('.') && f !== 'aliases.json')
      .map(f => f.replace(/\.json$/, ''));
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

  // Restore Keychain credentials if they were saved with this account.
  // Accounts saved before this version of claude-switch won't have _keychain;
  // in that case we leave the Keychain as-is and return a flag so the caller
  // can warn the user that the account needs to be re-added.
  // _apiKey is stripped here too so it never leaks into ~/.claude.json.
  const { _keychain, _apiKey: _ignored, ...oauthAccount } = accountData;
  const keychainRestored = !!(_keychain && typeof _keychain === 'object');
  if (keychainRestored) {
    writeKeychain(_keychain as KeychainData);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`${claudeJsonPath} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }
  data.oauthAccount = oauthAccount;

  const tmp = claudeJsonPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, claudeJsonPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(claudeJsonPath, 0o600);
  }

  return { keychainRestored };
}
