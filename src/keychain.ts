// src/keychain.ts
// macOS Keychain access for Claude Code OAuth credentials.
//
// Service-name layout:
//   - Default config (`~/.claude`): service = `Claude Code-credentials`
//   - Profile config (any other CLAUDE_CONFIG_DIR): service =
//     `Claude Code-credentials-<sha256(configDir).hex.slice(0,8)>`
//
// As of Phase 20.7a the actual I/O lives in the CredentialStore port
// (`credential-store.ts`); this module is a thin delegator that preserves the
// historical public surface so existing importers are unaffected. The pure
// naming helpers and credential types are defined in the port module and
// re-exported here.
//
// On non-macOS platforms every entry-point is a no-op (tokens live in the JSON
// file there) — that is the NoopCredentialStore the default selects.

import { defaultCredentialStore } from './credential-store.js';

export type { ClaudeAiOauth, KeychainData } from './credential-store.js';
export { claudeKeychainAccount, claudeKeychainServiceFor } from './credential-store.js';

import type { KeychainData } from './credential-store.js';

export function readKeychain(): KeychainData | null {
  return defaultCredentialStore.readOAuth();
}

/** Convenience read keyed by config dir + the canonical OS username. */
export function readKeychainForConfigDir(configDir: string | null): KeychainData | null {
  return defaultCredentialStore.readOAuthForConfigDir(configDir);
}

/** Convenience write keyed by config dir + the canonical OS username.
 *  `trustedBins` is forwarded to the underlying ACL (`security -T <bin>`)
 *  so native binaries (e.g. real `claude`) can read the entry without
 *  interactive Keychain prompts. */
export function writeKeychainForConfigDir(
  configDir: string | null,
  data: KeychainData,
  trustedBins: string[] = [],
): void {
  defaultCredentialStore.writeOAuthForConfigDir(configDir, data, trustedBins);
}

/** Convenience delete keyed by config dir + the canonical OS username. */
export function deleteKeychainForConfigDir(configDir: string | null): boolean {
  return defaultCredentialStore.deleteOAuthForConfigDir(configDir);
}
