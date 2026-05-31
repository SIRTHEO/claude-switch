// test/commands-switch.test.ts
// Coverage for `src/commands/switch.ts` — handleSwitchTo (the three
// fuzzy-match branches: 0 matches, 1 match, >1 matches).
// handleSwitchInteractive is not tested here because it either launches
// the Ink dashboard (TTY) or calls switchInteractive which requires stdin
// interaction — both would hang the test runner.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleSwitchTo } from '../src/commands/switch.js';
import { save as saveAccount, getCurrent } from '../src/accounts/accounts.js';
import { setAlias } from '../src/switching/aliases.js';
import type { CommandContext } from '../src/commands/context.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

interface Harness {
  tmpDir: string;
  claudeJson: string;
  accDir: string;
  ctx: CommandContext;
  stdout: string[];
  savedHome: SavedHome;
}

function setup(activeEmail?: string): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-switch-'));
  // The re-point path creates a profile under os.homedir()/.claude/profiles, so
  // HOME must be isolated or the test pollutes the real ~/.claude.
  const savedHome = setFakeHome(tmpDir);
  const claudeJson = path.join(tmpDir, '.claude.json');
  const accDir = path.join(tmpDir, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  if (activeEmail) {
    fs.writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { emailAddress: activeEmail },
    }));
    saveAccount(activeEmail, claudeJson, accDir);
  } else {
    fs.writeFileSync(claudeJson, '{}');
  }
  const ctx: CommandContext = {
    claudeJsonPath: claudeJson,
    accountsDirPath: accDir,
    updateInfo: null,
    selfUrl: fileURLToPath(import.meta.url),
  };
  return { tmpDir, claudeJson, accDir, ctx, stdout: [], savedHome };
}

function teardown(h: Harness): void {
  restoreFakeHome(h.savedHome);
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

function captureStdout(h: Harness): () => void {
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    h.stdout.push(args.map(String).join(' '));
  };
  return () => { console.log = origLog; };
}

// ---------------------------------------------------------------------------
// handleSwitchTo
// ---------------------------------------------------------------------------

describe('handleSwitchTo — no matches', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('a@example.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('prints a no-match message when target does not match any account', async () => {
    await handleSwitchTo(h.ctx, 'ghost@nowhere.com');
    const out = h.stdout.join('\n');
    assert.match(out, /No account matching/);
    assert.match(out, /claude switch list/);
  });
});

describe('handleSwitchTo — ambiguous (multiple matches)', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('alice@example.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('prints all matching accounts and asks user to be more specific', async () => {
    saveAccount('alfred@example.com', h.claudeJson, h.accDir);
    await handleSwitchTo(h.ctx, 'al');
    const out = h.stdout.join('\n');
    assert.match(out, /Multiple matches/);
    assert.match(out, /alice@example\.com/);
    assert.match(out, /alfred@example\.com/);
    assert.match(out, /Be more specific/);
  });
});

describe('handleSwitchTo — exact single match', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup('alice@example.com');
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('switches to the matched account and prints a confirmation', async () => {
    await handleSwitchTo(h.ctx, 'alice@example.com');
    const out = h.stdout.join('\n');
    // re-point reports the target account in its message
    assert.match(out, /alice@example\.com/);
  });

  it('resolves an alias before fuzzy matching', async () => {
    saveAccount('bob@example.com', h.claudeJson, h.accDir);
    setAlias('bob', 'bob@example.com', h.accDir);
    h.stdout.length = 0;
    await handleSwitchTo(h.ctx, 'bob');
    const out = h.stdout.join('\n');
    assert.match(out, /bob@example\.com/);
  });

  it('re-points WITHOUT overwriting ~/.claude (the global stays the active account)', async () => {
    // Unified-profile model: `claude switch <other>` re-points the default
    // pointer; it must NOT swap the global ~/.claude (that was the mixing bug).
    saveAccount('carol@example.com', h.claudeJson, h.accDir);
    h.stdout.length = 0;
    await handleSwitchTo(h.ctx, 'carol@example.com');
    assert.equal(getCurrent(h.claudeJson), 'alice@example.com', '~/.claude untouched by a re-point');
  });
});
