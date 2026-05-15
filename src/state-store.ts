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
import { writeJsonAtomic } from './atomic-write.js';
import { withLock } from './lock.js';

const STATE_FILE = '.claude-switch-state.json';
const LEGACY_FALLBACK_ENABLED = '.fallback-enabled';
const LEGACY_FALLBACK_AUTO_ENGAGED = '.fallback-auto-engaged';
const LEGACY_PENDING_RESTORE = '.pending-restore';

export interface State {
  version: 1;
  fallback: {
    enabled: boolean;
    autoEngaged: boolean;
  };
  /** Email pending restore from an interrupted `--as` session, or
   *  undefined when no restore is queued. */
  pendingRestore?: string;
  /** Snapshot of "last account routed to per emailDomain". Used by
   *  project-aware routing to pick deterministically when a
   *  `.claude-switch` constraint matches multiple saved accounts. Keyed
   *  by the lower-cased domain (`acme.com`), value is the chosen email.
   *  Optional — older state files predate the field; resolver tolerates
   *  an empty object. */
  lastUsedByDomain?: Record<string, string>;
}

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
  // Fast path: state.json present, parse it.
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(accountsDirPath), 'utf-8'));
    if (raw && typeof raw === 'object' && raw.version === 1) {
      // Tolerate partial files (older builds may have written a subset).
      const fallback = (raw.fallback && typeof raw.fallback === 'object')
        ? {
            enabled: !!raw.fallback.enabled,
            autoEngaged: !!raw.fallback.autoEngaged,
          }
        : EMPTY_STATE.fallback;
      const pending = typeof raw.pendingRestore === 'string' ? raw.pendingRestore : undefined;
      const lastUsed = sanitizeLastUsed(raw.lastUsedByDomain);
      return {
        version: 1,
        fallback,
        ...(pending ? { pendingRestore: pending } : {}),
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
