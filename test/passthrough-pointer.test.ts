// test/passthrough-pointer.test.ts
// Slice 4a of the unified-profile model: the default-pointer DIVERT on the bare
// `claude` path. When `defaultPointer` resolves to a NON-default workspace,
// handlePassthrough must run THAT profile isolated (CLAUDE_CONFIG_DIR set, its
// own creds) and bypass the global-account snapshot — without overwriting the
// global. `default` (the unset/sentinel pointer) must fall through to today's
// flow unchanged. The divert is the load-bearing half of 4a; this locks it.
//
// The legacy `claude switch <email>` overwrite is intentionally NOT exercised
// here — it is unchanged in 4a (the breaking re-point flip is 4b).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handlePassthrough } from '../src/commands/passthrough.js';
import { getCurrent, save } from '../src/accounts/accounts.js';
import { setDefaultPointer } from '../src/profiles/workspaces.js';
import { createProfile } from '../src/profiles/profiles.js';
import { readRaw } from '../src/sessions/session-registry.js';
import { ExitError } from '../src/platform/errors.js';
import type { CommandContext } from '../src/commands/context.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

describe('handlePassthrough — default-pointer divert (slice 4a)', () => {
  let home: string;
  let accDir: string;
  let claudeJson: string;
  let savedHome: SavedHome;
  let savedBin: string | undefined;
  let savedCwd: string;
  let savedCcd: string | undefined;
  let savedAccount: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pointer-'));
    savedHome = setFakeHome(home);
    accDir = path.join(home, '.claude', 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
    claudeJson = path.join(home, '.claude.json');

    // Global active account = personal (the future frozen `default`).
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'sirtheo.personal@example.com' } }));
    save('sirtheo.personal@example.com', claudeJson, accDir);

    savedBin = process.env.CLAUDE_SWITCH_BIN;
    process.env.CLAUDE_SWITCH_BIN = process.execPath;
    savedCcd = process.env.CLAUDE_CONFIG_DIR;
    savedAccount = process.env.CLAUDE_SWITCH_ACCOUNT;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_SWITCH_ACCOUNT;
    // Neutral cwd (no .git / .claude-switch) so cwd-routing finds nothing.
    savedCwd = process.cwd();
    process.chdir(home);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    restoreFakeHome(savedHome);
    if (savedBin === undefined) delete process.env.CLAUDE_SWITCH_BIN; else process.env.CLAUDE_SWITCH_BIN = savedBin;
    if (savedCcd === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCcd;
    if (savedAccount === undefined) delete process.env.CLAUDE_SWITCH_ACCOUNT; else process.env.CLAUDE_SWITCH_ACCOUNT = savedAccount;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function ctx(): CommandContext {
    return { claudeJsonPath: claudeJson, accountsDirPath: accDir, updateInfo: null, selfUrl: import.meta.url };
  }

  /** A logged-in profile dir (oauthAccount present → hasLogin under the
   *  disable-keychain test flag). */
  function createLoggedInProfile(name: string, email: string): string {
    const dir = createProfile(name);
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ userID: 'w'.repeat(64), oauthAccount: { emailAddress: email } }),
    );
    return dir;
  }

  function captureRun(): { calls: Array<NodeJS.ProcessEnv | null | undefined>; runClaude: (b: string, a: string[], env?: NodeJS.ProcessEnv | null) => never } {
    const calls: Array<NodeJS.ProcessEnv | null | undefined> = [];
    return {
      calls,
      runClaude: ((_b: string, _a: string[], env?: NodeJS.ProcessEnv | null) => {
        calls.push(env);
        return undefined as never;
      }),
    };
  }

  it('non-default pointer → launches that profile isolated, global untouched', async () => {
    const workDir = createLoggedInProfile('work', 'sirtheo.work@example.com');
    setDefaultPointer(accDir, 'work');
    const { calls, runClaude } = captureRun();

    await handlePassthrough(ctx(), ['--help'], { runClaude });

    assert.equal(calls.length, 1, 'claude must be launched once');
    assert.equal(calls[0]?.CLAUDE_CONFIG_DIR, workDir, 'must spawn isolated against the pointed profile');
    // The global default slot is NOT overwritten by the divert.
    assert.equal(getCurrent(claudeJson), 'sirtheo.personal@example.com');
    // Recorded as an isolated session for the profile's account.
    const recorded = readRaw(accDir).filter((s) => s.account === 'sirtheo.work@example.com');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.isolated, true);
  });

  it("default pointer → falls through to the global flow (no CLAUDE_CONFIG_DIR injected)", async () => {
    setDefaultPointer(accDir, 'default');
    const { calls, runClaude } = captureRun();

    await handlePassthrough(ctx(), ['--help'], { runClaude });

    assert.equal(calls.length, 1, 'claude must be launched once via the global flow');
    assert.equal(calls[0]?.CLAUDE_CONFIG_DIR, undefined, 'default must not inject a profile dir');
  });

  it('absent pointer (pre-unified install) → also falls through unchanged', async () => {
    // No setDefaultPointer call at all — state file may not even exist.
    const { calls, runClaude } = captureRun();
    await handlePassthrough(ctx(), ['--help'], { runClaude });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.CLAUDE_CONFIG_DIR, undefined);
  });

  it('pointer to an un-logged-in profile → refuses (throws), does not launch', async () => {
    createProfile('empty'); // exists but never logged in
    setDefaultPointer(accDir, 'empty');
    const { calls, runClaude } = captureRun();

    await assert.rejects(
      () => handlePassthrough(ctx(), ['--help'], { runClaude }),
      (e: unknown) => e instanceof ExitError && /has no login yet/.test(e.message),
    );
    assert.equal(calls.length, 0, 'a broken profile must not be launched');
  });

  it('external CLAUDE_CONFIG_DIR present → no divert (honors the user-pinned dir)', async () => {
    createLoggedInProfile('work', 'sirtheo.work@example.com');
    setDefaultPointer(accDir, 'work');
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'external-pin');
    const { calls, runClaude } = captureRun();

    await handlePassthrough(ctx(), ['--help'], { runClaude });

    assert.equal(calls.length, 1);
    // The divert is skipped: the override map carries no profile dir (the
    // external CCD rides on process.env, inherited by the real spawn, not on
    // our injected override). The global flow ran instead.
    assert.equal(calls[0]?.CLAUDE_CONFIG_DIR, undefined, 'must not divert when the user already pinned a dir');
  });
});
