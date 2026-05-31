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

import { _internal, _runDispatchLoop } from '../../src/ui/run-app.js';
import { ExitError } from '../../src/platform/errors.js';
import type { HomeExit } from '../../src/ui/screens/home.js';
import { save as saveAccount } from '../../src/accounts/accounts.js';
import { setFallbackEnabled } from '../../src/fallback/fallback.js';
import { setApiKey } from '../../src/credentials/apikey.js';
import { writeGlobalPrefs } from '../../src/switching/preferences.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from '../_helpers/fake-home.js';

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
  email: string;
  /** Path to a fake claude binary (exit 0, chmod 755). */
  claudeBin: string;
}

function setup(activeEmail = 'a@b.com'): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-runapp-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: activeEmail } }));
  saveAccount(activeEmail, claudeJson, accDir);
  // Fake claude binary: exits 0 immediately, chmod 755.
  const claudeBin = path.join(tmpDir, 'claude-fake');
  fs.writeFileSync(claudeBin, '#!/usr/bin/env sh\nexit 0\n');
  fs.chmodSync(claudeBin, 0o755);
  return { tmpDir, claudeJson, accDir, email: activeEmail, claudeBin };
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
      pointer: 'default',
    }, h.accDir);
    assert.equal(notice?.kind, 'info');
    assert.match(notice?.text ?? '', /Already on/);
  });

  it('returns success notice without spawning when autoLaunch is false', async () => {
    const notice = await _internal.handleSwitched({
      switchedFrom: 'old@x.com',
      switchedTo: h.email,
      autoLaunch: false,
      pointer: 'default',
    }, h.accDir);
    assert.equal(notice?.kind, 'success');
    assert.match(notice?.text ?? '', /Switched to/);
  });

  it('launches isolated by a non-default pointer and returns a notice (or throws on spawn)', async () => {
    // With CLAUDE_SWITCH_BIN set and a non-default pointer, handleSwitched
    // launches that profile isolated (CLAUDE_CONFIG_DIR = profilePath(pointer)).
    // The fake bin exits 0, so the spawn-and-wait path throws ExitError; either
    // an ExitError or a returned notice proves the isolated branch ran.
    const prevBin = process.env.CLAUDE_SWITCH_BIN;
    let savedHome: SavedHome;
    process.env.CLAUDE_SWITCH_BIN = h.claudeBin;
    savedHome = setFakeHome(h.tmpDir);
    // The pointed profile must exist and carry a credential — the work-dir
    // seeder refuses (no-creds guard) before the spawn otherwise.
    const workProfile = path.join(h.tmpDir, '.claude', 'profiles', 'work');
    fs.mkdirSync(workProfile, { recursive: true });
    fs.writeFileSync(path.join(workProfile, '.claude.json'), JSON.stringify({
      userID: 'w'.repeat(64),
      oauthAccount: { emailAddress: h.email, accessToken: 'tok', refreshToken: 'rtok', expiresAt: 9999999999999 },
    }));
    // Capture stderr: the isolated branch writes a distinctive banner naming the
    // pointed profile BEFORE it spawns. Its presence is the launch-target proof
    // — it means the profile-isolated path ran, NOT the global ~/.claude launch
    // (which writes no such banner). A pointer-only check would miss that bug.
    const origWrite = process.stderr.write.bind(process.stderr);
    const stderrSeen: string[] = [];
    (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
      stderrSeen.push(String(chunk));
      return true;
    };
    try {
      await _internal.handleSwitched({
        switchedFrom: 'old@example.com',
        switchedTo: h.email,
        autoLaunch: true,
        pointer: 'work',
      }, h.accDir);
    } catch (err) {
      // ExitError is expected — the fake bin exits 0, so spawn-and-wait throws.
      assert.ok(err instanceof ExitError, `Expected ExitError, got: ${String(err)}`);
    } finally {
      (process.stderr as { write: unknown }).write = origWrite;
      if (prevBin === undefined) delete process.env.CLAUDE_SWITCH_BIN;
      else process.env.CLAUDE_SWITCH_BIN = prevBin;
      restoreFakeHome(savedHome);
    }
    // Launch-target assertion: launched isolated against the pointed profile.
    assert.match(stderrSeen.join(''), /isolated · profile: work/);
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

// ────────────────────────────────────────────────────────────────────
// handleAdd (Phase 19.2 — bin-null path)
// ────────────────────────────────────────────────────────────────────

describe('_internal.handleAdd', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns error when claude binary cannot be found', async () => {
    // findClaudeBinary checks CLAUDE_SWITCH_BIN, getSavedClaudeBin(), then PATH.
    // Override all three paths to ensure null is returned.
    let savedHome2: SavedHome;
    const prevPath = process.env.PATH;
    const prevBin = process.env.CLAUDE_SWITCH_BIN;
    savedHome2 = setFakeHome(h.tmpDir);
    process.env.PATH = h.tmpDir;
    delete process.env.CLAUDE_SWITCH_BIN;
    try {
      const notice = await _internal.handleAdd(h.claudeJson, h.accDir);
      assert.equal(notice?.kind, 'error');
      assert.match(notice?.text ?? '', /Could not find/i);
    } finally {
      restoreFakeHome(savedHome2);
      process.env.PATH = prevPath;
      if (prevBin !== undefined) process.env.CLAUDE_SWITCH_BIN = prevBin;
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// handleProfiles (Phase 19.2 — bin-null path)
// ────────────────────────────────────────────────────────────────────

describe('_internal.handleProfiles', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns error when claude binary cannot be found', async () => {
    let savedHomeProfiles: SavedHome;
    const prevPath = process.env.PATH;
    const prevBin = process.env.CLAUDE_SWITCH_BIN;
    savedHomeProfiles = setFakeHome(h.tmpDir);
    process.env.PATH = h.tmpDir;
    delete process.env.CLAUDE_SWITCH_BIN;
    try {
      const notice = await _internal.handleProfiles(h.accDir);
      assert.equal(notice?.kind, 'error');
      assert.match(notice?.text ?? '', /Could not find/i);
    } finally {
      restoreFakeHome(savedHomeProfiles);
      process.env.PATH = prevPath;
      if (prevBin !== undefined) process.env.CLAUDE_SWITCH_BIN = prevBin;
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// handleReauth (Phase 19.2 — bin-null path)
// ────────────────────────────────────────────────────────────────────

describe('_internal.handleReauth', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns error when claude binary cannot be found', async () => {
    // Override HOME so getSavedClaudeBin finds no .claude-bin, and PATH
    // so resolver finds no 'claude' in PATH either.
    let savedHomeReauth: SavedHome;
    const prevPath = process.env.PATH;
    const prevBin = process.env.CLAUDE_SWITCH_BIN;
    savedHomeReauth = setFakeHome(h.tmpDir);
    process.env.PATH = h.tmpDir;
    delete process.env.CLAUDE_SWITCH_BIN;
    try {
      const notice = await _internal.handleReauth(h.claudeJson, h.accDir);
      assert.equal(notice?.kind, 'error');
      assert.match(notice?.text ?? '', /Could not find/i);
    } finally {
      restoreFakeHome(savedHomeReauth);
      process.env.PATH = prevPath;
      if (prevBin !== undefined) process.env.CLAUDE_SWITCH_BIN = prevBin;
    }
  });

});

// ────────────────────────────────────────────────────────────────────
// handleSwitched — autoLaunch=true + bin not found (Phase 19.2)
// ────────────────────────────────────────────────────────────────────

describe('_internal.handleSwitched — autoLaunch paths', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns success notice when autoLaunch=true but binary not found', async () => {
    // When findClaudeBinary returns null, handleSwitched falls through
    // to the "Switched to X" success notice even with autoLaunch=true.
    let savedHomeSwitched: SavedHome;
    const prevPath = process.env.PATH;
    const prevBin = process.env.CLAUDE_SWITCH_BIN;
    savedHomeSwitched = setFakeHome(h.tmpDir);
    process.env.PATH = h.tmpDir;
    delete process.env.CLAUDE_SWITCH_BIN;
    try {
      const notice = await _internal.handleSwitched({
        switchedFrom: 'old@example.com',
        switchedTo: h.email,
        autoLaunch: true,
        pointer: 'default',
      }, h.accDir);
      assert.equal(notice?.kind, 'success');
      assert.match(notice?.text ?? '', /Switched to/);
    } finally {
      restoreFakeHome(savedHomeSwitched);
      process.env.PATH = prevPath;
      if (prevBin !== undefined) process.env.CLAUDE_SWITCH_BIN = prevBin;
    }
  });

  it('throws ExitError when autoLaunch=true and binary exits 0 (spawnSync completes)', async () => {
    // With CLAUDE_SWITCH_BIN pointing to a fake binary (exit 0), handleSwitched
    // calls spawnSync, gets status=0, and throws ExitError('', 0).
    const prevBin = process.env.CLAUDE_SWITCH_BIN;
    process.env.CLAUDE_SWITCH_BIN = h.claudeBin;
    try {
      await assert.rejects(
        () => _internal.handleSwitched({
          switchedFrom: 'old@example.com',
          switchedTo: h.email,
          autoLaunch: true,
          pointer: 'default',
        }, h.accDir),
        (err: unknown) => err instanceof ExitError,
      );
    } finally {
      if (prevBin === undefined) delete process.env.CLAUDE_SWITCH_BIN;
      else process.env.CLAUDE_SWITCH_BIN = prevBin;
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// handleFallbackToggle — enable with API key already set (Phase 19.2)
// ────────────────────────────────────────────────────────────────────

describe('_internal.handleFallbackToggle — enable path', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('enables fallback when active account has an API key', async () => {
    // Fallback is currently OFF; account has an API key → should enable cleanly.
    setApiKey(h.email, 'sk-ant-api03-test', h.accDir);
    const notice = await _internal.handleFallbackToggle(h.claudeJson, h.accDir);
    assert.equal(notice?.kind, 'success');
    assert.match(notice?.text ?? '', /Fallback ON/);
  });
});

// ────────────────────────────────────────────────────────────────────
// _runDispatchLoop (Phase 19.2 — dispatch loop with injected renderHome)
// ────────────────────────────────────────────────────────────────────

describe('_runDispatchLoop', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('exits immediately when renderHome returns action=exit', async () => {
    // Stub renderHome to return exit on the first call.
    const renderStub = async (): Promise<HomeExit> => ({ action: 'exit' });
    await _runDispatchLoop(h.claudeJson, h.accDir, renderStub);
    // If we reach here without throwing, the loop exited cleanly.
    assert.ok(true);
  });

  it('dispatches switched action and loops back', async () => {
    // First call returns switched, second call returns exit.
    let callCount = 0;
    const renderStub = async (): Promise<HomeExit> => {
      callCount++;
      if (callCount === 1) {
        return {
          action: 'switched',
          payload: {
            switchedFrom: h.email,
            switchedTo: h.email,
            autoLaunch: false,
            pointer: 'default',
          },
        };
      }
      return { action: 'exit' };
    };
    await _runDispatchLoop(h.claudeJson, h.accDir, renderStub);
    assert.equal(callCount, 2, 'loop must continue after switched action');
  });

  it('dispatches apikey action when no active account (error notice, loop continues)', async () => {
    // Set up: no active account so handleApikey returns error notice.
    fs.writeFileSync(h.claudeJson, '{}');
    let callCount = 0;
    let receivedNotice: unknown;
    const renderStub = async (_cj: string, _ad: string, notice: unknown): Promise<HomeExit> => {
      callCount++;
      receivedNotice = notice;
      if (callCount >= 2) return { action: 'exit' };
      return { action: 'apikey' };
    };
    await _runDispatchLoop(h.claudeJson, h.accDir, renderStub);
    assert.equal(callCount, 2, 'loop must continue after apikey error');
    // On second call, notice should carry the error from handleApikey.
    assert.deepEqual((receivedNotice as { kind: string } | null)?.kind, 'error');
  });

  it('dispatches fallback-toggle action (enable path)', async () => {
    // Set up: account has an API key so handleFallbackToggle enables cleanly.
    setApiKey(h.email, 'sk-ant-api03-test', h.accDir);
    let callCount = 0;
    let receivedNotice: unknown;
    const renderStub = async (_cj: string, _ad: string, notice: unknown): Promise<HomeExit> => {
      callCount++;
      receivedNotice = notice;
      if (callCount >= 2) return { action: 'exit' };
      return { action: 'fallback-toggle' };
    };
    await _runDispatchLoop(h.claudeJson, h.accDir, renderStub);
    assert.equal(callCount, 2);
    assert.equal((receivedNotice as { kind: string } | null)?.kind, 'success');
  });

  it('dispatches usage action (no token → error notice)', async () => {
    let callCount = 0;
    let receivedNotice: unknown;
    const renderStub = async (_cj: string, _ad: string, notice: unknown): Promise<HomeExit> => {
      callCount++;
      receivedNotice = notice;
      if (callCount >= 2) return { action: 'exit' };
      return { action: 'usage' };
    };
    await _runDispatchLoop(h.claudeJson, h.accDir, renderStub);
    assert.equal(callCount, 2);
    assert.equal((receivedNotice as { kind: string } | null)?.kind, 'error');
  });

  it('propagates ExitError from handler (does not catch it)', async () => {
    // handleSwitched with autoLaunch=true + bin found throws ExitError.
    // Use CLAUDE_SWITCH_BIN to point to the fake binary (exit 0).
    // Also override HOME to tmpDir so getSavedClaudeBin doesn't pick up
    // a system-wide .claude-bin pointer that might resolve differently.
    const prevBin = process.env.CLAUDE_SWITCH_BIN;
    let savedHomeLoop: SavedHome;
    process.env.CLAUDE_SWITCH_BIN = h.claudeBin;
    savedHomeLoop = setFakeHome(h.tmpDir);
    try {
      const renderStub = async (): Promise<HomeExit> => ({
        action: 'switched',
        payload: {
          switchedFrom: 'old@example.com',
          switchedTo: h.email,
          autoLaunch: true,
          pointer: 'default',
        },
      });
      await assert.rejects(
        () => _runDispatchLoop(h.claudeJson, h.accDir, renderStub),
        (err: unknown) => err instanceof ExitError,
      );
    } finally {
      if (prevBin === undefined) delete process.env.CLAUDE_SWITCH_BIN;
      else process.env.CLAUDE_SWITCH_BIN = prevBin;
      restoreFakeHome(savedHomeLoop);
    }
  });

  it('dispatches add action (no binary → error notice, loop continues)', async () => {
    let callCount = 0;
    let receivedNotice: unknown;
    const renderStub = async (_cj: string, _ad: string, notice: unknown): Promise<HomeExit> => {
      callCount++;
      receivedNotice = notice;
      if (callCount >= 2) return { action: 'exit' };
      return { action: 'add' };
    };
    const savedHome = setFakeHome(h.tmpDir);
    const prevPath = process.env.PATH;
    const prevBin = process.env.CLAUDE_SWITCH_BIN;
    process.env.PATH = h.tmpDir;
    delete process.env.CLAUDE_SWITCH_BIN;
    try {
      await _runDispatchLoop(h.claudeJson, h.accDir, renderStub);
    } finally {
      restoreFakeHome(savedHome);
      process.env.PATH = prevPath;
      if (prevBin !== undefined) process.env.CLAUDE_SWITCH_BIN = prevBin;
    }
    assert.equal(callCount, 2);
    assert.equal((receivedNotice as { kind: string } | null)?.kind, 'error');
  });

  it('dispatches profiles action (no binary → error notice, loop continues)', async () => {
    let callCount = 0;
    let receivedNotice: unknown;
    const renderStub = async (_cj: string, _ad: string, notice: unknown): Promise<HomeExit> => {
      callCount++;
      receivedNotice = notice;
      if (callCount >= 2) return { action: 'exit' };
      return { action: 'profiles' };
    };
    const savedHome = setFakeHome(h.tmpDir);
    const prevPath = process.env.PATH;
    const prevBin = process.env.CLAUDE_SWITCH_BIN;
    process.env.PATH = h.tmpDir;
    delete process.env.CLAUDE_SWITCH_BIN;
    try {
      await _runDispatchLoop(h.claudeJson, h.accDir, renderStub);
    } finally {
      restoreFakeHome(savedHome);
      process.env.PATH = prevPath;
      if (prevBin !== undefined) process.env.CLAUDE_SWITCH_BIN = prevBin;
    }
    assert.equal(callCount, 2);
    assert.equal((receivedNotice as { kind: string } | null)?.kind, 'error');
  });

  it('dispatches reauth action (no binary → error notice, loop continues)', async () => {
    // handleReauth returns error notice when findClaudeBinary returns null.
    // Override HOME to point to tmpDir (no .claude-bin file) and PATH to
    // a dir with no real claude binary so findClaudeBinary returns null.
    let callCount = 0;
    let receivedNotice: unknown;
    const renderStub = async (_cj: string, _ad: string, notice: unknown): Promise<HomeExit> => {
      callCount++;
      receivedNotice = notice;
      if (callCount >= 2) return { action: 'exit' };
      return { action: 'reauth' };
    };
    const savedHome = setFakeHome(h.tmpDir);
    const prevPath = process.env.PATH;
    // Redirect HOME so getSavedClaudeBin finds no .claude-bin file.
    process.env.PATH = h.tmpDir;
    try {
      await _runDispatchLoop(h.claudeJson, h.accDir, renderStub);
    } finally {
      restoreFakeHome(savedHome);
      process.env.PATH = prevPath;
    }
    assert.equal(callCount, 2);
    assert.equal((receivedNotice as { kind: string } | null)?.kind, 'error');
  });
});

