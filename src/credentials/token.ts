import fs from 'node:fs';
import { readKeychain } from './keychain.js';

interface TokenHealth {
  status: 'valid' | 'expired' | 'present' | 'missing';
  expiresAt?: Date;
  expiresIn?: string;
}

function formatRelativeTime(diffMs: number): string {
  const absDiff = Math.abs(diffMs);
  const minutes = Math.floor(absDiff / 60000);
  const hours = Math.floor(absDiff / 3600000);
  const days = Math.floor(absDiff / 86400000);
  const suffix = diffMs > 0 ? '' : ' ago';
  const prefix = diffMs > 0 ? 'in ' : '';

  if (days > 0) return `${prefix}${days} day${days > 1 ? 's' : ''}${suffix}`;
  if (hours > 0) return `${prefix}${hours} hour${hours > 1 ? 's' : ''}${suffix}`;
  return `${prefix}${minutes} minute${minutes !== 1 ? 's' : ''}${suffix}`;
}

function healthFromExpiry(accessToken: string | undefined, rawExpiry: unknown): TokenHealth {
  if (!accessToken) return { status: 'missing' };

  if (rawExpiry === undefined || rawExpiry === null) {
    return { status: 'present' };
  }

  let expiresAt: Date;
  if (typeof rawExpiry === 'number') {
    // Milliseconds epoch (Claude Code's format)
    expiresAt = new Date(rawExpiry);
  } else if (typeof rawExpiry === 'string') {
    expiresAt = new Date(rawExpiry);
  } else {
    return { status: 'present' };
  }

  if (Number.isNaN(expiresAt.getTime())) return { status: 'present' };

  const diffMs = expiresAt.getTime() - Date.now();
  const expiresIn = formatRelativeTime(diffMs);

  return diffMs > 0
    ? { status: 'valid', expiresAt, expiresIn }
    : { status: 'expired', expiresAt, expiresIn };
}

export function getTokenHealth(
  claudeJsonPath: string,
  keychainReader: () => ReturnType<typeof readKeychain> = readKeychain,
): TokenHealth {
  // On macOS, tokens live in the Keychain — not in ~/.claude.json.
  const keychainData = keychainReader();
  if (keychainData?.claudeAiOauth) {
    const { accessToken, expiresAt } = keychainData.claudeAiOauth;
    return healthFromExpiry(accessToken, expiresAt);
  }

  // Fallback: Linux / Windows may store tokens inside ~/.claude.json.
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    const account = data.oauthAccount as Record<string, unknown> | undefined;
    if (!account) return { status: 'missing' };
    return healthFromExpiry(
      account.accessToken as string | undefined,
      account.expiresAt
    );
  } catch { // unreadable/malformed token data → report missing
    return { status: 'missing' };
  }
}
