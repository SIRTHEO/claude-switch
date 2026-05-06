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
  resolveEffectiveAuthMode,
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

describe('resolveEffectiveAuthMode', () => {
  // 4-state matrix × 3 user choices. Resolution must be deterministic and
  // match the table documented in preferences.ts. This is the single
  // source of truth for what mode the proxy boots into; getting it wrong
  // is what causes "wrong account billed" incidents.

  it('auto + healthy OAuth + key → oauth-first', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'auto', oauthHealthy: true, hasApiKey: true }), 'oauth-first');
  });
  it('auto + healthy OAuth + no key → oauth-only', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'auto', oauthHealthy: true, hasApiKey: false }), 'oauth-only');
  });
  it('auto + dead OAuth + key → api-first', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'auto', oauthHealthy: false, hasApiKey: true }), 'api-first');
  });
  it('auto + dead OAuth + no key → error', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'auto', oauthHealthy: false, hasApiKey: false }), 'error');
  });

  it('explicit oauth-first + healthy + key → oauth-first', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'oauth-first', oauthHealthy: true, hasApiKey: true }), 'oauth-first');
  });
  it('explicit oauth-first + healthy + no key → oauth-only (degrades — no fallback path)', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'oauth-first', oauthHealthy: true, hasApiKey: false }), 'oauth-only');
  });
  it('explicit oauth-first + dead + key → api-first (degrades — token unusable)', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'oauth-first', oauthHealthy: false, hasApiKey: true }), 'api-first');
  });
  it('explicit oauth-first + dead + no key → error', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'oauth-first', oauthHealthy: false, hasApiKey: false }), 'error');
  });

  it('explicit api-first + dead + key → api-first', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'api-first', oauthHealthy: false, hasApiKey: true }), 'api-first');
  });
  it('explicit api-first + healthy + key → api-first (user intent honoured)', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'api-first', oauthHealthy: true, hasApiKey: true }), 'api-first');
  });
  it('explicit api-first + healthy + no key → oauth-only (degrades — no key to use)', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'api-first', oauthHealthy: true, hasApiKey: false }), 'oauth-only');
  });
  it('explicit api-first + dead + no key → error', () => {
    assert.equal(resolveEffectiveAuthMode({ authMode: 'api-first', oauthHealthy: false, hasApiKey: false }), 'error');
  });

  it('default authMode in resolveAccountPrefs is "auto"', () => {
    // Smoke against the default — guard against regressions where someone
    // changes the default to oauth-first/api-first thinking it's "more
    // explicit". Default MUST stay auto so installs upgrade transparently.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-default-auth-'));
    const dir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a@b.com.json'), JSON.stringify({ emailAddress: 'a@b.com' }));
    try {
      const prefs = resolveAccountPrefs('a@b.com', dir);
      assert.equal(prefs.authMode, 'auto');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
