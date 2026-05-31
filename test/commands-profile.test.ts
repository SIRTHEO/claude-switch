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
import { save as saveAccount } from '../src/accounts/accounts.js';
import { ExitError } from '../src/platform/errors.js';
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
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => {
    h.stdout.push(args.map(String).join(' '));
  };
  process.stdout.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    h.stdout.push(String(chunk));
    return true;
  };
  return () => {
    console.log = origLog;
    process.stdout.write = origWrite;
  };
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

  it('emits a JSON array on --json (no banner)', async () => {
    const profileDir = path.join(h.fakeHome, '.claude', 'profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    h.stdout.length = 0;
    await handleProfileList({ json: true });
    const parsed = JSON.parse(h.stdout.join('').trim()) as Array<{
      name: string;
      account: string | null;
      hasLogin: boolean;
      path: string;
    }>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.name, 'work');
    assert.equal(parsed[0]?.hasLogin, false);
    assert.equal(parsed[0]?.account, null);
    assert.equal(parsed[0]?.path, profileDir);
  });

  it('emits "[]" on --json when no profiles exist', async () => {
    h.stdout.length = 0;
    await handleProfileList({ json: true });
    assert.deepEqual(JSON.parse(h.stdout.join('').trim()), []);
  });

  it('--include-default prepends the read-only default workspace (--json)', async () => {
    fs.writeFileSync(h.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'global@x.com' } }));
    const profileDir = path.join(h.fakeHome, '.claude', 'profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    h.stdout.length = 0;
    await handleProfileList({ json: true, includeDefault: true }, h.ctx);
    const parsed = JSON.parse(h.stdout.join('').trim()) as Array<{
      name: string; account: string | null; isDefault?: boolean;
    }>;
    assert.equal(parsed[0]?.name, 'default');
    assert.equal(parsed[0]?.isDefault, true);
    assert.equal(parsed[0]?.account, 'global@x.com');
    assert.ok(parsed.some((e) => e.name === 'work'), 'profiles still listed after default');
  });

  it('no-flag --json stays unchanged: no default entry, no isDefault key', async () => {
    const profileDir = path.join(h.fakeHome, '.claude', 'profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    h.stdout.length = 0;
    await handleProfileList({ json: true });
    const parsed = JSON.parse(h.stdout.join('').trim()) as Array<Record<string, unknown>>;
    assert.equal(parsed.some((e) => e.name === 'default'), false, 'no synthetic default in the plain list');
    assert.equal(parsed.every((e) => !Object.hasOwn(e, 'isDefault')), true, 'no isDefault key leaks into the plain list');
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
