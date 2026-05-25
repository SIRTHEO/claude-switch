// src/ui/screens/pick-account.tsx
// One-shot account picker for advanced/remove flows. Returns the selected
// email or null on cancel. Distinct from the dashboard picker which carries
// status panels and spawn-on-switch — this is a pure list.

import { useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { clearScreen } from '../screen-buffer.js';import { Badge } from '@inkjs/ui';

import { list as listAccounts } from '../../accounts/accounts.js';
import { ORANGE } from '../theme.js';
import { awaitInkScreen } from '../utils/ink-screen.js';

interface Props {
  title: string;
  accountsDirPath: string;
  exclude?: string;
  onDone: (email: string | null) => void;
}

function PickAccountScreen({ title, accountsDirPath, exclude, onDone }: Props) {
  const { exit } = useApp();
  const accounts = listAccounts(accountsDirPath).filter((a) => a !== exclude);
  const [cursor, setCursor] = useState(0);

  const finish = (email: string | null): void => {
    onDone(email);
    exit();
  };

  useInput((_input, key) => {
    if (accounts.length === 0) {
      if (key.escape || key.return) finish(null);
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(accounts.length - 1, c + 1));
    else if (key.escape) finish(null);
    else if (key.return) {
      const email = accounts[cursor];
      finish(email ?? null);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>{title}</Badge>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        {accounts.length === 0 && <Text color="gray">  (no matching accounts — esc to go back)</Text>}
        {accounts.map((email, i) => {
          const selected = i === cursor;
          return (
            <Box key={email}>
              <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
              <Text bold={selected}>{email}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑↓ select · enter pick · esc cancel</Text>
      </Box>
    </Box>
  );
}

export async function runPickAccount(
  title: string,
  accountsDirPath: string,
  exclude?: string,
): Promise<string | null> {
  let result: string | null = null;
  clearScreen();
  const instance = render(
    <PickAccountScreen
      title={title}
      accountsDirPath={accountsDirPath}
      exclude={exclude}
      onDone={(email) => { result = email; }}
    />,
    { exitOnCtrlC: true },
  );
  return awaitInkScreen(instance, () => result);
}
