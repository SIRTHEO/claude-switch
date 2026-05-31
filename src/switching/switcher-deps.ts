// src/switcher-deps.ts
// Shared dependency-injection seam for the switcher operations. Production
// code passes nothing (defaults are used); tests inject fakes.

import type { ProcessPort } from '../platform/process.js';

export interface SwitcherDeps {
  process?: ProcessPort;
  askFn?: (question: string) => Promise<string>;
  getTokenHealthFn?: (claudeJsonPath: string) => { status: string } | null;
}
