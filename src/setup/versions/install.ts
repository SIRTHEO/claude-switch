// src/setup/versions/install.ts
//
// Spawn the install command we built in install-commands.ts, stream its
// stdout/stderr through to the caller's terminal, and resolve to a
// structured result the command handler turns into either a JSON line
// or a human banner.
//
// We deliberately do NOT auto-escalate to sudo on EACCES (brief §4.3):
// every modern setup ships an unprivileged-friendly Node (nvm / asdf /
// Volta / brew), and silently `sudo`-ing on behalf of the user is a
// security smell. On EACCES we surface stderr verbatim — the user knows
// their setup and can decide.

import type { ChildProcess } from 'node:child_process';

import type { ProcessPort } from '../../platform/process.js';
import { nodeProcessAdapter } from '../../platform/process.js';
import type { InstallCommand } from './install-commands.js';

interface InstallResult {
  ok: boolean;
  /** Exit code from the child. `null` when the spawn itself failed. */
  exitCode: number | null;
  /** Reason for failure when `!ok`, empty string otherwise. */
  errorMessage: string;
}

interface InstallOptions {
  process?: ProcessPort;
  /** When true, the install runs silently (stdout/stderr captured, not
   *  written to the terminal). Default false — install output is
   *  meaningful to the user and the GUI surfaces it back. */
  silent?: boolean;
}

export function runInstall(
  command: InstallCommand,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const proc = opts.process ?? nodeProcessAdapter;
  return new Promise<InstallResult>((resolve) => {
    let child: ChildProcess;
    try {
      // stdio: stream live to the parent's terminal so the user sees the
      // npm/brew progress in real time. The GUI shell-plugin captures
      // these streams when invoked from the Tauri side.
      child = proc.spawn(command.cmd, command.args, {
        stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      });
    } catch (e) {
      // spawn() can throw synchronously when the binary doesn't exist —
      // surface a useful message rather than letting the promise resolve
      // to a confusing `ok: false, exitCode: null` with no context.
      resolve({
        ok: false,
        exitCode: null,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    let stderrBuf = '';
    if (opts.silent && child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
    }

    child.on('error', (err) => {
      // ENOENT (binary missing) shows up here when the platform spawns
      // async — same handling as the synchronous throw above.
      resolve({
        ok: false,
        exitCode: null,
        errorMessage: err.message,
      });
    });

    child.on('close', (code) => {
      const ok = code === 0;
      resolve({
        ok,
        exitCode: code,
        errorMessage: ok ? '' : stderrBuf.trim() || `exit ${code ?? '?'}`,
      });
    });
  });
}
