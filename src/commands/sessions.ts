// src/commands/sessions.ts
// `claude switch sessions [--json]` — show the claude sessions this machine is
// running right now, as tracked by the live-session registry: which account,
// isolated or global-bound, working dir, and age. It never starts or stops a
// session; the underlying `listLiveSessions` prunes dead pids on read (a
// self-healing write) so the answer never lies.
//
// It also surfaces the dangerous shape up front: two or more GLOBAL-bound
// sessions on different accounts share `~/.claude/.credentials.json` and can
// corrupt each other's tokens — the "one token good, the other bad" breakage.

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
    const scope = s.isolated ? 'isolated' : 'global';
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
