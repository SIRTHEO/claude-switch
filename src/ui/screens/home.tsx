// src/ui/screens/home.tsx
// Three-section home screen: Accounts → contextual Account actions →
// Global actions. Tab cycles focus, ↑↓ navigate, enter activates. The
// middle section's action set + title follow the highlighted account in
// the top section, so the user always sees WHAT they're about to act on.

import { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { StatusMessage } from '@inkjs/ui';

import { switchToAndSyncFallback } from '../../switcher.js';
import { resolveAccountPrefs } from '../../preferences.js';
import { useSnapshot } from '../hooks/use-snapshot.js';
import { useAsyncAction } from '../hooks/use-async-action.js';
import { ORANGE } from '../theme.js';
import { clearScreen } from '../screen-buffer.js';
import { awaitInkScreen } from '../utils/ink-screen.js';
import { AccountList, MenuList } from './home/components.js';
import {
  GLOBAL_ITEMS,
  buildAccountItems,
  type AccountActionValue,
  type GlobalActionValue,
} from './home/menu-items.js';

export type HomeAction =
  | 'add'
  | 'manage'
  | 'apikey'
  | 'fallback-toggle'
  | 'auto-fallback'
  | 'profiles'
  | 'usage'
  | 'reauth'
  | 'remove'
  | 'setup'
  | 'settings'
  | 'switched'
  | 'exit';

export interface HomeExit {
  action: HomeAction;
  payload?: {
    switchedFrom: string | null;
    switchedTo: string;
    autoLaunch: boolean;
    defaultIsolated: boolean;
  };
}

interface Props {
  claudeJsonPath: string;
  accountsDirPath: string;
  initialNotice: { kind: 'info' | 'success' | 'error' | 'warning'; text: string } | null;
  onExit: (e: HomeExit) => void;
}

type Focus = 'accounts' | 'account-actions' | 'global';

const FOCUS_ORDER: Focus[] = ['accounts', 'account-actions', 'global'];

// ---------------------------------------------------------------------------
// Sub-components live in `./home/components.tsx`. Static + dynamic
// menu data lives in `./home/menu-items.ts`. This file owns the
// state machine + dispatch + render wiring only.
// ---------------------------------------------------------------------------

export function HomeScreen({ claudeJsonPath, accountsDirPath, initialNotice, onExit }: Props) {
  const { exit } = useApp();
  const { snap, refresh } = useSnapshot(claudeJsonPath, accountsDirPath);
  const { busy, message, run, setMessage } = useAsyncAction();
  const [focus, setFocus] = useState<Focus>('accounts');
  const [accountCursor, setAccountCursor] = useState(() => {
    const i = snap.rows.findIndex((r) => r.active);
    return i < 0 ? 0 : i;
  });
  const [accountActionCursor, setAccountActionCursor] = useState(0);
  const [globalCursor, setGlobalCursor] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (initialNotice) setMessage(initialNotice);
  }, [initialNotice, setMessage]);

  // Track the previous active email so the cursor can follow a switch:
  // when the active account identity changes, jump the cursor to the
  // newly-active row so the user lands in the natural place after a
  // post-switch return to the home screen.
  const [prevActive, setPrevActive] = useState(snap.current);
  useEffect(() => {
    if (snap.current && snap.current !== prevActive) {
      const i = snap.rows.findIndex((r) => r.email === snap.current);
      if (i >= 0) setAccountCursor(i);
      setPrevActive(snap.current);
      return;
    }
    setAccountCursor((c) => {
      if (snap.rows.length === 0) return 0;
      if (c >= snap.rows.length) return snap.rows.length - 1;
      return c;
    });
  }, [snap.rows.length, snap.current, snap.rows, prevActive]);

  const target = snap.rows[accountCursor];
  const accountItems = buildAccountItems(target ?? null);

  // Reset the contextual menu cursor whenever the highlighted account
  // changes, otherwise the cursor can land out of bounds for accounts that
  // expose fewer rows (e.g. "reauth" only appears for the active account).
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger on cursor change, not value capture
  useEffect(() => {
    setAccountActionCursor(0);
  }, [accountCursor]);

  const finish = (action: HomeAction, payload?: HomeExit['payload']): void => {
    onExit({ action, ...(payload ? { payload } : {}) });
    exit();
  };

  const triggerSwitchOrLaunch = (): void => {
    if (!target) return;
    if (target.active) {
      const prefs = resolveAccountPrefs(target.email, accountsDirPath);
      finish('switched', {
        switchedFrom: target.email,
        switchedTo: target.email,
        autoLaunch: prefs.autoLaunchOnSwitch,
        defaultIsolated: prefs.defaultIsolated,
      });
      return;
    }
    const before = target.email;
    const previous = snap.current;
    void run(() => {
      const prefs = resolveAccountPrefs(before, accountsDirPath);
      // Bundle the switch + fallback flip into one withLock so a concurrent
      // `claude switch` from another terminal can't race the two writes
      // and leave us with `active=B / fallback=ON / B has no key`.
      const outcome = switchToAndSyncFallback(before, claudeJsonPath, accountsDirPath, {
        autoFlipFallback: prefs.autoFlipFallback,
      });
      let fallbackHint = '';
      if (prefs.autoFlipFallback) {
        fallbackHint = outcome.hasApiKey
          ? ' · fallback ON (API key)'
          : ' · fallback OFF (OAuth)';
      }
      refresh();
      queueMicrotask(() => finish('switched', {
        switchedFrom: previous || null,
        switchedTo: before,
        autoLaunch: prefs.autoLaunchOnSwitch,
        defaultIsolated: prefs.defaultIsolated,
      }));
      return outcome.message + fallbackHint;
    });
  };

  const triggerAccountAction = (value: AccountActionValue): void => {
    switch (value) {
      case 'switch': triggerSwitchOrLaunch(); return;
      case 'apikey': finish('apikey'); return;
      case 'manage': finish('manage'); return;
      case 'fallback-toggle': finish('fallback-toggle'); return;
      case 'reauth': finish('reauth'); return;
      case 'remove': finish('remove'); return;
    }
  };

  const triggerGlobalAction = (value: GlobalActionValue): void => {
    switch (value) {
      case 'add': finish('add'); return;
      case 'settings': finish('settings'); return;
      case 'profiles': finish('profiles'); return;
      case 'auto-fallback': finish('auto-fallback'); return;
      case 'usage': finish('usage'); return;
      case 'setup': finish('setup'); return;
      case 'quit': finish('exit'); return;
    }
  };

  const cycleFocus = (forward: boolean): void => {
    setFocus((f) => {
      // Skip the contextual section if there is no account selected.
      const filtered = FOCUS_ORDER.filter((s) => s !== 'account-actions' || target);
      const cur = filtered.indexOf(f) === -1 ? 0 : filtered.indexOf(f);
      const next = forward
        ? (cur + 1) % filtered.length
        : (cur - 1 + filtered.length) % filtered.length;
      return filtered[next] ?? f;
    });
  };

  useInput((input, key) => {
    if (busy) return;

    if (key.tab) { cycleFocus(!key.shift); return; }

    if (focus === 'accounts') {
      if (key.upArrow) { setAccountCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) {
        setAccountCursor((c) => Math.min(Math.max(0, snap.rows.length - 1), c + 1));
        return;
      }
      if (key.return) { triggerSwitchOrLaunch(); return; }
    } else if (focus === 'account-actions') {
      if (key.upArrow) { setAccountActionCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) {
        setAccountActionCursor((c) => Math.min(accountItems.length - 1, c + 1));
        return;
      }
      if (key.return) {
        const item = accountItems[accountActionCursor];
        if (item) triggerAccountAction(item.value);
        return;
      }
    } else if (focus === 'global') {
      if (key.upArrow) { setGlobalCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setGlobalCursor((c) => Math.min(GLOBAL_ITEMS.length - 1, c + 1)); return; }
      if (key.return) {
        const item = GLOBAL_ITEMS[globalCursor];
        if (item) triggerGlobalAction(item.value);
        return;
      }
    }

    // Universal hotkeys (work from any section).
    if (input === 'q' || key.escape) { finish('exit'); return; }
    if (input === '?') { setShowHelp((s) => !s); return; }
    if (input === 'r') { refresh(); setMessage({ kind: 'info', text: 'redrew' }); return; }

    // Per-account hotkeys: only fire when the user is NOT in the General
    // section, so cursor-driven nav can use letters that overlap with
    // action labels without accidentally triggering them.
    if (focus !== 'global') {
      const accItem = accountItems.find((a) => a.hotkey === input);
      if (accItem) { triggerAccountAction(accItem.value); return; }
    }
    const globalItem = GLOBAL_ITEMS.find((a) => a.hotkey === input);
    if (globalItem) { triggerGlobalAction(globalItem.value); return; }
  });

  const middleSubtitle = target ? `for ${target.email}` : 'no account selected';

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Brand line */}
      <Box marginBottom={1}>
        <Text bold color={ORANGE}>⚡ claude-switch</Text>
        <Text color="gray">  multi-account dashboard  ·  </Text>
        <Text color="gray">tab cycles  ·  </Text>
        <Text color="gray">? help  ·  </Text>
        <Text color="gray">q quit</Text>
      </Box>

      {snap.rows.length === 0 && (
        <Box marginBottom={1}>
          <Text color="gray">No accounts yet.  Press </Text>
          <Text color={ORANGE}>a</Text>
          <Text color="gray"> to log in with your first Claude account.</Text>
        </Box>
      )}

      <AccountList
        rows={snap.rows}
        cursor={accountCursor}
        focused={focus === 'accounts'}
        fallbackOn={snap.fallbackOn}
        tokenHealth={snap.tokenHealth}
      />

      <MenuList<AccountActionValue>
        title="Account"
        subtitle={middleSubtitle}
        items={accountItems}
        cursor={accountActionCursor}
        focused={focus === 'account-actions'}
        emptyHint="select an account above to see its actions"
      />

      <MenuList<GlobalActionValue>
        title="General"
        items={GLOBAL_ITEMS}
        cursor={globalCursor}
        focused={focus === 'global'}
      />

      {showHelp && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
          <Text bold>Hotkeys</Text>
          <Text color="gray">tab / shift-tab cycle sections  ·  ↑↓ navigate  ·  enter activate</Text>
          <Text color="gray">k set key  ·  m manage  ·  f fallback  ·  c re-authenticate  ·  d remove</Text>
          <Text color="gray">a add  ·  g settings  ·  p profiles  ·  F auto-fallback  ·  u refresh</Text>
          <Text color="gray">s setup  ·  r redraw  ·  ? toggle this help  ·  q quit</Text>
        </Box>
      )}

      {message && (
        <Box>
          <StatusMessage variant={message.kind}>{message.text}</StatusMessage>
        </Box>
      )}
      {busy && (
        <Box>
          <Text color={ORANGE}>… working</Text>
        </Box>
      )}
    </Box>
  );
}

export async function renderHome(
  claudeJsonPath: string,
  accountsDirPath: string,
  initialNotice: HomeExit extends never ? never : Props['initialNotice'] = null,
): Promise<HomeExit> {
  let result: HomeExit = { action: 'exit' };
  clearScreen();
  const instance = render(
    <HomeScreen
      claudeJsonPath={claudeJsonPath}
      accountsDirPath={accountsDirPath}
      initialNotice={initialNotice}
      onExit={(e) => {
        result = e;
      }}
    />,
    { exitOnCtrlC: true },
  );
  return awaitInkScreen(instance, () => result);
}
