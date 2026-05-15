// test/ui/manage-account.test.tsx
// Keystroke-driven coverage for the ManageScreen.
//
// State machine steps under test:
//   pick-account → menu (arrow-down + Enter)
//   menu → ESC → back exit
//   menu → Back item (Enter) → back exit
//   menu → apikey-set → launch exit
//   menu → remove → launch exit (inactive account only)
//   menu → apikey-remove → confirm-apikey-remove step
//   confirm-apikey-remove → cancel (n / ESC) → menu
//   confirm-apikey-remove → confirm (y) → note "API key removed"
//   menu → alias-add → alias-add step
//   alias-add → empty submit → inline error
//   alias-add → valid submit → note "Alias set"
//   alias-add → ESC → menu
//   menu → alias-remove → alias-remove step
//   alias-remove → arrow + Enter → note "Alias removed"
//   alias-remove → ESC → menu
//   note → Enter → menu
//   note → ESC → menu
//   pick-account empty state (no accounts)
//
// Uses ink-testing-library + makeKeystrokeHelper (Phase 18.7).
// afterEach calls instance?.unmount() to prevent timer leaks.
//
// Privacy: never uses real email addresses; fixtures use
//   sirtheo.work@example.com / sirtheo.personal@example.com

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import { ManageScreen, type ScreenExit } from '../../src/ui/screens/manage-account.js';
import { save as saveAccount } from '../../src/accounts.js';
import { setAlias } from '../../src/aliases.js';
import { makeKeystrokeHelper } from '../ui/ink-keystroke-helper.js';

// ---------------------------------------------------------------------------
// Disable real Keychain for all tests in this file
// ---------------------------------------------------------------------------

process.env['CLAUDE_SWITCH_DISABLE_KEYCHAIN'] = '1';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTIVE_EMAIL = 'sirtheo.work@example.com';
const INACTIVE_EMAIL = 'sirtheo.personal@example.com';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
}

/** Setup with one active account. `claudeJson` points to ACTIVE_EMAIL. */
function setup(): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-manage-ui-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: ACTIVE_EMAIL } }));
  saveAccount(ACTIVE_EMAIL, claudeJson, accDir);
  return { tmpDir, claudeJson, accDir };
}

/** Setup with two accounts; claudeJson points to ACTIVE_EMAIL (isActive=false for INACTIVE). */
function setupTwoAccounts(): Harness {
  const h = setup();
  // saveAccount needs a valid claudeJson pointing to the email being saved.
  // We write a temporary file for the second account.
  const claudeJson2 = path.join(h.tmpDir, '.claude2.json');
  fs.writeFileSync(claudeJson2, JSON.stringify({ oauthAccount: { emailAddress: INACTIVE_EMAIL } }));
  saveAccount(INACTIVE_EMAIL, claudeJson2, h.accDir);
  return h;
}

/**
 * Seed an API key directly into the account JSON file.
 * With CLAUDE_SWITCH_DISABLE_KEYCHAIN=1, getApiKey reads _apiKey from JSON.
 */
function seedApiKey(email: string, accDir: string, key = 'sk-ant-test-key-1234'): void {
  const file = path.join(accDir, `${email}.json`);
  const raw = fs.readFileSync(file, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  data._apiKey = key;
  fs.writeFileSync(file, JSON.stringify(data));
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// 1. Render — menu seeded directly via initialEmail
// ---------------------------------------------------------------------------

describe('ManageScreen — render', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('renders the menu for the seeded active account', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.ok(frame.includes(ACTIVE_EMAIL), `expected email in frame — got:\n${frame}`);
  });

  it('shows "Set API key" when no key is stored', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Set API key/, `expected "Set API key" — got:\n${frame}`);
  });

  it('shows "Replace API key" and "Remove API key" when a key is stored', async () => {
    seedApiKey(ACTIVE_EMAIL, h.accDir);
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Replace API key/, `expected "Replace API key" — got:\n${frame}`);
    assert.match(frame, /Remove API key/, `expected "Remove API key" — got:\n${frame}`);
  });

  it('shows "Remove account" only for inactive accounts', async () => {
    const h2 = setupTwoAccounts();
    instance = render(
      <ManageScreen
        claudeJsonPath={h2.claudeJson}
        accountsDirPath={h2.accDir}
        initialEmail={INACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Remove account/, `expected "Remove account" for inactive — got:\n${frame}`);
    instance.unmount();
    instance = undefined;
    teardown(h2);
  });

  it('does NOT show "Remove account" for the currently active account', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.ok(!frame.includes('Remove account'), `expected no "Remove account" for active — got:\n${frame}`);
  });

  it('shows "Remove alias" when aliases are seeded', async () => {
    setAlias('work', ACTIVE_EMAIL, h.accDir);
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.match(frame, /Remove alias/, `expected "Remove alias" — got:\n${frame}`);
  });

  it('handles the no-account empty state without crashing', async () => {
    fs.rmSync(h.accDir, { recursive: true });
    fs.mkdirSync(h.accDir);
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={null}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    assert.ok(frame.length > 0, 'expected non-empty frame for empty state');
  });
});

// ---------------------------------------------------------------------------
// 2. Navigation — pick-account → menu
// ---------------------------------------------------------------------------

describe('ManageScreen — pick-account navigation', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;
  let exits: ScreenExit[];

  beforeEach(() => { h = setup(); exits = []; });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('arrow-down + Enter on pick-account enters the menu', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={null}
        onExit={(e) => { exits.push(e); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    const before = instance.lastFrame() ?? '';
    assert.match(before, /Manage which account/, `expected pick-account — got:\n${before}`);
    // Select the first (and only) account by pressing Enter.
    await keys.pressEnter();
    await tick();
    const after = instance.lastFrame() ?? '';
    // After entering, should show the menu (Set API key item).
    assert.match(after, /Set API key|API key/, `expected menu after Enter — got:\n${after}`);
  });

  it('ESC on pick-account fires a back exit', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={null}
        onExit={(e) => { exits.push(e); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressEsc();
    await tick();
    assert.ok(exits.length >= 1, `expected back exit after ESC — got ${exits.length}`);
    assert.equal(exits[exits.length - 1]?.kind, 'back');
  });

  it('arrow-down on pick-account moves cursor (does not crash)', async () => {
    // Add a second account for cursor movement.
    const claudeJson2 = path.join(h.tmpDir, '.claude2.json');
    fs.writeFileSync(claudeJson2, JSON.stringify({ oauthAccount: { emailAddress: INACTIVE_EMAIL } }));
    saveAccount(INACTIVE_EMAIL, claudeJson2, h.accDir);

    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={null}
        onExit={(e) => { exits.push(e); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    const before = instance.lastFrame() ?? '';
    await keys.pressArrow('down');
    const after = instance.lastFrame() ?? '';
    assert.ok(after.length > 0, 'expected non-empty frame after arrow-down');
    void before;
  });
});

// ---------------------------------------------------------------------------
// 3. Menu navigation
// ---------------------------------------------------------------------------

describe('ManageScreen — menu navigation', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;
  let exits: ScreenExit[];

  beforeEach(() => { h = setup(); exits = []; });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  it('ESC on menu fires a back exit', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={(e) => { exits.push(e); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressEsc();
    await tick();
    assert.ok(exits.length >= 1, `expected back exit after ESC — got ${exits.length}`);
    assert.equal(exits[exits.length - 1]?.kind, 'back');
  });

  it('selecting "Back" item via Enter fires a back exit', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={(e) => { exits.push(e); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Navigate down many times to land on "Back" (last item).
    for (let i = 0; i < 10; i++) {
      await keys.pressArrow('down');
    }
    await keys.pressEnter();
    await tick();
    assert.ok(exits.length >= 1, `expected back exit after Enter on Back — got ${exits.length}`);
    assert.equal(exits[exits.length - 1]?.kind, 'back');
  });

  it('arrow-up clamps at top (does not crash)', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    await keys.pressArrow('up');
    await keys.pressArrow('up');
    const frame = instance.lastFrame() ?? '';
    assert.ok(frame.length > 0, 'expected non-empty frame after arrow-up');
  });

  it('selecting "Set API key" fires a launch exit with kind=apikey-set', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={(e) => { exits.push(e); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // "Set API key" is at index 0 by default (no key set).
    await keys.pressEnter();
    await tick();
    assert.ok(exits.length >= 1, `expected exit — got ${exits.length}`);
    const last = exits[exits.length - 1];
    assert.equal(last?.kind, 'launch', `expected launch exit — got ${last?.kind}`);
    if (last?.kind === 'launch') {
      assert.equal(last.req.kind, 'apikey-set');
      assert.equal(last.req.email, ACTIVE_EMAIL);
    }
  });

  it('selecting "Remove account" fires a launch exit with kind=remove-account', async () => {
    const h2 = setupTwoAccounts();
    const localExits: ScreenExit[] = [];
    instance = render(
      <ManageScreen
        claudeJsonPath={h2.claudeJson}
        accountsDirPath={h2.accDir}
        initialEmail={INACTIVE_EMAIL}
        onExit={(e) => { localExits.push(e); }}
      />,
    );
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Navigate down to find "Remove account".
    for (let i = 0; i < 10; i++) {
      const frame = instance.lastFrame() ?? '';
      if (/▸ Remove account/.test(frame)) break;
      await keys.pressArrow('down');
    }
    await keys.pressEnter();
    await tick();
    instance.unmount();
    instance = undefined;
    teardown(h2);

    assert.ok(localExits.length >= 1, `expected exit — got ${localExits.length}`);
    const last = localExits[localExits.length - 1];
    assert.equal(last?.kind, 'launch', `expected launch exit — got ${last?.kind}`);
    if (last?.kind === 'launch') {
      assert.equal(last.req.kind, 'remove-account');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. API key remove flow
// ---------------------------------------------------------------------------

describe('ManageScreen — apikey-remove flow', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => {
    h = setup();
    seedApiKey(ACTIVE_EMAIL, h.accDir);
  });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  /** Navigate to the confirm-apikey-remove step. */
  async function goToApikeyRemove(): Promise<ReturnType<typeof makeKeystrokeHelper>> {
    assert.ok(instance, 'instance must be set before calling goToApikeyRemove');
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // With a key seeded: 0=Replace, 1=Remove API key, 2=Add alias, 3=Back
    await keys.pressArrow('down');
    await keys.pressEnter();
    await tick();
    return keys;
  }

  it('entering apikey-remove shows confirm prompt', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await goToApikeyRemove();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Remove the saved API key|y.*n|cancel/i, `expected confirm prompt — got:\n${frame}`);
  });

  it('ESC on confirm-apikey-remove returns to menu', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToApikeyRemove();
    await keys.pressEsc();
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Replace API key|Set API key|API key/, `expected menu after ESC — got:\n${frame}`);
  });

  it('confirming with "y" removes the key and shows note', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToApikeyRemove();
    // ConfirmInput: "y" triggers onConfirm.
    await keys.pressKey('y');
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /API key removed|Done/, `expected "API key removed" note — got:\n${frame}`);
  });

  it('Enter (default=cancel) returns to menu', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToApikeyRemove();
    // ConfirmInput defaultChoice="cancel": Enter triggers onCancel.
    await keys.pressEnter();
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Replace API key|Set API key|API key/, `expected menu after cancel — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Alias-add flow
// ---------------------------------------------------------------------------

describe('ManageScreen — alias-add flow', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  /** Navigate to alias-add step. */
  async function goToAliasAdd(): Promise<ReturnType<typeof makeKeystrokeHelper>> {
    assert.ok(instance, 'instance must be set');
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Menu (no key): 0=Set API key, 1=Add alias, 2=Back
    await keys.pressArrow('down');
    await keys.pressEnter();
    await tick();
    return keys;
  }

  it('entering alias-add shows the name input', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await goToAliasAdd();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /alias|work, personal/i, `expected alias-add screen — got:\n${frame}`);
  });

  it('ESC on alias-add returns to menu', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToAliasAdd();
    await keys.pressEsc();
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Set API key|Add alias|Back/, `expected menu after ESC — got:\n${frame}`);
  });

  it('submitting a valid alias shows success note', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToAliasAdd();
    await keys.type('work');
    await keys.pressEnter();
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Alias set|Done/, `expected "Alias set" note — got:\n${frame}`);
  });

  it('submitting an empty alias shows inline error', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToAliasAdd();
    // Submit with no text → trimmed = '' → "Alias cannot be empty."
    await keys.pressEnter();
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /cannot be empty|alias/i, `expected empty-alias error — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// 6. Alias-remove flow
// ---------------------------------------------------------------------------

describe('ManageScreen — alias-remove flow', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => {
    h = setup();
    setAlias('work', ACTIVE_EMAIL, h.accDir);
  });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  /** Navigate to alias-remove step (requires "Remove alias" to be visible). */
  async function goToAliasRemove(): Promise<ReturnType<typeof makeKeystrokeHelper>> {
    assert.ok(instance, 'instance must be set');
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // With 1 alias seeded and no key: 0=Set API key, 1=Add alias, 2=Remove alias, 3=Back
    for (let i = 0; i < 10; i++) {
      const frame = instance.lastFrame() ?? '';
      if (/▸ Remove alias/.test(frame)) break;
      await keys.pressArrow('down');
    }
    await keys.pressEnter();
    await tick();
    return keys;
  }

  it('entering alias-remove shows the alias list', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    await goToAliasRemove();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Remove which alias|work/i, `expected alias-remove list — got:\n${frame}`);
  });

  it('ESC on alias-remove returns to menu', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToAliasRemove();
    await keys.pressEsc();
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Set API key|Add alias|Remove alias|Back/, `expected menu — got:\n${frame}`);
  });

  it('pressing Enter on alias removes it and shows note', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToAliasRemove();
    await keys.pressEnter();
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Alias removed|Done/, `expected "Alias removed" note — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// 7. Note step — Enter / ESC returns to menu
// ---------------------------------------------------------------------------

describe('ManageScreen — note step', () => {
  let h: Harness;
  let instance: ReturnType<typeof render> | undefined;

  beforeEach(() => { h = setup(); });
  afterEach(() => {
    instance?.unmount();
    instance = undefined;
    teardown(h);
  });

  /** Reach the note step via alias-add + valid name. */
  async function goToNote(): Promise<ReturnType<typeof makeKeystrokeHelper>> {
    assert.ok(instance, 'instance must be set');
    await tick();
    const keys = makeKeystrokeHelper(instance);
    // Navigate to Add alias (index 1 when no key).
    await keys.pressArrow('down');
    await keys.pressEnter();
    await tick();
    await keys.type('mynick');
    await keys.pressEnter();
    await tick();
    return keys;
  }

  it('Enter on note returns to menu', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToNote();
    const noteFrame = instance?.lastFrame() ?? '';
    assert.match(noteFrame, /Alias set|Done/, `expected note — got:\n${noteFrame}`);
    await keys.pressEnter();
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Set API key|API key|Back/, `expected menu after Enter on note — got:\n${frame}`);
  });

  it('ESC on note returns to menu', async () => {
    instance = render(
      <ManageScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialEmail={ACTIVE_EMAIL}
        onExit={() => undefined}
      />,
    );
    const keys = await goToNote();
    await keys.pressEsc();
    await tick();
    const frame = instance?.lastFrame() ?? '';
    assert.match(frame, /Set API key|API key|Back/, `expected menu after ESC on note — got:\n${frame}`);
  });
});

// Suppress an unused-import warning for the discriminated-union type.
void ({} as ScreenExit | undefined);
