// src/cache-health-flush.ts
// Line-accurate cache-flush event extraction from a session JSONL file.

import fs from 'node:fs';
import {
  FLUSH_CREATION_THRESHOLD,
  FLUSH_READ_THRESHOLD,
  extractAssistantEntry,
  extractTokenCount,
} from './cache-health-core.js';

/** Describes a single cache-flush event detected in the JSONL stream. */
export interface FlushEvent {
  /** 0-based turn index within the assistant entries. */
  turn: number;
  /** 1-based line number in the original JSONL file (empty lines included in count). */
  line: number;
  /** ISO timestamp string from the JSONL entry, or null if absent. */
  timestamp: string | null;
}

/**
 * Re-parse a Claude Code session JSONL file and return one {@link FlushEvent}
 * per detected cache flush, preserving the **1-based line number** from the
 * original file and the entry's `timestamp` field when present.
 *
 * Flush detection heuristic (identical to `summariseCacheHealth`):
 *   `turn_index > 0 && cache_creation > FLUSH_CREATION_THRESHOLD && cache_read < FLUSH_READ_THRESHOLD`
 *
 * Line numbers are 1-based and count all lines (including empty and malformed),
 * so they can be used to locate the entry in the raw file.
 *
 * Non-assistant entries and malformed JSON lines are skipped (same semantics as
 * `readSessionJsonl`), but they still increment the line counter.
 */
export function extractFlushTurns(filePath: string): FlushEvent[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const allLines = raw.split('\n');
  const events: FlushEvent[] = [];

  let turnIndex = 0; // counts only assistant turns (matches summariseCacheHealth's `i`)

  for (let lineIdx = 0; lineIdx < allLines.length; lineIdx++) {
    const line = allLines[lineIdx];
    if (!line || line.trim() === '') continue; // empty / whitespace — skip, no turn increment

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed line — skip, no turn increment
      continue;
    }

    const entry = extractAssistantEntry(parsed);
    if (entry === null) continue; // not an assistant turn — skip

    const { usage } = entry;
    const cacheCreation = extractTokenCount(usage['cache_creation_input_tokens']);
    const cacheRead = extractTokenCount(usage['cache_read_input_tokens']);

    if (turnIndex > 0 && cacheCreation > FLUSH_CREATION_THRESHOLD && cacheRead < FLUSH_READ_THRESHOLD) {
      // Extract timestamp from the raw entry if present
      let timestamp: string | null = null;
      if (typeof parsed === 'object' && parsed !== null) {
        const raw_ts = (parsed as Record<string, unknown>)['timestamp'];
        if (typeof raw_ts === 'string') timestamp = raw_ts;
      }

      events.push({
        turn: turnIndex,
        line: lineIdx + 1, // 1-based
        timestamp,
      });
    }

    turnIndex++;
  }

  return events;
}
