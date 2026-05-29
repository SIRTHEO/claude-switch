// src/commands/versions.ts
//
// `claude switch versions` — multi-target update-availability report.
// Read-only: emits the report, never installs (the install action lives in
// `claude switch update <target>`).
//
// JSON contract (`--json`): a single line on stdout matching the
// VersionsReport interface in src/contract.ts; clean stderr; exit 0 even
// when individual lookups fail (the GUI uses null latest to render
// "Could not check"). Non-JSON mode prints a small human-readable table
// for terminal users.

import { getVersionsReport, type VersionsOptions } from '../setup/versions/index.js';
import type { VersionTarget, VersionsReport } from '../contract.js';

interface VersionsCommandOptions {
  json: boolean;
  force: boolean;
}

export async function handleVersions(
  opts: VersionsCommandOptions,
  deps: Pick<VersionsOptions, 'http' | 'process' | 'now'> = {},
): Promise<void> {
  const report = await getVersionsReport({ force: opts.force, ...deps });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  printHuman(report);
}

function printHuman(report: VersionsReport): void {
  const rows: Array<[string, VersionTarget]> = [
    ['claude', report.claude],
    ['claude-switch', report.switch],
    ['claude-switch-gui', report.gui],
  ];
  process.stdout.write('Versions\n');
  for (const [name, t] of rows) {
    const current = t.current ?? '—';
    const latest = t.latest ?? '?';
    const arrow = t.upgradable ? ' → upgrade available' : '';
    const src = ` [${t.source}]`;
    process.stdout.write(`  ${name.padEnd(18)} ${current.padEnd(10)} (latest ${latest})${src}${arrow}\n`);
  }
  process.stdout.write(`\nLast checked: ${report.switch.lastCheckedAt}\n`);
}
