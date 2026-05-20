// src/keychain.ts
// macOS Keychain access for Claude Code credentials.
//
// Service-name layout:
//   - Default config (`~/.claude`): service = `Claude Code-credentials`
//   - Profile config (any other CLAUDE_CONFIG_DIR): service =
//     `Claude Code-credentials-<sha256(configDir).hex.slice(0,8)>`
//
// Account-name layout:
//   - Newer Claude Code (≥2.x): `process.env.USER || os.userInfo().username`
//   - Legacy Claude Code (<2.x): the service name itself
//
// claude-switch ≤3.4.x stored profile credentials at the default
// service under the profile's userID. That worked for read-back via our
// own status checks but real claude refused them once it switched to
// the per-config-dir service-name scheme. The helpers below expose the
// production layout so profile imports/recoveries write where claude
// actually looks.
//
// On non-macOS platforms every entry-point is a no-op (tokens live in
// the JSON file there).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

const SERVICE = 'Claude Code-credentials';

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

// Newer versions use the OS username; legacy versions used the service name.
function candidateAccounts(): string[] {
  return [os.userInfo().username, SERVICE];
}

export function readKeychain(): KeychainData | null {
  if (process.platform !== 'darwin') return null;
  // Honour the same disable flag the write paths use, so test fixtures
  // that opt out of Keychain don't leak the developer's REAL tokens
  // through this read into a test assertion.
  if (process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1') return null;

  for (const account of candidateAccounts()) {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
        { stdio: ['ignore', 'pipe', 'ignore'] }
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

export function writeKeychain(data: KeychainData): void {
  writeKeychainAt(candidateAccounts()[0]!, data);
}

/**
 * Write to a specific Keychain entry (account field). Used for profiles:
 * each profile has its own userID which becomes the account field, so we
 * can import a saved account's tokens into the profile's distinct entry.
 *
 * On non-darwin platforms this is a no-op (tokens live in the JSON file
 * there, no Keychain involved).
 */
function writeKeychainAt(account: string, data: KeychainData): void {
  writeKeychainAtService(SERVICE, account, data);
}

/**
 * Lower-level write helper that lets callers target a specific service
 * AND account. Used to land profile entries on the per-config-dir
 * service Claude Code derives from the CLAUDE_CONFIG_DIR path.
 */
function writeKeychainAtService(
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
    execFileSync(
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

function readKeychainAtService(service: string, account: string): KeychainData | null {
  if (process.platform !== 'darwin') return null;
  if (!account) return null;
  try {
    const raw = execFileSync(
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

function deleteKeychainAtService(service: string, account: string): boolean {
  if (process.platform !== 'darwin') return false;
  if (!account) return false;
  try {
    execFileSync('security', ['delete-generic-password', '-s', service, '-a', account], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
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
  if (!configDir) return SERVICE;
  // claude resolves CLAUDE_CONFIG_DIR with `.normalize("NFC")` on the
  // raw string — Unicode normalization only. No `path.normalize`,
  // `path.resolve`, or `realpath`. We mirror that exactly so an
  // absolute profile path (which is what we always pass internally)
  // hashes identically here and inside claude's binary. Side effect:
  // `/foo/./bar` and `/foo/bar` would hash *differently* — callers
  // must pass the same canonical path the spawn will receive.
  const normalised = configDir.normalize('NFC');
  const hash = createHash('sha256').update(normalised).digest('hex').substring(0, 8);
  return `${SERVICE}-${hash}`;
}

/** Convenience read keyed by config dir + the canonical OS username. */
export function readKeychainForConfigDir(configDir: string | null): KeychainData | null {
  return readKeychainAtService(claudeKeychainServiceFor(configDir), claudeKeychainAccount());
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
  writeKeychainAtService(
    claudeKeychainServiceFor(configDir),
    claudeKeychainAccount(),
    data,
    trustedBins,
  );
}

/** Convenience delete keyed by config dir + the canonical OS username. */
export function deleteKeychainForConfigDir(configDir: string | null): boolean {
  return deleteKeychainAtService(claudeKeychainServiceFor(configDir), claudeKeychainAccount());
}
