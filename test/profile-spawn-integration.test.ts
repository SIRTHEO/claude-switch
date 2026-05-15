// test/profile-spawn-integration.test.ts
// End-to-end regression test for the profile spawn flow.
//
// Closes the bug class "claude-switch writes credentials at the wrong
// location and nobody notices until a user reports it" (the macOS
// Keychain service-name divorce that this repo lived with for months).
//
// Flow:
//   1. seed a legacy account file with a `_keychain` snapshot
//   2. ensureProfileForAccount → creates profile + writes credentials
//   3. spawn the mock claude binary with CLAUDE_CONFIG_DIR=<profile>
//   4. assert the mock prints "OK <email>" → claude can find what we wrote
//
// Platform handling:
//   - Linux/Windows: tokens go into the per-profile claude.json. Always
//     runs — deterministic, no system keyring involved.
//   - macOS: tokens go into the login Keychain. The full write→read
//     cycle prompts the user for keychain auth on most dev macs the
//     first time `node` claims the per-config-dir service name; the
//     suite SKIPS writes there to keep `npm test` non-interactive
//     (CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 default), which means we
//     exercise the JSON-only branch on darwin too. Users opt in to
//     the real Keychain path with CLAUDE_SWITCH_DISABLE_KEYCHAIN=0.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureProfileForAccount } from '../src/profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/test/* → ../../test/fixtures/claude-mock.mjs
const MOCK_CLAUDE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'claude-mock.mjs');

const KEYCHAIN_DISABLED = process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN === '1';

describe('profile spawn — integration with mock claude', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let accountsDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-spawn-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.claude', 'profiles'), { recursive: true });
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function spawnMockWith(configDir: string): { stdout: string; status: number | null } {
    const r = spawnSync(process.execPath, [MOCK_CLAUDE], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });
    return { stdout: (r.stdout ?? '').trim(), status: r.status };
  }

  it(
    'mock claude can read the credentials claude-switch wrote (Linux/Windows JSON path)',
    // The JSON-write path is the one we exercise on every platform when
    // CLAUDE_SWITCH_DISABLE_KEYCHAIN=1. On a real macOS dev box opting
    // into Keychain, importProfileFromAccount writes to the Keychain
    // instead and the JSON has no accessToken — so this assertion is
    // only meaningful when keychain is disabled (i.e. the default test
    // mode that runs in CI everywhere).
    { skip: !KEYCHAIN_DISABLED },
    async () => {
      const email = 'spawn-test@example.com';
      // Legacy account file with a fresh _keychain snapshot (the
      // post-`add` representation of any saved account).
      fs.writeFileSync(path.join(accountsDir, `${email}.json`), JSON.stringify({
        emailAddress: email,
        _keychain: {
          claudeAiOauth: {
            accessToken: 'sk-ant-test-spawn',
            refreshToken: 'refresh-spawn',
            expiresAt: Date.now() + 3_600_000,
          },
        },
      }));

      const ensured = await ensureProfileForAccount(email, accountsDir);
      assert.equal(ensured.created, true, 'expected a brand-new profile to be created');
      assert.equal(ensured.needsLogin, false, 'expected credentials to be reachable post-import');

      const { stdout, status } = spawnMockWith(ensured.profilePath);
      assert.equal(status, 0,
        `mock claude exited non-zero — claude-switch wrote at the wrong place.\nmock said: ${stdout}`);
      assert.match(stdout, new RegExp(`^OK ${email.replace(/\./g, '\\.').replace(/@/g, '@')}$`),
        `expected "OK ${email}" — got: ${stdout}`);
    },
  );

  it(
    'mock claude exits non-zero when claude-switch did NOT write credentials (sanity: assertion would actually fire on regression)',
    { skip: !KEYCHAIN_DISABLED },
    () => {
      // Plant a JSON that LOOKS like a profile but has no accessToken —
      // claude-switch never wrote credentials here. This proves the
      // mock isn't spuriously "OK"-ing every directory we hand it.
      const profileDir = path.join(tmpHome, '.claude', 'profiles', 'empty');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, '.claude.json'), JSON.stringify({
        userID: 'placeholder',
        oauthAccount: { emailAddress: 'unauthenticated@example.com' },
      }));

      const { stdout, status } = spawnMockWith(profileDir);
      assert.notEqual(status, 0, 'mock should refuse a profile with no credentials');
      assert.match(stdout, /^FAIL /, `expected a FAIL message — got: ${stdout}`);
    },
  );
});
