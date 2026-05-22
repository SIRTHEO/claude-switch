// src/commands/skills.ts
// `claude switch skills …` — inspect globally installed skills. For now just
// `list` (+ `--json` for the GUI contract). Composing a profile's skills lands
// in Phase 22.2 (`profile skills link/unlink`).

import type { SkillEntry } from '../contract.js';

interface SkillsListOptions {
  json: boolean;
}

export async function handleSkillsList(
  opts: SkillsListOptions = { json: false },
): Promise<void> {
  const { listSkills, readSkill } = await import('../skills.js');
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
