import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireLock, withLock } from '../src/platform/lock.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lock-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('creates the lock file with the current pid', () => {
    const release = acquireLock(dir);
    try {
      const lockFile = path.join(dir, '.lock');
      assert.ok(fs.existsSync(lockFile));
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      assert.strictEqual(pid, process.pid);
    } finally {
      release();
    }
  });

  it('release removes the lock file', () => {
    const release = acquireLock(dir);
    release();
    assert.strictEqual(fs.existsSync(path.join(dir, '.lock')), false);
  });

  it('release is idempotent', () => {
    const release = acquireLock(dir);
    release();
    release();
    assert.strictEqual(fs.existsSync(path.join(dir, '.lock')), false);
  });

  it('throws when timeout exceeded with active lock holder', () => {
    // Create a lock that points to our own pid (definitely alive) and is fresh
    fs.writeFileSync(path.join(dir, '.lock'), String(process.pid));
    assert.throws(() => acquireLock(dir, 200), /Could not acquire lock/);
  });

  it('reclaims stale lock from a dead pid', () => {
    // PID 1 on macOS/Linux is launchd/init — never matches our user, so kill(1, 0) throws ESRCH or EPERM.
    // Use a high PID we control with a backdated mtime to be safe.
    const lockFile = path.join(dir, '.lock');
    fs.writeFileSync(lockFile, '999999');
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, oldTime, oldTime);
    const release = acquireLock(dir, 1000);
    try {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      assert.strictEqual(pid, process.pid);
    } finally {
      release();
    }
  });
});

describe('withLock', () => {
  it('runs the callback and releases on success', () => {
    const result = withLock(dir, () => 'ok');
    assert.strictEqual(result, 'ok');
    assert.strictEqual(fs.existsSync(path.join(dir, '.lock')), false);
  });

  it('releases on error', () => {
    assert.throws(() => withLock(dir, () => { throw new Error('boom'); }), /boom/);
    assert.strictEqual(fs.existsSync(path.join(dir, '.lock')), false);
  });
});
