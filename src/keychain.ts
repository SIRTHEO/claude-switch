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
  if (process.platform !== 'darwin') return;

  const account = candidateAccounts()[0]; // always write to the primary (username) account
  execFileSync(
    'security',
    ['add-generic-password', '-s', SERVICE, '-a', account, '-w', JSON.stringify(data), '-U'],
    { stdio: 'ignore' }
  );
}
