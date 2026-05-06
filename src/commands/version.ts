// src/commands/version.ts
import { VERSION } from '../version.js';

export function handleVersion(): void {
  console.log(`claude-switch ${VERSION}`);
}
