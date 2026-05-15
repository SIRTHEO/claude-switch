// test/ui/add-account.test.tsx
// Unit coverage for PreSpawnScreen and PostSpawnScreen from add-account.tsx.
//
// Both components are now exported for testability (export does not change
// runtime behaviour). The outer orchestrator (runAddAccountScreen) involves
// spawnSync + real Ink render on process.stdin and is NOT tested here —
// those code paths are exercised by manual smoke tests and the CLI e2e suite.
//
// The test harness uses ink-testing-library.render() + makeKeystrokeHelper
// (Phase 18.1). afterEach calls instance.unmount() to prevent timer leaks.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import {
  PreSpawnScreen,
  PostSpawnScreen,
  type AddAccountResult,
} from '../../src/ui/screens/add-account.js';
import { save as saveAccount } from '../../src/accounts.js';
import { makeKeystrokeHelper } from '../ui/ink-keystroke-helper.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
}

function setup(email = 'current@example.com'): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-add-acct-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  saveAccount(email, claudeJson, accDir);
  return { tmpDir, claudeJson, accDir };
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// PreSpawnScreen
// ---------------------------------------------------------------------------

describe('PreSpawnScreen — render', () => {
  let instance: ReturnType<typeof render> | undefined;

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
  });

  it('renders the Add account header and email prompt', async () => {
    instance = render(
      <PreSpawnScreen onSubmit={() => undefined} />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Add account/i, `expected header — got:\n${frame}`);
    assert.match(frame, /email|@/i, `expected email hint — got:\n${frame}`);
  });

  it('submits empty string when Enter is pressed with blank input', async () => {
    const submitted: string[] = [];
    instance = render(
      <PreSpawnScreen onSubmit={(e) => { submitted.push(e); }} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressEnter();
    await tick();
    assert.equal(submitted.length, 1, 'onSubmit should have been called once');
    assert.equal(submitted[0], '', 'empty submit should pass empty string');
  });

  it('submits the typed email when a valid email is entered', async () => {
    const submitted: string[] = [];
    instance = render(
      <PreSpawnScreen onSubmit={(e) => { submitted.push(e); }} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.type('sirtheo.work@example.com');
    await keys.pressEnter();
    await tick();
    assert.equal(submitted.length, 1, 'onSubmit should be called once for valid email');
    assert.equal(submitted[0], 'sirtheo.work@example.com');
  });

  it('shows a validation error and does not call onSubmit for non-email input', async () => {
    const submitted: string[] = [];
    instance = render(
      <PreSpawnScreen onSubmit={(e) => { submitted.push(e); }} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.type('notanemail');
    await keys.pressEnter();
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.equal(submitted.length, 0, 'onSubmit must NOT be called on invalid input');
    assert.match(frame, /email/i, `expected error message in frame — got:\n${frame}`);
  });

  it('calls onSubmit after fixing a bad email and resubmitting', async () => {
    const submitted: string[] = [];
    instance = render(
      <PreSpawnScreen onSubmit={(e) => { submitted.push(e); }} />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // First attempt: bad input
    await keys.type('bad');
    await keys.pressEnter();
    await tick();
    assert.equal(submitted.length, 0, 'onSubmit must not fire on bad input');

    // Backspace to clear, then type valid email
    for (let i = 0; i < 3; i++) {
      await keys.pressBackspace();
    }
    await keys.type('sirtheo.personal@example.com');
    await keys.pressEnter();
    await tick();
    assert.equal(submitted.length, 1, 'onSubmit should fire after valid resubmit');
    assert.equal(submitted[0], 'sirtheo.personal@example.com');
  });
});

// ---------------------------------------------------------------------------
// PostSpawnScreen — no mismatch path (straight to alias step)
// ---------------------------------------------------------------------------

describe('PostSpawnScreen — no mismatch (same email)', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;
  const NEW_EMAIL = 'sirtheo.work@example.com';

  beforeEach(() => {
    h = setup(NEW_EMAIL);
    // Save the account that will appear as "new" so save() can find it
    saveAccount(NEW_EMAIL, h.claudeJson, h.accDir);
  });

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('renders the Signed in badge on mount', async () => {
    const results: AddAccountResult[] = [];
    instance = render(
      <PostSpawnScreen
        newEmail={NEW_EMAIL}
        expectedEmail={NEW_EMAIL}
        currentEmail=""
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Signed in/i, `expected "Signed in" badge — got:\n${frame}`);
  });

  it('transitions to alias step after saving and renders alias prompt', async () => {
    const results: AddAccountResult[] = [];
    instance = render(
      <PostSpawnScreen
        newEmail={NEW_EMAIL}
        expectedEmail={NEW_EMAIL}
        currentEmail=""
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    // Let saving effect run
    await tick();
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /alias|nickname|Enter to skip/i,
      `expected alias prompt after saving — got:\n${frame}`);
  });

  it('submits empty alias → onDone with alias:null, cancelled:false', async () => {
    const results: AddAccountResult[] = [];
    instance = render(
      <PostSpawnScreen
        newEmail={NEW_EMAIL}
        expectedEmail={NEW_EMAIL}
        currentEmail=""
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    // Wait for saving effect
    await tick();
    await tick();

    const keys = makeKeystrokeHelper(instance);
    await keys.pressEnter(); // skip alias
    await tick();

    assert.equal(results.length, 1, 'onDone should be called once');
    assert.equal(results[0]?.email, NEW_EMAIL);
    assert.equal(results[0]?.alias, null);
    assert.equal(results[0]?.cancelled, false);
  });

  it('submits named alias → onDone with alias set, cancelled:false', async () => {
    const results: AddAccountResult[] = [];
    instance = render(
      <PostSpawnScreen
        newEmail={NEW_EMAIL}
        expectedEmail={NEW_EMAIL}
        currentEmail=""
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    await tick();

    const keys = makeKeystrokeHelper(instance);
    await keys.type('work');
    await keys.pressEnter();
    await tick();

    assert.equal(results.length, 1, 'onDone should be called once');
    assert.equal(results[0]?.email, NEW_EMAIL);
    assert.equal(results[0]?.alias, 'work');
    assert.equal(results[0]?.cancelled, false);
  });
});

// ---------------------------------------------------------------------------
// PostSpawnScreen — confirm-mismatch path
// ---------------------------------------------------------------------------

describe('PostSpawnScreen — confirm-mismatch', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;
  const EXPECTED_EMAIL = 'sirtheo.personal@example.com';
  const ACTUAL_EMAIL   = 'sirtheo.work@example.com';

  beforeEach(() => {
    h = setup(EXPECTED_EMAIL);
    saveAccount(ACTUAL_EMAIL, h.claudeJson, h.accDir);
  });

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('renders the mismatch warning when expected ≠ new email', async () => {
    const results: AddAccountResult[] = [];
    instance = render(
      <PostSpawnScreen
        newEmail={ACTUAL_EMAIL}
        expectedEmail={EXPECTED_EMAIL}
        currentEmail={EXPECTED_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /mismatch|Different|Expected/i,
      `expected mismatch warning — got:\n${frame}`);
    assert.equal(results.length, 0, 'onDone should not fire before user confirms');
  });

  it('confirms mismatch with Enter (defaultChoice=confirm) and proceeds to alias', async () => {
    const results: AddAccountResult[] = [];
    instance = render(
      <PostSpawnScreen
        newEmail={ACTUAL_EMAIL}
        expectedEmail={EXPECTED_EMAIL}
        currentEmail={EXPECTED_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // ConfirmInput defaultChoice="confirm", Enter accepts
    await keys.pressEnter();
    await tick();
    await tick();
    const frame = instance.lastFrame() ?? '';
    // After confirming, saving runs then alias step appears
    assert.match(frame, /alias|nickname|Enter to skip|Saved/i,
      `expected alias step or saved confirmation — got:\n${frame}`);
  });

  it('cancels mismatch with n and calls onDone cancelled:true', async () => {
    const results: AddAccountResult[] = [];
    instance = render(
      <PostSpawnScreen
        newEmail={ACTUAL_EMAIL}
        expectedEmail={EXPECTED_EMAIL}
        currentEmail={EXPECTED_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressKey('n');
    await tick();
    assert.equal(results.length, 1, 'onDone should be called after cancel');
    assert.equal(results[0]?.cancelled, true);
    assert.equal(results[0]?.email, null);
  });
});
