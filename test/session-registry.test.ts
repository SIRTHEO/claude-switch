// test/session-registry.test.ts
// Coverage for the live-session registry: pure shaping (prune / upsert /
// makeSession / globalBoundSessions) and the fs round-trip (record / read /
// remove / self-healing list). Liveness is injected so the suite never
// depends on real pids; storage uses an isolated tmp dir so it never reads
// the developer's real ~/.claude state.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type LiveSession,
  globalBoundSessions,
  listLiveSessions,
  makeSession,
  markSessionLive,
  pruneList,
  readRaw,
  recordSession,
  removeSession,
  upsertList,
} from '../src/sessions/session-registry.js';

const ENTRY = (over: Partial<LiveSession> = {}): LiveSession => ({
  pid: 100,
  account: 'sirtheo.personal@example.com',
  configDir: null,
  isolated: false,
  cwd: '/tmp/work',
  startedAt: 1,
  ...over,
});

describe('session-registry — pure shaping', () => {
  it('pruneList drops entries whose pid is not alive', () => {
    const list = [ENTRY({ pid: 1 }), ENTRY({ pid: 2 }), ENTRY({ pid: 3 })];
    const alive = (pid: number) => pid !== 2;
    const out = pruneList(list, alive);
    assert.deepEqual(out.map((s) => s.pid), [1, 3]);
  });

  it('upsertList replaces an existing entry for the same pid (no duplicates)', () => {
    const list = [ENTRY({ pid: 1, account: 'a@x.com' })];
    const out = upsertList(list, ENTRY({ pid: 1, account: 'b@x.com' }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.account, 'b@x.com');
  });

  it('upsertList appends a new pid', () => {
    const out = upsertList([ENTRY({ pid: 1 })], ENTRY({ pid: 2 }));
    assert.deepEqual(out.map((s) => s.pid).sort(), [1, 2]);
  });

  it('makeSession derives isolated=false when configDir equals the global default', () => {
    const s = makeSession({
      pid: 5,
      account: 'a@x.com',
      configDir: '/home/u/.claude',
      globalConfigDir: '/home/u/.claude',
      cwd: '/w',
      startedAt: 1,
    });
    assert.equal(s.isolated, false);
  });

  it('makeSession derives isolated=true for a distinct config dir', () => {
    const s = makeSession({
      pid: 5,
      account: 'a@x.com',
      configDir: '/home/u/.claude/profiles/work',
      globalConfigDir: '/home/u/.claude',
      cwd: '/w',
      startedAt: 1,
    });
    assert.equal(s.isolated, true);
  });

  it('makeSession treats a null configDir as global-bound', () => {
    const s = makeSession({
      pid: 5,
      account: null,
      configDir: null,
      globalConfigDir: '/home/u/.claude',
      cwd: '/w',
      startedAt: 1,
    });
    assert.equal(s.isolated, false);
  });

  it('globalBoundSessions returns only the non-isolated entries', () => {
    const list = [
      ENTRY({ pid: 1, isolated: false }),
      ENTRY({ pid: 2, isolated: true }),
      ENTRY({ pid: 3, isolated: false }),
    ];
    assert.deepEqual(globalBoundSessions(list).map((s) => s.pid), [1, 3]);
  });
});

describe('session-registry — fs round-trip', () => {
  let dir: string;
  const allAlive = { isAlive: () => true };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sessions-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readRaw returns [] when the registry file is absent', () => {
    assert.deepEqual(readRaw(dir), []);
  });

  it('readRaw returns [] on a corrupt registry file', () => {
    fs.writeFileSync(path.join(dir, '.sessions.json'), '{ not json');
    assert.deepEqual(readRaw(dir), []);
  });

  it('readRaw drops malformed entries but keeps well-shaped ones', () => {
    fs.writeFileSync(
      path.join(dir, '.sessions.json'),
      JSON.stringify([ENTRY({ pid: 1 }), { pid: 'nope' }, { junk: true }]),
    );
    assert.deepEqual(readRaw(dir).map((s) => s.pid), [1]);
  });

  it('recordSession persists an entry and round-trips through readRaw', () => {
    recordSession(dir, ENTRY({ pid: 42 }), allAlive);
    const out = readRaw(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.pid, 42);
  });

  it('recordSession prunes dead pids in the same write', () => {
    recordSession(dir, ENTRY({ pid: 1 }), allAlive);
    // pid 1 is now "dead"; recording pid 2 should drop pid 1.
    recordSession(dir, ENTRY({ pid: 2 }), { isAlive: (pid) => pid === 2 });
    assert.deepEqual(readRaw(dir).map((s) => s.pid), [2]);
  });

  it('removeSession deletes one entry by pid', () => {
    recordSession(dir, ENTRY({ pid: 1 }), allAlive);
    recordSession(dir, ENTRY({ pid: 2 }), allAlive);
    removeSession(dir, 1);
    assert.deepEqual(readRaw(dir).map((s) => s.pid), [2]);
  });

  it('the registry file is written with mode 0600', () => {
    recordSession(dir, ENTRY({ pid: 1 }), allAlive);
    const mode = fs.statSync(path.join(dir, '.sessions.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('listLiveSessions prunes dead pids and self-heals the file', () => {
    fs.writeFileSync(
      path.join(dir, '.sessions.json'),
      JSON.stringify([ENTRY({ pid: 1 }), ENTRY({ pid: 2 }), ENTRY({ pid: 3 })]),
    );
    const live = listLiveSessions(dir, { isAlive: (pid) => pid === 2 });
    assert.deepEqual(live.map((s) => s.pid), [2]);
    // self-heal: the on-disk file now reflects the pruned set.
    assert.deepEqual(readRaw(dir).map((s) => s.pid), [2]);
  });
});

describe('session-registry — markSessionLive', () => {
  let home: string;
  let accountsDir: string;
  let origCcd: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-marklive-'));
    accountsDir = path.join(home, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    origCcd = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => {
    if (origCcd === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origCcd;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('records THIS process as a global-bound session when configDir is null', () => {
    markSessionLive(accountsDir, { account: 'a@x.com', configDir: null, cwd: '/w' });
    const out = readRaw(accountsDir);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.pid, process.pid);
    assert.equal(out[0]!.account, 'a@x.com');
    assert.equal(out[0]!.isolated, false);
  });

  it('marks the entry isolated when configDir differs from the global home', () => {
    const profileDir = path.join(home, '.claude', 'profiles', 'work');
    markSessionLive(accountsDir, { account: 'a@x.com', configDir: profileDir, cwd: '/w' });
    assert.equal(readRaw(accountsDir)[0]!.isolated, true);
  });

  it('never throws on an unwritable accounts dir (best-effort)', () => {
    assert.doesNotThrow(() =>
      markSessionLive(path.join(home, 'does', 'not', 'exist'), {
        account: 'a@x.com',
        configDir: null,
        cwd: '/w',
      }),
    );
  });
});
