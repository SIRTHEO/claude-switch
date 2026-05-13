// src/ui/screens/add-account.tsx
// Ink port of `claude switch add`.
//
// The OAuth handshake runs in a real `claude auth login` subprocess that
// owns stdio (it opens a browser and waits for the user to come back).
// Trying to keep Ink mounted across that spawn corrupts the TTY, so the
// flow is split into TWO independent Ink renders separated by the spawn:
//
//   1. pre-spawn  — gather optional expected email
//   2. (no Ink)   — spawnSync claude auth login, plain stdio
//   3. post-spawn — confirm mismatch, prompt for alias, render summary
//
// Each render fully unmounts before the next stage, so neither Ink layer
// fights the subprocess for the terminal.

import { useEffect, useState } from 'react';
import { spawnSync } from 'node:child_process';
import { Box, Text, render, useApp } from 'ink';
import { clearScreen } from '../screen-buffer.js';import { Badge, ConfirmInput, StatusMessage, TextInput } from '@inkjs/ui';

import { getCurrent, save, load, list } from '../../accounts.js';
import { withLock } from '../../lock.js';
import { setAlias } from '../../aliases.js';
import { buildSpawnArgs } from '../../proxy.js';
import { ORANGE } from '../theme.js';
import { awaitInkScreen } from '../utils/ink-screen.js';

export interface AddAccountResult {
  email: string | null;
  alias: string | null;
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Pre-spawn: ask the optional expected email.
// ---------------------------------------------------------------------------

interface PreProps {
  onSubmit: (email: string) => void;
}

function PreSpawnScreen({ onSubmit }: PreProps) {
  const { exit } = useApp();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed && !trimmed.includes('@')) {
      setError('That does not look like an email.');
      return;
    }
    onSubmit(trimmed);
    exit();
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>Add account</Badge>
      </Box>
      <Text color="gray">
        Email of the account you are about to add (Enter to skip):
      </Text>
      <Box marginTop={1}>
        <Text>› </Text>
        <TextInput
          placeholder="work@company.com"
          onSubmit={handleSubmit}
        />
      </Box>
      {error && (
        <Box marginTop={1}>
          <StatusMessage variant="error">{error}</StatusMessage>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray">(Ctrl+C to cancel)</Text>
      </Box>
    </Box>
  );
}

async function askExpectedEmail(): Promise<string | null> {
  let result: string | null = null;
  let cancelled = true;
  clearScreen();
  const instance = render(
    <PreSpawnScreen
      onSubmit={(email) => {
        result = email;
        cancelled = false;
      }}
    />,
    { exitOnCtrlC: true },
  );
  return awaitInkScreen(instance, () => (cancelled ? null : result));
}

// ---------------------------------------------------------------------------
// Post-spawn: confirm mismatch + alias prompt + summary.
// ---------------------------------------------------------------------------

type PostStep =
  | { kind: 'confirm-mismatch' }
  | { kind: 'alias' }
  | { kind: 'saving' }
  | { kind: 'summary'; alias: string | null }
  | { kind: 'cancelled'; reason: string };

interface PostProps {
  newEmail: string;
  expectedEmail: string;
  currentEmail: string;
  claudeJsonPath: string;
  accountsDirPath: string;
  onDone: (result: AddAccountResult) => void;
}

function PostSpawnScreen({
  newEmail,
  expectedEmail,
  currentEmail,
  claudeJsonPath,
  accountsDirPath,
  onDone,
}: PostProps) {
  const { exit } = useApp();
  const initial: PostStep =
    expectedEmail && newEmail !== expectedEmail
      ? { kind: 'confirm-mismatch' }
      : { kind: 'saving' };
  const [step, setStep] = useState<PostStep>(initial);

  const finish = (result: AddAccountResult): void => {
    onDone(result);
    exit();
  };

  // Persist the account once we transition into the saving step. Triggered
  // both at first render (when there is no mismatch confirmation) and after
  // the user accepts the mismatch. `onDone` + `exit` are inlined so the
  // effect's deps stay stable across renders.
  useEffect(() => {
    if (step.kind !== 'saving') return;
    try {
      withLock(accountsDirPath, () => save(newEmail, claudeJsonPath, accountsDirPath));
      list(accountsDirPath);
      setStep({ kind: 'alias' });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setStep({ kind: 'cancelled', reason });
      onDone({ email: null, alias: null, cancelled: true });
      exit();
    }
  }, [step.kind, newEmail, claudeJsonPath, accountsDirPath, exit, onDone]);

  const onAliasSubmit = (raw: string): void => {
    const aliasName = raw.trim();
    if (!aliasName) {
      setStep({ kind: 'summary', alias: null });
      finish({ email: newEmail, alias: null, cancelled: false });
      return;
    }
    try {
      setAlias(aliasName, newEmail, accountsDirPath);
      setStep({ kind: 'summary', alias: aliasName });
      finish({ email: newEmail, alias: aliasName, cancelled: false });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setStep({ kind: 'cancelled', reason: `Alias not saved: ${reason}` });
      finish({ email: newEmail, alias: null, cancelled: false });
    }
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>Signed in</Badge>
        <Text> {newEmail}</Text>
      </Box>

      {step.kind === 'confirm-mismatch' && (
        <Box flexDirection="column">
          <StatusMessage variant="warning">
            Different account signed in.
          </StatusMessage>
          <Text color="gray">Expected: {expectedEmail}</Text>
          <Text color="gray">Got:      {newEmail}</Text>
          <Box marginTop={1}>
            <Text>Save the account that was actually signed in? </Text>
            <ConfirmInput
              defaultChoice="confirm"
              onConfirm={() => setStep({ kind: 'saving' })}
              onCancel={() => {
                if (currentEmail) {
                  withLock(accountsDirPath, () => load(currentEmail, claudeJsonPath, accountsDirPath));
                }
                setStep({ kind: 'cancelled', reason: 'Cancelled. No account added.' });
                finish({ email: null, alias: null, cancelled: true });
              }}
            />
          </Box>
        </Box>
      )}

      {step.kind === 'saving' && <Text color={ORANGE}>… saving</Text>}

      {step.kind === 'alias' && (
        <Box flexDirection="column">
          <StatusMessage variant="success">Saved {newEmail}.</StatusMessage>
          <Text color="gray">
            Optional alias (a short nickname you can type instead of the email):
          </Text>
          <Box marginTop={1}>
            <Text>› </Text>
            <TextInput placeholder="work, personal, … (Enter to skip)" onSubmit={onAliasSubmit} />
          </Box>
        </Box>
      )}

      {step.kind === 'summary' && (
        <Box flexDirection="column">
          <StatusMessage variant="success">Done.</StatusMessage>
          <Text color="gray">Email: {newEmail}</Text>
          {step.alias && <Text color="gray">Alias: {step.alias}</Text>}
          <Text color="gray">Switch any time with: claude switch</Text>
        </Box>
      )}

      {step.kind === 'cancelled' && (
        <StatusMessage variant="info">{step.reason}</StatusMessage>
      )}
    </Box>
  );
}

async function renderPostSpawn(
  newEmail: string,
  expectedEmail: string,
  currentEmail: string,
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<AddAccountResult> {
  let result: AddAccountResult = { email: null, alias: null, cancelled: true };
  clearScreen();
  const instance = render(
    <PostSpawnScreen
      newEmail={newEmail}
      expectedEmail={expectedEmail}
      currentEmail={currentEmail}
      claudeJsonPath={claudeJsonPath}
      accountsDirPath={accountsDirPath}
      onDone={(r) => {
        result = r;
      }}
    />,
    { exitOnCtrlC: true },
  );
  return awaitInkScreen(instance, () => result);
}

// ---------------------------------------------------------------------------
// Orchestrator — replaces clack `addAccountInteractive`.
// ---------------------------------------------------------------------------

export async function runAddAccountScreen(
  claudeBin: string,
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<AddAccountResult> {
  const currentEmail = getCurrent(claudeJsonPath);

  const expectedEmail = await askExpectedEmail();
  if (expectedEmail === null) {
    return { email: null, alias: null, cancelled: true };
  }

  // Snapshot current account before the OAuth swap.
  if (currentEmail) {
    withLock(accountsDirPath, () => save(currentEmail, claudeJsonPath, accountsDirPath));
  }

  // Hand the terminal to the real claude binary for the browser handshake.
  // Plain stderr write — Ink is fully unmounted at this point.
  process.stderr.write(
    '\nA browser window will open shortly. Sign in with the new account, then come back here.\n\n',
  );
  const { command, args: spawnArgs, options } = buildSpawnArgs(
    claudeBin, ['auth', 'login'], process.platform,
  );
  spawnSync(command, spawnArgs, options);

  const newEmail = getCurrent(claudeJsonPath);

  if (!newEmail) {
    if (currentEmail) {
      withLock(accountsDirPath, () => load(currentEmail, claudeJsonPath, accountsDirPath));
    }
    process.stderr.write('\nLogin failed or was cancelled. No account added.\n');
    return { email: null, alias: null, cancelled: true };
  }

  if (newEmail === currentEmail) {
    process.stderr.write('\nBrowser closed before sign-in finished. No account added.\n');
    return { email: null, alias: null, cancelled: true };
  }

  return renderPostSpawn(
    newEmail,
    expectedEmail,
    currentEmail ?? '',
    claudeJsonPath,
    accountsDirPath,
  );
}
