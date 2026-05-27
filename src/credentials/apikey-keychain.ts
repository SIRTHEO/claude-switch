// src/apikey-keychain.ts
// Thin delegators for per-account Anthropic API key storage, kept under this
// historical filename + `*Keychain` names so existing importers are unaffected.
//
// The actual I/O lives in the CredentialStore port (`credential-store.ts`).
// Since Phase 24 the default store is the cross-platform file vault
// (`~/.claude-switch/apikeys.json`, mode 0600) on every OS; the macOS Keychain
// backend is selected only under CLAUDE_SWITCH_USE_KEYCHAIN=1. So despite the
// names, these functions no longer touch the Keychain on the default path.
//
// CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 still disables the store entirely (used by
// the test suite and by users who explicitly opt out); the env var is read on
// every call so tests can flip it per-suite.

import { defaultCredentialStore } from './credential-store.js';

/** True when the host OS supports the Keychain backend. Only macOS for now.
 *  Honours `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` so the test suite (and any
 *  user who explicitly opts out) keeps the JSON-only behaviour. The env
 *  var is read on every call — tests flip it per-suite. */
export function keychainAvailable(): boolean {
  return defaultCredentialStore.available();
}

/** Read an API key from the Keychain. Returns null if absent or on
 *  non-macOS. Does NOT throw on missing entries (the common case). */
export function readApiKeyFromKeychain(email: string): string | null {
  return defaultCredentialStore.readApiKey(email);
}

/** Write an API key to the Keychain. Throws on macOS errors so the
 *  caller can surface them; no-op on non-macOS so callers can call
 *  unconditionally and only fall through to JSON when this returns false. */
export function writeApiKeyToKeychain(email: string, key: string): boolean {
  return defaultCredentialStore.writeApiKey(email, key);
}

/** Delete an API key from the Keychain. Returns true if an entry was
 *  removed, false if it didn't exist. No-op on non-macOS. */
export function deleteApiKeyFromKeychain(email: string): boolean {
  return defaultCredentialStore.deleteApiKey(email);
}
