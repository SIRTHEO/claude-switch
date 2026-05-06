// test/ui/home.test.tsx
// Keystroke-driven coverage for the Home (dashboard) screen.
//
// home.tsx has no subprocess spawn — it reads from disk via
// useSnapshot() and dispatches HomeAction events back to the caller via
// onExit. Tests assert two things: (a) the rendered frame contains the
// state we expect for a given disk layout, (b) hotkeys raise the right
// HomeAction.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import { HomeScreen, type HomeExit } from '../../src/ui/screens/home.js';
import { save as saveAccount } from '../../src/accounts.js';

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
  email: string;
}

function setup(emails: string[] = ['active@example.com', 'other@example.com']): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-home-ui-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  // Active account is the first one — its email goes into oauthAccount.
  const active = emails[0]!;
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: active } }));
  for (const e of emails) saveAccount(e, claudeJson, accDir);
  // saveAccount mutates oauthAccount.emailAddress to the email being saved,
  // so put the active one back at the end to match the on-disk current.
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: active } }));
  return { tmpDir, claudeJson, accDir, email: active };
}

function teardown(h: Harness): void {
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

describe('HomeScreen — render', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('renders the brand line and the account list on first frame', async () => {
    const { lastFrame } = render(
      <HomeScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialNotice={null}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    assert.match(frame, /claude-switch/, 'expected brand line');
    assert.ok(
      frame.includes('active@example.com'),
      `expected the active account email in the frame — got:\n${frame}`,
    );
    assert.ok(
      frame.includes('other@example.com'),
      `expected the second account email in the frame — got:\n${frame}`,
    );
  });

  it('shows the empty-state hint when no accounts exist', async () => {
    // Wipe the seeded accounts so the dir lists empty.
    for (const f of fs.readdirSync(h.accDir)) fs.unlinkSync(path.join(h.accDir, f));
    fs.writeFileSync(h.claudeJson, JSON.stringify({}));
    const { lastFrame } = render(
      <HomeScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialNotice={null}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    assert.match(frame, /No accounts yet/, `expected empty-state copy — got:\n${frame}`);
  });
});

describe('HomeScreen — hotkeys', () => {
  let h: Harness;
  let exits: HomeExit[];
  beforeEach(() => {
    h = setup();
    exits = [];
  });
  afterEach(() => teardown(h));

  function mount() {
    return render(
      <HomeScreen
        claudeJsonPath={h.claudeJson}
        accountsDirPath={h.accDir}
        initialNotice={null}
        onExit={(e) => { exits.push(e); }}
      />,
    );
  }

  it('q triggers the exit action', async () => {
    const { stdin } = mount();
    await tick();
    stdin.write('q');
    await tick();
    assert.equal(exits.length, 1, 'expected exactly one onExit call');
    assert.equal(exits[0]?.action, 'exit');
  });

  it('a (Add account) triggers the add action', async () => {
    const { stdin } = mount();
    await tick();
    stdin.write('a');
    await tick();
    assert.equal(exits.length, 1);
    assert.equal(exits[0]?.action, 'add');
  });

  it('g (Settings) triggers the settings action', async () => {
    const { stdin } = mount();
    await tick();
    stdin.write('g');
    await tick();
    assert.equal(exits.length, 1);
    assert.equal(exits[0]?.action, 'settings');
  });
});
