// src/ui/screens/profiles/pick-list.tsx
// Generic single-list keyboard-driven picker, reused for the account
// and profile sub-screens inside profiles.tsx. Generic over T so the
// caller keeps narrow types end-to-end.

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { ORANGE } from '../../theme.js';

interface PickProps<T> {
  title: string;
  items: T[];
  keyOf: (t: T) => string;
  formatLabel: (t: T) => string;
  formatHint?: (t: T) => string | undefined;
  onPick: (t: T) => void;
  onCancel: () => void;
}

export function PickList<T>({
  title,
  items,
  keyOf,
  formatLabel,
  formatHint,
  onPick,
  onCancel,
}: PickProps<T>) {
  const [cursor, setCursor] = useState(0);
  useInput((_input, key) => {
    if (items.length === 0) {
      if (key.escape || key.return) onCancel();
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    else if (key.escape) onCancel();
    else if (key.return) {
      const t = items[cursor];
      if (t !== undefined) onPick(t);
    }
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold>{title}</Text>
      {items.length === 0 && <Text color="gray">  (empty — esc to go back)</Text>}
      {items.map((t, i) => {
        const selected = i === cursor;
        const hint = formatHint?.(t);
        const label = formatLabel(t);
        return (
          <Box key={keyOf(t)}>
            <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
            <Text bold={selected}>{label}</Text>
            {hint && <Text color="gray">  · {hint}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
