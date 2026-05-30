// test/passthrough-isolate.test.ts
// 28.4 wiring: handlePassthrough must ACT on routing's token-mixing decision —
// launch the target's overlay isolated (CLAUDE_CONFIG_DIR set, no global swap)
// when a swap would clash, and refuse when no overlay is ready. The decision
// logic is unit-tested in passthrough-routing.test.ts; this proves the hot path
// consumes it (a launchIsolated that never reaches runClaude is a silent gap).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handlePassthrough } from '../src/commands/passthrough.js';
import { getCurrent, save } from '../src/accounts/accounts.js';
import { readRaw } from '../src/sessions/session-registry.js';
import { ExitError } from '../src/platform/errors.js';
import type { CommandContext } from '../src/commands/context.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

describe('handlePassthrough — 28.4 token-mixing prevention wiring', () => {
  let home: string;
  let accDir: string;
  let claudeJson: string;
  let repo: string;
  let savedHome: SavedHome;
  let savedBin: string | undefined;
  let savedCwd: string;
  let savedCcd: string | undefined;
  let savedAccount: string | undefined;
  let savedForce: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-isolate-'));
    savedHome = setFakeHome(home);
    accDir = path.join(home, '.claude', 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
    claudeJson = path.join(home, '.claude.json');
    repo = path.join(home, 'work', 'acme');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    // Two saved accounts; active = personal.
    for (const email of ['personal@gmail.com', 'theo@acme.com']) {
      fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
      save(email, claudeJson, accDir);
    }
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'personal@gmail.com' } }));

    // Route this repo to the acme account.
    fs.writeFileSync(path.join(repo, '.claude-switch'), '{"match":{"emailDomain":"acme.com"}}');
    // A live, global-bound session for personal → swapping to theo would clash.
    fs.writeFileSync(
      path.join(accDir, '.sessions.json'),
      JSON.stringify([
        { pid: process.pid, account: 'personal@gmail.com', configDir: null, isolated: false, cwd: repo, startedAt: 1 },
      ]),
    );

    savedBin = process.env.CLAUDE_SWITCH_BIN;
    process.env.CLAUDE_SWITCH_BIN = process.execPath;
    savedCcd = process.env.CLAUDE_CONFIG_DIR;
    savedAccount = process.env.CLAUDE_SWITCH_ACCOUNT;
    savedForce = process.env.CLAUDE_SWITCH_FORCE_SWAP;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_SWITCH_ACCOUNT;
    delete process.env.CLAUDE_SWITCH_FORCE_SWAP;
    savedCwd = process.cwd();
    process.chdir(repo); // handlePassthrough reads process.cwd() for routing
  });

  afterEach(() => {
    process.chdir(savedCwd);
    restoreFakeHome(savedHome);
    if (savedBin === undefined) delete process.env.CLAUDE_SWITCH_BIN; else process.env.CLAUDE_SWITCH_BIN = savedBin;
    if (savedCcd === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCcd;
    if (savedAccount === undefined) delete process.env.CLAUDE_SWITCH_ACCOUNT; else process.env.CLAUDE_SWITCH_ACCOUNT = savedAccount;
    if (savedForce === undefined) delete process.env.CLAUDE_SWITCH_FORCE_SWAP; else process.env.CLAUDE_SWITCH_FORCE_SWAP = savedForce;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function ctx(): CommandContext {
    return { claudeJsonPath: claudeJson, accountsDirPath: accDir, updateInfo: null, selfUrl: import.meta.url };
  }

  function createOverlay(name: string, email: string): string {
    const dir = path.join(home, '.claude', 'profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.cs-overlay'), '');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
    return dir;
  }

  it('launches the overlay isolated (CLAUDE_CONFIG_DIR set, no global swap)', async () => {
    const overlayDir = createOverlay('acme', 'theo@acme.com');
    const runCalls: Array<NodeJS.ProcessEnv | null | undefined> = [];

    await handlePassthrough(ctx(), ['--help'], {
      runClaude: ((_b: string, _a: string[], env?: NodeJS.ProcessEnv | null) => {
        runCalls.push(env);
        return undefined as never;
      }),
    });

    assert.equal(runCalls.length, 1, 'claude must be launched');
    assert.equal(runCalls[0]?.CLAUDE_CONFIG_DIR, overlayDir, 'must spawn isolated against the overlay');
    // Global active untouched — the live personal session keeps its token.
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com');
    // The isolated session was recorded.
    const recorded = readRaw(accDir).filter((s) => s.account === 'theo@acme.com');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.isolated, true);
  });

  it('refuses (throws) when a swap would clash and no overlay is ready', async () => {
    let launched = false;
    await assert.rejects(
      () =>
        handlePassthrough(ctx(), ['--help'], {
          runClaude: ((_b: string, _a: string[]) => {
            launched = true;
            return undefined as never;
          }),
        }),
      (e: unknown) => e instanceof ExitError && /Refusing to switch to theo@acme\.com/.test(e.message),
    );
    assert.equal(launched, false, 'claude must NOT be launched on refusal');
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com');
  });
});
