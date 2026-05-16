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
// as the OAuth tokens on those platforms (Claude Code itself stores
// tokens in `.claude.json` there, no system keyring), so consistency
// beats half-measures.
//
// Migration: on first read after upgrade, if the Keychain entry is
// missing but the JSON `_apiKey` field is present, copy to Keychain.
// The JSON field stays for one major as a fallback so a Keychain wipe
// (e.g. user deleted the entry manually) doesn't lose the key
// permanently — until v4 lands.

import { execFileSync } from 'node:child_process';

const SERVICE = 'claude-switch-apikey';

/** True when the host OS supports the Keychain backend. Only macOS for now.
 *  Honours `CLAUDE_SWITCH_DISABLE_KEYCHAIN=1` so the test suite (and any
 *  user who explicitly opts out) keeps the JSON-only behaviour. The env
 *  var is read on every call — tests flip it per-suite. */
export function keychainAvailable(): boolean {
  if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') {
    warnDisableKeychainOnce();
    return false;
  }
  return process.platform === 'darwin';
}

let disableWarnEmitted = false;
function warnDisableKeychainOnce(): void {
  if (disableWarnEmitted) return;
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.CLAUDE_SWITCH_TESTING === '1') return;
  disableWarnEmitted = true;
  process.stderr.write(
    '⚠ claude-switch: CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 is set — API-key Keychain is bypassed.\n' +
      '  This is meant for tests/sandboxes; unset it in your shell rc unless you know why.\n',
  );
}

/** Read an API key from the Keychain. Returns null if absent or on
 *  non-macOS. Does NOT throw on missing entries (the common case). */
export function readApiKeyFromKeychain(email: string): string | null {
  if (!keychainAvailable()) return null;
  if (!email) return null;
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', email, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    return raw || null;
  } catch {
    // Entry not found / Keychain locked / `security` missing — caller
    // falls back to the JSON path.
    return null;
  }
}

/** Write an API key to the Keychain. Throws on macOS errors so the
 *  caller can surface them; no-op on non-macOS so callers can call
 *  unconditionally and only fall through to JSON when this returns false. */
export function writeApiKeyToKeychain(email: string, key: string): boolean {
  if (!keychainAvailable()) return false;
  if (!email) throw new Error('writeApiKeyToKeychain requires a non-empty email');
  if (!key) throw new Error('writeApiKeyToKeychain requires a non-empty key');
  try {
    // -U upserts (create or update). Pipe stderr so we can surface a
    // useful diagnostic without including the key value in `e.message`.
    execFileSync(
      'security',
      ['add-generic-password', '-s', SERVICE, '-a', email, '-w', key, '-U'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return true;
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
    const detail = stderr ? `: ${stderr}` : '';
    throw new Error(
      `Failed to write API key to macOS Keychain${detail}. Make sure the keychain is unlocked.`,
    );
  }
}

/** Delete an API key from the Keychain. Returns true if an entry was
 *  removed, false if it didn't exist. No-op on non-macOS. */
export function deleteApiKeyFromKeychain(email: string): boolean {
  if (!keychainAvailable()) return false;
  if (!email) return false;
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-s', SERVICE, '-a', email],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}
