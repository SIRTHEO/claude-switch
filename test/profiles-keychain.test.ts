// test/profiles-keychain.test.ts
// Regression coverage for the macOS-only profile login-detection fix
// (commit 74b6023). Read-only against the real `security` CLI under
// unique userID-shaped accounts so it doesn't pollute the user's
// Keychain and doesn't trigger an authorization prompt — write-side
// tests would have to claim an entry under the `Claude Code-credentials`
// service, which prompts the user from `node` on first run; that's a
// hard "no" for an unattended `npm test`.
//
// Skipped on non-macOS and when CLAUDE_SWITCH_DISABLE_KEYCHAIN=1 — the
// rest of the suite runs with that env set so test fixtures don't
// touch the global Keychain. Toggle in via:
//   CLAUDE_SWITCH_DISABLE_KEYCHAIN=0 node --test dist/test/profiles-keychain.test.js
//
// What the fix did:
//   readProfile() used to declare hasLogin=true purely from the JSON
//   oauthAccount.emailAddress field. On macOS this is wrong: the actual
//   OAuth tokens live in the Keychain, and a stale emailAddress
//   survives Keychain wipes / token rotations. The fix demotes
//   hasLogin to false when the Keychain entry under userID is absent,
//   so callers (notably `ensureProfileForAccount` driving "Open
//   account isolated") stop spawning claude into empty profiles.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createProfile,
  readProfile,
  ensureProfileForAccount,
  removeProfile,
  type ProfileInfo,
} from '../src/profiles.js';

const macAndEnabled =
  process.platform === 'darwin' && process.env.CLAUDE_SWITCH_DISABLE_KEYCHAIN !== '1';

function freshUserID(suffix: string): string {
  // 64-char hex-ish string with a recognisable prefix so any leaked
  // Keychain entry is easy to grep for.
  const tag = `${process.pid.toString(16)}${Date.now().toString(16)}${suffix}`;
  return `cstest${tag.padEnd(58, '0').slice(0, 58)}`;
}

describe('profile Keychain integration — readProfile', { skip: !macAndEnabled }, () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prof-kc-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('demotes hasLogin to false when no Keychain entry resolves under userID', () => {
    const userID = freshUserID('a');
    const dir = createProfile('work');
    // Plant a JSON that LOOKS logged-in: oauthAccount.emailAddress + userID.
    // Intentionally do NOT write a Keychain entry under this userID — the
    // pre-fix code returned hasLogin=true for this layout, the post-fix
    // code returns false.
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      userID,
      oauthAccount: { emailAddress: 'user@example.com' },
    }));
    const info: ProfileInfo = readProfile('work');
    assert.equal(info.userID, userID);
    assert.equal(info.emailAddress, 'user@example.com');
    assert.equal(info.hasLogin, false,
      'pre-fix would return hasLogin=true; the fix demotes it because the Keychain entry is absent');
    removeProfile('work');
  });

  it('keeps hasLogin=false when the JSON has no oauthAccount block at all', () => {
    // Sanity guard: the fix must not flip a legitimately-empty profile
    // into hasLogin=true. Without an oauthAccount block the email is
    // null and hasLogin stays false regardless of platform.
    const userID = freshUserID('b');
    const dir = createProfile('empty');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ userID }));
    const info = readProfile('empty');
    assert.equal(info.emailAddress, null);
    assert.equal(info.hasLogin, false);
    removeProfile('empty');
  });
});

describe('profile Keychain integration — ensureProfileForAccount', { skip: !macAndEnabled }, () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prof-kc-ensure-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns needsLogin=true when an existing profile has no Keychain entry AND legacy account has no _keychain snapshot', async () => {
    // The "stuck" path: profile exists but credentials are gone, and
    // the legacy account file is too old to have a _keychain snapshot
    // (pre-v2.2 import). The fix should report needsLogin=true so the
    // UI tells the user to run `claude switch profile login`.
    const email = 'fresh@example.com';
    const userID = freshUserID('c');

    const dir = createProfile('fresh');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      userID,
      oauthAccount: { emailAddress: email },
    }));

    const accountsDir = path.join(tmpHome, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    // Legacy account file WITHOUT a _keychain snapshot.
    fs.writeFileSync(path.join(accountsDir, `${email}.json`), JSON.stringify({
      emailAddress: email,
    }));

    const result = await ensureProfileForAccount(email, accountsDir);
    assert.equal(result.profileName, 'fresh');
    assert.equal(result.created, false);
    assert.equal(result.needsLogin, true,
      'no _keychain snapshot to recover from → caller must be told to log in');
    removeProfile('fresh');
  });
});
