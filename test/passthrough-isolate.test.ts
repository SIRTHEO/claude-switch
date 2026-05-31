// test/passthrough-isolate.test.ts
// B2 wiring: handlePassthrough must ACT on routing's isolation decision —
// launch the routed account isolated (CLAUDE_CONFIG_DIR set, no global swap),
// either against an existing overlay or by minting the profile on demand
// (ensureProfileForAccount, async, off the snapshot lock). The decision logic
// is unit-tested in passthrough-routing.test.ts; this proves the hot path
// consumes it (a launch signal that never reaches runClaude is a silent gap)
// and that create-on-demand refuses rather than launch a broken session.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handlePassthrough } from '../src/commands/passthrough.js';
import { getCurrent, save } from '../src/accounts/accounts.js';
import { createProfile } from '../src/profiles/profiles.js';
import { readRaw } from '../src/sessions/session-registry.js';
import { ExitError } from '../src/platform/errors.js';
import type { CommandContext } from '../src/commands/context.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

describe('handlePassthrough — B2 routing isolation wiring', () => {
  let home: string;
  let accDir: string;
  let claudeJson: string;
  let repo: string;
  let savedHome: SavedHome;
  let savedBin: string | undefined;
  let savedCwd: string;
  let savedCcd: string | undefined;
  let savedAccount: string | undefined;

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
    // A live, global-bound session for personal → a swap to theo would clash,
    // which is exactly why routing isolates instead of swapping.
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
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_SWITCH_ACCOUNT;
    savedCwd = process.cwd();
    process.chdir(repo); // handlePassthrough reads process.cwd() for routing
  });

  afterEach(() => {
    process.chdir(savedCwd);
    restoreFakeHome(savedHome);
    if (savedBin === undefined) delete process.env.CLAUDE_SWITCH_BIN; else process.env.CLAUDE_SWITCH_BIN = savedBin;
    if (savedCcd === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCcd;
    if (savedAccount === undefined) delete process.env.CLAUDE_SWITCH_ACCOUNT; else process.env.CLAUDE_SWITCH_ACCOUNT = savedAccount;
    // setFakeHome covered os.homedir() throughout the mint, so any profile the
    // create-on-demand path wrote landed under THIS tmp home — gone with it.
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

  it('launches an existing overlay isolated (CLAUDE_CONFIG_DIR set, no global swap)', async () => {
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

  it('reuses an existing (non-overlay) logged-in profile isolated when no overlay marker exists', async () => {
    // A logged-in profile for theo exists but is NOT an overlay (no .cs-overlay
    // marker) → the resolver can't pre-resolve it, so it signals mintIsolated
    // and the handler resolves it via ensureProfileForAccount, which FINDS this
    // profile by email (created:false) and returns it with hasLogin under the
    // disable-keychain test flag, since its .claude.json carries an oauthAccount.
    const profileDir = createProfile('acme-work');
    fs.writeFileSync(
      path.join(profileDir, '.claude.json'),
      JSON.stringify({ userID: 'w'.repeat(64), oauthAccount: { emailAddress: 'theo@acme.com' } }),
    );
    const runCalls: Array<NodeJS.ProcessEnv | null | undefined> = [];

    await handlePassthrough(ctx(), ['--help'], {
      runClaude: ((_b: string, _a: string[], env?: NodeJS.ProcessEnv | null) => {
        runCalls.push(env);
        return undefined as never;
      }),
    });

    assert.equal(runCalls.length, 1, 'claude must be launched');
    assert.equal(runCalls[0]?.CLAUDE_CONFIG_DIR, profileDir, 'must spawn isolated against the resolved profile');
    // Global active untouched — routing is ephemeral (no swap, B2).
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com');
    const recorded = readRaw(accDir).filter((s) => s.account === 'theo@acme.com');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.isolated, true);
  });

  it('CREATES the routed account profile on demand (with login) and launches it isolated', async () => {
    // The headline of (a): theo has NO profile yet, but its saved account carries
    // a credential snapshot → ensureProfileForAccount MINTS a logged-in profile
    // from it (created:true) and the handler launches it isolated. expiresAt is
    // far-future so refreshLegacySnapshotIfStale is a no-op (no network in test).
    fs.writeFileSync(
      path.join(accDir, 'theo@acme.com.json'),
      JSON.stringify({
        emailAddress: 'theo@acme.com',
        _keychain: { claudeAiOauth: { accessToken: 'tok-A', refreshToken: 'rtok-A', expiresAt: 9999999999999 } },
      }),
    );
    const profilesRoot = path.join(home, '.claude', 'profiles');
    assert.equal(
      fs.existsSync(profilesRoot) && fs.readdirSync(profilesRoot).includes('theo'),
      false,
      'no theo profile may exist before the run',
    );

    const runCalls: Array<NodeJS.ProcessEnv | null | undefined> = [];
    await handlePassthrough(ctx(), ['--help'], {
      runClaude: ((_b: string, _a: string[], env?: NodeJS.ProcessEnv | null) => {
        runCalls.push(env);
        return undefined as never;
      }),
    });

    assert.equal(runCalls.length, 1, 'claude must be launched');
    // The profile was minted on demand (derived name "theo")…
    const minted = path.join(profilesRoot, 'theo');
    assert.equal(fs.existsSync(minted), true, 'the routed account profile must be created on demand');
    // …and claude spawned isolated against it, with the global active untouched.
    assert.equal(runCalls[0]?.CLAUDE_CONFIG_DIR, minted, 'must spawn isolated against the minted profile');
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com');
    const recorded = readRaw(accDir).filter((s) => s.account === 'theo@acme.com');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.isolated, true);
  });

  it('refuses (throws) when create-on-demand yields a profile that still needs a login', async () => {
    // theo is saved but token-less (disable-keychain seed) and has no profile
    // yet → ensureProfileForAccount mints a credential-less profile → needsLogin.
    // Refuse rather than launch a broken session.
    let launched = false;
    await assert.rejects(
      () =>
        handlePassthrough(ctx(), ['--help'], {
          runClaude: ((_b: string, _a: string[]) => {
            launched = true;
            return undefined as never;
          }),
        }),
      (e: unknown) =>
        e instanceof ExitError &&
        /theo@acme\.com is routed here/.test(e.message) &&
        /profile login/.test(e.message),
    );
    assert.equal(launched, false, 'claude must NOT be launched on refusal');
    assert.equal(getCurrent(claudeJson), 'personal@gmail.com');
  });
});
