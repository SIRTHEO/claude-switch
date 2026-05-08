// test/ui/run-app.test.ts
// Coverage push on src/ui/run-app.ts — the orchestrator loop's
// internal handlers. Production wires them through `runApp()` (which
// owns the alt-buffer + signal lifecycle); tests skip that envelope
// and exercise each handler's I/O contract against a tmpdir fixture.
//
// Branches that require Ink-interactive sub-screens (runApikeyScreen,
// runRemoveAccountScreen, runProfilesScreen, runConfirm) are NOT
// covered here — they need a deeper harness that drives stdin into
// child Ink trees synchronously. Those paths are exercised by the
// dedicated screen-level tests + the manual smoke checklist.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _internal } from '../../src/ui/run-app.js';
import { save as saveAccount } from '../../src/accounts.js';
import { setFallbackEnabled } from '../../src/fallback.js';
import { setApiKey } from '../../src/apikey.js';
import { writeGlobalPrefs } from '../../src/preferences.js';

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
  email: string;
}

function setup(activeEmail = 'a@b.com'): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-runapp-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: activeEmail } }));
  saveAccount(activeEmail, claudeJson, accDir);
  return { tmpDir, claudeJson, accDir, email: activeEmail };
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────
// refreshUsageOnEntry
// ────────────────────────────────────────────────────────────────────

describe('_internal.refreshUsageOnEntry', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('no-ops when refreshUsageOnEntry pref is off', async () => {
    writeGlobalPrefs(h.accDir, { refreshUsageOnEntry: false });
    // The function returns silently — we assert it doesn't throw or
    // touch the cache. No-op is the contract.
    await _internal.refreshUsageOnEntry(h.claudeJson, h.accDir);
    assert.equal(fs.existsSync(path.join(h.accDir, '.usage-cache.json')), false,
      'refreshUsageOnEntry must not write a cache when the pref is off');
  });

  it('no-ops when no active account is set', async () => {
    fs.writeFileSync(h.claudeJson, '{}');
    await _internal.refreshUsageOnEntry(h.claudeJson, h.accDir);
    assert.ok(true, 'refreshUsageOnEntry survives an empty claude.json');
  });

  it('no-ops when no access token can be resolved', async () => {
    // Active account is set but no token in the JSON or Keychain →
    // getAccessTokenFromKeychain returns null → early return.
    await _internal.refreshUsageOnEntry(h.claudeJson, h.accDir);
    assert.ok(true, 'refreshUsageOnEntry exits cleanly with no token');
  });

  it('honours a fresh cache (no fetch)', async () => {
    // Pre-populate a fresh cache; refreshUsageOnEntry should see it
    // as not-stale and skip the fetch entirely.
    fs.writeFileSync(path.join(h.accDir, '.usage-cache.json'), JSON.stringify({
      fetchedAt: Date.now() - 1000,
      account: h.email,
      payload: {
        five_hour: { utilization: 30 },
        seven_day: { utilization: 10 },
      },
    }));
    const before = fs.statSync(path.join(h.accDir, '.usage-cache.json')).mtimeMs;
    await _internal.refreshUsageOnEntry(h.claudeJson, h.accDir);
    const after = fs.statSync(path.join(h.accDir, '.usage-cache.json')).mtimeMs;
    assert.equal(after, before, 'fresh cache must not be rewritten');
  });
});

// ────────────────────────────────────────────────────────────────────
// handleSwitched
// ────────────────────────────────────────────────────────────────────

describe('_internal.handleSwitched', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns "Already on X" when switchedFrom === switchedTo', async () => {
    const notice = await _internal.handleSwitched({
      switchedFrom: h.email,
      switchedTo: h.email,
      autoLaunch: true,
      defaultIsolated: false,
    }, h.accDir);
    assert.equal(notice?.kind, 'info');
    assert.match(notice?.text ?? '', /Already on/);
  });

  it('returns success notice without spawning when autoLaunch is false', async () => {
    const notice = await _internal.handleSwitched({
      switchedFrom: 'old@x.com',
      switchedTo: h.email,
      autoLaunch: false,
      defaultIsolated: false,
    }, h.accDir);
    assert.equal(notice?.kind, 'success');
    assert.match(notice?.text ?? '', /Switched to/);
  });
});

// ────────────────────────────────────────────────────────────────────
// handleApikey
// ────────────────────────────────────────────────────────────────────

describe('_internal.handleApikey', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns an error notice when there is no active account', async () => {
    fs.writeFileSync(h.claudeJson, '{}');
    const notice = await _internal.handleApikey(h.claudeJson, h.accDir);
    assert.equal(notice?.kind, 'error');
    assert.match(notice?.text ?? '', /No active account/);
  });
});

// ────────────────────────────────────────────────────────────────────
// handleFallbackToggle (the branches that don't need runConfirm)
// ────────────────────────────────────────────────────────────────────

describe('_internal.handleFallbackToggle', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('refuses to enable when there is no active account', async () => {
    fs.writeFileSync(h.claudeJson, '{}');
    const notice = await _internal.handleFallbackToggle(h.claudeJson, h.accDir);
    assert.equal(notice?.kind, 'error');
    assert.match(notice?.text ?? '', /No active account/);
  });

  it('disables fallback cleanly when it was on AND token is healthy', async () => {
    // Seed: fallback ON, token still valid (no health-warning prompt).
    setFallbackEnabled(h.accDir, true);
    setApiKey(h.email, 'sk-ant-api03-test', h.accDir);
    // The token-health probe needs an oauthAccount.expiresAt in the
    // future; we already wrote a minimal oauthAccount in setup() — add
    // a future expiry.
    const data = JSON.parse(fs.readFileSync(h.claudeJson, 'utf-8'));
    data.oauthAccount.accessToken = 'sk-ant-test';
    data.oauthAccount.expiresAt = Date.now() + 60 * 60 * 1000;
    fs.writeFileSync(h.claudeJson, JSON.stringify(data));

    const notice = await _internal.handleFallbackToggle(h.claudeJson, h.accDir);
    assert.equal(notice?.kind, 'success');
    assert.match(notice?.text ?? '', /Fallback OFF/);
  });
});

// ────────────────────────────────────────────────────────────────────
// handleUsage
// ────────────────────────────────────────────────────────────────────

describe('_internal.handleUsage', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns an error notice when no OAuth access token is available', async () => {
    // No tokens in claude.json or Keychain → getAccessTokenFromKeychain
    // returns null → early-return error path.
    const notice = await _internal.handleUsage(h.claudeJson, h.accDir);
    assert.equal(notice?.kind, 'error');
    assert.match(notice?.text ?? '', /No OAuth access token/);
  });
});
