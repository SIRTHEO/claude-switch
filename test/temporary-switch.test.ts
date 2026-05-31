// test/temporary-switch.test.ts
// `claude --as <account>` (unified profile model, Fork C): launch the account
// ISOLATED for one session (CLAUDE_CONFIG_DIR set, no global swap), minting its
// profile on demand. The account already in the global ~/.claude (the frozen
// default) runs PLAIN — isolating it would mint a duplicate home (§1 invariant),
// so that path must NOT create a profile.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleTemporarySwitch } from '../src/commands/temporary-switch.js';
import { getCurrent, save } from '../src/accounts/accounts.js';
import { readRaw } from '../src/sessions/session-registry.js';
import { ExitError } from '../src/platform/errors.js';
import type { CommandContext } from '../src/commands/context.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

describe('handleTemporarySwitch — --as launch-once-isolated (Fork C)', () => {
  let home: string;
  let accDir: string;
  let claudeJson: string;
  let savedHome: SavedHome;
  let savedBin: string | undefined;
  let savedCcd: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-as-'));
    savedHome = setFakeHome(home);
    accDir = path.join(home, '.claude', 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
    claudeJson = path.join(home, '.claude.json');

    // Two saved accounts; active (global) = personal.
    for (const email of ['personal@gmail.com', 'work@acme.com']) {
      fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
      save(email, claudeJson, accDir);
    }
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'personal@gmail.com' } }));

    savedBin = process.env.CLAUDE_SWITCH_BIN;
    process.env.CLAUDE_SWITCH_BIN = process.execPath; // findClaude resolves to this
    savedCcd = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    restoreFakeHome(savedHome);
    if (savedBin === undefined) delete process.env.CLAUDE_SWITCH_BIN; else process.env.CLAUDE_SWITCH_BIN = savedBin;
    if (savedCcd === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCcd;
    // setFakeHome covered os.homedir() throughout any mint → profiles landed
    // under this tmp home and go with it.
    fs.rmSync(home, { recursive: true, force: true });
  });

  function ctx(): CommandContext {
    return { claudeJsonPath: claudeJson, accountsDirPath: accDir, updateInfo: null, selfUrl: import.meta.url };
  }

  function capture(): { calls: Array<NodeJS.ProcessEnv | null | undefined>; runClaude: (b: string, a: string[], env?: NodeJS.ProcessEnv | null) => never } {
    const calls: Array<NodeJS.ProcessEnv | null | undefined> = [];
    return {
      calls,
      runClaude: ((_b: string, _a: string[], env?: NodeJS.ProcessEnv | null) => {
        calls.push(env);
        return undefined as never;
      }),
    };
  }

  it('runs the global default account PLAIN — no mint, no isolation (§1 guard)', async () => {
    const { calls, runClaude } = capture();
    await handleTemporarySwitch(ctx(), 'personal@gmail.com', ['--help'], { runClaude });

    assert.equal(calls.length, 1, 'claude must be launched');
    assert.equal(calls[0]?.CLAUDE_CONFIG_DIR, undefined, 'the global default must NOT be isolated');
    // The §1 invariant: no duplicate profile minted for the frozen default.
    const profilesRoot = path.join(home, '.claude', 'profiles');
    assert.equal(
      fs.existsSync(profilesRoot) && fs.readdirSync(profilesRoot).length > 0,
      false,
      'no profile may be minted for the global default account',
    );
    // Recorded global-bound (configDir null), not isolated.
    const rec = readRaw(accDir).filter((s) => s.account === 'personal@gmail.com');
    assert.equal(rec.length, 1);
    assert.equal(rec[0]!.isolated, false);
  });

  it('launches a different account isolated against its existing overlay', async () => {
    const overlay = path.join(home, '.claude', 'profiles', 'work-ov');
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, '.cs-overlay'), '');
    fs.writeFileSync(path.join(overlay, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@acme.com' } }));

    const { calls, runClaude } = capture();
    await handleTemporarySwitch(ctx(), 'work@acme.com', ['--help'], { runClaude });

    assert.equal(calls[0]?.CLAUDE_CONFIG_DIR, overlay, 'must spawn isolated against the overlay');
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com', 'global active untouched');
    const rec = readRaw(accDir).filter((s) => s.account === 'work@acme.com');
    assert.equal(rec.length, 1);
    assert.equal(rec[0]!.isolated, true);
  });

  it('mints the account profile on demand (with login) and launches it isolated', async () => {
    // Give work a credential-bearing legacy snapshot so the mint comes out
    // logged-in. expiresAt far-future → no network refresh in test.
    fs.writeFileSync(
      path.join(accDir, 'work@acme.com.json'),
      JSON.stringify({
        emailAddress: 'work@acme.com',
        _keychain: { claudeAiOauth: { accessToken: 'tok', refreshToken: 'rtok', expiresAt: 9999999999999 } },
      }),
    );
    const profilesRoot = path.join(home, '.claude', 'profiles');
    assert.equal(
      fs.existsSync(profilesRoot) && fs.readdirSync(profilesRoot).includes('work'),
      false,
      'no work profile may exist before the run',
    );

    const { calls, runClaude } = capture();
    await handleTemporarySwitch(ctx(), 'work@acme.com', ['--help'], { runClaude });

    const minted = path.join(profilesRoot, 'work'); // derived name = local-part
    assert.equal(fs.existsSync(minted), true, 'the profile must be minted on demand');
    assert.equal(calls[0]?.CLAUDE_CONFIG_DIR, minted, 'must spawn isolated against the minted profile');
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com', 'global active untouched');
  });

  it('refuses (throws) when the account has no isolated login yet', async () => {
    // Force a credential-less legacy account → mint yields needsLogin.
    fs.writeFileSync(
      path.join(accDir, 'work@acme.com.json'),
      JSON.stringify({ emailAddress: 'work@acme.com' }),
    );
    const { calls, runClaude } = capture();
    await assert.rejects(
      () => handleTemporarySwitch(ctx(), 'work@acme.com', ['--help'], { runClaude }),
      (e: unknown) =>
        e instanceof ExitError &&
        /work@acme\.com has no isolated login/.test(e.message) &&
        /profile login/.test(e.message),
    );
    assert.equal(calls.length, 0, 'claude must NOT be launched on refusal');
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com');
    // A refused launch must not register a live session.
    assert.equal(readRaw(accDir).filter((s) => s.account === 'work@acme.com').length, 0);
  });
});
