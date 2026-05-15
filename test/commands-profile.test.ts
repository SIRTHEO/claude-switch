// test/commands-profile.test.ts
// Coverage for `src/commands/profile.ts`.
//
// The profile module uses os.homedir() directly for ~/.claude/profiles/.
// We override process.env.HOME to a tmp dir so tests are fully isolated
// and don't touch the real user profile store.
//
// handlers that spawn claude (handleProfileLogin, handleProfileUse happy
// path) are NOT tested here — they would require a real claude binary and
// could hang. Only the early-exit branches (ExitError before spawn) are
// covered.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  handleProfileList,
  handleProfileCreate,
  handleProfileStatus,
  handleProfileRemove,
} from '../src/commands/profile.js';
import { save as saveAccount } from '../src/accounts.js';
import { ExitError } from '../src/errors.js';
import type { CommandContext } from '../src/commands/context.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

interface Harness {
  tmpDir: string;
  fakeHome: string;
  claudeJson: string;
  accDir: string;
  ctx: CommandContext;
  stdout: string[];
  savedHome: SavedHome;
}

function setup(activeEmail?: string): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-profile-'));
  const fakeHome = path.join(tmpDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
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

  const savedHome = setFakeHome(fakeHome);

  return { tmpDir, fakeHome, claudeJson, accDir, ctx, stdout: [], savedHome };
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
// handleProfileList
// ---------------------------------------------------------------------------

describe('handleProfileList', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup();
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('prints no-profiles message when profiles dir does not exist', async () => {
    await handleProfileList();
    const out = h.stdout.join('\n');
    assert.match(out, /No profiles/);
    assert.match(out, /profile create/);
  });

  it('lists profiles when at least one profile exists', async () => {
    // Create a fake profile dir under the fake home
    const profileDir = path.join(h.fakeHome, '.claude', 'profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    h.stdout.length = 0;
    await handleProfileList();
    const out = h.stdout.join('\n');
    assert.match(out, /work/);
  });
});

// ---------------------------------------------------------------------------
// handleProfileCreate
// ---------------------------------------------------------------------------

describe('handleProfileCreate', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup();
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('creates a profile and prints confirmation with next steps', async () => {
    await handleProfileCreate('myprofile');
    const out = h.stdout.join('\n');
    assert.match(out, /myprofile/);
    assert.match(out, /profile login/);
    assert.match(out, /profile use/);
  });

  it('throws ExitError when profile name is invalid', async () => {
    await assert.rejects(
      () => handleProfileCreate('../evil-name'),
      ExitError,
    );
  });

  it('throws ExitError when profile already exists', async () => {
    await handleProfileCreate('duplicate');
    h.stdout.length = 0;
    await assert.rejects(
      () => handleProfileCreate('duplicate'),
      ExitError,
    );
  });
});

// ---------------------------------------------------------------------------
// handleProfileStatus
// ---------------------------------------------------------------------------

describe('handleProfileStatus — named profile errors', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup();
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('throws ExitError when the named profile does not exist', async () => {
    await assert.rejects(
      () => handleProfileStatus('ghost-profile'),
      ExitError,
    );
  });

  it('prints summary of all profiles when called with no name and profiles dir is empty', async () => {
    await handleProfileStatus(undefined);
    const out = h.stdout.join('\n');
    assert.match(out, /No profiles configured/);
  });

  it('shows profile details when the profile exists (no login yet)', async () => {
    await handleProfileCreate('myprofile');
    h.stdout.length = 0;
    await handleProfileStatus('myprofile');
    const out = h.stdout.join('\n');
    assert.match(out, /Profile:.*myprofile/);
    assert.match(out, /Token:/);
  });
});

describe('handleProfileStatus — all profiles summary', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup();
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('lists each profile with login status in summary view', async () => {
    await handleProfileCreate('work');
    await handleProfileCreate('personal');
    h.stdout.length = 0;
    await handleProfileStatus(undefined);
    const out = h.stdout.join('\n');
    assert.match(out, /work/);
    assert.match(out, /personal/);
  });
});

// ---------------------------------------------------------------------------
// handleProfileRemove
// ---------------------------------------------------------------------------

describe('handleProfileRemove', () => {
  let h: Harness;
  let restore: () => void;

  beforeEach(() => {
    h = setup();
    restore = captureStdout(h);
  });

  afterEach(() => {
    restore();
    teardown(h);
  });

  it('throws ExitError when the profile does not exist', async () => {
    await assert.rejects(
      () => handleProfileRemove('ghost'),
      ExitError,
    );
  });

  it('removes an existing profile and prints confirmation', async () => {
    await handleProfileCreate('tobedeleted');
    h.stdout.length = 0;
    await handleProfileRemove('tobedeleted');
    const out = h.stdout.join('\n');
    assert.match(out, /Removed profile dir/);
  });
});
