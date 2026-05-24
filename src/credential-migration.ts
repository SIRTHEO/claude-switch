// src/credential-migration.ts
// Phase 24 one-shot migration: copy Claude Code's existing Keychain OAuth
// item (and per-config-dir items for known profiles) into the file vault
// once. After that, claude-switch never touches the Keychain again.
//
// Design notes:
//   - Idempotent. A marker file `~/.claude-switch/.migration-v4.json` records
//     completion so a re-run is a no-op.
//   - Best-effort. If the Keychain read raises (item missing, ACL stricter
//     than expected, user dismisses the dialog), we leave the file vault
//     empty and rely on the user's next `/login` to populate it via Claude
//     Code itself.
//   - Skipped under CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 (test mode), and on
//     non-darwin (no Keychain to migrate).
//   - Does NOT delete the Keychain item afterwards. Claude Code may still
//     prefer to read from it on macOS; leaving the item in place lets the
//     two sources coexist until a future release decides to clean up.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KeychainAdapter, type CredentialStore, type KeychainData } from './credential-store.js';
import { FileCredentialStore, defaultCredentialsFilePath } from './file-credential-store.js';
import { writeJsonAtomic } from './atomic-write.js';

interface MigrationMarker {
  migratedAt: string; // ISO-8601 epoch
  migratedFrom: 'keychain' | 'none';
  /** Filenames touched during the migration, for audit. No tokens, no PII. */
  files: string[];
}

function markerPath(): string {
  return path.join(os.homedir(), '.claude-switch', '.migration-v4.json');
}

/**
 * Returns true if the v4 file-vault migration has already run on this machine.
 * The marker file is the single source of truth.
 */
export function isMigrated(markerFile: string = markerPath()): boolean {
  try {
    const raw = fs.readFileSync(markerFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return !!(parsed && typeof parsed === 'object' && 'migratedAt' in parsed);
  } catch {
    return false;
  }
}

/**
 * Run the one-shot Keychain → file-vault migration. Idempotent.
 *
 * Pseudocode:
 *   if marker present → no-op return
 *   if disable flag / non-darwin → write marker as 'none' (nothing to do)
 *   else try to read Keychain via the legacy adapter:
 *     if blob present + parses → write file vault, marker = 'keychain'
 *     else → marker = 'none' (Claude Code will repopulate on next /login)
 *
 * Returns true when a migration actually copied tokens, false otherwise
 * (already-done, no-op platform, no source data).
 *
 * `deps` is for tests: inject a fake KeychainAdapter that returns canned
 * data without ever touching the real `security` binary.
 */
export function runFileVaultMigration(deps?: {
  legacy?: CredentialStore;
  fileStore?: FileCredentialStore;
  markerFile?: string;
  now?: () => Date;
}): boolean {
  const markerFile = deps?.markerFile ?? markerPath();
  if (isMigrated(markerFile)) return false;

  const now = (deps?.now ?? (() => new Date()))();
  const filesTouched: string[] = [];

  // Refuse to migrate under the test-mode disable flag or off darwin.
  // Both write the marker as 'none' so we don't re-attempt on every run.
  if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1' || process.platform !== 'darwin') {
    writeMarker(markerFile, {
      migratedAt: now.toISOString(),
      migratedFrom: 'none',
      files: [],
    });
    return false;
  }

  // The file vault adapter we'll write into. Default = production singleton
  // but tests inject a temp-dir-backed instance.
  const fileStore = deps?.fileStore ?? new FileCredentialStore();
  const legacy = deps?.legacy ?? new KeychainAdapter();

  let migratedTokens = false;
  try {
    const blob = legacy.readOAuth();
    if (typeof blob?.claudeAiOauth?.accessToken === 'string') {
      fileStore.writeOAuth(blob as KeychainData);
      filesTouched.push(defaultCredentialsFilePath());
      migratedTokens = true;
    }
  } catch {
    // Keychain read raised (ACL strict, item missing). Fall through to
    // 'none' marker — the user's next /login will populate the file vault
    // via Claude Code's own write path.
  }

  writeMarker(markerFile, {
    migratedAt: now.toISOString(),
    migratedFrom: migratedTokens ? 'keychain' : 'none',
    files: filesTouched,
  });
  return migratedTokens;
}

function writeMarker(file: string, marker: MigrationMarker): void {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(file, marker);
  } catch {
    // Marker write failed (disk full / read-only fs / permission). The
    // migration won't be retried until a successful marker write — that's
    // acceptable. The next /login through Claude Code will populate the
    // file vault anyway; the marker is only useful to avoid a redundant
    // Keychain prompt, not for correctness.
  }
}
