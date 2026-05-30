// src/state-store.ts
// Single source of truth for ephemeral runtime state in the accounts dir.
// Replaces three separate marker / sidecar files that v3.x has accumulated:
//
//   .fallback-enabled         → state.fallback.enabled (presence-as-truth)
//   .fallback-auto-engaged    → state.fallback.autoEngaged
//   .pending-restore          → state.pendingRestore (email string)
//
// Why one file instead of three:
//   - One read on the hot path (passthrough / statusline) instead of three.
//   - Atomic writes mean a crash mid-write can't leave us with the
//     fallback flag flipped but the auto-engage sidecar stale (or vice
//     versa) — the previous design had no transactional guarantee
//     across the two files.
//   - Easier to add new ephemeral fields without growing the file zoo.
//
// Persistent user configuration (thresholds in `.auto-fallback.json`,
// global preferences in `.user-prefs.json`) and per-account state stay
// where they are — different lifecycle, different audience.
//
// Migration: on the first read after upgrade, if `state.json` is missing
// but any of the legacy marker files exist, we synthesise the new state
// from them and delete the old files. After that point the legacy files
// are never written again.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import { withLock } from '../platform/lock.js';

const STATE_FILE = '.claude-switch-state.json';
const LEGACY_FALLBACK_ENABLED = '.fallback-enabled';
const LEGACY_FALLBACK_AUTO_ENGAGED = '.fallback-auto-engaged';
const LEGACY_PENDING_RESTORE = '.pending-restore';

const FallbackSchema = z
  .object({
    enabled: z.coerce.boolean().catch(false),
    autoEngaged: z.coerce.boolean().catch(false),
  })
  .catch({ enabled: false, autoEngaged: false });

/**
 * Canonical shape of `<accountsDir>/.claude-switch-state.json`, and the single
 * source of truth for the `State` type (via z.infer). The `.catch()`/`.optional()`
 * make the parse tolerate partial / older files exactly the way the previous
 * hand-rolled typeof checks did: a missing/bad `fallback` collapses to off, a
 * bad optional drops to absent — a malformed field never throws on the hot path.
 * A wrong `version` makes the whole parse fail, which readState treats as
 * "fall through to legacy migration".
 */
const StateSchema = z.object({
  version: z.literal(1),
  fallback: FallbackSchema,
  /** Email pending restore from an interrupted `--as` session, or absent when
   *  no restore is queued. */
  pendingRestore: z.string().optional().catch(undefined),
  /** "last account routed to per emailDomain", keyed by lower-cased domain
   *  (`acme.com` → chosen email). Declared here for the type; readState
   *  normalises the value through sanitizeLastUsed (lowercasing + dropping
   *  empty/partial entries). Older state files predate the field; the resolver
   *  tolerates an empty object. */
  lastUsedByDomain: z.record(z.string(), z.string()).optional().catch(undefined),
});

export type State = z.infer<typeof StateSchema>;

const EMPTY_STATE: State = {
  version: 1,
  fallback: { enabled: false, autoEngaged: false },
};

function statePath(accountsDirPath: string): string {
  return path.join(accountsDirPath, STATE_FILE);
}

/** Read the current state, migrating from legacy marker files if needed.
 *  Migration runs at most once — once `state.json` exists, the legacy
 *  files are ignored even if they reappear (a stray marker can't override
 *  the state we already trust). */
export function readState(accountsDirPath: string): State {
  // Fast path: state.json present, parse it through the schema. The schema's
  // .catch()/.optional() tolerate partial / older files the way the previous
  // hand-rolled typeof checks did — a bad field is dropped, never thrown.
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(statePath(accountsDirPath), 'utf-8'));
    const parsed = StateSchema.safeParse(raw);
    if (parsed.success) {
      const { fallback, pendingRestore } = parsed.data;
      // lastUsedByDomain keeps its dedicated normaliser (lowercasing + dropping
      // empty/partial entries) applied to the RAW value, so a mixed map keeps
      // its valid entries instead of being dropped wholesale.
      const lastUsed = sanitizeLastUsed((raw as { lastUsedByDomain?: unknown }).lastUsedByDomain);
      return {
        version: 1,
        fallback,
        ...(pendingRestore ? { pendingRestore } : {}),
        ...(lastUsed ? { lastUsedByDomain: lastUsed } : {}),
      };
    }
  } catch {
    /* missing / unparseable → fall through to migration */
  }

  // Slow path: migrate from legacy markers if any exist.
  return migrateFromLegacy(accountsDirPath);
}

function sanitizeLastUsed(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0) continue;
    if (typeof v !== 'string' || v.length === 0) continue;
    out[k.toLowerCase()] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function migrateFromLegacy(accountsDirPath: string): State {
  const enabled = fs.existsSync(path.join(accountsDirPath, LEGACY_FALLBACK_ENABLED));
  const autoEngaged = enabled
    && fs.existsSync(path.join(accountsDirPath, LEGACY_FALLBACK_AUTO_ENGAGED));
  let pendingRestore: string | undefined;
  try {
    const raw = fs.readFileSync(path.join(accountsDirPath, LEGACY_PENDING_RESTORE), 'utf-8').trim();
    if (raw) pendingRestore = raw;
  } catch {
    /* no pending restore */
  }

  // If nothing existed, return empty state without touching disk.
  if (!enabled && !pendingRestore) {
    return EMPTY_STATE;
  }

  const migrated: State = {
    version: 1,
    fallback: { enabled, autoEngaged },
    ...(pendingRestore ? { pendingRestore } : {}),
  };

  // Persist + delete legacy markers atomically (best-effort cleanup).
  try {
    fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });
    writeJsonAtomic(statePath(accountsDirPath), migrated);
    for (const f of [LEGACY_FALLBACK_ENABLED, LEGACY_FALLBACK_AUTO_ENGAGED, LEGACY_PENDING_RESTORE]) {
      try {
        fs.unlinkSync(path.join(accountsDirPath, f));
      } catch {
        /* not present, fine */
      }
    }
  } catch {
    /* migration write failed — return the in-memory state anyway, the
       next call will retry. Worst case we do a few read-time merges. */
  }

  return migrated;
}

/** Apply a partial update INSIDE the caller's existing `withLock`. Use
 *  this when the surrounding code already holds the accounts-dir lock
 *  (passthrough's atomic snapshot, switcher's atomic switch+flip). */
export function updateStateInLock(
  accountsDirPath: string,
  patch: (state: State) => State,
): State {
  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });
  const current = readState(accountsDirPath);
  const next = patch(current);
  writeJsonAtomic(statePath(accountsDirPath), next);
  return next;
}

/** Apply a partial update — acquires the lock first. Use from contexts
 *  with no surrounding `withLock` (CLI command handlers, settings UI). */
export function updateState(
  accountsDirPath: string,
  patch: (state: State) => State,
): State {
  return withLock(accountsDirPath, () => updateStateInLock(accountsDirPath, patch));
}
