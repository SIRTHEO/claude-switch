// src/account-repository.ts
// AccountRepository — the persistence seam for account snapshot files under
// the accounts directory. The domain (accounts.ts) owns the business logic
// (payload merge, api-key purge, claude.json reconciliation); this port owns
// only the on-disk reads/writes of `<email>.json`, so account flows can be
// tested with a fake instead of a real filesystem.
//
// FsAccountRepo is the production adapter. It keeps two security-load-bearing
// invariants from the original accounts.ts: every path goes through
// resolvedAccountFile (path-traversal guard) and load rejects symlinked
// account files. Writes go through writeJsonAtomic to preserve atomicity.
//
// Methods take `accountsDirPath` per call (no instance state) to mirror the
// other ports (HttpPort/ProcessPort/CredentialStore) and avoid binding an
// instance to a single directory.

import fs from 'node:fs';
import { resolvedAccountFile } from './account-paths.js';
import { writeJsonAtomic } from './atomic-write.js';
import { errnoCode } from './errors.js';

export interface AccountRepository {
  /** Raw filenames in the accounts dir, or [] if it can't be read. */
  list(accountsDirPath: string): string[];
  /** Parsed snapshot for `email`, or null when the file does not exist.
   *  Throws on parse errors and non-ENOENT fs errors. */
  read(email: string, accountsDirPath: string): Record<string, unknown> | null;
  /** Atomically write the snapshot payload for `email`. */
  write(email: string, accountsDirPath: string, payload: Record<string, unknown>): void;
  /** Delete `email`'s snapshot. Throws "No saved account for <email>" on ENOENT. */
  remove(email: string, accountsDirPath: string): void;
  /** Read a snapshot for the load() path: rejects symlinks and a missing file
   *  with explicit errors (security-critical). */
  loadRaw(email: string, accountsDirPath: string): Record<string, unknown>;
}

class FsAccountRepo implements AccountRepository {
  list(accountsDirPath: string): string[] {
    try {
      return fs.readdirSync(accountsDirPath);
    } catch {
      // ENOENT (first run, accounts dir not yet created) is the most common
      // path here; any other readdir failure (permission, I/O) is treated the
      // same — surface "no accounts" rather than crash a status read.
      return [];
    }
  }

  read(email: string, accountsDirPath: string): Record<string, unknown> | null {
    const file = resolvedAccountFile(email, accountsDirPath);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      if (errnoCode(e) === 'ENOENT') return null;
      throw e;
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  write(email: string, accountsDirPath: string, payload: Record<string, unknown>): void {
    writeJsonAtomic(resolvedAccountFile(email, accountsDirPath), payload);
  }

  remove(email: string, accountsDirPath: string): void {
    const file = resolvedAccountFile(email, accountsDirPath);
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (errnoCode(e) === 'ENOENT') {
        throw new Error(`No saved account for ${email}`);
      }
      throw e;
    }
  }

  loadRaw(email: string, accountsDirPath: string): Record<string, unknown> {
    const file = resolvedAccountFile(email, accountsDirPath);

    // Reject symlinks to prevent symlink-based file read attacks.
    const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!fileStat) {
      throw new Error(`No saved account for ${email}`);
    }
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Account file for ${email} is a symbolic link and cannot be trusted`);
    }

    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`${file} contains invalid JSON. Please fix or delete it.`);
      }
      throw e;
    }
  }
}

/** Production default: real filesystem under the accounts dir. */
export const fsAccountRepo: AccountRepository = new FsAccountRepo();
