// src/ui/components/usage-glyph.ts
// Maps a 0-100 usage percentage to a glyph + colour pair used by the status
// panel and the progress bar. Pure function — kept out of TSX so it can be
// unit-tested without a renderer.

import { ORANGE } from '../theme.js';

export interface UsageGlyph {
  glyph: string;
  color: string;
}

export function usageGlyph(pct: number | undefined): UsageGlyph {
  if (pct === undefined) return { glyph: '○', color: 'gray' };
  if (pct >= 95) return { glyph: '○', color: 'red' };
  if (pct >= 85) return { glyph: '◑', color: ORANGE };
  if (pct >= 50) return { glyph: '◐', color: 'yellow' };
  return { glyph: '●', color: 'green' };
}
