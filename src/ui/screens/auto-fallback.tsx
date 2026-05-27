// src/ui/screens/auto-fallback.tsx
// Settings screen for the auto-fallback subsystem (auto-revert + auto-engage).
//
// Replaces the clack `runAutoFallbackMenu` loop with a single Ink screen that
// shows live config + lets the user toggle either flag and edit thresholds
// inline. The hysteresis invariant (`engageThreshold > revertThreshold`) is
// enforced at the input layer with the same error wording as before.

import { useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { clearScreen } from '../screen-buffer.js';import { Badge, StatusMessage, TextInput } from '@inkjs/ui';

import {
  getAutoFallbackConfig,
  setAutoFallbackConfig,
  type AutoFallbackConfig,
} from '../../fallback/auto-fallback.js';
import { ORANGE } from '../theme.js';
import { SelectableList } from '../components/selectable-list.js';
import { awaitInkScreen } from '../utils/ink-screen.js';

type Action =
  | 'toggle-revert'
  | 'set-revert'
  | 'toggle-engage'
  | 'set-engage'
  | 'show-config'
  | 'back';

interface MenuItem {
  value: Action;
  label: string;
  hint?: string;
}

function buildItems(cfg: AutoFallbackConfig): MenuItem[] {
  const items: MenuItem[] = [];

  items.push({
    value: 'toggle-revert',
    label: cfg.enabled ? 'Disable auto-revert' : 'Enable auto-revert',
    hint: cfg.enabled
      ? `armed: fallback OFF when 5h+7d < ${cfg.threshold}%`
      : 'turn fallback OFF automatically when subscription frees up',
  });
  if (cfg.enabled) {
    items.push({
      value: 'set-revert',
      label: `Set auto-revert threshold (now: ${cfg.threshold}%)`,
      hint: 'fallback flips OFF when both 5h and 7d drop below this',
    });
  }

  items.push({
    value: 'toggle-engage',
    label: cfg.engageEnabled ? 'Disable auto-engage' : 'Enable auto-engage',
    hint: cfg.engageEnabled
      ? `armed: fallback ON when 5h or 7d ≥ ${cfg.engageThreshold}%`
      : 'turn fallback ON automatically when you approach the rate limit',
  });
  if (cfg.engageEnabled) {
    items.push({
      value: 'set-engage',
      label: `Set auto-engage threshold (now: ${cfg.engageThreshold}%)`,
      hint: 'fallback flips ON when either 5h or 7d crosses this',
    });
  }

  items.push({ value: 'show-config', label: 'Show current config' });
  items.push({ value: 'back', label: 'Back to main menu' });
  return items;
}

interface PromptKind {
  field: 'revert' | 'engage';
  initial: number;
}

function validateThreshold(
  raw: string,
  cfg: AutoFallbackConfig,
  field: 'revert' | 'engage',
): { ok: number } | { error: string } {
  const n = parseInt(raw || '0', 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    return { error: 'Pick a number between 1 and 100.' };
  }
  if (field === 'revert' && n >= cfg.engageThreshold) {
    return {
      error: `Must be strictly less than the auto-engage threshold (${cfg.engageThreshold}%) to avoid oscillation.`,
    };
  }
  if (field === 'engage' && n <= cfg.threshold) {
    return {
      error: `Must be strictly greater than the auto-revert threshold (${cfg.threshold}%) to avoid oscillation.`,
    };
  }
  return { ok: n };
}

interface ScreenProps {
  accountsDirPath: string;
  onDone: () => void;
}

export function AutoFallbackScreen({ accountsDirPath, onDone }: ScreenProps) {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<AutoFallbackConfig>(() => getAutoFallbackConfig(accountsDirPath));
  const [cursor, setCursor] = useState(0);
  const [prompt, setPrompt] = useState<PromptKind | null>(null);
  const [inputErr, setInputErr] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'success' | 'error'; text: string } | null>(null);
  const [showCfg, setShowCfg] = useState(false);

  const items = buildItems(cfg);

  const refresh = (): void => {
    setCfg(getAutoFallbackConfig(accountsDirPath));
  };

  const finish = (): void => {
    onDone();
    exit();
  };

  const apply = (next: Partial<AutoFallbackConfig>, msg: string): void => {
    try {
      setAutoFallbackConfig(accountsDirPath, next);
      refresh();
      setMessage({ kind: 'success', text: msg });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const onSelect = (action: Action): void => {
    setMessage(null);
    setShowCfg(false);
    switch (action) {
      case 'back':
        finish();
        return;
      case 'toggle-revert':
        if (cfg.enabled) {
          apply({ enabled: false }, 'Auto-revert OFF. Fallback toggle is fully manual again.');
        } else {
          setPrompt({ field: 'revert', initial: cfg.threshold });
        }
        return;
      case 'set-revert':
        setPrompt({ field: 'revert', initial: cfg.threshold });
        return;
      case 'toggle-engage':
        if (cfg.engageEnabled) {
          apply({ engageEnabled: false }, 'Auto-engage OFF. Fallback will not be turned on automatically.');
        } else {
          setPrompt({ field: 'engage', initial: cfg.engageThreshold });
        }
        return;
      case 'set-engage':
        setPrompt({ field: 'engage', initial: cfg.engageThreshold });
        return;
      case 'show-config':
        setShowCfg(true);
    }
  };

  const onInputSubmit = (raw: string): void => {
    if (!prompt) return;
    const trimmed = raw.trim() || String(prompt.initial);
    const result = validateThreshold(trimmed, cfg, prompt.field);
    if ('error' in result) {
      setInputErr(result.error);
      return;
    }
    const n = result.ok;
    if (prompt.field === 'revert') {
      const isToggle = !cfg.enabled;
      apply(
        isToggle ? { enabled: true, threshold: n } : { threshold: n },
        isToggle
          ? `Auto-revert ON (threshold ${n}%).`
          : `Auto-revert threshold set to ${n}%.`,
      );
    } else {
      const isToggle = !cfg.engageEnabled;
      apply(
        isToggle ? { engageEnabled: true, engageThreshold: n } : { engageThreshold: n },
        isToggle
          ? `Auto-engage ON (threshold ${n}%).`
          : `Auto-engage threshold set to ${n}%.`,
      );
    }
    setPrompt(null);
    setInputErr(null);
  };

  useInput((_input, key) => {
    if (prompt) {
      if (key.escape) {
        setPrompt(null);
        setInputErr(null);
      }
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    else if (key.return) {
      const item = items[cursor];
      if (item) onSelect(item.value);
    } else if (key.escape) finish();
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>Auto-fallback</Badge>
        <Text color="gray">
          {' '}revert: {cfg.enabled ? `ON @ ${cfg.threshold}%` : 'OFF'} · engage: {cfg.engageEnabled ? `ON @ ${cfg.engageThreshold}%` : 'OFF'}
        </Text>
      </Box>

      <SelectableList items={items} cursor={cursor} />

      {prompt && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {prompt.field === 'revert'
              ? 'Auto-revert threshold % (fallback flips OFF below this)'
              : 'Auto-engage threshold % (fallback flips ON above this)'}
          </Text>
          <Box>
            <Text>› </Text>
            <TextInput
              defaultValue={String(prompt.initial)}
              placeholder={String(prompt.initial)}
              onSubmit={onInputSubmit}
            />
          </Box>
          {inputErr && (
            <StatusMessage variant="error">{inputErr}</StatusMessage>
          )}
          <Text color="gray">(esc to abort)</Text>
        </Box>
      )}

      {showCfg && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Auto-fallback config</Text>
          <Text color="gray">Auto-revert:  {cfg.enabled ? `ON (threshold ${cfg.threshold}%)` : 'OFF'}</Text>
          <Text color="gray">Auto-engage:  {cfg.engageEnabled ? `ON (threshold ${cfg.engageThreshold}%)` : 'OFF'}</Text>
          <Text color="gray">Hysteresis: engage ≥ engage-threshold, revert &lt; revert-threshold.</Text>
          <Text color="gray">Current: engage at {cfg.engageThreshold}% → revert at {cfg.threshold}%.</Text>
        </Box>
      )}

      {message && (
        <Box marginTop={1}>
          <StatusMessage variant={message.kind}>{message.text}</StatusMessage>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">↑↓ select · enter activate · esc back</Text>
      </Box>
    </Box>
  );
}

export async function runAutoFallbackScreen(accountsDirPath: string): Promise<void> {
  clearScreen();
  const instance = render(
    <AutoFallbackScreen accountsDirPath={accountsDirPath} onDone={() => undefined} />,
    { exitOnCtrlC: true },
  );
  return awaitInkScreen(instance, () => undefined);
}
