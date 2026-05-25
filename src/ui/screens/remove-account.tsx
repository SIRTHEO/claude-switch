// src/ui/screens/remove-account.tsx
// Ink port of the `remove <email>` confirmation flow. State machine:
//   precheck → confirm → removing → done.
// Mirrors the clack version's safety gates (active-account refuse + lock
// re-check) so behaviour is unchanged.

import { useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { Box, Text, render, useApp } from 'ink';
import { clearScreen } from '../screen-buffer.js';import { Badge, ConfirmInput, StatusMessage } from '@inkjs/ui';

import { removeSafely as removeAccountSafely, getCurrent } from '../../accounts/accounts.js';
import { getAliasesForEmail } from '../../switching/aliases.js';
import { getApiKey, maskApiKey } from '../../credentials/apikey.js';
import { ORANGE } from '../theme.js';
import { awaitInkScreen } from '../utils/ink-screen.js';

export interface RemoveAccountResult {
  removed: boolean;
  cancelled: boolean;
}

interface Preview {
  lines: string[];
  hadAliases: boolean;
}

export function buildPreview(email: string, accountsDirPath: string): Preview | { error: string } {
  const accountFile = path.join(accountsDirPath, `${email}.json`);
  if (!fs.existsSync(accountFile)) {
    return { error: `No saved account for ${email}.` };
  }
  let hasKeychain = false;
  try {
    const data = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
    hasKeychain = !!data._keychain;
  } catch {
    /* malformed file — proceed with the rest of the preview */
  }
  const lines: string[] = [];
  if (hasKeychain) lines.push('• Saved OAuth tokens (Keychain snapshot)');
  lines.push(`• Account file ${accountFile}`);
  const aliases = getAliasesForEmail(email, accountsDirPath);
  if (aliases.length > 0) lines.push(`• Aliases: ${aliases.join(', ')}`);
  const apiKey = getApiKey(email, accountsDirPath);
  if (apiKey) lines.push(`• API key (${maskApiKey(apiKey)})`);
  return { lines, hadAliases: aliases.length > 0 };
}

type Step =
  | { kind: 'confirm'; preview: Preview }
  | { kind: 'removing' }
  | { kind: 'removed'; hadAliases: boolean }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; reason: string };

interface Props {
  email: string;
  claudeJsonPath: string;
  accountsDirPath: string;
  initialStep: Step;
  onDone: (result: RemoveAccountResult) => void;
}

export function RemoveAccountScreen({ email, claudeJsonPath, accountsDirPath, initialStep, onDone }: Props) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(initialStep);

  const finish = (result: RemoveAccountResult): void => {
    onDone(result);
    exit();
  };

  const doRemove = (): void => {
    setStep({ kind: 'removing' });
    try {
      removeAccountSafely(email, claudeJsonPath, accountsDirPath);
      const hadAliases = step.kind === 'confirm' ? step.preview.hadAliases : false;
      setStep({ kind: 'removed', hadAliases });
      finish({ removed: true, cancelled: false });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setStep({ kind: 'failed', reason });
      finish({ removed: false, cancelled: false });
    }
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>Remove</Badge>
        <Text> {email}</Text>
      </Box>

      {step.kind === 'confirm' && (
        <Box flexDirection="column">
          <Text bold color="yellow">Will be deleted:</Text>
          {step.preview.lines.map((l) => (
            <Text key={l} color="gray">{l}</Text>
          ))}
          <Box marginTop={1}>
            <Text>Really remove {email}? </Text>
            <ConfirmInput
              defaultChoice="cancel"
              onConfirm={doRemove}
              onCancel={() => {
                setStep({ kind: 'cancelled', reason: 'Cancelled. Nothing was removed.' });
                finish({ removed: false, cancelled: true });
              }}
            />
          </Box>
        </Box>
      )}

      {step.kind === 'removing' && <Text color={ORANGE}>… removing</Text>}

      {step.kind === 'removed' && (
        <Box flexDirection="column">
          <StatusMessage variant="success">Removed.</StatusMessage>
          {step.hadAliases && (
            <Text color="yellow">
              Aliases still exist and point at a deleted account. Run
              {' '}<Text bold>claude switch alias --remove &lt;name&gt;</Text> to clean up.
            </Text>
          )}
        </Box>
      )}

      {step.kind === 'cancelled' && (
        <StatusMessage variant="info">{step.reason}</StatusMessage>
      )}

      {step.kind === 'failed' && (
        <StatusMessage variant="error">{step.reason}</StatusMessage>
      )}
    </Box>
  );
}

export async function runRemoveAccountScreen(
  email: string,
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<RemoveAccountResult> {
  // Pre-flight checks happen outside Ink so terminal failure paths don't have
  // to render a single frame.
  if (getCurrent(claudeJsonPath) === email) {
    process.stderr.write('Cannot remove the active account. Switch to another one first.\n');
    return { removed: false, cancelled: true };
  }
  const preview = buildPreview(email, accountsDirPath);
  if ('error' in preview) {
    process.stderr.write(`${preview.error}\n`);
    return { removed: false, cancelled: true };
  }

  let result: RemoveAccountResult = { removed: false, cancelled: true };
  clearScreen();
  const instance = render(
    <RemoveAccountScreen
      email={email}
      claudeJsonPath={claudeJsonPath}
      accountsDirPath={accountsDirPath}
      initialStep={{ kind: 'confirm', preview }}
      onDone={(r) => {
        result = r;
      }}
    />,
    { exitOnCtrlC: true },
  );
  return awaitInkScreen(instance, () => result);
}
