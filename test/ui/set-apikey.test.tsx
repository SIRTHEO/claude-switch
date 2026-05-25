// test/ui/set-apikey.test.tsx
// Unit coverage for ApikeyScreen from set-apikey.tsx.
//
// ApikeyScreen is exported for testability (export does not change runtime
// behaviour). The outer orchestrator (runApikeyScreen) involves real Ink render
// on process.stdin and is NOT tested here.
//
// State machine under test:
//   overwrite? → enter → (confirm-bad-prefix?) → save → done
//
// Uses ink-testing-library + makeKeystrokeHelper (Phase 18.1).
// afterEach calls instance.unmount() to prevent timer leaks.
//
// Mock strategy: CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 forces the filesystem
// backend for apikey storage, so all writes stay inside a per-test tmp dir.
// No calls reach the real macOS Keychain.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import {
  ApikeyScreen,
  type SetApiKeyResult,
} from '../../src/ui/screens/set-apikey.js';
import { save as saveAccount } from '../../src/accounts/accounts.js';
import { setApiKey } from '../../src/credentials/apikey.js';
import { makeKeystrokeHelper } from './ink-keystroke-helper.js';

// ---------------------------------------------------------------------------
// Disable real Keychain for all tests in this file
// ---------------------------------------------------------------------------

process.env['CLAUDE_SWITCH_DISABLE_KEYCHAIN'] = '1';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
}

const EMAIL = 'sirtheo.work@example.com';

function setup(email = EMAIL): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-apikey-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  // Must have a saved account record for setApiKey to find the file.
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
// ApikeyScreen — no existing key (enter flow)
// ---------------------------------------------------------------------------

describe('ApikeyScreen — enter key flow (no existing key)', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => {
    h = setup();
  });

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('renders the key prompt on mount when no key exists', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Paste the key|hidden/i, `expected key prompt — got:\n${frame}`);
    assert.equal(results.length, 0, 'onDone should not fire on mount');
  });

  it('submits valid sk-ant- key and calls onDone with saved:true', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Type a fake valid key: starts with sk-ant-, total length > 20 chars
    await keys.type('sk-ant-fake-key-12345');
    await keys.pressEnter();
    await tick();
    await tick();
    assert.equal(results.length, 1, 'onDone should be called once after save');
    assert.equal(results[0]?.saved, true, 'saved should be true');
    assert.equal(results[0]?.cancelled, false, 'cancelled should be false');
    assert.equal(results[0]?.email, EMAIL, 'email should match');
  });

  it('short key (< 20 chars) → onDone with saved:false, cancelled:true', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Type only 5 chars — too short
    await keys.type('short');
    await keys.pressEnter();
    await tick();
    assert.equal(results.length, 1, 'onDone should be called once for short key');
    assert.equal(results[0]?.saved, false, 'saved should be false for short key');
    assert.equal(results[0]?.cancelled, true, 'cancelled should be true for short key');
  });

  it('empty Enter → onDone with saved:false, cancelled:true', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressEnter();
    await tick();
    assert.equal(results.length, 1, 'onDone should fire for empty submit');
    assert.equal(results[0]?.saved, false, 'saved should be false');
    assert.equal(results[0]?.cancelled, true, 'cancelled should be true');
  });
});

// ---------------------------------------------------------------------------
// ApikeyScreen — bad-prefix confirm flow
// ---------------------------------------------------------------------------

describe('ApikeyScreen — bad-prefix confirm flow', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => {
    h = setup();
  });

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('key without sk-ant- prefix → shows confirm-bad-prefix step, onDone not yet fired', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // 20+ chars without sk-ant- prefix
    await keys.type('sk-test-fake-key-12345-bad');
    await keys.pressEnter();
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /does not look|expected prefix|Save it anyway/i,
      `expected bad-prefix warning — got:\n${frame}`);
    assert.equal(results.length, 0, 'onDone should not fire before confirm');
  });

  it('bad-prefix → cancel (n) → onDone with saved:false, cancelled:true', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.type('sk-test-fake-key-12345-bad');
    await keys.pressEnter();
    await tick();
    // Cancel the confirm prompt
    await keys.pressKey('n');
    await tick();
    assert.equal(results.length, 1, 'onDone should be called after cancel');
    assert.equal(results[0]?.saved, false, 'saved should be false');
    assert.equal(results[0]?.cancelled, true, 'cancelled should be true');
  });

  it('bad-prefix → confirm (y) → onDone with saved:true', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.type('sk-test-fake-key-12345-bad');
    await keys.pressEnter();
    await tick();
    // Confirm saving anyway
    await keys.pressKey('y');
    await tick();
    await tick();
    assert.equal(results.length, 1, 'onDone should be called after confirm');
    assert.equal(results[0]?.saved, true, 'saved should be true');
    assert.equal(results[0]?.cancelled, false, 'cancelled should be false');
    assert.equal(results[0]?.email, EMAIL);
  });
});

// ---------------------------------------------------------------------------
// ApikeyScreen — overwrite flow (existing key present)
// ---------------------------------------------------------------------------

describe('ApikeyScreen — overwrite flow (existing key present)', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => {
    h = setup();
    // Pre-populate a key so ApikeyScreen starts at the overwrite? step
    setApiKey(EMAIL, 'sk-ant-existing-key-99999', h.accDir);
  });

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('renders overwrite prompt when a key already exists', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /already saved|Overwrite/i, `expected overwrite prompt — got:\n${frame}`);
    assert.equal(results.length, 0, 'onDone should not fire on mount');
  });

  it('overwrite → cancel (Enter with defaultChoice=cancel) → onDone cancelled:true', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // defaultChoice="cancel", so pressing Enter cancels
    await keys.pressEnter();
    await tick();
    assert.equal(results.length, 1, 'onDone should be called after cancel');
    assert.equal(results[0]?.saved, false, 'saved should be false');
    assert.equal(results[0]?.cancelled, true, 'cancelled should be true');
  });

  it('overwrite → confirm (y) → transitions to enter step', async () => {
    const results: SetApiKeyResult[] = [];
    instance = render(
      <ApikeyScreen
        email={EMAIL}
        accountsDirPath={h.accDir}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressKey('y');
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Paste the key|hidden/i,
      `expected enter-key prompt after confirming overwrite — got:\n${frame}`);
    assert.equal(results.length, 0, 'onDone should not fire yet');
  });
});
