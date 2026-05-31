// test/profiles-workspaces.test.ts
// Locks the unified workspace listing (slice 2 of the unified-profile model):
// listWorkspaces() surfaces the global `~/.claude` as a first-class `default`
// entry alongside the isolated profiles, read-only. No switch/launch behaviour
// is involved here — only the listing shape.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listWorkspaces, profileEntries, defaultWorkspaceEntry } from '../src/profiles/workspaces.js';
import { createProfile, isValidProfileName, profilesDir } from '../src/profiles/profiles.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

let tmpHome: string;
let savedHome: SavedHome;
let claudeJson: string;
let accountsDir: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-workspaces-'));
  savedHome = setFakeHome(tmpHome);
  claudeJson = path.join(tmpHome, '.claude.json');
  accountsDir = path.join(tmpHome, '.claude', 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });
});
afterEach(() => {
  restoreFakeHome(savedHome);
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const writeGlobal = (email: string): void => {
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: email } }));
};

describe('defaultWorkspaceEntry', () => {
  it('reflects the global account, marked isDefault, path = ~/.claude', () => {
    writeGlobal('global@x.com');
    const e = defaultWorkspaceEntry(claudeJson, accountsDir);
    assert.equal(e.name, 'default');
    assert.equal(e.account, 'global@x.com');
    assert.equal(e.hasLogin, true);
    assert.equal(e.isDefault, true);
    assert.equal(e.overlay, false);
    assert.equal(e.path, path.join(tmpHome, '.claude'));
  });

  it('degrades to account=null / hasLogin=false when the global has no account', () => {
    const e = defaultWorkspaceEntry(claudeJson, accountsDir);
    assert.equal(e.account, null);
    assert.equal(e.hasLogin, false);
    assert.equal(e.isDefault, true);
  });

  it('degrades (no throw) on a malformed global claude.json', () => {
    fs.writeFileSync(claudeJson, 'garbage{');
    const e = defaultWorkspaceEntry(claudeJson, accountsDir);
    assert.equal(e.account, null);
    assert.equal(e.hasLogin, false);
  });
});

describe('listWorkspaces', () => {
  it('puts default first, then the profiles (sorted)', () => {
    writeGlobal('global@x.com');
    createProfile('work');
    createProfile('side');
    const ws = listWorkspaces(claudeJson, accountsDir);
    assert.equal(ws[0]?.name, 'default');
    assert.equal(ws[0]?.isDefault, true);
    assert.deepEqual(ws.map((w) => w.name), ['default', 'side', 'work']);
  });

  it('does not mark real profile entries as isDefault', () => {
    writeGlobal('global@x.com');
    createProfile('work');
    const work = listWorkspaces(claudeJson, accountsDir).find((w) => w.name === 'work');
    assert.ok(work);
    assert.notEqual(work?.isDefault, true);
  });

  it('carries a logged-in profile\'s account into its entry', () => {
    writeGlobal('global@x.com');
    createProfile('work');
    fs.writeFileSync(
      path.join(profilesDir(), 'work', '.claude.json'),
      JSON.stringify({ userID: 'w'.repeat(64), oauthAccount: { emailAddress: 'work@x.com' } }),
    );
    const work = listWorkspaces(claudeJson, accountsDir).find((w) => w.name === 'work');
    assert.equal(work?.account, 'work@x.com');
    assert.equal(work?.hasLogin, true);
  });

  it('reserves "default" so a stray disk profile cannot shadow the synthetic one', () => {
    writeGlobal('global@x.com');
    assert.equal(isValidProfileName('default'), false);
    // Plant a stray dir named "default" directly (bypassing createProfile's guard).
    fs.mkdirSync(path.join(profilesDir(), 'default'), { recursive: true });
    const defaults = listWorkspaces(claudeJson, accountsDir).filter((w) => w.name === 'default');
    assert.equal(defaults.length, 1, 'exactly one default entry — the synthetic global');
    assert.equal(defaults[0]?.isDefault, true);
    assert.equal(defaults[0]?.path, path.join(tmpHome, '.claude'));
  });
});

describe('profileEntries', () => {
  it('lists profiles only — no default entry, none marked isDefault', () => {
    createProfile('work');
    const entries = profileEntries();
    assert.equal(entries.some((e) => e.name === 'default'), false);
    assert.equal(entries.every((e) => e.isDefault !== true), true);
  });
});
