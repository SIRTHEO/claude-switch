import fs from 'node:fs';

export interface TokenHealth {
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

export function getTokenHealth(claudeJsonPath: string): TokenHealth {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch {
    return { status: 'missing' };
  }

  const account = data.oauthAccount as Record<string, unknown> | undefined;
  if (!account) return { status: 'missing' };
  if (!account.accessToken) return { status: 'missing' };

  const rawExpiry = account.expiresAt;
  if (rawExpiry === undefined || rawExpiry === null) {
    return { status: 'present' };
  }

  let expiresAt: Date;
  if (typeof rawExpiry === 'number') {
    expiresAt = new Date(rawExpiry);
  } else if (typeof rawExpiry === 'string') {
    expiresAt = new Date(rawExpiry);
  } else {
    return { status: 'present' };
  }

  if (isNaN(expiresAt.getTime())) return { status: 'present' };

  const diffMs = expiresAt.getTime() - Date.now();
  const expiresIn = formatRelativeTime(diffMs);

  if (diffMs > 0) {
    return { status: 'valid', expiresAt, expiresIn };
  }
  return { status: 'expired', expiresAt, expiresIn };
}
