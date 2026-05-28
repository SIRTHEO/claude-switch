// src/profiles/profiles-read.ts
//
// Single-purpose reader for a `claude switch add` legacy account snapshot.
// Extracted from `profiles.ts` so `refresh-legacy-snapshot.ts` can consume it
// without a circular import. No I/O writes here; pure read + parse + guard.

import fs from 'node:fs';
import { isSafeEmail, resolvedAccountFile } from '../accounts/accounts.js';
import type { AccountSnapshot } from '../accounts/account-snapshot.js';
import { errMessage } from '../platform/errors.js';

/**
 * Read + parse a legacy account snapshot. Throws when the file is missing, a
 * symlink, not JSON, or not a JSON object. Symlink rejection is a security
 * guard — the snapshot directory is mode-700 and we don't want an attacker
 * who can write into it to redirect a read to an arbitrary file on disk.
 */
export function readLegacyAccount(email: string, accountsDirPath: string): AccountSnapshot {
  // Reject anything that isn't a safe email up front so we never feed a
  // raw `../../etc/passwd` into `path.join`. Mirrors the guard that
  // `accounts.ts` applies on its read/write paths.
  if (!email || !isSafeEmail(email)) {
    throw new Error(`Email contains characters unsafe for filenames: ${email}`);
  }
  const file = resolvedAccountFile(email, accountsDirPath);

  // Reject symlinks before opening — a local attacker who can write into
  // ~/.claude/accounts/ could otherwise plant a symlink to an arbitrary
  // file and have us parse it as account data. Same defence applied by
  // `accounts.load`.
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`No saved account for ${email}. List accounts with: claude switch list`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Account file for ${email} is a symbolic link and cannot be trusted`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${errMessage(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain an object.`);
  }
  return parsed as AccountSnapshot;
}
