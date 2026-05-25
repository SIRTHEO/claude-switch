// src/file-credential-store.ts
// FileCredentialStore — Phase 24 file vault backend.
//
// macOS Keychain integration produced structural UX friction:
//   - per-item partition-list dialogs (read AND write)
//   - per-item ACL classic dialogs that 23.5–23.9 could not fully suppress
//   - iCloud-sync notifications cascade
//   - Claude Code 2.x resetting our partition-list on /login
//
// Empirically verified 2026-05-25: Claude Code 2.x reads OAuth tokens from
// `~/.claude/.credentials.json` when the Keychain item is absent. So we can
// stop maintaining a Keychain item for our own storage entirely. The token
// only needs to land in the file Claude Code itself reads, and our own
// account snapshots stay where they were (JSON under `~/.claude/accounts/`).
//
// This adapter implements the same `CredentialStore` port the rest of the
// codebase already depends on, so switching the default is a one-line flip
// in `credential-store.ts`. No new runtime dependencies; only `node:fs`
// + the existing atomic-write helper.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import type { CredentialStore, KeychainData, KeychainItemRef } from './credential-store.js';

/**
 * Path to Claude Code's "fallback" credentials file.
 *
 * On macOS, Claude Code 2.x prefers the Keychain item `Claude Code-credentials`
 * but falls back to this file when the item is absent. We never write the
 * Keychain item, so this file IS the source of truth for the active OAuth
 * token. On Linux/Windows, Claude Code reads `~/.claude.json` for `oauthAccount`
 * metadata and uses this file (when present) for tokens — same shape.
 *
 * Format: `{ "claudeAiOauth": { "accessToken", "refreshToken", "expiresAt", ... } }`
 * matching the Keychain blob exactly, so a write here is byte-equivalent to
 * the previous Keychain write.
 */
export function defaultCredentialsFilePath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * Path to the per-config-dir credentials file (claude-switch profiles).
 *
 * Per-profile token storage lives under `<configDir>/.credentials.json` so a
 * `claude` invocation with `CLAUDE_CONFIG_DIR=<configDir>` reads the profile's
 * own token. Mirrors the per-config-dir Keychain item naming we used to
 * produce via SHA-256(configDir)[:8], but now it's just a file path under
 * the existing config dir — no service-name suffix needed.
 */
export function credentialsFileForConfigDir(configDir: string | null | undefined): string {
  if (!configDir) return defaultCredentialsFilePath();
  return path.join(configDir, '.credentials.json');
}

/** Per-account API keys are kept in a separate file so a corrupted entry
 * doesn't poison OAuth state. Path matches the existing accountsDir layout
 * for symmetry, but the file is opaque to the snapshot tooling. */
function apiKeysFilePath(): string {
  return path.join(os.homedir(), '.claude-switch', 'apikeys.json');
}

/** Read+parse JSON from `file`. Returns `null` on absent / unreadable /
 * unparseable / wrong-shape — none of those are recoverable here and the
 * caller already handles a null token by prompting for a fresh login. */
function readJsonOrNull(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return null;
  } catch {
    // missing file, parse error, permission denied — all map to "no token"
    return null;
  }
}

function ensureParentDir(file: string): void {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // EEXIST is expected and harmless; anything else surfaces on the next
    // writeJsonAtomic, which has stronger error handling than we can add
    // here without leaking partial state.
  }
}

/**
 * Stable hash for legacy per-config-dir item lookups, kept so callers that
 * previously addressed an item by its Keychain service-name suffix still
 * have a way to reconstruct the path. Same algorithm as the deprecated
 * `claudeKeychainServiceFor` (NFC-normalised absolute path, SHA-256 first
 * 8 chars).
 */
export function configDirHash(configDir: string): string {
  const normalised = path.resolve(configDir).normalize('NFC');
  return createHash('sha256').update(normalised).digest('hex').substring(0, 8);
}

/**
 * Pure-fs adapter implementing `CredentialStore`. Cross-platform. No
 * external binary calls, no OS keyring, no dialogs.
 *
 * Security model documented honestly in SECURITY.md / README:
 *   - tokens at rest in `~/.claude/.credentials.json` (mode 0600, parent 0700)
 *   - protected against backups / cloud sync of the home dir only insofar
 *     as those tools respect file permissions
 *   - NOT protected against malicious processes running as the same user
 *   - matches the model of gh CLI, AWS CLI, npm, Docker
 */
export class FileCredentialStore implements CredentialStore {
  /**
   * Test-mode kill switch. The historical flag CLAUDE_SWITCH_DISABLE_KEYCHAIN=1
   * was set by the test runner to keep `npm test` from touching the developer's
   * real Keychain. Under Phase 24 file storage, the equivalent risk is writing
   * into the developer's real `~/.claude/.credentials.json` or
   * `~/.claude-switch/apikeys.json` during a test. Same flag, broader meaning:
   * "the store is disabled — behave as if nothing is persistent".
   *
   * Tests that exercise the real persistence path inject a temp-dir-backed
   * adapter via `deps.credentials` and don't need the flag.
   */
  private disabled(): boolean {
    return process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1';
  }

  available(): boolean {
    return !this.disabled();
  }

  readOAuth(): KeychainData | null {
    if (this.disabled()) return null;
    const data = readJsonOrNull(defaultCredentialsFilePath());
    if (!data) return null;
    // The on-disk shape is `{claudeAiOauth: {...}, mcpOAuth?: {...}}` — the
    // KeychainData interface. Pass through unchanged; downstream code already
    // accepts this exact shape (it's what the Keychain blob used to be).
    return data as KeychainData;
  }

  writeOAuth(data: KeychainData): void {
    if (this.disabled()) return;
    const file = defaultCredentialsFilePath();
    ensureParentDir(file);
    writeJsonAtomic(file, data);
  }

  readOAuthForConfigDir(configDir: string | null): KeychainData | null {
    if (this.disabled()) return null;
    if (!configDir) return this.readOAuth();
    const data = readJsonOrNull(credentialsFileForConfigDir(configDir));
    return data ? (data as KeychainData) : null;
  }

  writeOAuthForConfigDir(configDir: string | null, data: KeychainData, _trustedBins?: string[]): void {
    // _trustedBins was a Keychain-specific ACL hint (which binaries get
    // unprompted access). Irrelevant under file storage; argument kept on
    // the port for compatibility with the existing callers.
    if (this.disabled()) return;
    const file = credentialsFileForConfigDir(configDir);
    ensureParentDir(file);
    writeJsonAtomic(file, data);
  }

  deleteOAuthForConfigDir(configDir: string | null): boolean {
    if (this.disabled()) return false;
    const file = credentialsFileForConfigDir(configDir);
    try {
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      // ENOENT = nothing to delete = success-shaped. Anything else (EACCES,
      // EISDIR) propagates as "did not delete" so callers can surface it.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return false;
    }
  }

  readApiKey(email: string): string | null {
    if (this.disabled()) return null;
    if (!email) return null;
    const data = readJsonOrNull(apiKeysFilePath());
    if (!data) return null;
    const v = data[email];
    return typeof v === 'string' && v ? v : null;
  }

  writeApiKey(email: string, key: string): boolean {
    if (this.disabled()) return false;
    if (!email || !key) return false;
    const file = apiKeysFilePath();
    ensureParentDir(file);
    const current = readJsonOrNull(file) ?? {};
    current[email] = key;
    try {
      writeJsonAtomic(file, current);
      return true;
    } catch { // vault write failed → report not stored
      return false;
    }
  }

  deleteApiKey(email: string): boolean {
    if (this.disabled()) return false;
    if (!email) return false;
    const file = apiKeysFilePath();
    const current = readJsonOrNull(file);
    if (!current || !(email in current)) return false;
    delete current[email];
    try {
      writeJsonAtomic(file, current);
      return true;
    } catch { // vault write failed → report not removed
      return false;
    }
  }

  /** No-op under file storage — the Keychain item enumeration is meaningless
   * here. Kept on the port so the legacy `setup-keychain` command (deprecated
   * by Phase 24) still type-checks for the migration window. */
  listOAuthKeychainItems(): KeychainItemRef[] {
    return [];
  }

  /** No-op under file storage. The partition-list concept doesn't apply to
   * files. Returns `false` so any caller that asks "did you widen it?"
   * understands nothing happened — there was nothing to widen. */
  setPartitionList(_service: string, _account: string, _partitions: string): boolean {
    return false;
  }
}
