// src/ui/screens/settings.tsx
// Two-tab settings: global flags + per-account overrides. Every flag has a
// smart default (true) and is opt-out — the user comes here only to disable
// behaviour they don't want.

import { useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { Badge, StatusMessage } from '@inkjs/ui';

import { list as listAccounts } from '../../accounts.js';
import {
  readGlobalPrefs,
  writeGlobalPrefs,
  readStoredAccountPrefs,
  writeStoredAccountPrefs,
  resolveAccountPrefs,
  type GlobalPrefs,
  type AccountPrefs,
} from '../../preferences.js';
import { ORANGE } from '../theme.js';
import { clearScreen } from '../screen-buffer.js';

type Tab = 'global' | 'account';

interface ToggleRow<T extends string> {
  key: T;
  label: string;
  hint: string;
}

const GLOBAL_ROWS: Array<ToggleRow<keyof GlobalPrefs>> = [
  { key: 'refreshUsageOnEntry', label: 'Refresh usage on menu open', hint: 'foreground fetch when the menu loads' },
  { key: 'useAltBuffer', label: 'Full-screen menu', hint: 'use the terminal alt buffer (vs scrollback)' },
  { key: 'defaultAutoLaunchOnSwitch', label: 'Auto-launch claude after switch (default)', hint: 'per-account override on the Account tab' },
  { key: 'defaultAutoFlipFallback', label: 'Auto-toggle fallback on switch (default)', hint: 'flip fallback ON/OFF based on whether the new account has an API key' },
  { key: 'hideManualProfileOps', label: 'Hide manual profile ops in menu', hint: 'collapse Create/Import — profiles auto-create on demand' },
];

const ACCOUNT_ROWS: Array<ToggleRow<keyof AccountPrefs>> = [
  { key: 'autoLaunchOnSwitch', label: 'Auto-launch claude after switch', hint: 'override the global default for this account' },
  { key: 'autoFlipFallback', label: 'Auto-toggle fallback on switch', hint: 'override the global default for this account' },
  { key: 'defaultIsolated', label: 'Always launch isolated', hint: 'use a per-terminal profile instead of the global swap' },
];

interface ScreenProps {
  accountsDirPath: string;
  initialAccount: string | null;
  onDone: () => void;
}

export function SettingsScreen({ accountsDirPath, initialAccount, onDone }: ScreenProps) {
  const { exit } = useApp();
  const [tab, setTab] = useState<Tab>('global');
  const [globalPrefs, setGlobalPrefs] = useState<GlobalPrefs>(() => readGlobalPrefs(accountsDirPath));
  const accounts = listAccounts(accountsDirPath);
  const [accountIdx, setAccountIdx] = useState(() => {
    const i = initialAccount ? accounts.indexOf(initialAccount) : 0;
    return i < 0 ? 0 : i;
  });
  const activeEmail = accounts[accountIdx];
  const [accountPrefs, setAccountPrefs] = useState<AccountPrefs>(() =>
    activeEmail ? resolveAccountPrefs(activeEmail, accountsDirPath) : {
      autoLaunchOnSwitch: globalPrefs.defaultAutoLaunchOnSwitch,
      autoFlipFallback: globalPrefs.defaultAutoFlipFallback,
      defaultIsolated: false,
      authMode: 'auto',
    },
  );
  // Cached "which keys are explicitly overridden" so we don't hit disk on
  // every re-render to compute the badge.
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() =>
    activeEmail
      ? Object.fromEntries(
          Object.entries(readStoredAccountPrefs(activeEmail, accountsDirPath))
            .filter(([, v]) => v !== undefined)
            .map(([k]) => [k, true]),
        )
      : {},
  );
  const [cursor, setCursor] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const finish = (): void => {
    onDone();
    exit();
  };

  const refreshAccountPrefs = (email: string): void => {
    setAccountPrefs(resolveAccountPrefs(email, accountsDirPath));
    const stored = readStoredAccountPrefs(email, accountsDirPath);
    setOverrides(
      Object.fromEntries(
        Object.entries(stored).filter(([, v]) => v !== undefined).map(([k]) => [k, true]),
      ),
    );
  };

  const toggleGlobal = (key: keyof GlobalPrefs): void => {
    const next = writeGlobalPrefs(accountsDirPath, { [key]: !globalPrefs[key] });
    setGlobalPrefs(next);
    setMessage(`${key}: ${next[key] ? 'on' : 'off'}`);
  };

  const toggleAccount = (key: keyof AccountPrefs): void => {
    if (!activeEmail) return;
    // Only `defaultIsolated` lacks a global counterpart, so it's stored as
    // a literal boolean. The other two are explicit overrides — toggling
    // sets the explicit value (no longer "use global default").
    const stored = readStoredAccountPrefs(activeEmail, accountsDirPath);
    const current = accountPrefs[key];
    const next = !current;
    writeStoredAccountPrefs(activeEmail, accountsDirPath, { ...stored, [key]: next });
    refreshAccountPrefs(activeEmail);
    setMessage(`${activeEmail} · ${key}: ${next ? 'on' : 'off'} (override)`);
  };

  const clearAccountOverride = (key: keyof AccountPrefs): void => {
    if (!activeEmail) return;
    const stored = readStoredAccountPrefs(activeEmail, accountsDirPath);
    const updated = { ...stored };
    delete updated[key as keyof typeof updated];
    writeStoredAccountPrefs(activeEmail, accountsDirPath, updated);
    refreshAccountPrefs(activeEmail);
    setMessage(`${activeEmail} · ${key}: reset to global default`);
  };

  const rows = tab === 'global' ? GLOBAL_ROWS : ACCOUNT_ROWS;

  useInput((input, key) => {
    if (input === 'q' || key.escape) { finish(); return; }
    if (key.tab || input === '\t') {
      setTab((t) => (t === 'global' ? 'account' : 'global'));
      setCursor(0);
      return;
    }
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(rows.length - 1, c + 1)); return; }
    if (key.return || input === ' ') {
      const row = rows[cursor];
      if (!row) return;
      if (tab === 'global') toggleGlobal(row.key as keyof GlobalPrefs);
      else toggleAccount(row.key as keyof AccountPrefs);
      return;
    }
    if (input === 'd' && tab === 'account') {
      // Reset the per-account override → fall back to the global default.
      const row = rows[cursor];
      if (row) clearAccountOverride(row.key as keyof AccountPrefs);
      return;
    }
    if (tab === 'account' && key.leftArrow) {
      const next = Math.max(0, accountIdx - 1);
      setAccountIdx(next);
      const e = accounts[next];
      if (e) refreshAccountPrefs(e);
      return;
    }
    if (tab === 'account' && key.rightArrow) {
      const next = Math.min(accounts.length - 1, accountIdx + 1);
      setAccountIdx(next);
      const e = accounts[next];
      if (e) refreshAccountPrefs(e);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>Settings</Badge>
        <Text color="gray">  ·  every flag is on by default — opt out only what you don't want</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={tab === 'global' ? ORANGE : 'gray'} bold={tab === 'global'}>
          [ Global ]
        </Text>
        <Text color="gray">  </Text>
        <Text color={tab === 'account' ? ORANGE : 'gray'} bold={tab === 'account'}>
          [ Account ]
        </Text>
        <Text color="gray">    (tab switches)</Text>
      </Box>

      {tab === 'account' && (
        <Box marginBottom={1}>
          <Text color="gray">Account: </Text>
          <Text bold color={ORANGE}>{activeEmail ?? '(none)'}</Text>
          <Text color="gray">  ←/→ to switch  ·  d to reset override</Text>
        </Box>
      )}

      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        {rows.map((row, i) => {
          const selected = i === cursor;
          const value = tab === 'global'
            ? (globalPrefs[row.key as keyof GlobalPrefs] as boolean)
            : (accountPrefs[row.key as keyof AccountPrefs] as boolean);
          const isOverride = tab === 'account' && !!overrides[row.key];
          return (
            <Box key={row.key}>
              <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
              <Text color={value ? 'green' : 'gray'}>{value ? '[x]' : '[ ]'}</Text>
              <Text bold={selected}> {row.label}</Text>
              {isOverride && <Text color="yellow">  ·  override</Text>}
              <Text color="gray">  ·  {row.hint}</Text>
            </Box>
          );
        })}
      </Box>

      {message && (
        <Box marginTop={1}>
          <StatusMessage variant="success">{message}</StatusMessage>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">↑↓ select · enter/space toggle · tab switch tab · q back</Text>
      </Box>
    </Box>
  );
}

export async function runSettingsScreen(
  accountsDirPath: string,
  initialAccount: string | null,
): Promise<void> {
  return new Promise<void>((resolve) => {
    clearScreen();
    const instance = render(
      <SettingsScreen
        accountsDirPath={accountsDirPath}
        initialAccount={initialAccount}
        onDone={() => undefined}
      />,
      { exitOnCtrlC: true },
    );
    instance.waitUntilExit().then(() => resolve());
  });
}
