// Terminal detection + launch. Used by `claude switch terminals` and the GUI's
// per-profile launcher to enumerate installed emulators and spawn a fresh
// window in one. Detection probes per platform (macOS: app bundle paths;
// Linux: XDG default + PATH allowlist; Windows: where.exe over known hosts)
// and is pure — it spawns nothing, so it is safe on a hot path. Each entry
// carries a stable kebab-case `id`, a label, an `isDefault` flag, and a
// `launchHint`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { type ProcessPort, nodeProcessAdapter } from '../platform/process.js';

interface TerminalEntry {
  id: string;
  label: string;
  isDefault: boolean;
  /** Short human-friendly description of how the launcher will spawn it. */
  launchHint: string;
}

/** Detect every terminal emulator the launcher can target on this host. */
export function detectTerminals(deps: { process?: ProcessPort } = {}): TerminalEntry[] {
  const proc = deps.process ?? nodeProcessAdapter;
  if (process.platform === 'darwin') return detectDarwin();
  if (process.platform === 'linux') return detectLinux(proc);
  if (process.platform === 'win32') return detectWindows(proc);
  return [];
}

// --- macOS ---

interface MacApp {
  id: string;
  label: string;
  bundlePath: string;
}

const MAC_APPS: MacApp[] = [
  { id: 'terminal', label: 'Terminal.app', bundlePath: '/System/Applications/Utilities/Terminal.app' },
  { id: 'iterm2', label: 'iTerm2', bundlePath: '/Applications/iTerm.app' },
  { id: 'warp', label: 'Warp', bundlePath: '/Applications/Warp.app' },
  { id: 'ghostty', label: 'Ghostty', bundlePath: '/Applications/Ghostty.app' },
  { id: 'wezterm', label: 'WezTerm', bundlePath: '/Applications/WezTerm.app' },
  { id: 'alacritty', label: 'Alacritty', bundlePath: '/Applications/Alacritty.app' },
  { id: 'kitty', label: 'kitty', bundlePath: '/Applications/kitty.app' },
  { id: 'hyper', label: 'Hyper', bundlePath: '/Applications/Hyper.app' },
];

function detectDarwin(): TerminalEntry[] {
  const out: TerminalEntry[] = [];
  for (const app of MAC_APPS) {
    const present =
      fs.existsSync(app.bundlePath) ||
      fs.existsSync(path.join(os.homedir(), 'Applications', path.basename(app.bundlePath)));
    if (!present) continue;
    out.push({
      id: app.id,
      label: app.label,
      isDefault: app.id === 'terminal',
      launchHint:
        app.id === 'terminal' || app.id === 'iterm2'
          ? 'AppleScript driven — opens a new window and types the command.'
          : 'open -a + posix-spawn — the app receives the command via its argv.',
    });
  }
  return out;
}

// --- Linux ---

interface LinuxBin {
  id: string;
  label: string;
  bin: string;
}

const LINUX_BINS: LinuxBin[] = [
  { id: 'gnome-terminal', label: 'GNOME Terminal', bin: 'gnome-terminal' },
  { id: 'konsole', label: 'Konsole', bin: 'konsole' },
  { id: 'alacritty', label: 'Alacritty', bin: 'alacritty' },
  { id: 'kitty', label: 'kitty', bin: 'kitty' },
  { id: 'wezterm', label: 'WezTerm', bin: 'wezterm' },
  { id: 'foot', label: 'foot', bin: 'foot' },
  { id: 'terminator', label: 'Terminator', bin: 'terminator' },
  { id: 'tilix', label: 'Tilix', bin: 'tilix' },
  { id: 'xterm', label: 'xterm', bin: 'xterm' },
];

function detectLinux(proc: ProcessPort): TerminalEntry[] {
  const which = (bin: string) => proc.spawnSync('which', [bin], { stdio: 'pipe' }).status === 0;
  const xdgDefault = readXdgDefaultTerminal(proc);
  return LINUX_BINS.filter((b) => which(b.bin)).map((b) => ({
    id: b.id,
    label: b.label,
    isDefault: !!xdgDefault && xdgDefault.includes(b.bin),
    launchHint: `${b.bin} -e <command> spawn in a fresh window.`,
  }));
}

function readXdgDefaultTerminal(proc: ProcessPort): string | null {
  const probe = proc.spawnSync('xdg-mime', ['query', 'default', 'x-scheme-handler/terminal'], {
    stdio: 'pipe',
  });
  if (probe.status !== 0) return null;
  return probe.stdout.toString().trim() || null;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

interface WinBin {
  id: string;
  label: string;
  exe: string;
}

const WIN_BINS: WinBin[] = [
  { id: 'windows-terminal', label: 'Windows Terminal', exe: 'wt.exe' },
  { id: 'powershell', label: 'PowerShell', exe: 'powershell.exe' },
  { id: 'cmd', label: 'Command Prompt', exe: 'cmd.exe' },
  { id: 'wezterm', label: 'WezTerm', exe: 'wezterm.exe' },
  { id: 'alacritty', label: 'Alacritty', exe: 'alacritty.exe' },
];

function detectWindows(proc: ProcessPort): TerminalEntry[] {
  return WIN_BINS.filter((w) => {
    const r = proc.spawnSync('where.exe', [w.exe], { stdio: 'pipe' });
    return r.status === 0;
  }).map((w) => ({
    id: w.id,
    label: w.label,
    isDefault: w.id === 'windows-terminal',
    launchHint: `${w.exe} spawn in a fresh window.`,
  }));
}

// ---------------------------------------------------------------------------
// Launch a command in a specific terminal
// ---------------------------------------------------------------------------

interface LaunchOptions {
  /** Terminal id from detectTerminals(). Required. */
  terminalId: string;
  /** Working directory the new window should start in. Defaults to home. */
  cwd?: string;
  /** Environment overrides — typically CLAUDE_CONFIG_DIR for profile isolation. */
  env?: Record<string, string>;
  /** Command to execute in the new window, e.g. ["claude"] or ["claude", "--resume"]. */
  command: string[];
}

/**
 * Spawn a fresh window of `opts.terminalId` running `opts.command`. The
 * window inherits `opts.cwd` and the merged `opts.env`. Returns
 * synchronously after the helper process exits; the new terminal window
 * stays open until the user closes it.
 *
 * Throws when the terminal id is not recognised on this platform.
 */
export function launchInTerminal(opts: LaunchOptions, deps: { process?: ProcessPort } = {}): void {
  const proc = deps.process ?? nodeProcessAdapter;
  if (process.platform === 'darwin') {
    launchDarwin(opts, proc);
    return;
  }
  if (process.platform === 'linux') {
    launchLinux(opts, proc);
    return;
  }
  if (process.platform === 'win32') {
    launchWindows(opts, proc);
    return;
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function envExportPrefix(env: Record<string, string> | undefined): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)};`)
    .join(' ');
}

function shellCommand(opts: LaunchOptions): string {
  const cd = opts.cwd ? `cd ${JSON.stringify(opts.cwd)};` : '';
  const env = envExportPrefix(opts.env);
  const cmd = opts.command.map((a) => JSON.stringify(a)).join(' ');
  return `${cd} ${env} ${cmd}`.trim();
}

function launchDarwin(opts: LaunchOptions, proc: ProcessPort): void {
  const shell = shellCommand(opts);
  if (opts.terminalId === 'terminal') {
    const script = `tell application "Terminal" to do script "${escapeAppleScriptString(shell)}"`;
    proc.spawnSync('osascript', ['-e', script], { stdio: 'pipe' });
    proc.spawnSync('osascript', ['-e', 'tell application "Terminal" to activate'], { stdio: 'pipe' });
    return;
  }
  if (opts.terminalId === 'iterm2') {
    const script = [
      'tell application "iTerm"',
      '  create window with default profile',
      `  tell current session of current window to write text "${escapeAppleScriptString(shell)}"`,
      'end tell',
    ].join('\n');
    proc.spawnSync('osascript', ['-e', script], { stdio: 'pipe' });
    return;
  }
  // Most other macOS terminal apps accept the command on argv via `open -na`.
  const appName = MAC_APPS.find((a) => a.id === opts.terminalId)?.label;
  if (!appName) throw new Error(`Unknown terminal id on macOS: ${opts.terminalId}`);
  // Wrap the command in a bash login shell so PATH inherits and `claude`
  // resolves the same way it would in an interactive terminal.
  proc.spawnSync(
    'open',
    ['-na', appName, '--args', '-l', '-c', shell],
    { stdio: 'pipe' },
  );
}

function launchLinux(opts: LaunchOptions, proc: ProcessPort): void {
  const bin = LINUX_BINS.find((b) => b.id === opts.terminalId);
  if (!bin) throw new Error(`Unknown terminal id on Linux: ${opts.terminalId}`);
  const shell = shellCommand(opts);
  // Most Linux terminals accept `-e <cmd>` or `--command <cmd>` to run a
  // single command in the new window; we wrap in `bash -lc` so the env
  // export prefix lands correctly.
  const child = proc.spawn(bin.bin, ['-e', 'bash', '-lc', shell], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

/**
 * Build exe / argv / spawn options for a Windows terminal launch. Pure, so the
 * shaping is unit-testable without a Windows host. `opts.env` (carries
 * CLAUDE_CONFIG_DIR for profile isolation) and `cwd` ride on the spawn OPTIONS
 * — dropping env, as the prior inline version did, opened the DEFAULT profile.
 * argv stays as separate elements (wt's `-d <path>`, command trailing) instead
 * of one glued, quoted string wt.exe could not parse. Per-terminal command
 * semantics (powershell `-NoExit`, cmd `/K`) are deferred to the Windows work.
 */
export function buildWindowsLaunch(opts: LaunchOptions): {
  exe: string;
  args: string[];
  options: SpawnOptions;
} {
  const bin = WIN_BINS.find((w) => w.id === opts.terminalId);
  if (!bin) throw new Error(`Unknown terminal id on Windows: ${opts.terminalId}`);
  const args: string[] = [];
  // Windows Terminal opens the new tab in `-d <dir>`; other hosts inherit the
  // spawn cwd below.
  if (bin.id === 'windows-terminal' && opts.cwd) args.push('-d', opts.cwd);
  args.push(...opts.command);
  return {
    exe: bin.exe,
    args,
    options: {
      stdio: 'ignore',
      detached: true,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    },
  };
}

function launchWindows(opts: LaunchOptions, proc: ProcessPort): void {
  const { exe, args, options } = buildWindowsLaunch(opts);
  const child = proc.spawn(exe, args, options);
  child.unref();
}
