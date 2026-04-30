// src/keychain.ts
// macOS Keychain access for Claude Code credentials.
// Claude Code stores OAuth tokens in the login keychain under service
// "Claude Code-credentials". The account field is the OS username (newer
// versions) or the service name itself (legacy format).
// On non-macOS platforms this module is a no-op.

import { execFileSync } from 'node:child_process';
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
  writeKeychainAt(candidateAccounts()[0], data);
}

/**
 * Write to a specific Keychain entry (account field). Used for profiles:
 * each profile has its own userID which becomes the account field, so we
 * can import a saved account's tokens into the profile's distinct entry.
 *
 * On non-darwin platforms this is a no-op (tokens live in the JSON file
 * there, no Keychain involved).
 */
export function writeKeychainAt(account: string, data: KeychainData): void {
  if (process.platform !== 'darwin') return;
  if (!account) throw new Error('writeKeychainAt requires a non-empty account name');
  try {
    execFileSync(
      'security',
      ['add-generic-password', '-s', SERVICE, '-a', account, '-w', JSON.stringify(data), '-U'],
      // Capture stderr separately so we can surface diagnostics without
      // re-throwing Node's default error.message — which embeds argv,
      // and our argv contains the OAuth tokens.
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
    const detail = stderr ? `: ${stderr}` : '';
    throw new Error(
      `Failed to write to macOS Keychain${detail}. Make sure the keychain is unlocked.`
    );
  }
}
