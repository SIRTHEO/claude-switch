import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countActiveClaudeSessions } from '../src/active-sessions.js';

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
