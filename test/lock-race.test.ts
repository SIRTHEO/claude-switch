import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock } from '../src/platform/lock.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lockrace-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Deterministic guards for the reclaim primitive.
describe('reclaimIfStale primitive (via acquireLock)', () => {
  it('reclaims a stale lock and leaves no tombstone behind', () => {
    const lockFile = path.join(dir, '.lock');
    fs.writeFileSync(lockFile, '999999'); // dead pid
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);

    const release = acquireLock(dir, 1000);
    try {
      assert.strictEqual(parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10), process.pid);
      // The rename-based reclaim must clean up its `.stale.*` tombstone.
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.stale.'));
      assert.deepStrictEqual(leftovers, [], `tombstone left behind: ${leftovers.join(', ')}`);
    } finally {
      release();
    }
  });

  it('does NOT reclaim a fresh lock even if its pid is dead', () => {
    // Recent mtime → not stale regardless of pid liveness. Acquire must time
    // out rather than steal the lock.
    fs.writeFileSync(path.join(dir, '.lock'), '999999');
    assert.throws(() => acquireLock(dir, 200), /Could not acquire lock/);
  });
});

// Real multi-process contention. The GREEN direction is reliable: correct
// mutual exclusion never reports a double occupancy. The test pre-stages a
// stale lock so every worker starts in reclaim contention — the exact window
// of the race this fix closes.
describe('lock — concurrent reclaim contention', () => {
  it('never grants two holders at once under N-process contention', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
    const worker = fileURLToPath(new URL('./_helpers/lock-race-worker.js', import.meta.url));
    const N = 8;
    const ITERS = 40;

    // Pre-stage a stale lock: all workers see it stale on their first acquire
    // and race to reclaim it simultaneously.
    const lockFile = path.join(dir, '.lock');
    fs.writeFileSync(lockFile, '999999');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);
    fs.writeFileSync(path.join(dir, '.witness'), '');

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        new Promise<{ doubles: number; acquired: number }>((resolve, reject) => {
          const child = fork(worker, [dir, String(ITERS)], { stdio: 'ignore' });
          let msg: { doubles: number; acquired: number } | null = null;
          child.on('message', (m) => { msg = m as { doubles: number; acquired: number }; });
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code !== 0 && code !== null) reject(new Error(`worker exited ${code}`));
            else resolve(msg ?? { doubles: 0, acquired: 0 });
          });
        }),
      ),
    );

    const totalDoubles = results.reduce((s, r) => s + r.doubles, 0);
    const totalAcquired = results.reduce((s, r) => s + r.acquired, 0);
    assert.strictEqual(totalDoubles, 0, `detected ${totalDoubles} double-ownership events`);
    // Sanity: the workers actually exercised the lock (not all timed out).
    assert.ok(totalAcquired > 0, 'no worker ever acquired the lock — test exercised nothing');
  });
});
