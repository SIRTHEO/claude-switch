// src/commands/migrate.ts
// `claude switch migrate <pid> <account> [--json]` — live-migrate a RUNNING
// isolated claude session (identified by the pid shown in `claude switch
// sessions`) to a different account, without restarting it.
//
// ⛔ TEMPORARILY INERT. Live migration rewrites a running session's config dir;
// today every isolated session runs in its account's CANONICAL profile dir, so a
// real migration would corrupt that account and reintroduce token mixing. The
// command is therefore wired but DISABLED at the surface: its default action is
// `notAvailable` (an unconditional refuse), immune to where sessions run. It is
// re-enabled — by switching the default back to `migrateSession` — only once
// per-session work dirs + the reconcile/usage-poll/launch-refusal protections
// land (the per-session-dir work and its final step). The `migrateSession` writer
// itself stays fully tested for that day.

import type { MigrateResult } from '../sessions/migrate-session.js';
import { listLiveSessions } from '../sessions/session-registry.js';

interface MigrateOptions {
  json: boolean;
}

type MigrateFn = (target: string, configDir: string, accountsDirPath: string) => Promise<MigrateResult>;

/** Default action while the feature is disabled (see header): refuse, never
 *  touch credentials. Replaced by `migrateSession` when migration is re-enabled. */
const notAvailable: MigrateFn = () => {
  throw new Error(
    'live migration is not available in this version yet — it lands with the ' +
      'per-session working-directory support (so it can never corrupt an account).',
  );
};

/** Seam so the JSON-contract test can drive the output paths with an injected
 *  migration. Production uses `notAvailable` (feature disabled — see header). */
interface MigrateDeps {
  migrate?: MigrateFn;
}

/** Emit a single-line JSON failure + exit non-zero (GUI contract: clean stderr
 *  in json mode), or a human stderr message + exit non-zero otherwise. */
function fail(message: string, opts: MigrateOptions): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  } else {
    process.stderr.write(`claude switch migrate: ${message}\n`);
  }
  process.exitCode = 1;
}

export async function handleMigrate(
  ctx: { accountsDirPath: string },
  session: string | undefined,
  target: string | undefined,
  opts: MigrateOptions,
  deps: MigrateDeps = {},
): Promise<void> {
  const migrate = deps.migrate ?? notAvailable;
  if (!session || !target) {
    fail('usage: claude switch migrate <pid> <account>  (pid from `claude switch sessions`)', opts);
    return;
  }

  const pid = Number(session);
  if (!Number.isInteger(pid) || pid <= 0) {
    fail(`"${session}" is not a valid pid — see \`claude switch sessions\` for the live pids.`, opts);
    return;
  }

  const found = listLiveSessions(ctx.accountsDirPath).find((s) => s.pid === pid);
  if (!found) {
    fail(`No live session with pid ${pid}. Run \`claude switch sessions\` to list them.`, opts);
    return;
  }
  if (!found.isolated || !found.configDir) {
    fail(
      `Session ${pid} is global-bound (shares ~/.claude). Only isolated sessions ` +
        `(launched in a profile/overlay) can be live-migrated.`,
      opts,
    );
    return;
  }

  try {
    const result = await migrate(target, found.configDir, ctx.accountsDirPath);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    } else if (result.noop) {
      process.stdout.write(`Session ${pid} already runs ${target} — nothing to migrate.\n`);
    } else {
      process.stdout.write(
        `Migrated session ${pid} → ${target}. It adopts the new account on its next turn.\n`,
      );
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), opts);
  }
}
