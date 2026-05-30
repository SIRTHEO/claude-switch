// Advisory file lock for serializing read-modify-write on ~/.claude.json
// and the Keychain.
//
// Two `claude --as` invocations in parallel would otherwise race on the
// account swap and leave the JSON / Keychain out of sync. We use a simple
// O_CREAT|O_EXCL lock file that is removed on release.
//
// The lock is best-effort — if the holder process crashes without releasing,
// we detect stale locks by comparing the recorded PID and the file mtime,
// and reclaim them automatically after STALE_LOCK_MS.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { errnoCode } from './errors.js';

const STALE_LOCK_MS = 30_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 50;

function lockFilePath(accountsDirPath: string): string {
  return path.join(accountsDirPath, '.lock');
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM';
  }
}

function tryClaim(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if (errnoCode(e) === 'EEXIST') return false;
    throw e;
  }
  // Ensure the fd is always closed, even if writeSync throws (ENOSPC, EIO).
  // A leaked fd would persist for the rest of the process; the lock file
  // itself is fine — reclaimIfStale will recover it after STALE_LOCK_MS
  // since the partial PID won't resolve to a live process.
  try {
    fs.writeSync(fd, String(process.pid));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function reclaimIfStale(file: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch { // lock file vanished → nothing stale to reclaim
    return false;
  }
  const staleMtimeMs = stat.mtimeMs;
  let stalePid = 0;
  try {
    stalePid = parseInt(fs.readFileSync(file, 'utf-8').trim(), 10);
  } catch { /* unreadable */ }

  const stale = Date.now() - staleMtimeMs > STALE_LOCK_MS && (!stalePid || !isProcessAlive(stalePid));
  if (!stale) return false;

  // Claim the right to reclaim by atomically renaming the stale file to a
  // private tombstone. rename(2) is atomic: of N racers only one moves a
  // given path; every other gets ENOENT and falls back to the normal
  // acquire retry. This is what closes the documented double-claim race —
  // previously two processes could both `unlink(file)` after seeing the
  // same stale lock, the second deleting whatever fresh claim had landed in
  // between.
  const tomb = `${file}.stale.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    fs.renameSync(file, tomb);
  } catch {
    // Lost the rename race (someone else reclaimed it) or the file is gone.
    return false;
  }

  // Guard the stat→rename window: a competitor may have fully reclaimed the
  // stale lock AND written a FRESH claim before our rename ran, in which
  // case we just moved a live lock aside. Confirm the tombstone is byte-for
  // -byte the stale lock we judged (same mtime + pid); if not, restore it.
  let tombPid = 0;
  let tombMtimeMs = -1;
  try {
    tombMtimeMs = fs.statSync(tomb).mtimeMs;
    tombPid = parseInt(fs.readFileSync(tomb, 'utf-8').trim(), 10);
  } catch { /* unreadable; treat as not-matching below */ }

  if (tombMtimeMs === staleMtimeMs && tombPid === stalePid) {
    try { fs.unlinkSync(tomb); } catch { /* already gone */ }
    return true;
  }

  // Mis-grab: put the live lock back. POSIX rename clobbers atomically, so a
  // fourth racer that recreated `file` meanwhile would be overwritten — that
  // is benign for this advisory lock (release only unlinks, never reads the
  // pid, and the restored mtime stays fresh so no false reclaim follows).
  try {
    fs.renameSync(tomb, file);
  } catch {
    try { fs.unlinkSync(tomb); } catch { /* best-effort */ }
  }
  return false;
}

/**
 * Acquire an advisory lock on the accounts directory. Blocks (busy-wait
 * with sleep) until the lock is free or `timeoutMs` elapses.
 *
 * Returns a release function. Always call it in a finally block.
 */
export function acquireLock(
  accountsDirPath: string,
  timeoutMs: number = ACQUIRE_TIMEOUT_MS,
): () => void {
  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });
  const file = lockFilePath(accountsDirPath);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (tryClaim(file)) {
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      };
    }

    if (reclaimIfStale(file)) continue;

    if (Date.now() >= deadline) {
      throw new Error(
        `Could not acquire lock on ${file} within ${timeoutMs}ms — ` +
        'another claude-switch process may be running. ' +
        'If you are sure no other instance is active, delete the file manually.'
      );
    }

    // Busy wait with small sleep. We can't await here because callers are
    // synchronous. Atomics.wait on a SharedArrayBuffer is the standard
    // synchronous-sleep idiom for Node when setTimeout is unavailable.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_INTERVAL_MS);
  }
}

/**
 * Run `fn` while holding the accounts lock. Releases on both success and error.
 */
export function withLock<T>(accountsDirPath: string, fn: () => T): T {
  const release = acquireLock(accountsDirPath);
  try {
    return fn();
  } finally {
    release();
  }
}
