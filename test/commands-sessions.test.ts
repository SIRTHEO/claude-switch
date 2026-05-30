// test/commands-sessions.test.ts
// Coverage for `claude switch sessions [--json]` (src/commands/sessions.ts).
// Liveness is injected (isAlive: () => true) so seeded pids count as live
// without depending on real processes; storage is an isolated tmp dir.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleSessions } from '../src/commands/sessions.js';
import { type LiveSession, recordSession } from '../src/sessions/session-registry.js';

const ALIVE = { isAlive: () => true };
const NOW = 1_000_000;

function capture(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

const SESSION = (over: Partial<LiveSession> = {}): LiveSession => ({
  pid: 100,
  account: 'sirtheo.personal@example.com',
  configDir: null,
  isolated: false,
  cwd: '/tmp/work',
  startedAt: NOW - 5000,
  ...over,
});

describe('handleSessions', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cmd-sessions-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--json emits [] when no sessions are tracked', () => {
    const out = capture(() => handleSessions({ accountsDirPath: dir }, { json: true }, { ...ALIVE, now: () => NOW }));
    assert.equal(out.trim(), '[]');
  });

  it('--json emits the live session array', () => {
    recordSession(dir, SESSION({ pid: 1, account: 'a@x.com' }), ALIVE);
    const out = capture(() => handleSessions({ accountsDirPath: dir }, { json: true }, { ...ALIVE, now: () => NOW }));
    const parsed = JSON.parse(out.trim()) as LiveSession[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.account, 'a@x.com');
  });

  it('human mode reports the empty case', () => {
    const out = capture(() => handleSessions({ accountsDirPath: dir }, { json: false }, { ...ALIVE, now: () => NOW }));
    assert.match(out, /No live claude sessions tracked/);
  });

  it('human mode lists each session with its scope', () => {
    recordSession(dir, SESSION({ pid: 1, account: 'a@x.com', isolated: false }), ALIVE);
    recordSession(dir, SESSION({ pid: 2, account: 'b@x.com', isolated: true }), ALIVE);
    const out = capture(() => handleSessions({ accountsDirPath: dir }, { json: false }, { ...ALIVE, now: () => NOW }));
    assert.match(out, /a@x\.com — global/);
    assert.match(out, /b@x\.com — isolated/);
  });

  it('warns when ≥2 accounts run GLOBAL-bound at once (mixing hazard)', () => {
    recordSession(dir, SESSION({ pid: 1, account: 'a@x.com', isolated: false }), ALIVE);
    recordSession(dir, SESSION({ pid: 2, account: 'b@x.com', isolated: false }), ALIVE);
    const out = capture(() => handleSessions({ accountsDirPath: dir }, { json: false }, { ...ALIVE, now: () => NOW }));
    assert.match(out, /running GLOBAL-bound at once/);
    assert.match(out, /a@x\.com, b@x\.com/);
  });

  it('does NOT warn when the two sessions are different-account but isolated', () => {
    recordSession(dir, SESSION({ pid: 1, account: 'a@x.com', isolated: true }), ALIVE);
    recordSession(dir, SESSION({ pid: 2, account: 'b@x.com', isolated: false }), ALIVE);
    const out = capture(() => handleSessions({ accountsDirPath: dir }, { json: false }, { ...ALIVE, now: () => NOW }));
    assert.doesNotMatch(out, /running GLOBAL-bound at once/);
  });
});
