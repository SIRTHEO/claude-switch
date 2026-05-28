// src/profiles/profiles-read.ts
//
// Single-purpose reader for a `claude switch add` legacy account snapshot.
// Extracted from `profiles.ts` so `refresh-legacy-snapshot.ts` can consume it
// without a circular import. No I/O writes here; pure read + parse + guard.

import fs from 'node:fs';
import { isSafeEmail, resolvedAccountFile } from '../accounts/accounts.js';
import type { AccountSnapshot } from '../accounts/account-snapshot.js';
import { errMessage, errnoCode } from '../platform/errors.js';

/**
 * Read + parse a legacy account snapshot. Throws when the file is missing, a
 * symlink, not JSON, or not a JSON object. The open() + read-from-fd shape
 * closes the TOCTOU window CodeQL's `js/file-system-race` flagged: the old
 * `lstatSync(path)` then `readFileSync(path)` pair could be swapped between
 * the check and the use. We use `O_NOFOLLOW` so the kernel refuses to open
 * a symlink atomically (ELOOP) — no separate symlink check to race against —
 * then read from the file descriptor we already hold, which can't be
 * substituted under us. Symlink rejection matters because the snapshot
 * directory is mode-700 and we don't want an attacker who can write into it
 * to redirect a read to an arbitrary file on disk.
 */
export function readLegacyAccount(email: string, accountsDirPath: string): AccountSnapshot {
  // Reject anything that isn't a safe email up front so we never feed a
  // raw `../../etc/passwd` into `path.join`. Mirrors the guard that
  // `accounts.ts` applies on its read/write paths.
  if (!email || !isSafeEmail(email)) {
    throw new Error(`Email contains characters unsafe for filenames: ${email}`);
  }
  const file = resolvedAccountFile(email, accountsDirPath);

  // O_NOFOLLOW is POSIX (defined on Linux + macOS); on Windows it's absent
  // from fs.constants and we fall back to plain O_RDONLY. Windows ACLs and
  // the lack of unprivileged symlinks make the symlink-substitution vector
  // far weaker there anyway — this is honest best-effort, not a regression.
  const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ENOENT') {
      throw new Error(`No saved account for ${email}. List accounts with: claude switch list`);
    }
    if (code === 'ELOOP') {
      // O_NOFOLLOW + symlink → ELOOP. Same user-facing message as the old
      // lstat-based guard so any test depending on it still matches.
      throw new Error(`Account file for ${email} is a symbolic link and cannot be trusted`);
    }
    throw new Error(`Cannot open ${file}: ${errMessage(e)}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(fd, 'utf-8');
  } finally {
    // Close in finally so a parse-throw still releases the fd.
    try { fs.closeSync(fd); } catch { /* nothing actionable on close failure */ }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${errMessage(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain an object.`);
  }
  return parsed as AccountSnapshot;
}
