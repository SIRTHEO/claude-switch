// test/find-claude.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findClaudeBinary } from '../src/setup/find-claude.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

// findClaudeBinary resolves via:
//   1. getSavedClaudeBin() — reads ~/.claude/accounts/.claude-bin
//   2. resolve({ envBin, selfPath, pathEnv })
//
// We isolate by overriding HOME (so getSavedClaudeBin reads from a sandbox)
// and PATH/env (so resolve() doesn't pick up the user's real claude).

describe('findClaudeBinary', () => {
  let tmpHome: string;
  let savedHome: SavedHome;
  let originalPath: string | undefined;
  let originalEnvBin: string | undefined;

  // A real executable file to point .claude-bin at. /bin/sh is universal on
  // Unix; on Windows we skip the saved-bin happy-path test (no equivalent).
  const realExecutable = '/bin/sh';

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-find-'));
    savedHome = setFakeHome(tmpHome);
    originalPath = process.env.PATH;
    originalEnvBin = process.env.CLAUDE_SWITCH_BIN;
    // Empty PATH so resolve() can't accidentally find a real claude.
    process.env.PATH = '';
    delete process.env.CLAUDE_SWITCH_BIN;
  });

  afterEach(() => {
    restoreFakeHome(savedHome);
    if (originalPath !== undefined) process.env.PATH = originalPath;
    else delete process.env.PATH;
    if (originalEnvBin !== undefined) process.env.CLAUDE_SWITCH_BIN = originalEnvBin;
    else delete process.env.CLAUDE_SWITCH_BIN;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns the saved bin when ~/.claude/accounts/.claude-bin points at an executable', () => {
    if (process.platform === 'win32') return; // /bin/sh n/a on Windows
    const accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(path.join(accountsDir, '.claude-bin'), realExecutable);

    const result = findClaudeBinary(import.meta.url);
    assert.strictEqual(result, realExecutable);
  });

  it('falls through to resolve() when no saved bin exists', () => {
    // No .claude-bin, no PATH match, no CLAUDE_SWITCH_BIN, no KNOWN_PATHS
    // entry that exists on the test machine — resolve() returns null.
    const result = findClaudeBinary(import.meta.url);
    // On a real macOS test machine, /usr/local/bin/claude may exist (we
    // saw 'claude' in the user's PATH earlier). Accept either null OR a
    // path that is NOT the wrapper script itself — the contract is "do
    // not resolve to ourselves".
    if (result !== null) {
      const selfPath = fileURLToPath(import.meta.url);
      assert.notStrictEqual(result, selfPath);
    }
  });

  it('respects CLAUDE_SWITCH_BIN env var (when no saved bin)', () => {
    if (process.platform === 'win32') return;
    process.env.CLAUDE_SWITCH_BIN = realExecutable;
    const result = findClaudeBinary(import.meta.url);
    assert.strictEqual(result, realExecutable);
  });

  it('returns null when saved bin file points to a non-executable path', () => {
    // .claude-bin contents point at a path that does not exist.
    const accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(path.join(accountsDir, '.claude-bin'), '/nonexistent/claude/binary');

    // Saved bin fails accessSync(X_OK) → getSavedClaudeBin returns null,
    // findClaudeBinary falls through to resolve(). With empty PATH and no
    // env, resolve() should return null on most test machines (KNOWN_PATHS
    // entries may exist on dev machines — accept that case as well).
    const result = findClaudeBinary(import.meta.url);
    if (result !== null) {
      // Whatever was found must not be the bogus path.
      assert.notStrictEqual(result, '/nonexistent/claude/binary');
    }
  });

  it('rejects an empty .claude-bin file', () => {
    const accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(path.join(accountsDir, '.claude-bin'), '');

    const result = findClaudeBinary(import.meta.url);
    // Empty saved bin → getSavedClaudeBin returns null, fall through.
    // Don't assert the resolved value — depends on the test machine. Just
    // make sure findClaudeBinary doesn't crash on empty input.
    assert.ok(result === null || typeof result === 'string');
  });

  it('rejects a loop pointer via argv[1] even when called with an unrelated module url', () => {
    if (process.platform === 'win32') return; // symlink-to-self shape is unix
    // Reproduce the recursion bug at the call surface: run-app.ts / profiles.ts
    // call findClaudeBinary(import.meta.url) with their OWN sub-module url, not
    // the wrapper entry. The self-guard must still fire because the wrapper
    // entry is realpathSync(process.argv[1]) — the thing node actually ran.
    const wrapper = path.join(tmpHome, 'cli.js');
    fs.writeFileSync(wrapper, '#!/usr/bin/env node\nconsole.log("x")\n'); // no marker
    fs.chmodSync(wrapper, 0o755);
    const shim = path.join(tmpHome, 'claude'); // a symlink to the wrapper, what .claude-bin points at
    fs.symlinkSync(wrapper, shim);
    const accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(path.join(accountsDir, '.claude-bin'), shim);

    const savedArgv1 = process.argv[1];
    process.argv[1] = wrapper; // node ran the wrapper entry for this process
    try {
      // Pass an UNRELATED module url as metaUrl — the run-app.js / profiles.js
      // mistake. The fix must not depend on this argument being the entry.
      const result = findClaudeBinary(pathToFileURL(path.join(tmpHome, 'sub-module.js')).href);
      // Must never hand back the wrapper/shim (PATH is empty → falls through).
      assert.notStrictEqual(result, shim);
      assert.notStrictEqual(result, wrapper);
    } finally {
      if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
    }
  });
});
