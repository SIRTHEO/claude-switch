// src/commands/sessions.ts
// `claude switch sessions [--json]` — show the claude sessions this machine is
// running right now, as tracked by the live-session registry: which account,
// the profile it runs in (or global-bound), working dir, and age. It never
// starts or stops a session; the underlying `listLiveSessions` prunes dead pids
// on read (a self-healing write) so the answer never lies.
//
// It also surfaces the dangerous shape up front: two or more GLOBAL-bound
// sessions on different accounts share `~/.claude/.credentials.json` and can
// corrupt each other's tokens — the "one token good, the other bad" breakage.

import path from 'node:path';
import { type LiveSession, globalBoundSessions, listLiveSessions } from '../sessions/session-registry.js';

interface SessionsOptions {
  json: boolean;
}

/** Coarse human age label from a spawn timestamp. */
function ageLabel(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.round((now - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/**
 * Human scope label for a session: `global` (shares ~/.claude), or — when the
 * session is isolated against a profile/overlay — `profile "<name>"` so the
 * user can tell which terminal is which. `isolated` (the stored flag) is the
 * source of truth for global-vs-isolated; `configDir` only supplies the name,
 * and only when it points into the profiles tree (a user's arbitrary
 * CLAUDE_CONFIG_DIR isolates too but has no profile name → plain `isolated`).
 * The profiles root is derived from accountsDirPath (`<~/.claude>/profiles`),
 * NOT from profiles.ts — that module is heavy and this command is on the cli
 * startup graph.
 *
 * (Forward note: when live migration lands — slice 5 — a session's CURRENT
 * profile can diverge from the one it was SPAWNED with; that two-column view
 * ships with the migration writer that produces the divergence, not here.)
 */
function scopeLabel(s: LiveSession, accountsDirPath: string): string {
  if (!s.isolated) return 'global';
  if (s.configDir) {
    const home = path.dirname(accountsDirPath);
    const profilesRoot = path.join(home, 'profiles');
    if (s.configDir === profilesRoot || s.configDir.startsWith(profilesRoot + path.sep)) {
      return `profile "${path.basename(s.configDir)}"`;
    }
    // Per-session work dir: `<home>/session-dirs/<profile>.<pid>` (the seeded copy
    // a session actually runs in). Recover the profile name by stripping the
    // trailing `.<pid>` — the profile name's own alphabet excludes `.`.
    const sessionDirsRoot = path.join(home, 'session-dirs');
    if (s.configDir.startsWith(sessionDirsRoot + path.sep)) {
      return `profile "${path.basename(s.configDir).replace(/\.\d+$/, '')}"`;
    }
  }
  return 'isolated';
}

/** The distinct accounts running GLOBAL-bound right now. Two or more = a live
 *  token-mixing hazard (they share the global credential file). */
function clashingGlobalAccounts(sessions: LiveSession[]): string[] {
  const accounts = new Set<string>();
  for (const s of globalBoundSessions(sessions)) {
    if (s.account) accounts.add(s.account);
  }
  return [...accounts].sort();
}

export function handleSessions(
  ctx: { accountsDirPath: string },
  opts: SessionsOptions,
  deps?: { now?: () => number; isAlive?: (pid: number) => boolean },
): void {
  const now = (deps?.now ?? Date.now)();
  const sessions = listLiveSessions(ctx.accountsDirPath, { isAlive: deps?.isAlive });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(sessions)}\n`);
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write('No live claude sessions tracked.\n');
    return;
  }

  process.stdout.write(`Live claude sessions (${sessions.length}):\n`);
  for (const s of sessions) {
    const scope = scopeLabel(s, ctx.accountsDirPath);
    process.stdout.write(
      `  • ${s.account ?? '(unknown)'} — ${scope} · pid ${s.pid} · ${ageLabel(s.startedAt, now)} · ${s.cwd}\n`,
    );
  }

  const clashing = clashingGlobalAccounts(sessions);
  if (clashing.length > 1) {
    process.stdout.write(
      `\n⚠ ${clashing.length} accounts are running GLOBAL-bound at once ` +
      `(${clashing.join(', ')}). They share ~/.claude/.credentials.json and can ` +
      `corrupt each other's tokens. Launch each non-active account isolated ` +
      `(a profile/overlay) — see \`claude switch doctor\`.\n`,
    );
  }
}
