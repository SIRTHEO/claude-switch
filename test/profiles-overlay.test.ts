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

import { createOverlayProfile, isOverlayProfile } from '../src/profiles/overlay.js';
import { createProfile } from '../src/profiles/profiles.js';
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
