// test/apikey-set-stdin.test.ts
// Regression: `apikey set` reads the key from stdin in a non-interactive
// context. Empty/closed stdin (e.g. a GUI sidecar that spawns the CLI but
// forgets to pipe the key) used to hang the process forever — promptSecret
// only listened for a 'line' event, never 'close'. This spawns the real
// binary with empty stdin and asserts it exits promptly with the "no key"
// guard instead of blocking.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/test/* → ../../dist/bin/cli.js
const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

describe('apikey set — empty stdin does not hang', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-apikey-stdin-'));
    const accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    // Seed an account so resolveTargetEmail resolves before stdin is read.
    fs.writeFileSync(
      path.join(accountsDir, 'sirtheo.work@example.com.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'sirtheo.work@example.com' } }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('exits with the "no key on stdin" guard instead of blocking', () => {
    const res = spawnSync(
      process.execPath,
      [CLI, 'switch', 'apikey', 'set', 'sirtheo.work@example.com'],
      {
        input: '', // empty, immediately-closed stdin
        timeout: 5000, // a hang would trip this; the fix exits in well under it
        encoding: 'utf-8',
        env: { ...process.env, HOME: tmpHome, CLAUDE_SWITCH_DISABLE_KEYCHAIN: '1' },
      },
    );

    // No timeout kill (would surface as signal SIGTERM + null status).
    assert.equal(res.signal, null, 'process should exit on its own, not be killed by timeout');
    assert.notEqual(res.status, 0, 'empty stdin must not be treated as a saved key');
    assert.match(res.stderr ?? '', /No key on stdin/);
  });
});
