import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isValidProfileName,
  profilePath,
  profileExists,
  listProfiles,
  createProfile,
  readProfile,
  removeProfile,
} from '../src/profiles.js';

// All tests redirect HOME so the profiles dir is sandboxed in /tmp.
let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-profiles-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('isValidProfileName', () => {
  it('accepts simple names', () => {
    assert.ok(isValidProfileName('work'));
    assert.ok(isValidProfileName('personal'));
    assert.ok(isValidProfileName('client_acme'));
    assert.ok(isValidProfileName('side-project-1'));
  });
  it('rejects empty / whitespace / non-string', () => {
    assert.ok(!isValidProfileName(''));
    assert.ok(!isValidProfileName(' '));
    assert.ok(!isValidProfileName(undefined as unknown as string));
    assert.ok(!isValidProfileName(null as unknown as string));
  });
  it('rejects shell metacharacters and path separators', () => {
    assert.ok(!isValidProfileName('work/personal'));
    assert.ok(!isValidProfileName('a b'));
    assert.ok(!isValidProfileName('back$pwd'));
    assert.ok(!isValidProfileName('foo;bar'));
    assert.ok(!isValidProfileName('..'));
  });
  it('rejects reserved subcommand names', () => {
    for (const r of ['list', 'ls', 'create', 'use', 'login', 'remove', 'rm', 'status', 'help']) {
      assert.ok(!isValidProfileName(r), `should reject "${r}"`);
    }
  });
  it('rejects names longer than 64 chars', () => {
    assert.ok(!isValidProfileName('a'.repeat(65)));
    assert.ok(isValidProfileName('a'.repeat(64)));
  });
});

describe('profilePath', () => {
  it('returns a path under the profiles dir', () => {
    const p = profilePath('work');
    assert.ok(p.startsWith(path.join(tmpHome, '.claude', 'profiles')));
    assert.ok(p.endsWith(path.sep + 'work') || p.endsWith('/work'));
  });
  it('throws for invalid names (path traversal etc.)', () => {
    assert.throws(() => profilePath('../escape'), /Invalid profile name/);
    assert.throws(() => profilePath('a/b'), /Invalid profile name/);
    assert.throws(() => profilePath(''), /Invalid profile name/);
  });
});

describe('createProfile + profileExists + listProfiles', () => {
  it('creates a fresh profile dir', () => {
    const p = createProfile('work');
    assert.ok(fs.statSync(p).isDirectory());
    assert.ok(profileExists('work'));
  });
  it('creates the dir with mode 0o700 on unix', { skip: process.platform === 'win32' }, () => {
    const p = createProfile('work');
    assert.strictEqual(fs.statSync(p).mode & 0o777, 0o700);
  });
  it('throws when the profile already exists', () => {
    createProfile('work');
    assert.throws(() => createProfile('work'), /already exists/);
  });
  it('listProfiles returns empty when no profiles dir', () => {
    assert.deepStrictEqual(listProfiles(), []);
  });
  it('listProfiles returns sorted profile names', () => {
    createProfile('work');
    createProfile('personal');
    createProfile('client_acme');
    assert.deepStrictEqual(listProfiles(), ['client_acme', 'personal', 'work']);
  });
  it('listProfiles ignores non-profile names that may appear in the dir', () => {
    createProfile('work');
    // Stray file/dir with an invalid name should be skipped.
    fs.writeFileSync(path.join(tmpHome, '.claude', 'profiles', '.DS_Store'), '');
    fs.mkdirSync(path.join(tmpHome, '.claude', 'profiles', 'not valid'));
    assert.deepStrictEqual(listProfiles(), ['work']);
  });
});

describe('readProfile', () => {
  it('returns null fields for a fresh profile (no .claude.json yet)', () => {
    createProfile('work');
    const info = readProfile('work');
    assert.strictEqual(info.name, 'work');
    assert.strictEqual(info.userID, null);
    assert.strictEqual(info.emailAddress, null);
    assert.strictEqual(info.hasLogin, false);
  });
  it('parses userID and emailAddress when claude has populated the dir', () => {
    const p = createProfile('work');
    fs.writeFileSync(path.join(p, '.claude.json'), JSON.stringify({
      userID: 'cfc0482b6ae14ad3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      oauthAccount: { emailAddress: 'me@x.com' },
    }));
    const info = readProfile('work');
    assert.strictEqual(info.userID, 'cfc0482b6ae14ad3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(info.emailAddress, 'me@x.com');
    assert.strictEqual(info.hasLogin, true);
  });
  it('throws for non-existent profile', () => {
    assert.throws(() => readProfile('nope'), /does not exist/);
  });
  it('handles malformed .claude.json gracefully', () => {
    const p = createProfile('work');
    fs.writeFileSync(path.join(p, '.claude.json'), '{ not json');
    const info = readProfile('work');
    // Should fall back to nulls instead of throwing.
    assert.strictEqual(info.userID, null);
    assert.strictEqual(info.emailAddress, null);
    assert.strictEqual(info.hasLogin, false);
  });
});

describe('removeProfile', () => {
  it('deletes the directory', () => {
    const p = createProfile('work');
    assert.ok(fs.existsSync(p));
    removeProfile('work');
    assert.ok(!fs.existsSync(p));
  });
  it('returns the userID for Keychain cleanup hint', () => {
    const p = createProfile('work');
    fs.writeFileSync(path.join(p, '.claude.json'), JSON.stringify({
      userID: 'abc123def456',
    }));
    const result = removeProfile('work');
    assert.strictEqual(result.userID, 'abc123def456');
    assert.ok(result.dir.endsWith('work'));
  });
  it('returns userID=null when the profile never ran claude', () => {
    createProfile('work');
    const result = removeProfile('work');
    assert.strictEqual(result.userID, null);
  });
});
