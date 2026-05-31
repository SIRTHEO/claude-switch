// src/commands/migrate.ts
// `claude switch migrate <pid> <account> [--json]` — live-migrate a RUNNING
// isolated claude session (identified by the pid shown in `claude switch
// sessions`) to a different account, without restarting it. Thin surface over
// `migrateSession`: resolve pid → the session's private config dir from the
// live registry, then hand off to the writer (which enforces every safety gate:
// isolated-only, target-logged-in, target-not-live-elsewhere).

import { type MigrateResult, migrateSession } from '../sessions/migrate-session.js';
import { listLiveSessions } from '../sessions/session-registry.js';

interface MigrateOptions {
  json: boolean;
}

/** Seam so the JSON-contract test can drive the output paths without the real
 *  profile-resolve / credential write. Production uses `migrateSession`. */
interface MigrateDeps {
  migrate?: (target: string, configDir: string, accountsDirPath: string) => Promise<MigrateResult>;
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
  const migrate = deps.migrate ?? migrateSession;
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
