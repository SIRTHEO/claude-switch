// test/ui/remove-account.test.tsx
// Unit coverage for RemoveAccountScreen from remove-account.tsx.
//
// RemoveAccountScreen is exported for testability (export does not change
// runtime behaviour). The outer orchestrator (runRemoveAccountScreen) involves
// real Ink render on process.stdin and is NOT tested here.
//
// The test harness uses ink-testing-library.render() + makeKeystrokeHelper
// (Phase 18.1). afterEach calls instance.unmount() to prevent timer leaks.
//
// Key: ConfirmInput defaultChoice="cancel", so:
//   - 'y' → onConfirm → doRemove() → onDone({removed:true, cancelled:false})
//   - 'n' or Enter → onCancel → onDone({removed:false, cancelled:true})

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import {
  RemoveAccountScreen,
  buildPreview,
  type RemoveAccountResult,
} from '../../src/ui/screens/remove-account.js';
import { save as saveAccount } from '../../src/accounts.js';
import { makeKeystrokeHelper } from '../ui/ink-keystroke-helper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

process.env['CLAUDE_SWITCH_DISABLE_KEYCHAIN'] = '1';

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
}

function setup(currentEmail = 'other@example.com', accountEmail = 'sirtheo.work@example.com'): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-remove-acct-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  // currentEmail is active (not the one we're removing)
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: currentEmail } }));
  // Save the account we want to remove
  saveAccount(accountEmail, claudeJson, accDir);
  // Also save the current account so accounts dir is consistent
  if (currentEmail !== accountEmail) {
    saveAccount(currentEmail, claudeJson, accDir);
  }
  return { tmpDir, claudeJson, accDir };
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

const TEST_EMAIL = 'sirtheo.work@example.com';

// ---------------------------------------------------------------------------
// Render initial state
// ---------------------------------------------------------------------------

describe('RemoveAccountScreen — initial render (confirm step)', () => {
  let instance: ReturnType<typeof render> | undefined;
  let h: Harness;

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    if (h) teardown(h);
  });

  it('renders the Remove badge with the account email', async () => {
    h = setup();
    const preview = { lines: [`• Account file ${path.join(h.accDir, `${TEST_EMAIL}.json`)}`], hadAliases: false };
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'confirm', preview }}
        onDone={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Remove/i, `expected "Remove" badge — got:\n${frame}`);
    assert.match(frame, /sirtheo\.work@example\.com/, `expected email — got:\n${frame}`);
  });

  it('renders Will be deleted warning and preview lines', async () => {
    h = setup();
    const preview = { lines: ['• Account file /tmp/test.json', '• API key (sk-****)'], hadAliases: false };
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'confirm', preview }}
        onDone={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Will be deleted/i, `expected warning header — got:\n${frame}`);
    assert.match(frame, /Account file/, `expected account file line — got:\n${frame}`);
    assert.match(frame, /API key/, `expected api key line — got:\n${frame}`);
  });

  it('renders the confirm/cancel prompt', async () => {
    h = setup();
    const preview = { lines: ['• Account file /tmp/x.json'], hadAliases: false };
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'confirm', preview }}
        onDone={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Really remove/i, `expected confirmation prompt — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// Cancel path (defaultChoice="cancel" → Enter triggers cancel)
// ---------------------------------------------------------------------------

describe('RemoveAccountScreen — cancel path', () => {
  let instance: ReturnType<typeof render> | undefined;
  let h: Harness;

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    if (h) teardown(h);
  });

  it('Enter (defaultChoice=cancel) calls onDone with removed:false, cancelled:true', async () => {
    h = setup();
    const results: RemoveAccountResult[] = [];
    const preview = { lines: ['• Account file /tmp/x.json'], hadAliases: false };
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'confirm', preview }}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressEnter();
    await tick();
    assert.equal(results.length, 1, 'onDone should be called once');
    assert.equal(results[0]?.removed, false);
    assert.equal(results[0]?.cancelled, true);
  });

  it("pressing 'n' calls onDone with removed:false, cancelled:true", async () => {
    h = setup();
    const results: RemoveAccountResult[] = [];
    const preview = { lines: ['• Account file /tmp/x.json'], hadAliases: false };
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'confirm', preview }}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressKey('n');
    await tick();
    assert.equal(results.length, 1, 'onDone should be called once after n');
    assert.equal(results[0]?.removed, false);
    assert.equal(results[0]?.cancelled, true);
  });

  it("shows cancelled status message after cancel", async () => {
    h = setup();
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'cancelled', reason: 'Cancelled. Nothing was removed.' }}
        onDone={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Cancelled|Nothing was removed/i, `expected cancelled message — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// Confirm path ('y' → doRemove → removed)
// ---------------------------------------------------------------------------

describe('RemoveAccountScreen — confirm path (y to remove)', () => {
  let instance: ReturnType<typeof render> | undefined;
  let h: Harness;

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    if (h) teardown(h);
  });

  it("pressing 'y' calls onDone with removed:true, cancelled:false", async () => {
    h = setup();
    const results: RemoveAccountResult[] = [];
    const preview = {
      lines: [`• Account file ${path.join(h.accDir, `${TEST_EMAIL}.json`)}`],
      hadAliases: false,
    };
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'confirm', preview }}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressKey('y');
    await tick();
    await tick();
    assert.equal(results.length, 1, 'onDone should be called once after y');
    assert.equal(results[0]?.removed, true);
    assert.equal(results[0]?.cancelled, false);
  });
});

// ---------------------------------------------------------------------------
// Pre-rendered terminal states (initialStep variety)
// ---------------------------------------------------------------------------

describe('RemoveAccountScreen — pre-rendered states', () => {
  let instance: ReturnType<typeof render> | undefined;
  let h: Harness;

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    if (h) teardown(h);
  });

  it('renders removing spinner when step=removing', async () => {
    h = setup();
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'removing' }}
        onDone={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /removing/i, `expected removing indicator — got:\n${frame}`);
  });

  it('renders success message when step=removed (no aliases)', async () => {
    h = setup();
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'removed', hadAliases: false }}
        onDone={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Removed/i, `expected success message — got:\n${frame}`);
  });

  it('renders alias cleanup warning when step=removed with hadAliases:true', async () => {
    h = setup();
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'removed', hadAliases: true }}
        onDone={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Removed/i, `expected success message — got:\n${frame}`);
    assert.match(frame, /[Aa]liases/i, `expected alias warning — got:\n${frame}`);
  });

  it('renders error message when step=failed', async () => {
    h = setup();
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'failed', reason: 'Lock acquisition failed.' }}
        onDone={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Lock acquisition failed/i, `expected error message — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// doRemove — error path (removeAccountSafely throws)
// ---------------------------------------------------------------------------

describe('RemoveAccountScreen — doRemove error path', () => {
  let instance: ReturnType<typeof render> | undefined;
  let h: Harness;

  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    if (h) teardown(h);
  });

  it("pressing 'y' when account file missing calls onDone with removed:false, cancelled:false", async () => {
    h = setup();
    // Remove the account file so removeAccountSafely throws
    const accountFile = path.join(h.accDir, `${TEST_EMAIL}.json`);
    fs.rmSync(accountFile, { force: true });

    const results: RemoveAccountResult[] = [];
    const preview = { lines: ['• Account file /tmp/x.json'], hadAliases: false };
    instance = render(
      <RemoveAccountScreen
        email={TEST_EMAIL}
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialStep={{ kind: 'confirm', preview }}
        onDone={(r) => { results.push(r); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressKey('y');
    await tick();
    await tick();
    assert.equal(results.length, 1, 'onDone should be called once on error');
    assert.equal(results[0]?.removed, false);
    assert.equal(results[0]?.cancelled, false);
  });
});

// ---------------------------------------------------------------------------
// buildPreview — unit tests (exported for testability)
// ---------------------------------------------------------------------------

describe('buildPreview', () => {
  let h: Harness;

  afterEach(() => {
    if (h) teardown(h);
  });

  it('returns error when account file does not exist', () => {
    h = setup();
    const result = buildPreview('nonexistent@example.com', h.accDir);
    assert.ok('error' in result, 'expected error result');
    assert.match((result as { error: string }).error, /No saved account/i);
  });

  it('returns preview lines with account file path when file exists', () => {
    h = setup();
    const result = buildPreview(TEST_EMAIL, h.accDir);
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`);
    const preview = result as { lines: string[]; hadAliases: boolean };
    assert.ok(preview.lines.some((l) => l.includes('Account file')), 'expected account file line');
    assert.equal(preview.hadAliases, false);
  });

  it('returns preview with hadAliases:false when account exists without aliases', () => {
    h = setup('other@example.com', TEST_EMAIL);
    const result = buildPreview(TEST_EMAIL, h.accDir);
    assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`);
    const preview = result as { lines: string[]; hadAliases: boolean };
    assert.equal(preview.hadAliases, false);
    assert.ok(preview.lines.length >= 1, 'expected at least one preview line');
  });
});
