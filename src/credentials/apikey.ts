// src/apikey.ts
// Per-account Anthropic API key storage.
//
// Backend selection (Phase 24): keys flow through the CredentialStore port.
// The default store is the cross-platform file vault
// (`~/.claude-switch/apikeys.json`, mode 0600) on EVERY OS; the macOS Keychain
// backend is selected only under CLAUDE_SWITCH_USE_KEYCHAIN=1. The legacy
// `_apiKey` field inside the account JSON file (mode 0600) survives as a
// READ-ONLY fallback for keys written by pre-Phase-24 versions.
//
// Migration (migrateApiKeysToKeychain): copies any legacy plaintext `_apiKey`
// into the active vault. It runs on every platform now — the vault is
// available everywhere, not just macOS. The JSON field is intentionally left
// in place as a one-major fallback so losing the vault entry doesn't lose the
// key; v4 will retire it.

import fs from 'node:fs';
import { isSafeEmail, resolvedAccountFile } from '../accounts/accounts.js';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import { errnoCode } from '../platform/errors.js';
import type { AccountSnapshot } from '../accounts/account-snapshot.js';
import {
  keychainAvailable,
  readApiKeyFromKeychain,
  writeApiKeyToKeychain,
  deleteApiKeyFromKeychain,
} from './apikey-keychain.js';
import { defaultCredentialStore, type CredentialStore } from './credential-store.js';

function accountFilePath(email: string, accountsDirPath: string): string {
  if (!email || !isSafeEmail(email)) {
    throw new Error(`Email contains characters unsafe for filenames: ${email}`);
  }
  return resolvedAccountFile(email, accountsDirPath);
}

function readAccountFile(file: string): AccountSnapshot | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as AccountSnapshot;
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return null;
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
  // macOS: Keychain wins. If the Keychain entry is missing, fall through
  // to the JSON field — which on first read after upgrade carries the
  // legacy v3.x value. We do NOT auto-migrate during getApiKey() because
  // it's a hot-path read; migration runs explicitly inside setApiKey()
  // and a one-shot startup pass below.
  if (keychainAvailable()) {
    const fromKeychain = readApiKeyFromKeychain(email);
    if (fromKeychain) return fromKeychain;
  }

  const data = readAccountFile(accountFilePath(email, accountsDirPath));
  if (!data) return null;
  const key = data._apiKey;
  return typeof key === 'string' && key ? key : null;
}

export function setApiKey(
  email: string,
  key: string,
  accountsDirPath: string,
  deps: { credentials?: CredentialStore } = {},
): void {
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

  // Primary write: the credential vault (file vault by default, Keychain only
  // under CLAUDE_SWITCH_USE_KEYCHAIN=1). When it accepts the key we ALSO drop
  // the legacy `_apiKey` JSON field so a stale fallback can't shadow the vault.
  const store = deps.credentials ?? defaultCredentialStore;
  if (store.available()) {
    // Confirm the write succeeded BEFORE deleting the fallback. The Keychain
    // adapter throws on failure (so the delete is skipped), but the file vault
    // swallows write errors and returns false — deleting `_apiKey` on a false
    // return would lose the key from both places. Fail loud instead.
    if (!store.writeApiKey(email, trimmed)) {
      throw new Error(
        `Failed to store the API key for ${email}. Your existing key (if any) was left untouched.`,
      );
    }
    if (data._apiKey !== undefined) {
      delete data._apiKey;
      writeAccountFile(file, data);
    }
    return;
  }

  data._apiKey = trimmed;
  writeAccountFile(file, data);
}

export function removeApiKey(email: string, accountsDirPath: string): boolean {
  const file = accountFilePath(email, accountsDirPath);
  const data = readAccountFile(file);
  let removed = false;

  if (keychainAvailable()) {
    if (deleteApiKeyFromKeychain(email)) removed = true;
  }

  if (data?._apiKey !== undefined) {
    delete data._apiKey;
    writeAccountFile(file, data);
    removed = true;
  }

  return removed;
}

/**
 * One-shot migration: walks the accounts dir, copies any plaintext
 * `_apiKey` field into the active credential vault. Idempotent — running it
 * twice is harmless. Called from the CLI entry-point on every platform so the
 * upgrade path is silent (the name is historical; the default vault is the
 * file store, not the Keychain).
 *
 * The JSON `_apiKey` field is intentionally NOT removed by this pass —
 * it stays as a one-major fallback in case the vault entry is lost.
 * Removal happens in v4.
 *
 * Returns the count of accounts migrated. Errors per-account are
 * swallowed so a single failed write doesn't break the whole pass.
 */
export function migrateApiKeysToKeychain(accountsDirPath: string): number {
  if (!keychainAvailable()) return 0;
  let migrated = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(accountsDirPath);
  } catch { // accounts dir absent → nothing to migrate
    return 0;
  }
  for (const f of entries) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const email = f.slice(0, -5);
    if (!isSafeEmail(email)) continue;
    if (readApiKeyFromKeychain(email)) continue; // already migrated
    const data = readAccountFile(resolvedAccountFile(email, accountsDirPath));
    const legacy = data?._apiKey;
    if (typeof legacy !== 'string' || !legacy) continue;
    try {
      writeApiKeyToKeychain(email, legacy);
      migrated++;
    } catch {
      // Keychain locked or other failure — leave the JSON value in place
      // and try again on the next run.
    }
  }
  return migrated;
}

/** sk-ant-api03-…WXYZ — keeps the prefix for source identification, last 4 for confirmation. */
export function maskApiKey(key: string): string {
  if (key.length <= 12) return `…${key.slice(-4)}`;
  // sk-ant-api03 prefix is 12 chars; keep that, hide middle, show last 4.
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}
