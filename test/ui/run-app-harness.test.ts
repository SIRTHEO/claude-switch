// test/ui/run-app-harness.test.ts
// Demo tests for the run-app mock harness (Phase 19.1).
//
// These three tests validate that:
//   1. makeRunAppHarness() creates a self-contained fixture environment
//   2. _internal handlers can be exercised via the harness without real I/O
//   3. cleanup() is robust: no tmp-dir leaks, no HOME pollution, no timer leaks
//
// Tests do NOT call runApp() directly — the orchestrator's infinite loop
// and alt-buffer lifecycle are intentionally out of scope here. Instead,
// each handler is called directly via _internal, exactly as run-app.test.ts
// already does for its own describe blocks. The harness is the reusable
// factory that makes that pattern composable for 19.2+ Phase tests.
//
// Privacy: sirtheo.work@example.com is the only email in this file.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { makeRunAppHarness, type RunAppHarness } from './run-app-harness.js';
import { _internal } from '../../src/ui/run-app.js';
import { save as saveAccount } from '../../src/accounts.js';

// Disable real Keychain for the whole file.
process.env['CLAUDE_SWITCH_DISABLE_KEYCHAIN'] = '1';

// ---------------------------------------------------------------------------
// Test 1 — harness bootstraps an isolated environment
// ---------------------------------------------------------------------------

describe('makeRunAppHarness — fixture bootstrap', () => {
  let h: RunAppHarness;

  beforeEach(() => { h = makeRunAppHarness(); });
  afterEach(() => h.cleanup());

  it('creates accountsDir and claudeJsonPath in a fresh tmpDir', () => {
    assert.ok(fs.existsSync(h.tmpDir), 'tmpDir must exist');
    assert.ok(fs.existsSync(h.accountsDir), 'accountsDir must exist');
    assert.ok(fs.existsSync(h.claudeJsonPath), 'claudeJsonPath must exist');

    const json = JSON.parse(fs.readFileSync(h.claudeJsonPath, 'utf-8')) as {
      oauthAccount?: { emailAddress?: string };
    };
    assert.equal(
      json.oauthAccount?.emailAddress,
      'sirtheo.work@example.com',
      'claudeJsonPath must contain the default active email',
    );
  });

  it('creates a fake claude binary that is executable and exits 0', () => {
    assert.ok(fs.existsSync(h.claudeBinFake), 'claudeBinFake must exist');

    const result = spawnSync(h.claudeBinFake, [], { encoding: 'utf-8' });
    assert.equal(result.status, 0, 'fake claude binary must exit 0');
  });

  it('cleanup removes tmpDir and restores HOME', () => {
    const tmpPath = h.tmpDir;
    const prevHome = process.env.HOME;

    // During the test HOME is overridden to tmpDir.
    assert.equal(process.env.HOME, tmpPath, 'HOME must point to tmpDir while harness is live');

    h.cleanup();

    assert.ok(!fs.existsSync(tmpPath), 'tmpDir must be removed after cleanup()');
    // HOME is restored to whatever it was before makeRunAppHarness().
    // prevHome is the value set BY the harness (= tmpPath), so after cleanup
    // it should be the value from the enclosing beforeEach scope — but the
    // harness restores the value that existed BEFORE it was called. Since
    // beforeEach calls makeRunAppHarness() at top level, the restored value
    // is whatever HOME was before this test file started (the real home dir,
    // likely /Users/… on macOS). We just check it's different from tmpPath.
    assert.notEqual(process.env.HOME, tmpPath, 'HOME must not still point to the deleted tmpDir');

    // Calling cleanup() twice must be idempotent (no throw).
    assert.doesNotThrow(() => h.cleanup());

    // Restore state so afterEach() doesn't double-clean or error.
    process.env.HOME = prevHome;
  });
});

// ---------------------------------------------------------------------------
// Test 2 — action dispatch via _internal (handleSwitched)
// ---------------------------------------------------------------------------

describe('makeRunAppHarness — _internal handler dispatch', () => {
  let h: RunAppHarness;
  const EMAIL = 'sirtheo.work@example.com';

  beforeEach(() => {
    h = makeRunAppHarness({ activeEmail: EMAIL });
    // Seed the account so handlers that read accountsDir find it.
    saveAccount(EMAIL, h.claudeJsonPath, h.accountsDir);
  });
  afterEach(() => h.cleanup());

  it('handleSwitched returns info notice when already on the same account', async () => {
    const notice = await _internal.handleSwitched(
      { switchedFrom: EMAIL, switchedTo: EMAIL, autoLaunch: false, defaultIsolated: false },
      h.accountsDir,
    );
    assert.equal(notice?.kind, 'info', 'should be an info notice');
    assert.match(notice?.text ?? '', /Already on/, 'text should mention "Already on"');
  });

  it('handleSwitched returns success notice when switching without autoLaunch', async () => {
    const notice = await _internal.handleSwitched(
      { switchedFrom: 'other@example.com', switchedTo: EMAIL, autoLaunch: false, defaultIsolated: false },
      h.accountsDir,
    );
    assert.equal(notice?.kind, 'success', 'should be a success notice');
    assert.match(notice?.text ?? '', /Switched to/, 'text should confirm the switch');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — harness cleanup is robust (no leaked instances / dirs)
// ---------------------------------------------------------------------------

describe('makeRunAppHarness — cleanup robustness', () => {
  it('can create and clean up multiple harness instances without leaks', () => {
    const a = makeRunAppHarness();
    const b = makeRunAppHarness({ activeEmail: 'sirtheo.personal@example.com' });

    const aDir = a.tmpDir;
    const bDir = b.tmpDir;

    // Both exist while live.
    assert.ok(fs.existsSync(aDir), 'harness-a tmpDir must exist');
    assert.ok(fs.existsSync(bDir), 'harness-b tmpDir must exist');

    // They must be independent directories.
    assert.notEqual(aDir, bDir, 'two harness instances must use distinct tmp dirs');

    // Verify harness-b has the custom email.
    const json = JSON.parse(fs.readFileSync(b.claudeJsonPath, 'utf-8')) as {
      oauthAccount?: { emailAddress?: string };
    };
    assert.equal(json.oauthAccount?.emailAddress, 'sirtheo.personal@example.com');

    // Cleanup both.
    a.cleanup();
    b.cleanup();

    assert.ok(!fs.existsSync(aDir), 'harness-a tmpDir must be removed');
    assert.ok(!fs.existsSync(bDir), 'harness-b tmpDir must be removed');
  });

  it('handleUsage returns error when no OAuth token is available in harness env', async () => {
    const h = makeRunAppHarness();
    try {
      // claudeJsonPath has no accessToken → getAccessTokenFromKeychain returns null.
      const notice = await _internal.handleUsage(h.claudeJsonPath, h.accountsDir);
      assert.equal(notice?.kind, 'error', 'should be an error notice');
      assert.match(notice?.text ?? '', /No OAuth access token/);
    } finally {
      h.cleanup();
    }
  });

  it('cleanup() is idempotent — calling twice does not throw', () => {
    const h = makeRunAppHarness();
    assert.doesNotThrow(() => h.cleanup());
    assert.doesNotThrow(() => h.cleanup());
  });
});
