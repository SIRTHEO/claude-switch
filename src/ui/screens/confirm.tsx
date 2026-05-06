// src/ui/screens/confirm.tsx
// One-shot yes/no prompt. Reusable across the app for guard confirmations
// that don't justify a full screen on their own.

import { Box, Text, render, useApp } from 'ink';
import { clearScreen } from '../screen-buffer.js';import { Badge, ConfirmInput } from '@inkjs/ui';

import { ORANGE } from '../theme.js';

interface Props {
  title: string;
  message: string;
  defaultYes?: boolean;
  onDone: (yes: boolean) => void;
}

function ConfirmScreen({ title, message, defaultYes = false, onDone }: Props) {
  const { exit } = useApp();
  const finish = (yes: boolean): void => {
    onDone(yes);
    exit();
  };
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>{title}</Badge>
      </Box>
      {message.split('\n').map((line) => (
        <Text key={line || ' '}>{line}</Text>
      ))}
      <Box marginTop={1}>
        <Text>› </Text>
        <ConfirmInput
          defaultChoice={defaultYes ? 'confirm' : 'cancel'}
          onConfirm={() => finish(true)}
          onCancel={() => finish(false)}
        />
      </Box>
    </Box>
  );
}

export async function runConfirm(
  title: string,
  message: string,
  defaultYes = false,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let result = false;
    clearScreen();
    const instance = render(
      <ConfirmScreen
        title={title}
        message={message}
        defaultYes={defaultYes}
        onDone={(yes) => { result = yes; }}
      />,
      { exitOnCtrlC: true },
    );
    instance.waitUntilExit().then(() => resolve(result));
  });
}
