// src/ui/ink/run-dashboard.tsx
// Bootstrap helper: renders the Ink dashboard and resolves when the user
// quits (q, ESC, or Ctrl-C).

import React from 'react';
import { render } from 'ink';
import { Dashboard } from './dashboard.js';

export async function runDashboard(claudeJsonPath: string, accountsDirPath: string): Promise<void> {
  const instance = render(
    <Dashboard claudeJsonPath={claudeJsonPath} accountsDirPath={accountsDirPath} />,
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
}
