// src/apikey.ts
// Per-account Anthropic API key storage. The key is stored as `_apiKey` inside
// the account JSON file (perms 0600), alongside `_keychain`. It is injected as
// ANTHROPIC_API_KEY when fallback mode is on (see fallback.ts), letting users
// bypass their OAuth subscription quota and bill against API credits instead.
//
// Storage rationale: same file as the OAuth credentials, same permissions,
// same blast radius. No second backend (e.g. macOS Keychain) in v1.

import fs from 'node:fs';
import { isSafeEmail, resolvedAccountFile } from './accounts.js';
import { writeJsonAtomic } from './atomic-write.js';

function accountFilePath(email: string, accountsDirPath: string): string {
  if (!email || !isSafeEmail(email)) {
    throw new Error(`Email contains characters unsafe for filenames: ${email}`);
  }
  return resolvedAccountFile(email, accountsDirPath);
}

function readAccountFile(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (e instanceof SyntaxError) {
      throw new Error(`${file} contains invalid JSON. Please fix or delete it.`);
    }
    throw e;
  }
}

function writeAccountFile(file: string, data: Record<string, unknown>): void {
  writeJsonAtomic(file, data);
}

export function getApiKey(email: string, accountsDirPath: string): string | null {
  const data = readAccountFile(accountFilePath(email, accountsDirPath));
  if (!data) return null;
  const key = data._apiKey;
  return typeof key === 'string' && key ? key : null;
}

export function setApiKey(email: string, key: string, accountsDirPath: string): void {
  // Trim whitespace — pasted keys often arrive with leading/trailing
  // spaces or newlines that Anthropic rejects with a 401, and the user
  // has no clue why. Trim once here so both the TUI and CLI paths benefit.
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key cannot be empty');
  const file = accountFilePath(email, accountsDirPath);
  const data = readAccountFile(file);
  if (!data) {
    throw new Error(`No saved account for ${email}. Run: claude switch add`);
  }
  data._apiKey = trimmed;
  writeAccountFile(file, data);
}

export function removeApiKey(email: string, accountsDirPath: string): boolean {
  const file = accountFilePath(email, accountsDirPath);
  const data = readAccountFile(file);
  if (!data?._apiKey) return false;
  delete data._apiKey;
  writeAccountFile(file, data);
  return true;
}

/** sk-ant-api03-…WXYZ — keeps the prefix for source identification, last 4 for confirmation. */
export function maskApiKey(key: string): string {
  if (key.length <= 12) return '…' + key.slice(-4);
  // sk-ant-api03 prefix is 12 chars; keep that, hide middle, show last 4.
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}
