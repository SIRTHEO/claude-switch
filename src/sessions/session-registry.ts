// src/sessions/session-registry.ts
// Live-session registry — the single source of truth for "which claude
// sessions are running right now, as which account, isolated or global".
//
// WHY. Changing the global active account (`claude switch <x>` / a routing
// swap) does NOT affect an already-running claude process: it keeps the tokens
// it read at startup and re-reads `~/.claude/.credentials.json` only on its own
// internal refresh. Two concurrent GLOBAL-bound sessions of *different*
// accounts therefore corrupt each other — one session's refresh rotates the
// shared refresh_token at Anthropic, the other's next refresh sends the
// now-invalidated token and gets 401 → "Please run /login". That is the
// "one token good, the other bad" breakage; `usage/active-vault-mirror.ts`
// patched the single-account case, this registry is what lets us reason about
// the concurrent-multi-account generalization.
//
// It serves three layers:
//   1. observability — `claude switch sessions` shows the live topology;
//   2. prevention    — routing reads it to know whether a GLOBAL-bound session
//                      of another account is live before flipping the global
//                      account (if so, launch isolated instead);
//   3. doctor        — identify a mess from ANY cause (a user editing files by
//                      hand, or a claude-switch bug), e.g. two global-bound
//                      sessions on different accounts = mixing in progress.
//
// A registry that LIES is worse than none, so every read prunes dead pids
// (process.kill(pid,0) via the shared `isProcessAlive`). Storage is
// `<accountsDir>/.sessions.json` (mode 0600 via writeJsonAtomic). The pure
// shaping (prune / upsert) is split from fs + the liveness probe so it is
// unit-testable without real pids or a clock; mutations ride the caller's
// existing `withLock(accountsDirPath)`.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../platform/atomic-write.js';
import { isProcessAlive, withLock } from '../platform/lock.js';

export interface LiveSession {
  /** OS pid of the spawned claude process. */
  pid: number;
  /** Account the session was launched as, or null when unknown. */
  account: string | null;
  /** CLAUDE_CONFIG_DIR the session runs against; null = the global default
   *  (`~/.claude`). A non-null configDir means the session has its OWN
   *  credential file and therefore cannot mix with the global vault. */
  configDir: string | null;
  /** Derived from configDir, stored for cheap reads: true = isolated (own
   *  creds), false = global-bound (shares `~/.claude/.credentials.json`). */
  isolated: boolean;
  /** Working directory at launch — for the `sessions` listing only. */
  cwd: string;
  /** Epoch-ms of the spawn. Display + a coarse pid-reuse guard. */
  startedAt: number;
  /** Account the session speaks as RIGHT NOW, after any live migration. Absent
   *  ⇒ unchanged since spawn (equals `account`). Additive: written only by the
   *  migrate writer (`setCurrentAccountForConfigDir`), so `markSessionLive` never
   *  sets it and the `--json` shape is unchanged for un-migrated sessions. */
  currentAccount?: string | null;
}

/** Liveness probe seam so tests don't depend on real pids. */
export interface RegistryDeps {
  isAlive?: (pid: number) => boolean;
}

function registryPath(accountsDirPath: string): string {
  return path.join(accountsDirPath, '.sessions.json');
}

function isLiveSession(v: unknown): v is LiveSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.pid === 'number' &&
    (s.account === null || typeof s.account === 'string') &&
    (s.configDir === null || typeof s.configDir === 'string') &&
    typeof s.isolated === 'boolean' &&
    typeof s.cwd === 'string' &&
    typeof s.startedAt === 'number' &&
    (s.currentAccount === undefined || s.currentAccount === null || typeof s.currentAccount === 'string')
  );
}

/** The account a session speaks as now: its migrated `currentAccount` if set,
 *  else the spawn `account`. The single read every consumer should use. */
export function effectiveAccount(s: LiveSession): string | null {
  return s.currentAccount ?? s.account;
}

/** Read the on-disk registry, dropping any entry that fails the shape guard.
 *  A missing or corrupt file reads as an empty registry (never throws). */
export function readRaw(accountsDirPath: string): LiveSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath(accountsDirPath), 'utf-8'));
  } catch {
    return []; // missing / corrupt registry → treat as no live sessions
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isLiveSession);
}

/** PURE: drop entries whose pid is no longer alive. */
export function pruneList(
  list: LiveSession[],
  isAlive: (pid: number) => boolean,
): LiveSession[] {
  return list.filter((s) => isAlive(s.pid));
}

/** PURE: add `entry`, replacing any existing entry for the same pid (a reused
 *  pid slot is overwritten, never duplicated). */
export function upsertList(list: LiveSession[], entry: LiveSession): LiveSession[] {
  return [...list.filter((s) => s.pid !== entry.pid), entry];
}

/** Build a registry entry, deriving `isolated` from the config dir. A configDir
 *  equal to the global default counts as global-bound, not isolated. */
export function makeSession(input: {
  pid: number;
  account: string | null;
  configDir: string | null;
  globalConfigDir: string;
  cwd: string;
  startedAt: number;
}): LiveSession {
  const { pid, account, configDir, globalConfigDir, cwd, startedAt } = input;
  const isolated = configDir !== null && path.resolve(configDir) !== path.resolve(globalConfigDir);
  return { pid, account, configDir, isolated, cwd, startedAt };
}

/** Record (or refresh) a live session. Prunes dead pids in the same write so
 *  the file self-heals. Caller holds `withLock(accountsDirPath)`. */
export function recordSession(
  accountsDirPath: string,
  entry: LiveSession,
  deps: RegistryDeps = {},
): void {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const next = upsertList(pruneList(readRaw(accountsDirPath), isAlive), entry);
  writeJsonAtomic(registryPath(accountsDirPath), next);
}

/** Remove a session by pid (clean-exit path). Best-effort: a write failure
 *  leaves a stale entry that the next prune drops anyway. */
export function removeSession(accountsDirPath: string, pid: number): void {
  const next = readRaw(accountsDirPath).filter((s) => s.pid !== pid);
  try {
    writeJsonAtomic(registryPath(accountsDirPath), next);
  } catch {
    // best-effort: the entry's pid is dead, so the next prune removes it
  }
}

/**
 * Set a live session's `currentAccount` by its config dir — the migrate writer's
 * registry update (a session's first post-spawn account change, so a later
 * conflict check sees the account it actually speaks as now). No-op when no
 * session matches the dir (e.g. it isn't registered). The caller holds
 * `withLock(accountsDirPath)`; this does NOT self-lock (matches recordSession).
 */
export function setCurrentAccountForConfigDir(
  accountsDirPath: string,
  configDir: string,
  account: string,
): void {
  const resolved = path.resolve(configDir);
  let changed = false;
  const next = readRaw(accountsDirPath).map((s) => {
    if (s.configDir && path.resolve(s.configDir) === resolved) {
      changed = true;
      return { ...s, currentAccount: account };
    }
    return s;
  });
  if (changed) writeJsonAtomic(registryPath(accountsDirPath), next);
}

/** List the live sessions, pruning dead pids. Opportunistically rewrites the
 *  file when it pruned anything so the registry self-heals on every read. */
export function listLiveSessions(
  accountsDirPath: string,
  deps: RegistryDeps = {},
): LiveSession[] {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const all = readRaw(accountsDirPath);
  const live = pruneList(all, isAlive);
  if (live.length !== all.length) {
    try {
      writeJsonAtomic(registryPath(accountsDirPath), live);
    } catch {
      // self-heal is best-effort; the in-memory `live` is still correct
    }
  }
  return live;
}

/** PURE: the global-bound subset (shares `~/.claude/.credentials.json`). These
 *  are the only sessions a global account swap can corrupt — isolated sessions
 *  read their own credential file and are immune. */
export function globalBoundSessions(list: LiveSession[]): LiveSession[] {
  return list.filter((s) => !s.isolated);
}

/**
 * Best-effort: record THIS wrapper process as a live claude session, called by
 * the spawn-and-wait launch paths (passthrough / interactive switch / --as).
 * The pid is `process.pid`: the wrapper blocks for the spawned claude's whole
 * lifetime (see `proxy.run`'s never-settling promise), so prune-on-read
 * reclaims the entry when the session exits — no exit handler needed.
 *
 * The registry is observability + safety tooling; a write failure must NEVER
 * block a launch, so every failure mode is swallowed. Mutates under the
 * accounts-dir lock. `globalConfigDir` is derived as the parent of the accounts
 * dir (`~/.claude`), so a `configDir` equal to it (or null) reads as
 * global-bound, a distinct one as isolated.
 */
export function markSessionLive(
  accountsDirPath: string,
  info: { account: string | null; configDir: string | null; cwd: string },
  deps: RegistryDeps & { now?: () => number } = {},
): void {
  try {
    const entry = makeSession({
      pid: process.pid,
      account: info.account,
      configDir: info.configDir,
      globalConfigDir: path.dirname(accountsDirPath),
      cwd: info.cwd,
      startedAt: (deps.now ?? Date.now)(),
    });
    withLock(accountsDirPath, () => recordSession(accountsDirPath, entry, deps));
  } catch {
    // best-effort observability: never block a claude launch on a registry write
  }
}
