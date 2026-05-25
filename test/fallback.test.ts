import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFallbackEnabled, isFallbackAutoEngaged, setFallbackEnabled } from '../src/fallback/fallback.js';

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

  it('state file has 0o600 perms (unix)', () => {
    if (process.platform === 'win32') return;
    setFallbackEnabled(accDir, true);
    const stat = fs.statSync(path.join(accDir, '.claude-switch-state.json'));
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('migrates legacy .fallback-enabled marker on first read', () => {
    fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
    // Simulate a v3.3 install with the old marker file present.
    fs.writeFileSync(path.join(accDir, '.fallback-enabled'), '');
    // Also place the auto-engage sidecar.
    fs.writeFileSync(path.join(accDir, '.fallback-auto-engaged'), '');
    // First read after upgrade should: see the markers, build state.json
    // from them, delete the legacy files.
    assert.equal(isFallbackEnabled(accDir), true);
    assert.equal(isFallbackAutoEngaged(accDir), true);
    assert.ok(fs.existsSync(path.join(accDir, '.claude-switch-state.json')));
    assert.equal(fs.existsSync(path.join(accDir, '.fallback-enabled')), false, 'legacy marker removed');
    assert.equal(fs.existsSync(path.join(accDir, '.fallback-auto-engaged')), false, 'legacy auto marker removed');
  });
});

describe('isFallbackAutoEngaged', () => {
  let tmpDir: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fb-auto-'));
    accDir = path.join(tmpDir, 'accounts');
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns false when fallback is off', () => {
    assert.equal(isFallbackAutoEngaged(accDir), false);
  });

  it('returns false when fallback is manually on (no auto marker)', () => {
    setFallbackEnabled(accDir, true);
    assert.equal(isFallbackAutoEngaged(accDir), false);
  });

  it('returns true when set with byAutoEngage', () => {
    setFallbackEnabled(accDir, true, { byAutoEngage: true });
    assert.equal(isFallbackAutoEngaged(accDir), true);
    assert.equal(isFallbackEnabled(accDir), true);
  });

  it('clears the auto marker when manually flipped on (user intent overrides)', () => {
    setFallbackEnabled(accDir, true, { byAutoEngage: true });
    assert.equal(isFallbackAutoEngaged(accDir), true);
    // User explicitly toggles ON — same physical state but "manual" semantics.
    setFallbackEnabled(accDir, true);
    assert.equal(isFallbackEnabled(accDir), true);
    assert.equal(isFallbackAutoEngaged(accDir), false);
  });

  it('clears both flags when disabled', () => {
    setFallbackEnabled(accDir, true, { byAutoEngage: true });
    setFallbackEnabled(accDir, false);
    assert.equal(isFallbackEnabled(accDir), false);
    assert.equal(isFallbackAutoEngaged(accDir), false);
  });
});
