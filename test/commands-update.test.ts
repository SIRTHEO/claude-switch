// test/commands-update.test.ts
// Coverage for `src/commands/update.ts` and supporting `src/update-check.ts`
// pure functions.
//
// handleUpdate accepts an optional `deps.fetch` to avoid live HTTPS requests.
// We exercise:
//   - isNewer: pure semver comparison (many branches)
//   - detectInstallCommand: install command detection
//   - writeUpdateCache / checkForUpdate: file-based cache round-trip
//   - handleUpdate with mocked fetch: null (no registry), up-to-date,
//     new version available + non-TTY, new version available + isTTY (skipped).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isNewer,
  detectInstallCommand,
  writeUpdateCache,
  checkForUpdate,
} from '../src/setup/update-check.js';
import { handleUpdate } from '../src/commands/update.js';
import { VERSION } from '../src/setup/version.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

// ---------------------------------------------------------------------------
// isNewer — pure function, no I/O
// ---------------------------------------------------------------------------

describe('isNewer', () => {
  it('returns false when latest equals current', () => {
    assert.equal(isNewer('1.2.3', '1.2.3'), false);
  });

  it('returns true when latest patch is higher', () => {
    assert.equal(isNewer('1.2.3', '1.2.4'), true);
  });

  it('returns true when latest minor is higher', () => {
    assert.equal(isNewer('1.2.3', '1.3.0'), true);
  });

  it('returns true when latest major is higher', () => {
    assert.equal(isNewer('1.2.3', '2.0.0'), true);
  });

  it('returns false when latest is older', () => {
    assert.equal(isNewer('2.0.0', '1.9.9'), false);
  });

  it('returns false when latest is a pre-release (even if higher base version)', () => {
    assert.equal(isNewer('1.0.0', '2.0.0-rc.1'), false);
  });

  it('returns true when current is a pre-release and latest is the stable counterpart', () => {
    assert.equal(isNewer('1.0.0-rc.1', '1.0.0'), true);
  });

  it('handles versions with v-prefix', () => {
    assert.equal(isNewer('v1.2.3', 'v1.2.4'), true);
    assert.equal(isNewer('v1.2.4', 'v1.2.3'), false);
  });

  it('handles two-component versions gracefully', () => {
    assert.equal(isNewer('1.2', '1.3'), true);
    assert.equal(isNewer('1.3', '1.2'), false);
  });
});

// ---------------------------------------------------------------------------
// detectInstallCommand
// ---------------------------------------------------------------------------

describe('detectInstallCommand', () => {
  it('returns a non-empty array', () => {
    const cmd = detectInstallCommand();
    assert.ok(Array.isArray(cmd), 'should return an array');
    assert.ok(cmd.length > 0, 'should contain at least one element');
  });

  it('first element is a known package manager or install verb', () => {
    const cmd = detectInstallCommand();
    const knownManagers = ['npm', 'npx', 'pnpm', 'yarn', 'bun'];
    const first = cmd[0] ?? '';
    assert.ok(
      knownManagers.some(m => first.includes(m)),
      `expected a known package manager, got: ${first}`,
    );
  });

  it('includes the package name in the command', () => {
    const cmdStr = detectInstallCommand().join(' ');
    assert.match(cmdStr, /claude-switch/);
  });
});

// ---------------------------------------------------------------------------
// writeUpdateCache / checkForUpdate — file-based round-trip
// Override HOME to a tmp dir so we don't pollute the real user cache.
// ---------------------------------------------------------------------------

describe('writeUpdateCache / checkForUpdate', () => {
  let tmpDir: string;
  let savedHome: SavedHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upd-'));
    savedHome = setFakeHome(tmpDir);
  });

  afterEach(() => {
    restoreFakeHome(savedHome);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeUpdateCache persists a version that checkForUpdate can read back', () => {
    writeUpdateCache('99.0.0');
    const result = checkForUpdate('1.0.0');
    assert.ok(result !== null, 'expected an update notification in result');
    assert.equal(result?.latestVersion, '99.0.0');
  });

  it('checkForUpdate returns null when cached version is not newer than current', () => {
    writeUpdateCache('1.0.0');
    const result = checkForUpdate('99.0.0');
    assert.equal(result, null, 'no update expected when current is already ahead');
  });

  it('checkForUpdate returns null when no cache file exists', () => {
    const result = checkForUpdate('1.0.0');
    assert.equal(result, null, 'expected null when cache is absent');
  });
});

// ---------------------------------------------------------------------------
// handleUpdate — exercised with mocked fetch (no real HTTPS)
// ---------------------------------------------------------------------------

describe('handleUpdate — fetch returns null (registry unreachable)', () => {
  const stdout: string[] = [];
  let restoreLog: () => void;
  let restoreStdoutWrite: () => void;

  beforeEach(() => {
    stdout.length = 0;
    const origLog = console.log;
    restoreLog = () => { console.log = origLog; };
    console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };
    const origWrite = process.stdout.write.bind(process.stdout);
    restoreStdoutWrite = () => { process.stdout.write = origWrite; };
    (process.stdout as { write: unknown }).write = () => true;
  });

  afterEach(() => {
    restoreLog();
    restoreStdoutWrite();
  });

  it('prints registry-unreachable message and returns', async () => {
    await handleUpdate({ fetch: async () => null });
    const out = stdout.join('\n');
    assert.match(out, /Could not reach npm registry/);
  });

  it('prints current version before the network attempt', async () => {
    await handleUpdate({ fetch: async () => null });
    assert.ok(stdout[0]?.includes(VERSION), 'first output should include current version');
  });
});

describe('handleUpdate — fetch returns current version (already up to date)', () => {
  const stdout: string[] = [];
  let restoreLog: () => void;
  let restoreStdoutWrite: () => void;
  let tmpDir: string;
  let savedHome: SavedHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upd2-'));
    savedHome = setFakeHome(tmpDir);
    stdout.length = 0;
    const origLog = console.log;
    restoreLog = () => { console.log = origLog; };
    console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };
    const origWrite = process.stdout.write.bind(process.stdout);
    restoreStdoutWrite = () => { process.stdout.write = origWrite; };
    (process.stdout as { write: unknown }).write = () => true;
  });

  afterEach(() => {
    restoreLog();
    restoreStdoutWrite();
    restoreFakeHome(savedHome);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints already-up-to-date when latest equals current', async () => {
    await handleUpdate({ fetch: async () => VERSION });
    const out = stdout.join('\n');
    assert.match(out, /Already up to date/);
  });
});

describe('handleUpdate — fetch returns newer version, non-TTY', () => {
  const stdout: string[] = [];
  let restoreLog: () => void;
  let restoreStdoutWrite: () => void;
  let tmpDir: string;
  let savedHome: SavedHome;
  let origStdinIsTTY: boolean;
  let origStdoutIsTTY: boolean;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upd3-'));
    savedHome = setFakeHome(tmpDir);
    stdout.length = 0;
    const origLog = console.log;
    restoreLog = () => { console.log = origLog; };
    console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };
    const origWrite = process.stdout.write.bind(process.stdout);
    restoreStdoutWrite = () => { process.stdout.write = origWrite; };
    (process.stdout as { write: unknown }).write = () => true;
    // Force non-TTY so we don't hit the interactive prompt
    origStdinIsTTY = process.stdin.isTTY;
    origStdoutIsTTY = process.stdout.isTTY;
    (process.stdin as { isTTY: boolean }).isTTY = false;
    (process.stdout as { isTTY: boolean }).isTTY = false;
  });

  afterEach(() => {
    restoreLog();
    restoreStdoutWrite();
    (process.stdin as { isTTY: boolean }).isTTY = origStdinIsTTY;
    (process.stdout as { isTTY: boolean }).isTTY = origStdoutIsTTY;
    restoreFakeHome(savedHome);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints new-version-available and install command in non-TTY mode', async () => {
    await handleUpdate({ fetch: async () => '99.99.99' });
    const out = stdout.join('\n');
    assert.match(out, /New version available/);
    assert.match(out, /99\.99\.99/);
    assert.match(out, /claude-switch/);
  });
});
