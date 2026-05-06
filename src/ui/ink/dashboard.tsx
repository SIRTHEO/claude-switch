// src/ui/ink/dashboard.tsx
// Ink-based dashboard: account picker + live status panel.
//
// Stand-alone for now — invoked via `claude switch dashboard`. Once we're
// happy with the look it replaces src/ui/main-menu.ts.

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Badge, Spinner, StatusMessage } from '@inkjs/ui';

import { getCurrent, list as listAccounts } from '../../accounts.js';
import { isFallbackEnabled } from '../../fallback.js';
import { getApiKey, maskApiKey } from '../../apikey.js';
import { getAliasesForEmail } from '../../aliases.js';
import { getTokenHealth } from '../../token.js';
import { readUsageCacheFor } from '../../usage.js';

const ORANGE = '#D97757';

// --------------------------------------------------------------------------
// Domain snapshot — gathered once per render (the dashboard refetches when
// the user takes an action).
// --------------------------------------------------------------------------

interface AccountRow {
  email: string;
  active: boolean;
  alias: string | undefined;
  hasApiKey: boolean;
  apiKeyMasked: string | undefined;
}

interface Snapshot {
  rows: AccountRow[];
  current: string;
  fallbackOn: boolean;
  tokenHealth: ReturnType<typeof getTokenHealth> | null;
  usage5h: number | undefined;
  usageWeek: number | undefined;
}

function loadSnapshot(claudeJsonPath: string, accountsDirPath: string): Snapshot {
  const current = getCurrent(claudeJsonPath);
  const emails = listAccounts(accountsDirPath);
  const fallbackOn = isFallbackEnabled(accountsDirPath);
  const tokenHealth = current ? getTokenHealth(claudeJsonPath) : null;

  const rows: AccountRow[] = emails.map((email) => {
    const aliases = getAliasesForEmail(email, accountsDirPath);
    const apiKey = getApiKey(email, accountsDirPath);
    return {
      email,
      active: email === current,
      alias: aliases[0],
      hasApiKey: !!apiKey,
      apiKeyMasked: apiKey ? maskApiKey(apiKey) : undefined,
    };
  });

  const cache = current ? readUsageCacheFor(accountsDirPath, current) : null;
  const usage5h = cache?.payload?.five_hour?.utilization;
  const usageWeek = cache?.payload?.seven_day?.utilization;

  return { rows, current, fallbackOn, tokenHealth, usage5h, usageWeek };
}

// --------------------------------------------------------------------------
// Visual primitives
// --------------------------------------------------------------------------

function usageGlyph(pct: number | undefined): { glyph: string; color: string } {
  if (pct === undefined) return { glyph: '○', color: 'gray' };
  if (pct >= 95) return { glyph: '○', color: 'red' };
  if (pct >= 85) return { glyph: '◑', color: ORANGE };
  if (pct >= 50) return { glyph: '◐', color: 'yellow' };
  return { glyph: '●', color: 'green' };
}

function ProgressBar({ pct, width = 20 }: { pct: number | undefined; width?: number }) {
  if (pct === undefined) return <Text color="gray">{'─'.repeat(width)}</Text>;
  const filled = Math.round((pct / 100) * width);
  const { color } = usageGlyph(pct);
  return (
    <Text>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(width - filled)}</Text>
    </Text>
  );
}

// --------------------------------------------------------------------------
// Sections
// --------------------------------------------------------------------------

function Header() {
  return (
    <Box marginBottom={1} flexDirection="column">
      <Box>
        <Text bold color={ORANGE}>
          ⚡ claude-switch
        </Text>
        <Text color="gray"> · multi-account dashboard</Text>
      </Box>
    </Box>
  );
}

function StatusPanel({ snap }: { snap: Snapshot }) {
  const usingApi = snap.fallbackOn && snap.rows.find((r) => r.active)?.hasApiKey;
  const proxyActive = snap.rows.find((r) => r.active)?.hasApiKey ?? false;
  const five = usageGlyph(snap.usage5h);
  const week = usageGlyph(snap.usageWeek);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1} marginBottom={1}>
      <Text bold color={ORANGE}>Status</Text>

      <Box marginTop={1}>
        <Box width={14}><Text color="gray">Active</Text></Box>
        <Text>{snap.current || <Text color="gray">none</Text>}</Text>
      </Box>

      <Box>
        <Box width={14}><Text color="gray">Auth mode</Text></Box>
        {usingApi
          ? <Badge color="red">API key (billed credits)</Badge>
          : <Badge color="green">OAuth (subscription)</Badge>}
        {proxyActive && (
          <Text> <Text color={ORANGE}>⚡ proxy ready</Text></Text>
        )}
      </Box>

      <Box>
        <Box width={14}><Text color="gray">Fallback</Text></Box>
        {snap.fallbackOn
          ? <Text color="yellow">ON  (manual or auto-engaged)</Text>
          : <Text color="gray">OFF (will retry on 429)</Text>}
      </Box>

      {snap.tokenHealth && (
        <Box>
          <Box width={14}><Text color="gray">Token</Text></Box>
          <Text color={snap.tokenHealth.status === 'valid' ? 'green' : snap.tokenHealth.status === 'expired' ? 'red' : 'yellow'}>
            {snap.tokenHealth.status === 'valid' ? '✓ valid' : snap.tokenHealth.status === 'expired' ? '✗ expired' : `· ${snap.tokenHealth.status}`}
          </Text>
          {snap.tokenHealth.expiresIn && (
            <Text color="gray"> · expires in {snap.tokenHealth.expiresIn}</Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Box width={14}><Text color="gray">5h window</Text></Box>
        <Text color={five.color}>{five.glyph} </Text>
        <ProgressBar pct={snap.usage5h} />
        <Text color="gray"> {snap.usage5h !== undefined ? `${snap.usage5h.toFixed(0)}%` : '—'}</Text>
      </Box>

      <Box>
        <Box width={14}><Text color="gray">Weekly</Text></Box>
        <Text color={week.color}>{week.glyph} </Text>
        <ProgressBar pct={snap.usageWeek} />
        <Text color="gray"> {snap.usageWeek !== undefined ? `${snap.usageWeek.toFixed(0)}%` : '—'}</Text>
      </Box>
    </Box>
  );
}

function AccountList({ snap, cursor }: { snap: Snapshot; cursor: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold>Accounts</Text>
      {snap.rows.length === 0 && (
        <Text color="gray">  (no accounts yet — press <Text color={ORANGE}>a</Text> to add)</Text>
      )}
      {snap.rows.map((row, i) => {
        const selected = i === cursor;
        return (
          <Box key={row.email}>
            <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
            <Text bold={row.active} color={row.active ? ORANGE : undefined}>{row.email.padEnd(34)}</Text>
            {row.alias && <Text color="cyan">  @{row.alias}</Text>}
            {row.hasApiKey && (
              <Text color="gray">  · key {row.apiKeyMasked}</Text>
            )}
            {row.active && <Text color={ORANGE}>  ◀ active</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

function Footer() {
  return (
    <Box flexDirection="row" gap={2}>
      <Text color="gray">↑↓ select</Text>
      <Text color="gray">enter switch</Text>
      <Text color="gray">a add</Text>
      <Text color="gray">k api key</Text>
      <Text color="gray">f fallback</Text>
      <Text color="gray">r refresh</Text>
      <Text color="gray">q quit</Text>
    </Box>
  );
}

// --------------------------------------------------------------------------
// Main component
// --------------------------------------------------------------------------

interface DashboardProps {
  claudeJsonPath: string;
  accountsDirPath: string;
}

export function Dashboard({ claudeJsonPath, accountsDirPath }: DashboardProps) {
  const { exit } = useApp();
  const [snap, setSnap] = useState<Snapshot>(() => loadSnapshot(claudeJsonPath, accountsDirPath));
  const [cursor, setCursor] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  // Keep cursor inside bounds when accounts change.
  useEffect(() => {
    if (cursor >= snap.rows.length && snap.rows.length > 0) setCursor(snap.rows.length - 1);
    if (snap.rows.length === 0) setCursor(0);
  }, [snap.rows.length]);

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(Math.max(0, snap.rows.length - 1), c + 1));
    else if (key.return) {
      const target = snap.rows[cursor];
      if (target) {
        setMessage(`(switch is read-only in PoC — would switch to ${target.email})`);
      }
    } else if (input === 'r') {
      setSnap(loadSnapshot(claudeJsonPath, accountsDirPath));
      setMessage('refreshed');
    } else if (input === 'q' || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header />
      <StatusPanel snap={snap} />
      <AccountList snap={snap} cursor={cursor} />
      {message && (
        <Box marginBottom={1}>
          <StatusMessage variant="info">{message}</StatusMessage>
        </Box>
      )}
      <Footer />
    </Box>
  );
}
