// src/ui/screens/manage-account.tsx
// Sub-flow for "Manage account" from the home screen. Two-step state
// machine: pick account → action menu. Inline actions (alias add/remove,
// apikey-remove confirm) run in-Ink; spawn-bearing actions (apikey-set,
// remove-account) return a `LaunchRequest` so the wrapper can run the
// existing one-shot screens with their own render lifecycle.

import { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { clearScreen } from '../screen-buffer.js';import { Badge, ConfirmInput, StatusMessage, TextInput } from '@inkjs/ui';

import { getCurrent, list as listAccounts } from '../../accounts.js';
import { getApiKey, removeApiKey } from '../../apikey.js';
import { getAliasesForEmail, setAlias, removeAlias } from '../../aliases.js';
import { withLock } from '../../lock.js';
import { ORANGE } from '../theme.js';
import { runApikeyScreen } from './set-apikey.js';
import { runRemoveAccountScreen } from './remove-account.js';

type LaunchRequest =
  | { kind: 'apikey-set'; email: string }
  | { kind: 'remove-account'; email: string };

export type ScreenExit = { kind: 'back' } | { kind: 'launch'; req: LaunchRequest };

type Step =
  | { kind: 'pick-account' }
  | { kind: 'menu'; email: string }
  | { kind: 'alias-add'; email: string; error?: string }
  | { kind: 'alias-remove'; email: string }
  | { kind: 'confirm-apikey-remove'; email: string }
  | { kind: 'note'; email: string; title: string; body: string };

type Action =
  | 'apikey-set'
  | 'apikey-remove'
  | 'alias-add'
  | 'alias-remove'
  | 'remove'
  | 'back';

interface MenuItem {
  value: Action;
  label: string;
  hint?: string;
}

function buildMenu(email: string, accountsDirPath: string, isActive: boolean): MenuItem[] {
  const hasKey = !!getApiKey(email, accountsDirPath);
  const aliases = getAliasesForEmail(email, accountsDirPath);
  const items: MenuItem[] = [];
  items.push({
    value: 'apikey-set',
    label: hasKey ? 'Replace API key' : 'Set API key',
    hint: hasKey ? 'overwrite the current key' : 'paste an Anthropic key',
  });
  if (hasKey) items.push({ value: 'apikey-remove', label: 'Remove API key', hint: 'forget the saved key' });
  items.push({ value: 'alias-add', label: 'Add alias', hint: 'short nickname' });
  if (aliases.length > 0) items.push({ value: 'alias-remove', label: 'Remove alias', hint: aliases.join(', ') });
  if (!isActive) items.push({ value: 'remove', label: 'Remove account', hint: 'delete tokens, key, aliases' });
  items.push({ value: 'back', label: 'Back', hint: 'return to main menu' });
  return items;
}

interface ScreenProps {
  claudeJsonPath: string;
  accountsDirPath: string;
  initialEmail: string | null;
  onExit: (e: ScreenExit) => void;
}

export function ManageScreen({ claudeJsonPath, accountsDirPath, initialEmail, onExit }: ScreenProps) {
  const { exit } = useApp();
  const accounts = listAccounts(accountsDirPath);
  const initial: Step = initialEmail
    ? { kind: 'menu', email: initialEmail }
    : { kind: 'pick-account' };
  const [step, setStep] = useState<Step>(initial);
  const [accCursor, setAccCursor] = useState(0);
  const [menuCursor, setMenuCursor] = useState(0);
  const [aliasCursor, setAliasCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const finish = (e: ScreenExit): void => {
    onExit(e);
    exit();
  };

  // Refresh menu cursor when re-entering the menu (counts may shift).
  useEffect(() => {
    if (step.kind === 'menu') setMenuCursor((c) => Math.max(0, c));
  }, [step.kind]);

  const menuItems = step.kind === 'menu'
    ? buildMenu(step.email, accountsDirPath, getCurrent(claudeJsonPath) === step.email)
    : [];
  const aliases = step.kind === 'alias-remove'
    ? getAliasesForEmail(step.email, accountsDirPath)
    : [];

  useInput((_input, key) => {
    if (step.kind === 'pick-account') {
      if (accounts.length === 0) {
        if (key.escape || key.return) finish({ kind: 'back' });
        return;
      }
      if (key.upArrow) setAccCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setAccCursor((c) => Math.min(accounts.length - 1, c + 1));
      else if (key.escape) finish({ kind: 'back' });
      else if (key.return) {
        const email = accounts[accCursor];
        if (email) setStep({ kind: 'menu', email });
      }
      return;
    }

    if (step.kind === 'menu') {
      if (key.upArrow) setMenuCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setMenuCursor((c) => Math.min(menuItems.length - 1, c + 1));
      else if (key.escape) finish({ kind: 'back' });
      else if (key.return) {
        const item = menuItems[menuCursor];
        if (!item) return;
        switch (item.value) {
          case 'back':
            finish({ kind: 'back' });
            return;
          case 'apikey-set':
            finish({ kind: 'launch', req: { kind: 'apikey-set', email: step.email } });
            return;
          case 'remove':
            finish({ kind: 'launch', req: { kind: 'remove-account', email: step.email } });
            return;
          case 'apikey-remove':
            setStep({ kind: 'confirm-apikey-remove', email: step.email });
            return;
          case 'alias-add':
            setStep({ kind: 'alias-add', email: step.email });
            return;
          case 'alias-remove':
            setStep({ kind: 'alias-remove', email: step.email });
            setAliasCursor(0);
            return;
        }
      }
      return;
    }

    if (step.kind === 'alias-remove') {
      if (aliases.length === 0) {
        if (key.escape || key.return) setStep({ kind: 'menu', email: step.email });
        return;
      }
      if (key.upArrow) setAliasCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setAliasCursor((c) => Math.min(aliases.length - 1, c + 1));
      else if (key.escape) setStep({ kind: 'menu', email: step.email });
      else if (key.return) {
        const alias = aliases[aliasCursor];
        if (alias) {
          try {
            removeAlias(alias, accountsDirPath);
            setStep({ kind: 'note', email: step.email, title: 'Done', body: `Alias removed: ${alias}` });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStep({ kind: 'menu', email: step.email });
          }
        }
      }
      return;
    }

    if (step.kind === 'note') {
      if (key.escape || key.return) {
        setStep({ kind: 'menu', email: step.email });
      }
      return;
    }

    if (step.kind === 'confirm-apikey-remove' || step.kind === 'alias-add') {
      if (key.escape) {
        setStep({ kind: 'menu', email: step.email });
      }
      return;
    }
  });

  const onAliasSubmit = (raw: string): void => {
    if (step.kind !== 'alias-add') return;
    const name = raw.trim();
    if (!name) {
      setStep({ ...step, error: 'Alias cannot be empty.' });
      return;
    }
    try {
      setAlias(name, step.email, accountsDirPath);
      setStep({ kind: 'note', email: step.email, title: 'Done', body: `Alias set: ${name} → ${step.email}` });
    } catch (e) {
      setStep({ ...step, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const onApikeyRemoveConfirm = (yes: boolean): void => {
    if (step.kind !== 'confirm-apikey-remove') return;
    if (!yes) {
      setStep({ kind: 'menu', email: step.email });
      return;
    }
    try {
      const removed = withLock(accountsDirPath, () => removeApiKey(step.email, accountsDirPath));
      setStep({
        kind: 'note',
        email: step.email,
        title: 'Done',
        body: removed ? 'API key removed.' : 'No key was saved.',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep({ kind: 'menu', email: step.email });
    }
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>Manage</Badge>
        {step.kind !== 'pick-account' && <Text> {(step as { email?: string }).email}</Text>}
      </Box>

      {error && (
        <Box marginBottom={1}><StatusMessage variant="error">{error}</StatusMessage></Box>
      )}

      {step.kind === 'pick-account' && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold>Manage which account?</Text>
          {accounts.length === 0 && <Text color="gray">  (no accounts — esc to go back)</Text>}
          {accounts.map((email, i) => {
            const selected = i === accCursor;
            return (
              <Box key={email}>
                <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
                <Text bold={selected}>{email}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {step.kind === 'menu' && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {menuItems.map((item, i) => {
            const selected = i === menuCursor;
            return (
              <Box key={item.value}>
                <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
                <Text bold={selected}>{item.label}</Text>
                {item.hint && <Text color="gray">  · {item.hint}</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      {step.kind === 'alias-add' && (
        <Box flexDirection="column">
          <Text>New alias for {step.email}</Text>
          <Box>
            <Text>› </Text>
            <TextInput placeholder="work, personal, …" onSubmit={onAliasSubmit} />
          </Box>
          {step.error && <StatusMessage variant="error">{step.error}</StatusMessage>}
          <Text color="gray">(esc to abort)</Text>
        </Box>
      )}

      {step.kind === 'alias-remove' && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold>Remove which alias?</Text>
          {aliases.length === 0 && <Text color="gray">  (none — esc to go back)</Text>}
          {aliases.map((alias, i) => {
            const selected = i === aliasCursor;
            return (
              <Box key={alias}>
                <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
                <Text bold={selected}>{alias}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {step.kind === 'confirm-apikey-remove' && (
        <Box flexDirection="column">
          <Text>Remove the saved API key for {step.email}?</Text>
          <Box>
            <Text>› </Text>
            <ConfirmInput
              defaultChoice="cancel"
              onConfirm={() => onApikeyRemoveConfirm(true)}
              onCancel={() => onApikeyRemoveConfirm(false)}
            />
          </Box>
        </Box>
      )}

      {step.kind === 'note' && (
        <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
          <Text bold color={ORANGE}>{step.title}</Text>
          <Text color="gray">{step.body}</Text>
          <Text color="gray">(enter or esc to continue)</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">↑↓ select · enter activate · esc back</Text>
      </Box>
    </Box>
  );
}

async function renderManage(
  claudeJsonPath: string,
  accountsDirPath: string,
  initialEmail: string | null,
): Promise<ScreenExit> {
  return new Promise<ScreenExit>((resolve) => {
    let result: ScreenExit = { kind: 'back' };
    clearScreen();
    const instance = render(
      <ManageScreen
        claudeJsonPath={claudeJsonPath}
        accountsDirPath={accountsDirPath}
        initialEmail={initialEmail}
        onExit={(e) => {
          result = e;
        }}
      />,
      { exitOnCtrlC: true },
    );
    instance.waitUntilExit().then(() => resolve(result));
  });
}

export async function runManageAccount(
  claudeJsonPath: string,
  accountsDirPath: string,
): Promise<void> {
  let pinned: string | null = null;
  while (true) {
    const r = await renderManage(claudeJsonPath, accountsDirPath, pinned);
    if (r.kind === 'back') return;
    pinned = r.req.kind === 'apikey-set' ? r.req.email : r.req.email;
    if (r.req.kind === 'apikey-set') {
      await runApikeyScreen(r.req.email, accountsDirPath);
      // Loop back into the manage screen on the same account.
    } else {
      const result = await runRemoveAccountScreen(r.req.email, claudeJsonPath, accountsDirPath);
      if (result.removed) {
        // Account is gone — exit the whole flow.
        return;
      }
      // Removal cancelled or failed — return to menu on the same account.
    }
  }
}
