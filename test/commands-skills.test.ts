// test/commands-skills.test.ts
// Coverage for `src/commands/skills.ts` + `src/skills.ts`.
//
// The skills module uses os.homedir() for ~/.claude/skills. We override HOME
// via the fake-home helper so tests are isolated from the real skills store.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleProfileSkillsList, handleSkillsList } from '../src/commands/skills.js';
import {
  linkSkillToProfile,
  listProfileSkills,
  unlinkSkillFromProfile,
} from '../src/skills.js';
import { setFakeHome, restoreFakeHome, type SavedHome } from './_helpers/fake-home.js';

interface Harness {
  tmpDir: string;
  fakeHome: string;
  skillsDir: string;
  stdout: string[];
  stderr: string[];
  savedHome: SavedHome;
}

function setup(): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-skills-'));
  const fakeHome = path.join(tmpDir, 'home');
  const skillsDir = path.join(fakeHome, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  const savedHome = setFakeHome(fakeHome);
  return { tmpDir, fakeHome, skillsDir, stdout: [], stderr: [], savedHome };
}

function teardown(h: Harness): void {
  restoreFakeHome(h.savedHome);
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

function makeSkill(h: Harness, name: string, description?: string): void {
  const dir = path.join(h.skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const body =
    description != null
      ? `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`
      : `# ${name}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

function capture(h: Harness): () => void {
  const origLog = console.log;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]) => {
    h.stdout.push(args.map(String).join(' '));
  };
  process.stdout.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    h.stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    h.stderr.push(String(chunk));
    return true;
  };
  return () => {
    console.log = origLog;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
}

describe('handleSkillsList', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => teardown(h));

  it('emits "[]" on --json when no skills exist (clean stderr)', async () => {
    const restore = capture(h);
    await handleSkillsList({ json: true });
    restore();
    assert.deepEqual(JSON.parse(h.stdout.join('').trim()), []);
    assert.equal(h.stderr.join(''), '');
  });

  it('emits a JSON array with name/description/source/path (no banner)', async () => {
    makeSkill(h, 'airtable', 'Airtable integration for Node.');
    makeSkill(h, 'zod', 'Schema validation.');
    const restore = capture(h);
    await handleSkillsList({ json: true });
    restore();
    const parsed = JSON.parse(h.stdout.join('').trim()) as Array<{
      name: string;
      description: string | null;
      source: string;
      path: string;
    }>;
    assert.equal(parsed.length, 2);
    const airtable = parsed.find((p) => p.name === 'airtable');
    assert.ok(airtable);
    assert.equal(airtable?.description, 'Airtable integration for Node.');
    assert.equal(airtable?.source, 'user');
    assert.equal(airtable?.path, path.join(h.skillsDir, 'airtable'));
    assert.equal(h.stderr.join(''), '');
  });

  it('ignores directories without a SKILL.md', async () => {
    makeSkill(h, 'real', 'A real skill.');
    fs.mkdirSync(path.join(h.skillsDir, 'not-a-skill'), { recursive: true });
    const restore = capture(h);
    await handleSkillsList({ json: true });
    restore();
    const parsed = JSON.parse(h.stdout.join('').trim()) as Array<{ name: string }>;
    assert.deepEqual(
      parsed.map((p) => p.name),
      ['real'],
    );
  });

  it('returns null description when frontmatter is absent', async () => {
    makeSkill(h, 'bare');
    const restore = capture(h);
    await handleSkillsList({ json: true });
    restore();
    const parsed = JSON.parse(h.stdout.join('').trim()) as Array<{
      description: string | null;
    }>;
    assert.equal(parsed[0]?.description, null);
  });

  it('prints a human list when not --json', async () => {
    makeSkill(h, 'airtable', 'Airtable integration.');
    const restore = capture(h);
    await handleSkillsList({ json: false });
    restore();
    const out = h.stdout.join('\n');
    assert.match(out, /Skills:/);
    assert.match(out, /airtable/);
  });

  it('prints a no-skills message when empty and not --json', async () => {
    const restore = capture(h);
    await handleSkillsList({ json: false });
    restore();
    assert.match(h.stdout.join('\n'), /No skills/);
  });
});

function makeProfile(h: Harness, name: string): string {
  const dir = path.join(h.fakeHome, '.claude', 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('profile skills link/unlink/list', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => teardown(h));

  it('links a global skill into a profile as a symlink to the global dir', () => {
    makeSkill(h, 'airtable', 'desc');
    makeProfile(h, 'work');
    linkSkillToProfile('work', 'airtable');
    const link = path.join(h.fakeHome, '.claude', 'profiles', 'work', 'skills', 'airtable');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readlinkSync(link), path.join(h.skillsDir, 'airtable'));
  });

  it('is idempotent when the same link already exists', () => {
    makeSkill(h, 'airtable', 'd');
    makeProfile(h, 'work');
    linkSkillToProfile('work', 'airtable');
    assert.doesNotThrow(() => linkSkillToProfile('work', 'airtable'));
  });

  it('refuses to link an unknown skill', () => {
    makeProfile(h, 'work');
    assert.throws(() => linkSkillToProfile('work', 'nope'), /not found/);
  });

  it('rejects an invalid skill name (path escape)', () => {
    makeProfile(h, 'work');
    assert.throws(() => linkSkillToProfile('work', '../../etc'), /Invalid skill name/);
  });

  it('lists linked vs available and detects broken links', () => {
    makeSkill(h, 'a', 'da');
    makeSkill(h, 'b', 'db');
    makeProfile(h, 'work');
    linkSkillToProfile('work', 'a');
    let entries = listProfileSkills('work');
    assert.equal(entries.find((e) => e.name === 'a')?.linked, true);
    assert.equal(entries.find((e) => e.name === 'a')?.broken, false);
    assert.equal(entries.find((e) => e.name === 'b')?.linked, false);

    // Remove the global skill 'a' → its link is now broken.
    fs.rmSync(path.join(h.skillsDir, 'a'), { recursive: true, force: true });
    entries = listProfileSkills('work');
    const a = entries.find((e) => e.name === 'a');
    assert.equal(a?.linked, true);
    assert.equal(a?.broken, true);
  });

  it('unlinks a skill, removing the symlink but not the global dir', () => {
    makeSkill(h, 'a', 'd');
    makeProfile(h, 'work');
    linkSkillToProfile('work', 'a');
    unlinkSkillFromProfile('work', 'a');
    const link = path.join(h.fakeHome, '.claude', 'profiles', 'work', 'skills', 'a');
    assert.equal(fs.existsSync(link), false);
    assert.ok(fs.existsSync(path.join(h.skillsDir, 'a')));
  });

  it('refuses to unlink a real directory', () => {
    makeProfile(h, 'work');
    const skillsInProfile = path.join(h.fakeHome, '.claude', 'profiles', 'work', 'skills');
    fs.mkdirSync(path.join(skillsInProfile, 'real'), { recursive: true });
    assert.throws(() => unlinkSkillFromProfile('work', 'real'), /real directory/);
  });

  it('emits ProfileSkillEntry[] on --json', async () => {
    makeSkill(h, 'a', 'd');
    makeProfile(h, 'work');
    linkSkillToProfile('work', 'a');
    const restore = capture(h);
    await handleProfileSkillsList('work', { json: true });
    restore();
    const parsed = JSON.parse(h.stdout.join('').trim()) as Array<{
      name: string;
      linked: boolean;
      broken: boolean;
      path: string;
    }>;
    const a = parsed.find((p) => p.name === 'a');
    assert.equal(a?.linked, true);
    assert.equal(a?.broken, false);
    assert.equal(h.stderr.join(''), '');
  });
});
