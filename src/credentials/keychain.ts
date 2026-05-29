// src/keychain.ts
// OAuth-credential access for Claude Code, delegating to the CredentialStore
// port (`credential-store.ts`). Since v4.0.0 that port is the file vault by
// default on EVERY platform (tokens in `<configDir>/.credentials.json`); the
// macOS Keychain backend is opt-in only via CLAUDE_SWITCH_USE_KEYCHAIN=1.
// The wrappers below (readActiveCredentials, read/write/deleteProfileCredentials)
// are pure delegators that keep call sites short — the "keychain" in this
// file's name is legacy, not the backend.
//
// Service-name layout (only relevant on the opt-in Keychain path):
//   - Default config (`~/.claude`): service = `Claude Code-credentials`
//   - Profile config (any other CLAUDE_CONFIG_DIR): service =
//     `Claude Code-credentials-<sha256(configDir).hex.slice(0,8)>`
//
// The pure naming helpers and credential types are defined in the port module
// and re-exported here.

import { defaultCredentialStore } from './credential-store.js';

export type { ClaudeAiOauth, KeychainData } from './credential-store.js';
export { claudeKeychainAccount, claudeKeychainServiceFor } from './credential-store.js';

import type { KeychainData } from './credential-store.js';

export function readActiveCredentials(): KeychainData | null {
  return defaultCredentialStore.readOAuth();
}

/** Convenience read keyed by config dir + the canonical OS username. */
export function readProfileCredentials(configDir: string | null): KeychainData | null {
  return defaultCredentialStore.readOAuthForConfigDir(configDir);
}

/** Convenience write keyed by config dir + the canonical OS username.
 *  `trustedBins` is forwarded to the underlying ACL (`security -T <bin>`)
 *  so native binaries (e.g. real `claude`) can read the entry without
 *  interactive Keychain prompts. */
export function writeProfileCredentials(
  configDir: string | null,
  data: KeychainData,
  trustedBins: string[] = [],
): void {
  defaultCredentialStore.writeOAuthForConfigDir(configDir, data, trustedBins);
}

/** Convenience delete keyed by config dir + the canonical OS username. */
export function deleteProfileCredentials(configDir: string | null): boolean {
  return defaultCredentialStore.deleteOAuthForConfigDir(configDir);
}
