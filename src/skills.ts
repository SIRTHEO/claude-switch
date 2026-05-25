// src/skills.ts
// Inventory of globally installed Claude Code skills (~/.claude/skills).
//
// A skill is a directory containing a SKILL.md whose YAML frontmatter carries
// `name` and `description`. We only read the inventory here; composing a
// profile's skills (symlinking selected ones into a profile) is a separate
// concern (Phase 22.2). ~/.claude/skills is often a symlink to a real dir —
// readdir/stat follow it transparently.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { profilePath } from './profiles.js';

interface SkillInfo {
  name: string;
  /** Absolute path to the skill directory. */
  path: string;
  /** First `description:` from the SKILL.md frontmatter, or null if absent. */
  description: string | null;
  /** Origin of the skill. Currently only the user skills dir is inventoried. */
  source: 'user';
}

/** Root directory under which global skill dirs live. */
function skillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

/** List global skill names: immediate subdirs of skillsDir that hold a SKILL.md. */
export function listSkills(): string[] {
  try {
    return fs
      .readdirSync(skillsDir())
      .filter((n) => {
        try {
          return fs.statSync(path.join(skillsDir(), n, 'SKILL.md')).isFile();
        } catch {
          return false; // no SKILL.md (or entry vanished) → not a skill dir
        }
      })
      .sort();
  } catch {
    return []; // skills dir absent → no skills installed
  }
}

/** Read a single skill's inventory entry. */
export function readSkill(name: string): SkillInfo {
  const dir = path.join(skillsDir(), name);
  return {
    name,
    path: dir,
    description: readDescription(path.join(dir, 'SKILL.md')),
    source: 'user',
  };
}

/**
 * Pull the `description:` value out of a SKILL.md YAML frontmatter block.
 * Minimal on purpose: reads the first `---`-delimited block and returns the
 * single-line `description` value. Skills use a single-line description today;
 * folded/multi-line YAML scalars are not supported (would return the first
 * line only).
 */
function readDescription(skillMd: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(skillMd, 'utf8');
  } catch {
    return null; // unreadable → no description
  }
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm?.[1]) return null;
  const line = fm[1].split(/\r?\n/).find((l) => /^description\s*:/.test(l));
  if (!line) return null;
  const value = line.replace(/^description\s*:\s*/, '').trim();
  return value || null;
}

// ───────────────────────── profile skill composition ─────────────────────────

const SKILL_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isValidSkillName(name: string): boolean {
  if (name === '.' || name === '..') return false;
  return SKILL_NAME_RE.test(name);
}

/** `<profile>/skills` — where a profile's linked skills live. Reuses
 *  profilePath, so it validates the profile name + refuses path traversal. */
function profileSkillsDir(profileName: string): string {
  return path.join(profilePath(profileName), 'skills');
}

function safeLstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null; // entry absent → caller treats as "not present"
  }
}

function skillExists(name: string): boolean {
  try {
    return fs.statSync(path.join(skillsDir(), name, 'SKILL.md')).isFile();
  } catch {
    return false; // no global skill by this name
  }
}

interface ProfileSkillStatus {
  name: string;
  /** A symlink for this skill exists in the profile's skills dir. */
  linked: boolean;
  /** The link exists but its global target is gone. */
  broken: boolean;
  /** Absolute path of the global skill dir (the link target). */
  path: string;
}

/**
 * Status of every skill known to a profile: the global skills (linked or
 * available) plus any broken links (symlinks whose global target was removed).
 */
export function listProfileSkills(profileName: string): ProfileSkillStatus[] {
  const dir = profileSkillsDir(profileName);
  const global = new Set(listSkills());
  const linkedNames = new Set<string>();
  try {
    for (const n of fs.readdirSync(dir)) {
      if (safeLstat(path.join(dir, n))?.isSymbolicLink()) linkedNames.add(n);
    }
  } catch {
    // profile skills dir absent → nothing linked yet
  }
  const names = [...new Set([...global, ...linkedNames])].sort();
  return names.map((name) => {
    const linked = linkedNames.has(name);
    return {
      name,
      linked,
      broken: linked && !skillExists(name),
      path: path.join(skillsDir(), name),
    };
  });
}

/** Symlink a global skill into a profile. Idempotent if the same link already
 *  exists; refuses to clobber a real dir or a link we don't own. */
export function linkSkillToProfile(profileName: string, skillName: string): void {
  if (!isValidSkillName(skillName)) throw new Error(`Invalid skill name "${skillName}".`);
  if (!skillExists(skillName)) {
    throw new Error(`Skill "${skillName}" not found in ~/.claude/skills.`);
  }
  const dir = profileSkillsDir(profileName);
  fs.mkdirSync(dir, { recursive: true });
  const linkPath = path.join(dir, skillName);
  if (!path.resolve(linkPath).startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`Skill "${skillName}" resolves outside the profile skills directory.`);
  }
  const target = path.join(skillsDir(), skillName);
  const existing = safeLstat(linkPath);
  if (existing) {
    if (existing.isSymbolicLink() && fs.readlinkSync(linkPath) === target) return; // already linked
    throw new Error(
      `"${skillName}" already exists in profile "${profileName}" and is not a link we own.`,
    );
  }
  fs.symlinkSync(target, linkPath, 'dir');
}

/** Remove a skill link from a profile. Refuses to delete a real directory —
 *  only a symlink we created. */
export function unlinkSkillFromProfile(profileName: string, skillName: string): void {
  if (!isValidSkillName(skillName)) throw new Error(`Invalid skill name "${skillName}".`);
  const linkPath = path.join(profileSkillsDir(profileName), skillName);
  const st = safeLstat(linkPath);
  if (!st) throw new Error(`Skill "${skillName}" is not linked in profile "${profileName}".`);
  if (!st.isSymbolicLink()) {
    throw new Error(
      `"${skillName}" in profile "${profileName}" is a real directory, not a link — refusing to remove.`,
    );
  }
  fs.unlinkSync(linkPath);
}
