// src/ui/screens/home.tsx
// Three-section home screen: Accounts → contextual Account actions →
// Global actions. Tab cycles focus, ↑↓ navigate, enter activates. The
// middle section's action set + title follow the highlighted account in
// the top section, so the user always sees WHAT they're about to act on.

import { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { StatusMessage } from '@inkjs/ui';

import { switchTo } from '../../switcher.js';
import { getApiKey } from '../../apikey.js';
import { setFallbackEnabled } from '../../fallback.js';
import { resolveAccountPrefs } from '../../preferences.js';
import { useSnapshot, type AccountRow } from '../hooks/use-snapshot.js';
import { useAsyncAction } from '../hooks/use-async-action.js';
import { ORANGE } from '../theme.js';
import { ProgressBar } from '../components/progress-bar.js';
import { usageGlyph } from '../components/usage-glyph.js';
import { clearScreen } from '../screen-buffer.js';

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

interface MenuItem<V extends string> {
  value: V;
  label: string;
  hotkey: string;
  hint: string;
}

type AccountActionValue =
  | 'switch'
  | 'apikey'
  | 'manage'
  | 'fallback-toggle'
  | 'reauth'
  | 'remove';

type GlobalActionValue =
  | 'add'
  | 'settings'
  | 'profiles'
  | 'auto-fallback'
  | 'usage'
  | 'setup'
  | 'quit';

const GLOBAL_ITEMS: MenuItem<GlobalActionValue>[] = [
  { value: 'add',           label: 'Add account',         hotkey: 'a', hint: 'log in with a new email' },
  { value: 'settings',      label: 'Settings',            hotkey: 'g', hint: 'global + per-account preferences' },
  { value: 'profiles',      label: 'Profiles',            hotkey: 'p', hint: 'isolated per-terminal sessions' },
  { value: 'auto-fallback', label: 'Auto-fallback',       hotkey: 'F', hint: 'thresholds for auto-engage / auto-revert' },
  { value: 'usage',         label: 'Refresh usage',       hotkey: 'u', hint: 'force-fetch from Anthropic' },
  { value: 'setup',         label: 'Setup wizard',        hotkey: 's', hint: 'fix claude binary / shell PATH' },
  { value: 'quit',          label: 'Quit',                hotkey: 'q', hint: 'or press esc' },
];

function buildAccountItems(row: AccountRow | null): MenuItem<AccountActionValue>[] {
  if (!row) return [];
  const items: MenuItem<AccountActionValue>[] = [];
  items.push({
    value: 'switch',
    label: row.active ? 'Launch claude (already active)' : 'Switch & launch claude',
    hotkey: '↵',
    hint: row.active ? 'open a session on this account' : 'swap then run claude',
  });
  items.push({
    value: 'apikey',
    label: row.hasApiKey ? 'Replace API key' : 'Set API key',
    hotkey: 'k',
    hint: row.hasApiKey ? `currently ${row.apiKeyMasked}` : 'paste an Anthropic key',
  });
  items.push({
    value: 'manage',
    label: 'Manage (alias · key · remove)',
    hotkey: 'm',
    hint: 'detailed account operations',
  });
  items.push({
    value: 'fallback-toggle',
    label: 'Toggle fallback',
    hotkey: 'f',
    hint: 'flip OAuth ↔ API key globally',
  });
  if (row.active) {
    items.push({
      value: 'reauth',
      label: 'Re-authenticate',
      hotkey: 'c',
      hint: 'browser re-login (current account)',
    });
  }
  items.push({
    value: 'remove',
    label: 'Remove account',
    hotkey: 'd',
    hint: 'delete saved tokens, key, aliases',
  });
  return items;
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
// Sub-components
// ---------------------------------------------------------------------------

interface SectionProps {
  title: string;
  subtitle?: string;
  focused: boolean;
  children: React.ReactNode;
}

function Section({ title, subtitle, focused, children }: SectionProps) {
  const color = focused ? ORANGE : 'gray';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text bold color={color}>{title}</Text>
        {subtitle && <Text color="gray">  {subtitle}</Text>}
      </Box>
      {children}
    </Box>
  );
}

interface AccountListProps {
  rows: AccountRow[];
  cursor: number;
  focused: boolean;
}

interface AccountSummaryProps {
  row: AccountRow;
  fallbackOn: boolean;
  tokenHealth: ReturnType<typeof import('../../token.js').getTokenHealth> | null;
}

/** Per-account detail block. Active row gets the live runtime context
 *  (fallback flag + token state) inline; idle rows show only configuration. */
function AccountRowDetail({ row, fallbackOn, tokenHealth }: AccountSummaryProps) {
  const authLabel = row.active
    ? (fallbackOn && row.hasApiKey ? 'API key' : 'OAuth')
    : (row.hasApiKey ? 'OAuth + key saved' : 'OAuth only');
  const authColor = row.active && fallbackOn && row.hasApiKey ? 'red' : 'green';

  const fiveGlyph = usageGlyph(row.usage5h);
  const weekGlyph = usageGlyph(row.usageWeek);
  const hasUsage = row.usage5h !== undefined || row.usageWeek !== undefined;

  const tokenIcon = tokenHealth?.status === 'valid' ? '✓'
    : tokenHealth?.status === 'expired' ? '✗'
    : '·';
  const tokenColor = tokenHealth?.status === 'valid' ? 'green'
    : tokenHealth?.status === 'expired' ? 'red'
    : 'yellow';

  return (
    <Box flexDirection="column">
      {/* Config / runtime line. Active rows include fallback + token info
          since they're the only place those values are meaningful. */}
      <Box>
        <Text color="gray">      </Text>
        <Text color={authColor}>{authLabel}</Text>
        {row.active && (
          <>
            <Text color="gray">  ·  fallback </Text>
            {fallbackOn ? <Text color="yellow">ON</Text> : <Text color="gray">OFF</Text>}
            {tokenHealth && (
              <>
                <Text color="gray">  ·  token </Text>
                <Text color={tokenColor}>{tokenIcon} {tokenHealth.status}</Text>
                {tokenHealth.expiresIn && (
                  <Text color="gray"> · {tokenHealth.expiresIn}</Text>
                )}
              </>
            )}
          </>
        )}
        {row.hasApiKey && row.apiKeyMasked && !row.active && (
          <Text color="gray">  ·  {row.apiKeyMasked}</Text>
        )}
        {row.defaultIsolated && (
          <Text color="cyan">  ·  isolated default</Text>
        )}
      </Box>
      {/* Usage line: cached numbers if any, else compact placeholder. */}
      <Box>
        <Text color="gray">      </Text>
        {hasUsage ? (
          <>
            <Text color={fiveGlyph.color}>{fiveGlyph.glyph} 5h </Text>
            <ProgressBar pct={row.usage5h} width={14} />
            <Text color="gray"> {row.usage5h !== undefined ? `${row.usage5h.toFixed(0)}%` : '—'}</Text>
            <Text color="gray">    </Text>
            <Text color={weekGlyph.color}>{weekGlyph.glyph} 7d </Text>
            <ProgressBar pct={row.usageWeek} width={14} />
            <Text color="gray"> {row.usageWeek !== undefined ? `${row.usageWeek.toFixed(0)}%` : '—'}</Text>
          </>
        ) : (
          <Text color="gray">no usage cached</Text>
        )}
      </Box>
    </Box>
  );
}

function AccountList({
  rows,
  cursor,
  focused,
  fallbackOn,
  tokenHealth,
}: AccountListProps & {
  fallbackOn: boolean;
  tokenHealth: ReturnType<typeof import('../../token.js').getTokenHealth> | null;
}) {
  return (
    <Section title="Accounts" subtitle={`(${rows.length})`} focused={focused}>
      {rows.length === 0 && (
        <Text color="gray">  none — press <Text color={ORANGE}>a</Text> to add</Text>
      )}
      {rows.map((row, i) => {
        const selected = focused && i === cursor;
        const isHighlighted = i === cursor;
        const cursorChar = selected ? '▸' : isHighlighted ? '·' : ' ';
        const cursorColor = selected ? ORANGE : 'gray';
        return (
          <Box key={row.email} flexDirection="column" marginBottom={i === rows.length - 1 ? 0 : 1}>
            <Box>
              <Text color={cursorColor}>{cursorChar} </Text>
              <Text bold={row.active} color={row.active ? ORANGE : undefined}>
                {row.email}
              </Text>
              {row.alias && <Text color="cyan">  @{row.alias}</Text>}
              {row.active && <Text color={ORANGE}>  ◀ active</Text>}
            </Box>
            <AccountRowDetail row={row} fallbackOn={fallbackOn} tokenHealth={row.active ? tokenHealth : null} />
          </Box>
        );
      })}
    </Section>
  );
}

interface MenuRendererProps<V extends string> {
  title: string;
  subtitle?: string;
  items: MenuItem<V>[];
  cursor: number;
  focused: boolean;
  emptyHint?: string;
}

function MenuList<V extends string>({
  title,
  subtitle,
  items,
  cursor,
  focused,
  emptyHint,
}: MenuRendererProps<V>) {
  return (
    <Section title={title} subtitle={subtitle} focused={focused}>
      {items.length === 0 && emptyHint && <Text color="gray">  {emptyHint}</Text>}
      {items.map((item, i) => {
        const selected = focused && i === cursor;
        const cursorChar = selected ? '▸' : ' ';
        return (
          <Box key={item.value}>
            <Text color={selected ? ORANGE : 'gray'}>{cursorChar} </Text>
            <Text color={selected ? ORANGE : 'cyan'}>[{item.hotkey}]</Text>
            <Text> </Text>
            <Text bold={selected}>{item.label.padEnd(34)}</Text>
            <Text color="gray">{item.hint}</Text>
          </Box>
        );
      })}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

function HomeScreen({ claudeJsonPath, accountsDirPath, initialNotice, onExit }: Props) {
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
      const result = switchTo(before, claudeJsonPath, accountsDirPath);
      const prefs = resolveAccountPrefs(before, accountsDirPath);
      let fallbackHint = '';
      if (prefs.autoFlipFallback) {
        const hasKey = !!getApiKey(before, accountsDirPath);
        setFallbackEnabled(accountsDirPath, hasKey);
        fallbackHint = hasKey ? ' · fallback ON (API key)' : ' · fallback OFF (OAuth)';
      }
      refresh();
      queueMicrotask(() => finish('switched', {
        switchedFrom: previous || null,
        switchedTo: before,
        autoLaunch: prefs.autoLaunchOnSwitch,
        defaultIsolated: prefs.defaultIsolated,
      }));
      return result + fallbackHint;
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
  return new Promise<HomeExit>((resolve) => {
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
    instance.waitUntilExit().then(() => resolve(result));
  });
}
