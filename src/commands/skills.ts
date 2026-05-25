// src/commands/skills.ts
// `claude switch skills …` — inspect globally installed skills. For now just
// `list` (+ `--json` for the GUI contract). Composing a profile's skills lands
// in Phase 22.2 (`profile skills link/unlink`).

import { ExitError } from '../platform/errors.js';
import type { ProfileSkillEntry, SkillEntry } from '../contract.js';

interface SkillsListOptions {
  json: boolean;
}

export async function handleSkillsList(
  opts: SkillsListOptions = { json: false },
): Promise<void> {
  const { listSkills, readSkill } = await import('../profiles/skills.js');
  const names = listSkills();

  if (opts.json) {
    const payload: SkillEntry[] = names.map((name) => {
      const info = readSkill(name);
      return {
        name: info.name,
        description: info.description,
        source: info.source,
        path: info.path,
      };
    });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (names.length === 0) {
    console.log('No skills installed in ~/.claude/skills.');
    return;
  }
  console.log('Skills:\n');
  for (const name of names) {
    const info = readSkill(name);
    const desc = info.description ? ` — ${truncate(info.description, 80)}` : '';
    console.log(`  ${name.padEnd(24)}${desc}`);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

async function requireProfile(profileName: string): Promise<void> {
  const { profileExists } = await import('../profiles/profiles.js');
  if (!profileExists(profileName)) {
    throw new ExitError(`Profile "${profileName}" does not exist.`);
  }
}

export async function handleProfileSkillsList(
  profileName: string,
  opts: SkillsListOptions = { json: false },
): Promise<void> {
  await requireProfile(profileName);
  const { listProfileSkills } = await import('../profiles/skills.js');
  const entries = listProfileSkills(profileName);

  if (opts.json) {
    const payload: ProfileSkillEntry[] = entries.map((e) => ({
      name: e.name,
      linked: e.linked,
      broken: e.broken,
      path: e.path,
    }));
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  const linked = entries.filter((e) => e.linked);
  console.log(`Skills linked into profile "${profileName}":\n`);
  if (linked.length === 0) {
    console.log('  (none)');
  } else {
    for (const e of linked) {
      console.log(`  ${e.name.padEnd(24)}${e.broken ? ' — BROKEN (target missing)' : ''}`);
    }
  }
  const available = entries.filter((e) => !e.linked);
  if (available.length > 0) {
    console.log(`\nAvailable to link (${available.length}): ${available.map((e) => e.name).join(', ')}`);
  }
}

export async function handleProfileSkillsLink(
  profileName: string,
  skillName: string,
): Promise<void> {
  await requireProfile(profileName);
  const { linkSkillToProfile } = await import('../profiles/skills.js');
  linkSkillToProfile(profileName, skillName);
  console.log(`Linked skill "${skillName}" into profile "${profileName}".`);
}

export async function handleProfileSkillsUnlink(
  profileName: string,
  skillName: string,
): Promise<void> {
  await requireProfile(profileName);
  const { unlinkSkillFromProfile } = await import('../profiles/skills.js');
  unlinkSkillFromProfile(profileName, skillName);
  console.log(`Unlinked skill "${skillName}" from profile "${profileName}".`);
}
