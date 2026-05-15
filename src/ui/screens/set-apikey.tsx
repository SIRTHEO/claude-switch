// src/ui/screens/set-apikey.tsx
// Ink port of the `apikey set` flow. State machine:
//   overwrite? → enter key → (non-prefix? confirm anyway) → save → done.
// Exposes `runApikeyScreen()` which renders, awaits exit, and resolves the
// same shape the clack version did.

import { useState } from 'react';
import { Box, Text, render, useApp } from 'ink';
import { clearScreen } from '../screen-buffer.js';import { Badge, ConfirmInput, PasswordInput, StatusMessage } from '@inkjs/ui';

import { getApiKey, maskApiKey } from '../../apikey.js';
import { saveApiKeyAndMaybeInit } from '../../auto-fallback.js';
import { ORANGE } from '../theme.js';
import { awaitInkScreen } from '../utils/ink-screen.js';

const KEY_PREFIX = 'sk-ant-';

export interface SetApiKeyResult {
  saved: boolean;
  cancelled: boolean;
  email: string;
}

type Step =
  | { kind: 'overwrite'; existing: string }
  | { kind: 'enter' }
  | { kind: 'confirm-bad-prefix'; key: string }
  | { kind: 'saving'; key: string }
  | { kind: 'saved'; key: string; smartEnabled: boolean }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; reason: string };

interface Props {
  email: string;
  accountsDirPath: string;
  onDone: (result: SetApiKeyResult) => void;
}

export function ApikeyScreen({ email, accountsDirPath, onDone }: Props) {
  const { exit } = useApp();
  const existing = getApiKey(email, accountsDirPath);
  const [step, setStep] = useState<Step>(
    existing ? { kind: 'overwrite', existing } : { kind: 'enter' },
  );

  const finish = (result: SetApiKeyResult): void => {
    onDone(result);
    exit();
  };

  const save = (key: string): void => {
    setStep({ kind: 'saving', key });
    try {
      const { smartEnabled } = saveApiKeyAndMaybeInit(email, key, accountsDirPath);
      setStep({ kind: 'saved', key, smartEnabled });
      finish({ saved: true, cancelled: false, email });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setStep({ kind: 'failed', reason });
      finish({ saved: false, cancelled: false, email });
    }
  };

  const onKeySubmit = (key: string): void => {
    if (!key || key.length < 20) {
      setStep({ kind: 'cancelled', reason: 'Key looks too short. Nothing saved.' });
      finish({ saved: false, cancelled: true, email });
      return;
    }
    if (!key.startsWith(KEY_PREFIX)) {
      setStep({ kind: 'confirm-bad-prefix', key });
      return;
    }
    save(key);
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>API key</Badge>
        <Text> for {email}</Text>
      </Box>

      {step.kind === 'overwrite' && (
        <Box flexDirection="column">
          <Text>An API key is already saved ({maskApiKey(step.existing)}).</Text>
          <Box>
            <Text>Overwrite? </Text>
            <ConfirmInput
              defaultChoice="cancel"
              onConfirm={() => setStep({ kind: 'enter' })}
              onCancel={() => {
                setStep({ kind: 'cancelled', reason: 'Existing key kept.' });
                finish({ saved: false, cancelled: true, email });
              }}
            />
          </Box>
        </Box>
      )}

      {step.kind === 'enter' && (
        <Box flexDirection="column">
          <Text color="gray">
            Get your key at https://console.anthropic.com/settings/keys
          </Text>
          <Text color="gray">It should start with "{KEY_PREFIX}"</Text>
          <Box marginTop={1}>
            <Text>Paste the key (hidden): </Text>
            <PasswordInput placeholder="sk-ant-…" onSubmit={onKeySubmit} />
          </Box>
        </Box>
      )}

      {step.kind === 'confirm-bad-prefix' && (
        <Box flexDirection="column">
          <StatusMessage variant="warning">
            That does not look like an Anthropic key (got {maskApiKey(step.key)}, expected prefix "{KEY_PREFIX}").
          </StatusMessage>
          <Box>
            <Text>Save it anyway? </Text>
            <ConfirmInput
              defaultChoice="cancel"
              onConfirm={() => save(step.key)}
              onCancel={() => {
                setStep({ kind: 'cancelled', reason: 'No key saved.' });
                finish({ saved: false, cancelled: true, email });
              }}
            />
          </Box>
        </Box>
      )}

      {step.kind === 'saving' && (
        <Text color={ORANGE}>… saving</Text>
      )}

      {step.kind === 'saved' && (
        <Box flexDirection="column">
          <StatusMessage variant="success">
            Saved ({maskApiKey(step.key)}).
          </StatusMessage>
          <Text color="gray">
            Smart fallback is {step.smartEnabled ? 'now active' : 'already configured'}.
            {' '}Switches to API key above 95% usage and reverts below 80%.
          </Text>
          <Text color="yellow">
            First-run reminder: claude will ask "Use this API key? [y/N]" — press y.
          </Text>
        </Box>
      )}

      {step.kind === 'cancelled' && (
        <StatusMessage variant="info">{step.reason}</StatusMessage>
      )}

      {step.kind === 'failed' && (
        <StatusMessage variant="error">Save failed: {step.reason}</StatusMessage>
      )}
    </Box>
  );
}

export async function runApikeyScreen(
  email: string,
  accountsDirPath: string,
): Promise<SetApiKeyResult> {
  let result: SetApiKeyResult = { saved: false, cancelled: true, email };
  clearScreen();
  const instance = render(
    <ApikeyScreen
      email={email}
      accountsDirPath={accountsDirPath}
      onDone={(r) => {
        result = r;
      }}
    />,
    { exitOnCtrlC: true },
  );
  return awaitInkScreen(instance, () => result);
}
