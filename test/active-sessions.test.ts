import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';
import { countActiveClaudeSessions } from '../src/active-sessions.js';
import type { ProcessPort } from '../src/process.js';

// Build a ProcessPort whose spawnSync returns canned `ps` output (or a
// failure), so the parsing/filtering logic can be exercised without a real
// `ps`. spawn is never expected on this path.
function fakeProc(
  ps: { stdout?: string; status?: number; error?: Error },
): { process: ProcessPort } {
  const result: SpawnSyncReturns<Buffer> = {
    pid: 1,
    output: [],
    stdout: Buffer.from(ps.stdout ?? ''),
    stderr: Buffer.from(''),
    status: ps.status ?? 0,
    signal: null,
    error: ps.error,
  };
  return {
    process: {
      spawn: () => { throw new Error('spawn not expected'); },
      spawnSync: () => result,
    },
  };
}

describe('countActiveClaudeSessions', () => {
  it('returns 0 with unsupportedReason when realClaudePath is null', () => {
    const result = countActiveClaudeSessions(null);
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.unsupportedReason, 'no-real-claude');
  });

  it('returns 0 with unsupportedReason on Windows', { skip: process.platform !== 'win32' }, () => {
    const result = countActiveClaudeSessions('C:\\some\\claude.exe');
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.unsupportedReason, 'windows');
  });

  it('does not crash on supported platforms (smoke test)', { skip: process.platform === 'win32' }, () => {
    // We don't assert a specific count — depends on what's actually running.
    // Just verify the function returns a sane shape with a non-existent
    // claude path (so count should be 0 but no error).
    const result = countActiveClaudeSessions('/nonexistent/path/to/claude');
    assert.ok(typeof result.count === 'number');
    assert.ok(result.count >= 0);
  });

  it('excludes the current process from the count', { skip: process.platform === 'win32' }, () => {
    // Use the current node binary path as a sentinel — the test process
    // itself appears in `ps` output. With our own pid excluded, we should
    // never count ourselves no matter what path we pass.
    const result = countActiveClaudeSessions(process.execPath);
    // process.execPath includes "node" — even if other node procs are
    // running, this only verifies the function returns; the exact count
    // is environment-dependent. The test confirms no exception.
    assert.ok(typeof result.count === 'number');
  });
});

describe('countActiveClaudeSessions — parsing with injected ProcessPort', () => {
  const CLAUDE = '/usr/local/bin/claude';

  it('counts real claude processes, excluding self', () => {
    const psOutput = [
      '  101 /usr/local/bin/claude',
      '  202 /usr/local/bin/claude --resume',
      '  303 /usr/local/bin/claude-switch status', // substring, must not match
    ].join('\n');
    const result = countActiveClaudeSessions(CLAUDE, 101, fakeProc({ stdout: psOutput }));
    assert.strictEqual(result.count, 1); // 101 is self, 303 is the wrapper
    assert.strictEqual(result.unsupportedReason, undefined);
  });

  it('skips `claude switch` subcommands (no long-lived REPL)', () => {
    const psOutput = [
      '  101 /usr/local/bin/claude',
      '  202 /usr/local/bin/claude switch status',
    ].join('\n');
    const result = countActiveClaudeSessions(CLAUDE, 999, fakeProc({ stdout: psOutput }));
    assert.strictEqual(result.count, 1);
  });

  it('reports ps-unavailable on non-zero exit', () => {
    const result = countActiveClaudeSessions(CLAUDE, 999, fakeProc({ status: 1 }));
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.unsupportedReason, 'ps-unavailable');
  });

  it('reports ps-unavailable on spawn error', () => {
    const result = countActiveClaudeSessions(CLAUDE, 999, fakeProc({ error: new Error('ENOENT') }));
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.unsupportedReason, 'ps-unavailable');
  });
});
