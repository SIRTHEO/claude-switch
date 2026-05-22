// src/credential-store.ts
// CredentialStore — the single seam for the secrets the domain needs: Claude
// Code's OAuth Keychain blobs (service "Claude Code-credentials" and its
// per-config-dir variants) AND per-account Anthropic API keys (service
// "claude-switch-apikey"). KeychainAdapter is the production darwin
// implementation over the `security` CLI; NoopCredentialStore is every other
// platform, where credentials live in plain JSON instead. `defaultCredentialStore`
// picks the adapter by platform once at load — `process.platform` is static.
//
// Extracted from keychain.ts + apikey-keychain.ts (Phase 20.7a) WITHOUT
// behaviour change. The bodies are transcribed verbatim, which means two
// load-bearing details are preserved deliberately:
//   1. CLAUDE_SWITCH_DISABLE_KEYCHAIN is read on EVERY call (the test suite
//      flips it per-suite at runtime), never cached at construction.
//   2. The two distinct "Keychain bypassed" warnings (OAuth vs API-key) and
//      their once-per-process latches are kept separate — collapsing them
//      would change the number of warnings emitted, which is observable.
// Only one adapter is instantiated per process, so the per-instance warning
// latches reproduce the previous module-global behaviour exactly.
//
// keychain.ts / apikey-keychain.ts now delegate their public functions here;
// the pure naming helpers (claudeKeychainAccount / claudeKeychainServiceFor)
// and the credential types live here and are re-exported there so existing
// importers are unaffected.

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

const OAUTH_SERVICE = 'Claude Code-credentials';
const APIKEY_SERVICE = 'claude-switch-apikey';

/**
 * The slice of `execFileSync` the Keychain adapter needs. A narrow type so a
 * test can inject a fake `security` runner without casts. Production passes
 * the real `execFileSync` (the constructor default).
 */
export type SecurityExec = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptions,
) => Buffer | string;

export interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | string;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface KeychainData {
  claudeAiOauth?: ClaudeAiOauth;
  mcpOAuth?: Record<string, unknown>;
}

// Newer Claude Code uses the OS username; legacy versions used the service name.
function candidateAccounts(): string[] {
  return [os.userInfo().username, OAUTH_SERVICE];
}

/**
 * The OS-username account field claude v2.x uses for OAuth lookups.
 * Mirrors the binary's `uV()` helper: prefer `process.env.USER`, fall
 * back to `os.userInfo().username`, and substitute "claude-code-user"
 * if neither yields a value that looks like a unix username.
 */
export function claudeKeychainAccount(): string {
  let name: string;
  try {
    name = process.env.USER || os.userInfo().username;
  } catch {
    name = 'claude-code-user';
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
}

/**
 * Compute the Keychain service name claude v2.x uses for the given
 * config dir. With CLAUDE_CONFIG_DIR unset (the default ~/.claude
 * case) the service is just `Claude Code-credentials`. With any other
 * config dir, an 8-char SHA-256 prefix of the absolute path is
 * appended. Path normalisation matches claude's: NFC-normalised
 * absolute path. The empty-string sentinel means "treat as default".
 */
export function claudeKeychainServiceFor(configDir: string | null | undefined): string {
  if (!configDir) return OAUTH_SERVICE;
  // claude resolves CLAUDE_CONFIG_DIR with `.normalize("NFC")` on the
  // raw string — Unicode normalization only. No `path.normalize`,
  // `path.resolve`, or `realpath`. We mirror that exactly so an
  // absolute profile path (which is what we always pass internally)
  // hashes identically here and inside claude's binary. Side effect:
  // `/foo/./bar` and `/foo/bar` would hash *differently* — callers
  // must pass the same canonical path the spawn will receive.
  const normalised = configDir.normalize('NFC');
  const hash = createHash('sha256').update(normalised).digest('hex').substring(0, 8);
  return `${OAUTH_SERVICE}-${hash}`;
}

export interface CredentialStore {
  // OAuth Keychain blobs (was keychain.ts)
  readOAuth(): KeychainData | null;
  writeOAuth(data: KeychainData): void;
  readOAuthForConfigDir(configDir: string | null): KeychainData | null;
  writeOAuthForConfigDir(configDir: string | null, data: KeychainData, trustedBins?: string[]): void;
  deleteOAuthForConfigDir(configDir: string | null): boolean;
  // Per-account API keys (was apikey-keychain.ts)
  available(): boolean;
  readApiKey(email: string): string | null;
  writeApiKey(email: string, key: string): boolean;
  deleteApiKey(email: string): boolean;
}

/** Production adapter over the macOS `security` CLI. */
export class KeychainAdapter implements CredentialStore {
  // Once-per-process warning latches. Kept separate (and with distinct
  // messages) because OAuth and API-key bypass are reported independently;
  // see the file header.
  private oauthWarned = false;
  private apiKeyWarned = false;

  // The `security` shell-out is injectable so tests can drive the adapter
  // without touching the real Keychain. Production uses node's execFileSync.
  constructor(private readonly exec: SecurityExec = execFileSync) {}

  // --- OAuth ---------------------------------------------------------------

  private warnOAuthBypass(): void {
    if (this.oauthWarned) return;
    if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN !== '1') return;
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.CLAUDE_SWITCH_TESTING === '1') return;
    this.oauthWarned = true;
    process.stderr.write(
      '⚠ claude-switch: CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 is set — Keychain is bypassed.\n' +
        '  This is meant for tests/sandboxes; unset it in your shell rc unless you know why.\n',
    );
  }

  readOAuth(): KeychainData | null {
    if (process.platform !== 'darwin') return null;
    // Honour the same disable flag the write paths use, so test fixtures
    // that opt out of Keychain don't leak the developer's REAL tokens
    // through this read into a test assertion.
    if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') {
      this.warnOAuthBypass();
      return null;
    }

    for (const account of candidateAccounts()) {
      try {
        const raw = this.exec(
          'security',
          ['find-generic-password', '-s', OAUTH_SERVICE, '-a', account, '-w'],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        ).toString().trim();
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed as KeychainData;
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  writeOAuth(data: KeychainData): void {
    this.writeOAuthAtService(OAUTH_SERVICE, candidateAccounts()[0]!, data);
  }

  readOAuthForConfigDir(configDir: string | null): KeychainData | null {
    return this.readOAuthAtService(claudeKeychainServiceFor(configDir), claudeKeychainAccount());
  }

  writeOAuthForConfigDir(configDir: string | null, data: KeychainData, trustedBins: string[] = []): void {
    this.writeOAuthAtService(claudeKeychainServiceFor(configDir), claudeKeychainAccount(), data, trustedBins);
  }

  deleteOAuthForConfigDir(configDir: string | null): boolean {
    return this.deleteOAuthAtService(claudeKeychainServiceFor(configDir), claudeKeychainAccount());
  }

  private writeOAuthAtService(
    service: string,
    account: string,
    data: KeychainData,
    trustedBins: string[] = [],
  ): void {
    if (process.platform !== 'darwin') return;
    if (!account) throw new Error('writeKeychain requires a non-empty account name');
    // Build ACL: include /usr/bin/security (so our own CLI keeps read access)
    // plus any provided trusted binaries (typically the real `claude` binary
    // so the native Mach-O app can read its own Keychain entry without an
    // interactive prompt). Without -T the entry's ACL is bound only to the
    // creating process, causing claude to silently fall back to OAuth login.
    const aclArgs: string[] = ['-T', '/usr/bin/security'];
    for (const bin of trustedBins) {
      if (bin) aclArgs.push('-T', bin);
    }
    try {
      this.exec(
        'security',
        [
          'add-generic-password',
          '-s', service,
          '-a', account,
          '-w', JSON.stringify(data),
          ...aclArgs,
          '-U',
        ],
        // Capture stderr separately so we can surface diagnostics without
        // re-throwing Node's default error.message — which embeds argv,
        // and our argv contains the OAuth tokens.
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
      const detail = stderr ? `: ${stderr}` : '';
      throw new Error(
        `Failed to write to macOS Keychain${detail}. Make sure the keychain is unlocked.`,
      );
    }
  }

  private readOAuthAtService(service: string, account: string): KeychainData | null {
    if (process.platform !== 'darwin') return null;
    if (!account) return null;
    try {
      const raw = this.exec(
        'security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString().trim();
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as KeychainData;
      }
    } catch {
      /* not present / locked / not JSON */
    }
    return null;
  }

  private deleteOAuthAtService(service: string, account: string): boolean {
    if (process.platform !== 'darwin') return false;
    if (!account) return false;
    try {
      this.exec('security', ['delete-generic-password', '-s', service, '-a', account], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  }

  // --- API key -------------------------------------------------------------

  private warnApiKeyBypass(): void {
    if (this.apiKeyWarned) return;
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.CLAUDE_SWITCH_TESTING === '1') return;
    this.apiKeyWarned = true;
    process.stderr.write(
      '⚠ claude-switch: CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 is set — API-key Keychain is bypassed.\n' +
        '  This is meant for tests/sandboxes; unset it in your shell rc unless you know why.\n',
    );
  }

  available(): boolean {
    if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') {
      this.warnApiKeyBypass();
      return false;
    }
    return process.platform === 'darwin';
  }

  readApiKey(email: string): string | null {
    if (!this.available()) return null;
    if (!email) return null;
    try {
      const raw = this.exec(
        'security',
        ['find-generic-password', '-s', APIKEY_SERVICE, '-a', email, '-w'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString().trim();
      return raw || null;
    } catch {
      // Entry not found / Keychain locked / `security` missing — caller
      // falls back to the JSON path.
      return null;
    }
  }

  writeApiKey(email: string, key: string): boolean {
    if (!this.available()) return false;
    if (!email) throw new Error('writeApiKeyToKeychain requires a non-empty email');
    if (!key) throw new Error('writeApiKeyToKeychain requires a non-empty key');
    try {
      // -U upserts (create or update). Pipe stderr so we can surface a
      // useful diagnostic without including the key value in `e.message`.
      this.exec(
        'security',
        ['add-generic-password', '-s', APIKEY_SERVICE, '-a', email, '-w', key, '-U'],
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

  deleteApiKey(email: string): boolean {
    if (!this.available()) return false;
    if (!email) return false;
    try {
      this.exec(
        'security',
        ['delete-generic-password', '-s', APIKEY_SERVICE, '-a', email],
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Non-macOS adapter: credentials live in the plain JSON files there, so every
 * Keychain operation is a no-op. `available()` still emits the API-key bypass
 * warning under the disable flag to match the previous keychainAvailable()
 * ordering (flag checked before platform).
 */
export class NoopCredentialStore implements CredentialStore {
  private apiKeyWarned = false;

  readOAuth(): KeychainData | null { return null; }
  writeOAuth(): void { /* tokens live in JSON off-darwin */ }
  readOAuthForConfigDir(): KeychainData | null { return null; }
  writeOAuthForConfigDir(): void { /* no-op */ }
  deleteOAuthForConfigDir(): boolean { return false; }

  available(): boolean {
    if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') {
      if (!this.apiKeyWarned && process.env.NODE_ENV !== 'test' && process.env.CLAUDE_SWITCH_TESTING !== '1') {
        this.apiKeyWarned = true;
        process.stderr.write(
          '⚠ claude-switch: CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 is set — API-key Keychain is bypassed.\n' +
            '  This is meant for tests/sandboxes; unset it in your shell rc unless you know why.\n',
        );
      }
      return false;
    }
    return false;
  }

  readApiKey(): string | null { return null; }
  writeApiKey(): boolean { return false; }
  deleteApiKey(): boolean { return false; }
}

/**
 * Composition default: pick the adapter by platform at load. `process.platform`
 * is fixed for the process lifetime, so this selection is safe to cache (the
 * DISABLE flag, which tests flip at runtime, is read per-call inside the
 * adapters, not here).
 */
export const defaultCredentialStore: CredentialStore =
  process.platform === 'darwin' ? new KeychainAdapter() : new NoopCredentialStore();
