// src/commands/completions.ts
// `claude switch --completions <shell>` — emits shell-tab-completion script.

import { ExitError } from '../platform/errors.js';
import { generateBash, generateZsh, generateFish, generatePowerShell } from '../setup/completions.js';

export function handleCompletions(shell: string | undefined): void {
  if (shell === 'bash') {
    console.log(generateBash());
    return;
  }
  if (shell === 'zsh') {
    console.log(generateZsh());
    return;
  }
  if (shell === 'fish') {
    console.log(generateFish());
    return;
  }
  if (shell === 'powershell') {
    console.log(generatePowerShell());
    return;
  }
  throw new ExitError('Usage: claude switch --completions <bash|zsh|fish|powershell>');
}
