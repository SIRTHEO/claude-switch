// src/switcher.ts
import { getCurrent, save, load } from './accounts.js';

export function switchTo(targetEmail: string, claudeJsonPath: string, accountsDirPath: string): string {
  const currentEmail = getCurrent(claudeJsonPath);

  if (targetEmail === currentEmail) {
    return `Already on ${targetEmail}`;
  }

  if (currentEmail) {
    save(currentEmail, claudeJsonPath, accountsDirPath);
  }

  load(targetEmail, claudeJsonPath, accountsDirPath);
  return `Switched to ${targetEmail}`;
}

export function fuzzyMatch(input: string, accounts: string[]): string[] {
  const lower = input.toLowerCase();

  // Exact match first
  const exact = accounts.find(a => a === input);
  if (exact) return [exact];

  // Partial match (case-insensitive)
  return accounts.filter(a => a.toLowerCase().includes(lower));
}
