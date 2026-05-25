// test/ui/settings.test.tsx
// Keystroke-driven coverage for the Settings screen.
//
// Why this is the first stateful-screen suite: settings.tsx has no
// subprocess spawn and only touches per-account JSON under a tmp dir,
// so it's a clean validation of the ink-testing-library wiring before
// we replicate the pattern on home/profiles/setup-wizard.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import { SettingsScreen } from '../../src/ui/screens/settings.js';
import { save as saveAccount } from '../../src/accounts/accounts.js';
import { readGlobalPrefs, readStoredAccountPrefs } from '../../src/switching/preferences.js';

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
  email: string;
}

function setup(): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-settings-ui-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  const email = 'a@b.com';
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  saveAccount(email, claudeJson, accDir);
  return { tmpDir, claudeJson, accDir, email };
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

// Ink renders asynchronously: useEffect, setState, and useInput dispatch
// across microtask boundaries. A single setImmediate tick is enough to
// flush them on the versions of ink/ink-testing-library this repo uses,
// but wrap so the tests stay readable.
async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

describe('SettingsScreen — global tab', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('renders the global preferences tab on first frame', async () => {
    const { lastFrame } = render(
      <SettingsScreen accountsDirPath={h.accDir} initialAccount={h.email} onDone={() => undefined} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    // Tab indicator + at least one global pref row should be visible.
    assert.match(frame, /global/i, 'expected global tab indicator in first frame');
    assert.match(frame, /Auto-launch/i,
      'expected the auto-launch row to render in the global tab');
  });

  it('toggles a global preference when Enter is pressed on the cursor row', async () => {
    const before = readGlobalPrefs(h.accDir);
    const { stdin, lastFrame } = render(
      <SettingsScreen accountsDirPath={h.accDir} initialAccount={h.email} onDone={() => undefined} />,
    );
    await tick();
    // Cursor starts at row 0 (first global row). Press Enter to toggle.
    stdin.write('\r');
    await tick();
    const after = readGlobalPrefs(h.accDir);
    // At least one global flag must have flipped between before/after.
    const flipped = (Object.keys(before) as Array<keyof typeof before>).some(
      (k) => before[k] !== after[k],
    );
    assert.ok(flipped, `no global pref flipped — frame:\n${lastFrame()}`);
  });

  it('switches to the account tab on Tab key', async () => {
    const { stdin, lastFrame } = render(
      <SettingsScreen accountsDirPath={h.accDir} initialAccount={h.email} onDone={() => undefined} />,
    );
    await tick();
    stdin.write('\t');
    await tick();
    const frame = lastFrame() ?? '';
    // Account tab shows the email of the active account.
    assert.match(frame, new RegExp(h.email.replace(/[.@]/g, '.')),
      `expected active email "${h.email}" in account tab — got:\n${frame}`);
  });
});

describe('SettingsScreen — account tab', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('writes a per-account override when toggling on the account tab', async () => {
    const { stdin } = render(
      <SettingsScreen accountsDirPath={h.accDir} initialAccount={h.email} onDone={() => undefined} />,
    );
    await tick();
    stdin.write('\t'); // → account tab
    await tick();
    stdin.write('\r'); // toggle row 0 (first account-pref row)
    await tick();
    const stored = readStoredAccountPrefs(h.email, h.accDir);
    // Some explicit override key should now be present.
    const hasOverride = Object.values(stored).some((v) => v !== undefined);
    assert.ok(hasOverride, `expected at least one explicit override after toggle — got ${JSON.stringify(stored)}`);
  });

  it('exits via q key (calls onDone exactly once)', async () => {
    let doneCount = 0;
    const { stdin } = render(
      <SettingsScreen accountsDirPath={h.accDir} initialAccount={h.email} onDone={() => { doneCount++; }} />,
    );
    await tick();
    stdin.write('q');
    await tick();
    assert.equal(doneCount, 1);
  });
});
