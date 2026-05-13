// test/ui/profiles.test.tsx
// Keystroke-driven coverage for the Profiles screen — pre-spawn paths
// only. The launch path eventually calls spawnSync(claude, ...); those
// branches are out of scope (would need DI on spawnSync) and are
// covered by manual smoke. Here we exercise navigation and the back
// path, which are both spawn-free.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';

import { ProfilesScreen, type ScreenExit } from '../../src/ui/screens/profiles.js';
import { save as saveAccount } from '../../src/accounts.js';

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
  email: string;
  prevHome: string | undefined;
}

function setup(): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-profiles-ui-'));
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  const email = 'a@b.com';
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  saveAccount(email, claudeJson, accDir);
  // profiles.ts reads from ~/.claude/profiles via os.homedir() — point
  // HOME at tmpDir for the duration of this test.
  const prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
  // Empty profiles dir so listProfiles() returns []; some menu items
  // gate on that.
  fs.mkdirSync(path.join(tmpDir, '.claude', 'profiles'), { recursive: true });
  return { tmpDir, claudeJson, accDir, email, prevHome };
}

function teardown(h: Harness): void {
  if (h.prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = h.prevHome;
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

// Control sequences ink's input decoder recognises.
const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;

describe('ProfilesScreen — render', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('renders the home menu with at least the Back row', async () => {
    const { lastFrame } = render(
      <ProfilesScreen accountsDirPath={h.accDir} initialNotice={null} onExit={() => undefined} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    assert.match(frame, /Back to main menu/, `expected Back row — got:\n${frame}`);
  });

  it('shows "Open account isolated" when at least one account exists', async () => {
    const { lastFrame } = render(
      <ProfilesScreen accountsDirPath={h.accDir} initialNotice={null} onExit={() => undefined} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    assert.match(frame, /Open account isolated/i,
      `expected "Open account isolated" with seeded account — got:\n${frame}`);
  });
});

describe('ProfilesScreen — navigation', () => {
  let h: Harness;
  let exits: ScreenExit[];
  beforeEach(() => { h = setup(); exits = []; });
  afterEach(() => teardown(h));

  function mount() {
    return render(
      <ProfilesScreen
        accountsDirPath={h.accDir}
        initialNotice={null}
        onExit={(e) => { exits.push(e); }}
      />,
    );
  }

  it('arrow-down moves the cursor visibly between menu rows', async () => {
    const { stdin, lastFrame } = mount();
    await tick();
    const before = lastFrame() ?? '';
    stdin.write(ARROW_DOWN);
    await tick();
    const after = lastFrame() ?? '';
    // Ink draws the cursor as a left-margin marker on the focused row;
    // re-rendering after a key press must change the frame. We don't
    // assert on a specific glyph (the marker varies by component) — only
    // that the frame is no longer identical to the pre-keypress one.
    assert.notEqual(before, after,
      `expected the frame to change after ARROW_DOWN — same content rendered:\n${before}`);
  });

  it('selecting Back via Enter fires a back exit', async () => {
    const { stdin, lastFrame } = mount();
    await tick();
    // Down-arrow sequences (CSI B) to reach the last item (Back). Cursor
    // clamps at the last row, so over-shooting is safe.
    for (let i = 0; i < 10; i++) {
      stdin.write(ARROW_DOWN);
      await tick();
    }
    stdin.write('\r');
    await tick();
    assert.ok(exits.length >= 1,
      `expected at least one onExit — got ${exits.length}\nframe:\n${lastFrame()}`);
    assert.equal(exits[exits.length - 1]?.kind, 'back');
  });

  it('renders an initialNotice as the opening screen', async () => {
    const { lastFrame } = render(
      <ProfilesScreen
        accountsDirPath={h.accDir}
        initialNotice="welcome to profiles"
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    assert.match(frame, /welcome to profiles/, `expected initialNotice in frame — got:\n${frame}`);
  });
});

// ---------------------------------------------------------------------------
// spawnClaudeAndExit — unit tests (no Ink involved)
// ---------------------------------------------------------------------------
import { spawnClaudeAndExit } from '../../src/ui/screens/profiles.js';
import { ExitError } from '../../src/errors.js';

describe('spawnClaudeAndExit', () => {
  it('throws ExitError with code 1 when the binary does not exist', () => {
    assert.throws(
      () => spawnClaudeAndExit('/nonexistent-claude-binary-12345', [], { stdio: 'inherit' }),
      (err: unknown) => {
        assert.ok(err instanceof ExitError, `expected ExitError, got ${String(err)}`);
        assert.equal(err.code, 1);
        assert.match(err.message, /could not run claude/);
        return true;
      },
    );
  });

  it('throws ExitError with code 0 when the subprocess exits cleanly', () => {
    assert.throws(
      () => spawnClaudeAndExit(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'inherit' }),
      (err: unknown) => {
        assert.ok(err instanceof ExitError, `expected ExitError, got ${String(err)}`);
        assert.equal(err.code, 0);
        return true;
      },
    );
  });

  it('throws ExitError with code 42 when the subprocess exits with code 42', () => {
    assert.throws(
      () => spawnClaudeAndExit(process.execPath, ['-e', 'process.exit(42)'], { stdio: 'inherit' }),
      (err: unknown) => {
        assert.ok(err instanceof ExitError, `expected ExitError, got ${String(err)}`);
        assert.equal(err.code, 42);
        return true;
      },
    );
  });

  it('never calls process.exit directly — spawnClaudeAndExit is pure throw', () => {
    // Guard: if this test throws anything other than ExitError, we'd get
    // a test failure. If it called process.exit, the test runner would die.
    let threw = false;
    try {
      spawnClaudeAndExit('/nonexistent-claude-binary-12345', [], { stdio: 'inherit' });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof ExitError);
    }
    assert.ok(threw, 'expected spawnClaudeAndExit to throw');
  });
});
