// src/commands/update-target.ts
//
// `claude switch update <target> [--check] [--json]` — automated install
// of one of the three update targets. Read-side detection lives in
// `setup/versions/`; this handler picks the channel via
// `buildInstallCommand`, optionally dry-runs (`--check`), and shells out
// to the npm/brew command for real otherwise.
//
// JSON contract on success:
//   { "ok": true, "target": "switch", "from": "4.1.1", "to": "4.1.2" }
//
// JSON contract on failure:
//   { "ok": false, "target": "switch", "error": "<short>", "exitCode": 1 }
//
// Exit codes (per brief §4.2):
//   0  — install succeeded OR `--check` printed plan OR `gui` printed url
//   1  — install attempted and failed (network, perms)
//   2  — target unsupported (e.g. `update gui` or claude on manual source)

import { getVersionsReport, type VersionsOptions } from '../setup/versions/index.js';
import {
  type InstallCommand,
  type UpdateTarget,
  buildInstallCommand,
} from '../setup/versions/install-commands.js';
import { runInstall } from '../setup/versions/install.js';
import type { VersionTarget, VersionsReport } from '../contract.js';

interface UpdateTargetOptions {
  target: UpdateTarget;
  check: boolean;
  json: boolean;
}

/** Optional dep overrides so tests run without hitting the network or
 *  shelling out for real. Production callers leave this empty. */
type Deps = Pick<VersionsOptions, 'http' | 'process' | 'now'>;

export async function handleUpdateTarget(
  opts: UpdateTargetOptions,
  deps: Deps = {},
): Promise<number> {
  // Force a fresh detection so we don't act on stale cache (the user just
  // typed `update`, they want the current state of the world).
  const before = await getVersionsReport({ force: true, ...deps });
  const row = pickRow(before, opts.target);
  const cmd = buildInstallCommand(opts.target, row.source);

  if (!cmd) {
    return handleManualOrUnsupported(opts, row);
  }
  if (opts.check) {
    return handleCheck(opts, cmd, row);
  }
  return handleRun(opts, cmd, row, deps);
}

function pickRow(report: VersionsReport, target: UpdateTarget): VersionTarget {
  return target === 'claude' ? report.claude : target === 'switch' ? report.switch : report.gui;
}

function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handleManualOrUnsupported(opts: UpdateTargetOptions, row: VersionTarget): number {
  const url = row.manualUrl ?? '(no URL on file)';
  if (opts.target === 'gui') {
    // `gui` is manual-by-design until SH-UPD-5. Exit 0 — printing the URL
    // is the documented "install action" for this target in v1.
    if (opts.json) {
      emitJson({ ok: true, target: opts.target, manualUrl: url, from: row.current, to: row.latest });
    } else {
      process.stdout.write(`No automated installer for the GUI in this version.\nDownload: ${url}\n`);
    }
    return 0;
  }
  // claude/switch on a manual or unknown channel — exit 2 so scripts can
  // distinguish "we don't know how" from "we tried and failed".
  if (opts.json) {
    emitJson({
      ok: false,
      target: opts.target,
      error: 'unsupported install source',
      source: row.source,
      manualUrl: url,
      exitCode: 2,
    });
  } else {
    process.stderr.write(
      `Cannot install ${opts.target} automatically (source: ${row.source}).\n` +
        `Install it yourself, then re-run: claude switch versions\n` +
        (row.manualUrl ? `Docs: ${row.manualUrl}\n` : ''),
    );
  }
  return 2;
}

function handleCheck(opts: UpdateTargetOptions, cmd: InstallCommand, row: VersionTarget): number {
  if (opts.json) {
    emitJson({
      ok: true,
      target: opts.target,
      check: true,
      command: cmd.label,
      from: row.current,
      to: row.latest,
    });
  } else {
    process.stdout.write(`Would run: ${cmd.label}\n`);
    process.stdout.write(`Current: ${row.current ?? '—'}  Latest: ${row.latest ?? '?'}\n`);
  }
  return 0;
}

async function handleRun(
  opts: UpdateTargetOptions,
  cmd: InstallCommand,
  row: VersionTarget,
  deps: Deps,
): Promise<number> {
  // Non-JSON callers see the live stream; JSON callers get a clean stdout
  // with the install output suppressed (the structured result is the
  // contract, not the npm/brew banner).
  if (!opts.json) {
    process.stdout.write(`Installing ${opts.target}: ${cmd.label}\n`);
  }
  const result = await runInstall(cmd, { silent: opts.json, process: deps.process });

  if (!result.ok) {
    if (opts.json) {
      emitJson({
        ok: false,
        target: opts.target,
        error: result.errorMessage,
        exitCode: result.exitCode,
      });
    } else {
      process.stderr.write(`Install failed: ${result.errorMessage}\n`);
      process.stderr.write(`Try manually: ${cmd.label}\n`);
    }
    return 1;
  }

  // Force a fresh report so the on-disk cache reflects the new installed
  // version on the next `versions` call — closes the dual-cache drift
  // flagged in memory `sh-upd-followups`.
  const after = await getVersionsReport({ force: true, ...deps });
  const afterRow = pickRow(after, opts.target);
  if (opts.json) {
    emitJson({
      ok: true,
      target: opts.target,
      from: row.current,
      to: afterRow.current,
    });
  } else {
    process.stdout.write(`\n${opts.target} upgraded ${row.current ?? '—'} → ${afterRow.current ?? '?'}.\n`);
  }
  return 0;
}
