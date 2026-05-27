// src/ui/components/selectable-list.tsx
// Presentational bordered list with the standard ▸ / orange / bold selection
// styling shared across the home-style menus (manage-account, profiles,
// auto-fallback). Stateless: the PARENT owns the cursor and the keyboard input
// loop — this only renders. For a self-driving picker that owns its own cursor
// and useInput handling (the profiles account/profile sub-screens), use
// PickList (`screens/profiles/pick-list.tsx`) instead.

import { Box, Text } from 'ink';
import { ORANGE } from '../theme.js';

/** Minimal row shape. Screens pass their own MenuItem-like arrays — any object
 *  with a string `value` (used as the React key), a `label`, and an optional
 *  `hint` is structurally compatible. */
export interface SelectableRow {
  value: string;
  label: string;
  hint?: string;
}

export function SelectableList({
  items,
  cursor,
}: {
  items: readonly SelectableRow[];
  cursor: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {items.map((item, i) => {
        const selected = i === cursor;
        return (
          <Box key={item.value}>
            <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
            <Text bold={selected}>{item.label}</Text>
            {item.hint && <Text color="gray">  · {item.hint}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
