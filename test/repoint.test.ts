// test/repoint.test.ts
// Slice 4b — the re-point core (landed inert; no entry point wired yet).
// `repointToDefault` SETS the default-pointer instead of overwriting ~/.claude.
// The load-bearing proof is the BYPASS assertion: after re-pointing to another
// account, the global ~/.claude is UNCHANGED (the swap-in-place is gone). The
// frozen default account short-circuits to the 'default' sentinel without
// minting a duplicate home (the §1 invariant).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repointToDefault } from '../src/switching/repoint.js';
import { getCurrent, save } from '../src/accounts/accounts.js';
import { readDefaultPointer } from '../src/profiles/workspaces.js';
import { createProfile, listProfiles } from '../src/profiles/profiles.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

describe('repointToDefault', () => {
  let home: string;
  let accDir: string;
  let claudeJson: string;
  let savedHome: SavedHome;

  const GLOBAL = 'sirtheo.personal@example.com';
  const OTHER = 'sirtheo.work@example.com';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-repoint-'));
    savedHome = setFakeHome(home);
    accDir = path.join(home, '.claude', 'accounts');
    fs.mkdirSync(accDir, { recursive: true });
    claudeJson = path.join(home, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: GLOBAL } }));
    save(GLOBAL, claudeJson, accDir);
  });

  afterEach(() => {
    restoreFakeHome(savedHome);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('re-points the frozen default account to the `default` sentinel (no duplicate home)', async () => {
    const r = await repointToDefault(GLOBAL, claudeJson, accDir);
    assert.equal(r.needsLogin, false);
    assert.equal(r.pointer, 'default');
    assert.equal(readDefaultPointer(accDir), 'default');
    // §1 invariant: the default account is NOT minted as a profile.
    assert.equal(listProfiles().length, 0, 'no profile created for the default account');
  });

  it('re-points another account to its profile WITHOUT overwriting ~/.claude (the bypass)', async () => {
    // A logged-in profile already exists for OTHER (found by email match, so
    // ensureProfileForAccount returns it ready — no creds capture needed).
    const dir = createProfile('work');
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ userID: 'w'.repeat(64), oauthAccount: { emailAddress: OTHER } }),
    );

    const before = getCurrent(claudeJson);
    assert.equal(before, GLOBAL);

    const r = await repointToDefault(OTHER, claudeJson, accDir);

    assert.equal(r.needsLogin, false);
    assert.equal(r.pointer, 'work');
    assert.equal(readDefaultPointer(accDir), 'work');

    // THE BYPASS ASSERTION: the global slot is NOT overwritten by a re-point.
    assert.equal(getCurrent(claudeJson), GLOBAL, '~/.claude must be untouched by a re-point');
  });

  it('refuses (needsLogin) when the target account has no usable creds — still no overwrite', async () => {
    // A snapshot exists for OTHER but carries no credentials (token-less save),
    // so the profile ensureProfileForAccount mints needs a one-time login.
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: OTHER } }));
    save(OTHER, claudeJson, accDir);
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: GLOBAL } }));
    save(GLOBAL, claudeJson, accDir);

    const r = await repointToDefault(OTHER, claudeJson, accDir);

    assert.equal(r.needsLogin, true);
    assert.equal(r.pointer, null);
    assert.match(r.message, /profile login/);
    // The pointer is NOT moved on a refusal, and the global is untouched.
    assert.equal(readDefaultPointer(accDir), 'default');
    assert.equal(getCurrent(claudeJson), GLOBAL);
  });
});
