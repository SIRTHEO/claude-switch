// src/apikey-keychain.ts
// macOS Keychain storage for per-account Anthropic API keys.
//
// API keys are billing-sensitive secrets that don't expire — leaving them
// as plaintext in `~/.claude/accounts/<email>.json` (mode 0600) was a
// considered tradeoff in v3.x but the wrong one. On macOS we now write
// them to the login Keychain under service "claude-switch-apikey" with
// the account email as the entry's account field.
//
// Linux/Windows continue to use the JSON `_apiKey` field — same lifecycle
// as the OAuth tokens on those platforms.
//
// As of Phase 20.7a the actual I/O lives in the CredentialStore port
// (`credential-store.ts`); this module is a thin delegator that preserves the
// historical public surface so existing importers are unaffected.

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
