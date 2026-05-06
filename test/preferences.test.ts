// test/preferences.test.ts
// Locks the global + per-account preference contracts:
//   - smart defaults are ON when no file exists
//   - writes round-trip
//   - per-account `_prefs` is preserved across save() rewrites
//   - resolveAccountPrefs falls back to globals when the override is unset

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { save } from '../src/accounts.js';
import {
  DEFAULT_GLOBAL_PREFS,
  readGlobalPrefs,
  writeGlobalPrefs,
  readStoredAccountPrefs,
  writeStoredAccountPrefs,
  resolveAccountPrefs,
} from '../src/preferences.js';

describe('global preferences', () => {
  let tmpDir: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prefs-'));
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns smart defaults (all true) when no prefs file exists', () => {
    const prefs = readGlobalPrefs(accDir);
    assert.deepEqual(prefs, DEFAULT_GLOBAL_PREFS);
    for (const v of Object.values(prefs)) assert.equal(v, true);
  });

  it('write/read round-trip', () => {
    writeGlobalPrefs(accDir, { refreshUsageOnEntry: false });
    assert.equal(readGlobalPrefs(accDir).refreshUsageOnEntry, false);
    // Other defaults stay ON.
    assert.equal(readGlobalPrefs(accDir).useAltBuffer, true);
  });

  it('partial write merges with existing values', () => {
    writeGlobalPrefs(accDir, { useAltBuffer: false });
    writeGlobalPrefs(accDir, { hideManualProfileOps: false });
    const after = readGlobalPrefs(accDir);
    assert.equal(after.useAltBuffer, false);
    assert.equal(after.hideManualProfileOps, false);
    // Untouched defaults remain ON.
    assert.equal(after.refreshUsageOnEntry, true);
  });

  it('falls back to defaults on malformed file', () => {
    fs.writeFileSync(path.join(accDir, '.user-prefs.json'), '{not json');
    assert.deepEqual(readGlobalPrefs(accDir), DEFAULT_GLOBAL_PREFS);
  });
});

describe('per-account preferences', () => {
  let tmpDir: string;
  let claudeJson: string;
  let accDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-acct-prefs-'));
    claudeJson = path.join(tmpDir, '.claude.json');
    accDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
    // Seed an account file so the prefs API has somewhere to write.
    fs.writeFileSync(path.join(accDir, 'work@example.com.json'), JSON.stringify({
      emailAddress: 'work@example.com',
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty stored prefs when none set', () => {
    assert.deepEqual(readStoredAccountPrefs('work@example.com', accDir), {});
  });

  it('write/read round-trip on stored prefs', () => {
    writeStoredAccountPrefs('work@example.com', accDir, { autoLaunchOnSwitch: false });
    assert.deepEqual(readStoredAccountPrefs('work@example.com', accDir), { autoLaunchOnSwitch: false });
  });

  it('resolveAccountPrefs falls back to globals when override is unset', () => {
    writeGlobalPrefs(accDir, { defaultAutoLaunchOnSwitch: false });
    const resolved = resolveAccountPrefs('work@example.com', accDir);
    assert.equal(resolved.autoLaunchOnSwitch, false);
    assert.equal(resolved.autoFlipFallback, true); // global default still ON
    assert.equal(resolved.defaultIsolated, false);  // no global counterpart
  });

  it('resolveAccountPrefs honours explicit override over global default', () => {
    writeGlobalPrefs(accDir, { defaultAutoLaunchOnSwitch: false });
    writeStoredAccountPrefs('work@example.com', accDir, { autoLaunchOnSwitch: true });
    const resolved = resolveAccountPrefs('work@example.com', accDir);
    assert.equal(resolved.autoLaunchOnSwitch, true, 'per-account override beats global default');
  });

  it('accounts.save() preserves _prefs across rewrites', () => {
    writeStoredAccountPrefs('work@example.com', accDir, { defaultIsolated: true });
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: 'work@example.com' },
    }));
    save('work@example.com', claudeJson, accDir);
    const after = JSON.parse(fs.readFileSync(path.join(accDir, 'work@example.com.json'), 'utf-8'));
    assert.deepEqual(after._prefs, { defaultIsolated: true });
  });
});
