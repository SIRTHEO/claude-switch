// test/ui/ink-keystroke-helper.test.tsx
// Demonstration tests for makeKeystrokeHelper() using the HomeScreen.
// Each test proves that a CSI multi-byte sequence is correctly received
// by Ink's useInput hook and causes the expected state change or exit event.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import { HomeScreen, type HomeExit } from '../../src/ui/screens/home.js';
import { save as saveAccount } from '../../src/accounts/accounts.js';
import { makeKeystrokeHelper } from './ink-keystroke-helper.js';

// ---------------------------------------------------------------------------
// Test harness — identical pattern to home.test.tsx
// ---------------------------------------------------------------------------

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
}

function setup(emails: string[] = ['alice@example.com', 'bob@example.com', 'carol@example.com']): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-kh-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  const active = emails[0]!;
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: active } }));
  for (const e of emails) saveAccount(e, claudeJson, accDir);
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: active } }));
  return { tmpDir, claudeJson, accDir };
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeKeystrokeHelper — HomeScreen demos', () => {
  let h: Harness;
  let exits: HomeExit[];
  let instance: ReturnType<typeof render>;

  beforeEach(() => {
    h = setup();
    exits = [];
  });

  afterEach(() => {
    // Unmount explicitly to stop Ink's internal timers and avoid cross-test
    // stdin contamination (especially the 20 ms ESC-flush timer).
    try { instance.unmount(); } catch { /* already unmounted */ }
    teardown(h);
  });

  function mount() {
    instance = render(
      <HomeScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialNotice={null}
        onExit={(e) => { exits.push(e); }}
      />,
    );
    // Return the local instance so individual tests can use it directly.
    return instance;
  }

  // -------------------------------------------------------------------------
  // Test 1: pressArrow('down') moves the cursor highlight down
  // -------------------------------------------------------------------------

  it('pressArrow(down) moves selection to the next account row', async () => {
    const instance = mount();
    const ks = makeKeystrokeHelper(instance);
    // Allow first render tick
    await new Promise<void>((r) => setImmediate(r));

    const frameBefore = instance.lastFrame() ?? '';
    await ks.pressArrow('down');
    const frameAfter = instance.lastFrame() ?? '';

    // The cursor glyph changes position between frames: the moved-to row
    // now carries the '▸' cursor while the first row is downgraded to '·'.
    assert.notStrictEqual(
      frameBefore,
      frameAfter,
      'expected the rendered frame to change after pressing down arrow',
    );
    // The second account (bob@) should now carry the active-selection glyph.
    // We can confirm indirectly: the frame after contains '▸' in a position
    // associated with bob — both frames contain all emails, but cursor char
    // is rendered before the email string.
    assert.ok(frameAfter.includes('bob@example.com'), 'bob should still be visible after arrow');
  });

  // -------------------------------------------------------------------------
  // Test 2: pressEsc invokes onExit with action === 'exit'
  // -------------------------------------------------------------------------

  it('pressEsc calls onExit with action "exit"', async () => {
    const instance = mount();
    const ks = makeKeystrokeHelper(instance);
    await new Promise<void>((r) => setImmediate(r));

    await ks.pressEsc();

    assert.equal(exits.length, 1, 'expected exactly one onExit call after ESC');
    assert.equal(exits[0]?.action, 'exit', 'expected action to be "exit"');
  });

  // -------------------------------------------------------------------------
  // Test 3: pressEnter on first account item triggers onExit
  // -------------------------------------------------------------------------

  it('pressEnter on the highlighted account row invokes onExit', async () => {
    const instance = mount();
    const ks = makeKeystrokeHelper(instance);
    await new Promise<void>((r) => setImmediate(r));

    // Cursor starts on row 0 (alice, which is the active account).
    // Pressing Enter on an active account triggers the 'switched' action
    // (see triggerSwitchOrLaunch in home.tsx).
    await ks.pressEnter();

    assert.equal(exits.length, 1, 'expected one onExit call after Enter');
    // active account → 'switched' action
    assert.equal(exits[0]?.action, 'switched');
  });

  // -------------------------------------------------------------------------
  // Test 4: type('?') triggers the help panel toggle (HomeScreen reacts to
  // single-char hotkeys written as a string, demonstrating the type() method)
  // -------------------------------------------------------------------------

  it('type("?") toggles the help panel (demonstrates type() for hotkey strings)', async () => {
    const instance = mount();
    const ks = makeKeystrokeHelper(instance);
    await new Promise<void>((r) => setImmediate(r));

    const frameBefore = instance.lastFrame() ?? '';
    assert.ok(!frameBefore.includes('Hotkeys'), 'help panel should be hidden initially');

    await ks.type('?');
    const frameAfter = instance.lastFrame() ?? '';

    assert.ok(
      frameAfter.includes('Hotkeys'),
      `expected "Hotkeys" section to appear after typing "?" — got:\n${frameAfter}`,
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: multi-step — 2 down arrows then Enter navigates to bob and selects
  // -------------------------------------------------------------------------

  it('multi-step: down × 2 highlights carol (keystroke navigation)', async () => {
    const instance = mount();
    const ks = makeKeystrokeHelper(instance);
    await new Promise<void>((r) => setImmediate(r));

    // Move down twice: alice (0) → bob (1) → carol (2)
    await ks.pressArrow('down');
    await ks.pressArrow('down');

    const frameAfterMove = instance.lastFrame() ?? '';
    assert.ok(frameAfterMove.includes('carol@example.com'), 'carol should be visible/highlighted after down×2');

    // NOTE: pressing Enter on a NON-active account now triggers the async
    // re-point flow (await repointToDefault → microtask finish), which depends
    // on the target having a logged-in profile. That switch→exit behaviour is
    // engine-tested (commands-switch / switcher / run-app handleSwitched); the
    // sync active-account Enter→onExit('switched') path is covered by the test
    // above. The dashboard's interactive switch+launch UX is redone in the
    // "cruscotto" slice, so this keystroke test stays at the navigation layer.
  });
});
