// src/ui/screens/home/components.tsx
// Pure render components used by the Home screen — `Section`, the
// per-row account detail, the AccountList, and the generic
// `MenuList<V>`. Extracted out of `home.tsx` so the orchestrator
// stays under the readability threshold.

import type React from 'react';
import { Box, Text } from 'ink';

import type { AccountRow } from '../../hooks/use-snapshot.js';
import { ORANGE } from '../../theme.js';
import { ProgressBar } from '../../components/progress-bar.js';
import { usageGlyph } from '../../components/usage-glyph.js';
import type { MenuItem } from './menu-items.js';

// ---------------------------------------------------------------------------
// Section — bordered title + body container; consumed by AccountList + MenuList
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

// ---------------------------------------------------------------------------
// AccountRowDetail — per-account auth/usage line block
// ---------------------------------------------------------------------------

interface AccountSummaryProps {
  row: AccountRow;
  fallbackOn: boolean;
  tokenHealth: ReturnType<typeof import('../../../credentials/token.js').getTokenHealth> | null;
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

// ---------------------------------------------------------------------------
// AccountList — top section showing every saved account row
// ---------------------------------------------------------------------------

interface AccountListProps {
  rows: AccountRow[];
  cursor: number;
  focused: boolean;
  fallbackOn: boolean;
  tokenHealth: ReturnType<typeof import('../../../credentials/token.js').getTokenHealth> | null;
}

export function AccountList({
  rows,
  cursor,
  focused,
  fallbackOn,
  tokenHealth,
}: AccountListProps) {
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

// ---------------------------------------------------------------------------
// MenuList — generic list-of-actions used for the Account-actions and
// Global sections. Generic over the action's tagged-string type so the
// dispatch site keeps narrow types end-to-end.
// ---------------------------------------------------------------------------

interface MenuRendererProps<V extends string> {
  title: string;
  subtitle?: string;
  items: MenuItem<V>[];
  cursor: number;
  focused: boolean;
  emptyHint?: string;
}

export function MenuList<V extends string>({
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
