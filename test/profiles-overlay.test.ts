// test/profiles-overlay.test.ts
// Unit coverage for the overlay ("as-global") profile primitive (Phase 27.1).
// Isolates only the identity; shares skills/ + projects/ from the global
// ~/.claude via whole-dir symlinks. Pure fs assertions in a fake HOME — no
// credentials, no Keychain, no spawned claude.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleProfileCreate, handleProfileList } from '../src/commands/profile.js';
import { createOverlayProfile, isOverlayProfile } from '../src/profiles/overlay.js';
import { createProfile, importProfileFromAccount } from '../src/profiles/profiles.js';
import { restoreFakeHome, setFakeHome, type SavedHome } from './_helpers/fake-home.js';

describe('createOverlayProfile', () => {
  let saved: SavedHome;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-overlay-'));
    saved = setFakeHome(home);
    // Seed a global skill + a global projects entry to prove they show through.
    const skill = path.join(home, '.claude', 'skills', 'airtable');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: airtable\n---\n');
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-proj'), { recursive: true });
  });

  afterEach(() => {
    restoreFakeHome(saved);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('symlinks skills/ and projects/ to the global ~/.claude dirs', () => {
    const dir = createOverlayProfile('work');
    const skills = path.join(dir, 'skills');
    const projects = path.join(dir, 'projects');
    assert.ok(fs.lstatSync(skills).isSymbolicLink());
    assert.equal(fs.readlinkSync(skills), path.join(home, '.claude', 'skills'));
    assert.ok(fs.lstatSync(projects).isSymbolicLink());
    assert.equal(fs.readlinkSync(projects), path.join(home, '.claude', 'projects'));
  });

  it('sees global skills + projects through the symlinks', () => {
    const dir = createOverlayProfile('work');
    assert.ok(fs.existsSync(path.join(dir, 'skills', 'airtable', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, 'projects', '-proj')));
  });

  it('marks the profile as overlay', () => {
    createOverlayProfile('work');
    assert.equal(isOverlayProfile('work'), true);
  });

  it('a classic profile is not overlay', () => {
    createProfile('classic');
    assert.equal(isOverlayProfile('classic'), false);
  });

  it('isolates credentials: the primitive creates no .credentials.json / .claude.json', () => {
    const dir = createOverlayProfile('work');
    assert.equal(fs.existsSync(path.join(dir, '.credentials.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.claude.json')), false);
  });

  it('creates a non-broken projects/ symlink on a fresh machine (no global projects yet)', () => {
    fs.rmSync(path.join(home, '.claude', 'projects'), { recursive: true, force: true });
    const dir = createOverlayProfile('fresh');
    const projects = path.join(dir, 'projects');
    assert.ok(fs.lstatSync(projects).isSymbolicLink());
    // The global dir was created so the link resolves rather than dangling.
    assert.ok(fs.statSync(path.join(home, '.claude', 'projects')).isDirectory());
    assert.ok(fs.existsSync(projects));
  });

  it('throws when the profile already exists', () => {
    createOverlayProfile('work');
    assert.throws(() => createOverlayProfile('work'), /already exists/);
  });

  it('rejects an invalid profile name (path escape)', () => {
    assert.throws(() => createOverlayProfile('../escape'), /Invalid profile name|resolves outside/);
  });
});

describe('handleProfileCreate --as-global', () => {
  let saved: SavedHome;
  let home: string;
  let origLog: typeof console.log;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-overlay-cmd-'));
    saved = setFakeHome(home);
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    origLog = console.log;
    console.log = () => {}; // silence the handler's "Next steps" banner
  });

  afterEach(() => {
    console.log = origLog;
    restoreFakeHome(saved);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('creates an overlay profile when opts.overlay is true', async () => {
    await handleProfileCreate('work', { overlay: true });
    assert.equal(isOverlayProfile('work'), true);
  });

  it('creates a classic (non-overlay) profile by default', async () => {
    await handleProfileCreate('classic');
    assert.equal(isOverlayProfile('classic'), false);
  });
});

describe('profile list --json exposes overlay', () => {
  let saved: SavedHome;
  let home: string;
  let origLog: typeof console.log;
  let origWrite: typeof process.stdout.write;
  let out: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-overlay-list-'));
    saved = setFakeHome(home);
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    out = [];
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array): boolean => {
      out.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    origLog = console.log;
    console.log = () => {}; // silence create banners
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    console.log = origLog;
    restoreFakeHome(saved);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('marks overlay profiles overlay:true and classic overlay:false', async () => {
    await handleProfileCreate('work', { overlay: true });
    await handleProfileCreate('classic');
    out.length = 0; // discard anything emitted during creation
    await handleProfileList({ json: true });
    const line = out.join('').split('\n').find((l) => l.trim().startsWith('['));
    assert.ok(line, 'expected a JSON array line on stdout');
    const entries = JSON.parse(line) as Array<{ name: string; overlay: boolean }>;
    assert.equal(entries.find((e) => e.name === 'work')?.overlay, true);
    assert.equal(entries.find((e) => e.name === 'classic')?.overlay, false);
  });
});

describe('importProfileFromAccount --as-global (overlay)', () => {
  let saved: SavedHome;
  let home: string;
  let accountsDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-overlay-import-'));
    saved = setFakeHome(home);
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    accountsDir = path.join(home, '.claude', 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(accountsDir, 'me@x.com.json'),
      JSON.stringify({
        emailAddress: 'me@x.com',
        _keychain: {
          claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
        },
      }),
    );
  });

  afterEach(() => {
    restoreFakeHome(saved);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('imports the account into an overlay and keeps the symlinks intact', () => {
    const res = importProfileFromAccount('me@x.com', accountsDir, 'work', {
      createDir: createOverlayProfile,
    });
    assert.equal(res.emailAddress, 'me@x.com');
    assert.equal(isOverlayProfile('work'), true);
    const profDir = path.join(home, '.claude', 'profiles', 'work');
    // The import writes .claude.json / creds (separate files) — the shared
    // skills/ and projects/ symlinks must survive untouched.
    assert.ok(fs.lstatSync(path.join(profDir, 'skills')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(profDir, 'projects')).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(profDir, '.claude.json')));
  });

  it('default createDir makes a classic, non-overlay profile', () => {
    importProfileFromAccount('me@x.com', accountsDir, 'classic');
    assert.equal(isOverlayProfile('classic'), false);
  });
});
