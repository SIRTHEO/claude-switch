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

export interface SkillInfo {
  name: string;
  /** Absolute path to the skill directory. */
  path: string;
  /** First `description:` from the SKILL.md frontmatter, or null if absent. */
  description: string | null;
  /** Origin of the skill. Currently only the user skills dir is inventoried. */
  source: 'user';
}

/** Root directory under which global skill dirs live. */
export function skillsDir(): string {
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
