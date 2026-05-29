// src/account-paths.ts
// Pure naming + path-safety helpers for account snapshot files. Extracted from
// accounts.ts (in an earlier refactor) so both the domain (accounts.ts) and the
// AccountRepository adapter can depend on them without a circular import. No
// I/O lives here. accounts.ts re-exports both names, so existing importers are
// unaffected.

import path from 'node:path';

// Whitelist of characters allowed in account names. RFC 5321 email local-part
// can contain more than this, but accepting only [A-Za-z0-9._+@-] covers ~all
// real-world emails and blocks shell metacharacters ($, `, (, ), ;, &, |,
// space, newline, etc.) that would otherwise allow command injection through
// downstream consumers like shell completions (compgen -W).
const SAFE_EMAIL_CHARS = /^[A-Za-z0-9._+@-]+$/;

export function isSafeEmail(email: string): boolean {
  return SAFE_EMAIL_CHARS.test(email);
}

/**
 * Resolve `<email>.json` inside `accountsDirPath`, refusing any value that
 * escapes the directory (path traversal). Used by accounts.ts and apikey.ts
 * — both produce files in the same dir with the same naming scheme.
 */
export function resolvedAccountFile(email: string, accountsDirPath: string): string {
  const base = path.resolve(accountsDirPath);
  const resolved = path.resolve(accountsDirPath, `${email}.json`);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Email resolves outside accounts directory: ${email}`);
  }
  return resolved;
}
