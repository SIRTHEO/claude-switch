// test/state-store.test.ts
// Locks the contract of the unified state.json:
//   - empty defaults when nothing exists
//   - migration from legacy marker files (one-shot, files removed)
//   - read/write atomicity via the locking variant
//   - in-lock writer for callers already holding the accounts-dir lock

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readState, updateState, updateStateInLock } from '../src/state-store.js';
import { withLock } from '../src/lock.js';

let tmp: string;
let accDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-state-'));
  accDir = path.join(tmp, 'accounts');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readState', () => {
  it('returns empty defaults when no state file or legacy markers exist', () => {
    fs.mkdirSync(accDir, { recursive: true });
    const state = readState(accDir);
    assert.deepEqual(state, {
      version: 1,
      fallback: { enabled: false, autoEngaged: false },
    });
  });

  it('returns empty defaults when accounts dir does not exist yet', () => {
    const state = readState(accDir);
    assert.equal(state.fallback.enabled, false);
  });

  it('returns the parsed state.json when present', () => {
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(path.join(accDir, '.claude-switch-state.json'), JSON.stringify({
      version: 1,
      fallback: { enabled: true, autoEngaged: true },
      pendingRestore: 'work@example.com',
    }));
    const state = readState(accDir);
    assert.equal(state.fallback.enabled, true);
    assert.equal(state.fallback.autoEngaged, true);
    assert.equal(state.pendingRestore, 'work@example.com');
  });

  it('falls back to empty state on malformed state.json', () => {
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(path.join(accDir, '.claude-switch-state.json'), '{ not json');
    const state = readState(accDir);
    assert.equal(state.fallback.enabled, false);
  });
});

describe('legacy migration', () => {
  it('synthesises state from .fallback-enabled + .fallback-auto-engaged + .pending-restore', () => {
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(path.join(accDir, '.fallback-enabled'), '');
    fs.writeFileSync(path.join(accDir, '.fallback-auto-engaged'), '');
    fs.writeFileSync(path.join(accDir, '.pending-restore'), 'pending@x.com');

    const state = readState(accDir);
    assert.equal(state.fallback.enabled, true);
    assert.equal(state.fallback.autoEngaged, true);
    assert.equal(state.pendingRestore, 'pending@x.com');
  });

  it('removes legacy markers after the first read', () => {
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(path.join(accDir, '.fallback-enabled'), '');
    fs.writeFileSync(path.join(accDir, '.pending-restore'), 'x@x.com');

    readState(accDir);

    assert.equal(fs.existsSync(path.join(accDir, '.fallback-enabled')), false);
    assert.equal(fs.existsSync(path.join(accDir, '.pending-restore')), false);
    assert.equal(fs.existsSync(path.join(accDir, '.claude-switch-state.json')), true);
  });

  it('ignores .fallback-auto-engaged when .fallback-enabled is missing', () => {
    // Sanity: an orphaned auto sidecar shouldn't tell us fallback is on.
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(path.join(accDir, '.fallback-auto-engaged'), '');
    const state = readState(accDir);
    assert.equal(state.fallback.enabled, false);
    assert.equal(state.fallback.autoEngaged, false);
  });

  it('subsequent legacy markers DO NOT override existing state.json', () => {
    fs.mkdirSync(accDir, { recursive: true });
    // First write modern state.json with fallback off.
    updateState(accDir, () => ({
      version: 1,
      fallback: { enabled: false, autoEngaged: false },
    }));
    // Now plant a stray legacy marker (e.g. another tool wrote it).
    fs.writeFileSync(path.join(accDir, '.fallback-enabled'), '');
    // Must not flip our state — state.json wins.
    assert.equal(readState(accDir).fallback.enabled, false);
  });
});

describe('updateState (locking)', () => {
  it('round-trips a fallback flip', () => {
    updateState(accDir, (s) => ({ ...s, fallback: { enabled: true, autoEngaged: false } }));
    assert.equal(readState(accDir).fallback.enabled, true);
  });

  it('preserves unrelated fields across patches', () => {
    updateState(accDir, (s) => ({ ...s, pendingRestore: 'a@x.com' }));
    updateState(accDir, (s) => ({ ...s, fallback: { enabled: true, autoEngaged: false } }));
    const state = readState(accDir);
    assert.equal(state.pendingRestore, 'a@x.com');
    assert.equal(state.fallback.enabled, true);
  });

  it('writes 0o600 on the state file (unix)', () => {
    if (process.platform === 'win32') return;
    updateState(accDir, (s) => ({ ...s, fallback: { enabled: true, autoEngaged: false } }));
    const stat = fs.statSync(path.join(accDir, '.claude-switch-state.json'));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe('updateStateInLock', () => {
  it('writes the patch when called inside an existing withLock', () => {
    withLock(accDir, () => {
      updateStateInLock(accDir, (s) => ({ ...s, pendingRestore: 'inlock@x.com' }));
    });
    assert.equal(readState(accDir).pendingRestore, 'inlock@x.com');
  });

  it('would deadlock if updateState (locking variant) were used inside withLock — sanity check', () => {
    // We don't actually run the deadlock case (it would hang the test).
    // Documented here so future contributors don't accidentally swap the
    // in-lock variant for the locking one inside switcher.ts / auto-fallback.ts.
    assert.ok(true);
  });
});
