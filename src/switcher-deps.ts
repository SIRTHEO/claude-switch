// src/switcher-deps.ts
// Shared dependency-injection seam for the switcher operations. Production
// code passes nothing (defaults are used); tests inject fakes.

import type { ProcessPort } from './process.js';

export interface SwitcherDeps {
  process?: ProcessPort;
  askFn?: (question: string) => Promise<string>;
  exitFn?: (code: number) => never;
  getTokenHealthFn?: (claudeJsonPath: string) => { status: string } | null;
  saveFn?: (email: string, claudeJsonPath: string, accountsDirPath: string) => void;
  loadFn?: (email: string, claudeJsonPath: string, accountsDirPath: string) => { keychainRestored: boolean };
}
