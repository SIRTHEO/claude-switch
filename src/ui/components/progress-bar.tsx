// src/ui/components/progress-bar.tsx
// Coloured horizontal bar bound to a percentage. Colour follows usageGlyph.

import { Text } from 'ink';
import { usageGlyph } from './usage-glyph.js';

export interface ProgressBarProps {
  pct: number | undefined;
  width?: number;
}

export function ProgressBar({ pct, width = 20 }: ProgressBarProps) {
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
