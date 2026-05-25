// `claude switch terminals [--json]` — list the terminal emulators the
// host has installed and the launcher can target. The GUI consumes the
// JSON shape to populate the per-profile "Launch in ▾" dropdown.

import { detectTerminals } from '../sessions/terminals.js';

interface TerminalsOptions {
  json: boolean;
}

export function handleTerminals(opts: TerminalsOptions = { json: false }): void {
  const terminals = detectTerminals();

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(terminals)}\n`);
    return;
  }

  if (terminals.length === 0) {
    console.log('No supported terminals detected on this host.');
    return;
  }
  console.log('Available terminals:\n');
  for (const t of terminals) {
    const flag = t.isDefault ? '*' : ' ';
    console.log(`  ${flag} ${t.id.padEnd(18)} ${t.label}`);
  }
}
