import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFallbackEnabled, setFallbackEnabled } from '../src/fallback.js';

describe('fallback toggle', () => {
  let tmpDir: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fb-'));
    accDir = path.join(tmpDir, 'accounts');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is off by default', () => {
    assert.equal(isFallbackEnabled(accDir), false);
  });

  it('is on after enable', () => {
    setFallbackEnabled(accDir, true);
    assert.equal(isFallbackEnabled(accDir), true);
  });

  it('is off after enable then disable', () => {
    setFallbackEnabled(accDir, true);
    setFallbackEnabled(accDir, false);
    assert.equal(isFallbackEnabled(accDir), false);
  });

  it('disabling without prior enable does not throw', () => {
    assert.doesNotThrow(() => setFallbackEnabled(accDir, false));
  });

  it('creates accounts dir when enabling', () => {
    setFallbackEnabled(accDir, true);
    assert.ok(fs.existsSync(accDir));
  });

  it('marker file has 0o600 perms (unix)', () => {
    if (process.platform === 'win32') return;
    setFallbackEnabled(accDir, true);
    const stat = fs.statSync(path.join(accDir, '.fallback-enabled'));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});
