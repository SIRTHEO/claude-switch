// Terminal detection. Used by `claude switch terminals` and by the GUI's
// per-profile launcher to surface the terminal emulators the user has
// installed, plus the command shape to spawn a fresh window in each.
//
// Strategy by platform:
//
//   macOS    — probe known Application bundle paths under /Applications
//              and ~/Applications. The OS default Terminal.app is always
//              counted as present.
//   Linux    — probe the FreeDesktop XDG default (`xdg-mime query default
//              x-scheme-handler/terminal`) plus a fixed allowlist of
//              executables on PATH (gnome-terminal, konsole, alacritty,
//              kitty, wezterm, terminator, foot, …).
//   Windows  — probes `where.exe` for the standard terminal hosts
//              (wt.exe = Windows Terminal, powershell.exe, cmd.exe,
//              and any wezterm.exe / alacritty.exe on PATH).
//
// Each detected entry carries a stable `id` (kebab-case slug used by the
// GUI and the launcher CLI), a human label, an `isDefault` flag (true
// for the system default terminal), and a `launchHint` describing the
// shell-out shape the launcher will use. Detection is pure: it does not
// spawn anything, so it's safe to call from a hot path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export interface TerminalEntry {
  id: string;
  label: string;
  isDefault: boolean;
  /** Short human-friendly description of how the launcher will spawn it. */
  launchHint: string;
}

/** Detect every terminal emulator the launcher can target on this host. */
export function detectTerminals(): TerminalEntry[] {
  if (process.platform === 'darwin') return detectDarwin();
  if (process.platform === 'linux') return detectLinux();
  if (process.platform === 'win32') return detectWindows();
  return [];
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

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

function detectLinux(): TerminalEntry[] {
  const which = (bin: string) => spawnSync('which', [bin], { stdio: 'pipe' }).status === 0;
  const xdgDefault = readXdgDefaultTerminal();
  return LINUX_BINS.filter((b) => which(b.bin)).map((b) => ({
    id: b.id,
    label: b.label,
    isDefault: !!xdgDefault && xdgDefault.includes(b.bin),
    launchHint: `${b.bin} -e <command> spawn in a fresh window.`,
  }));
}

function readXdgDefaultTerminal(): string | null {
  const probe = spawnSync('xdg-mime', ['query', 'default', 'x-scheme-handler/terminal'], {
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

function detectWindows(): TerminalEntry[] {
  return WIN_BINS.filter((w) => {
    const r = spawnSync('where.exe', [w.exe], { stdio: 'pipe' });
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

export interface LaunchOptions {
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
export function launchInTerminal(opts: LaunchOptions): void {
  if (process.platform === 'darwin') {
    launchDarwin(opts);
    return;
  }
  if (process.platform === 'linux') {
    launchLinux(opts);
    return;
  }
  if (process.platform === 'win32') {
    launchWindows(opts);
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

function launchDarwin(opts: LaunchOptions): void {
  const shell = shellCommand(opts);
  if (opts.terminalId === 'terminal') {
    const script = `tell application "Terminal" to do script "${escapeAppleScriptString(shell)}"`;
    spawnSync('osascript', ['-e', script], { stdio: 'pipe' });
    spawnSync('osascript', ['-e', 'tell application "Terminal" to activate'], { stdio: 'pipe' });
    return;
  }
  if (opts.terminalId === 'iterm2') {
    const script = [
      'tell application "iTerm"',
      '  create window with default profile',
      `  tell current session of current window to write text "${escapeAppleScriptString(shell)}"`,
      'end tell',
    ].join('\n');
    spawnSync('osascript', ['-e', script], { stdio: 'pipe' });
    return;
  }
  // Most other macOS terminal apps accept the command on argv via `open -na`.
  const appName = MAC_APPS.find((a) => a.id === opts.terminalId)?.label;
  if (!appName) throw new Error(`Unknown terminal id on macOS: ${opts.terminalId}`);
  // Wrap the command in a bash login shell so PATH inherits and `claude`
  // resolves the same way it would in an interactive terminal.
  spawnSync(
    'open',
    ['-na', appName, '--args', '-l', '-c', shell],
    { stdio: 'pipe' },
  );
}

function launchLinux(opts: LaunchOptions): void {
  const bin = LINUX_BINS.find((b) => b.id === opts.terminalId);
  if (!bin) throw new Error(`Unknown terminal id on Linux: ${opts.terminalId}`);
  const shell = shellCommand(opts);
  // Most Linux terminals accept `-e <cmd>` or `--command <cmd>` to run a
  // single command in the new window; we wrap in `bash -lc` so the env
  // export prefix lands correctly.
  const child = spawn(bin.bin, ['-e', 'bash', '-lc', shell], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

function launchWindows(opts: LaunchOptions): void {
  const bin = WIN_BINS.find((w) => w.id === opts.terminalId);
  if (!bin) throw new Error(`Unknown terminal id on Windows: ${opts.terminalId}`);
  const cmd = opts.command.join(' ');
  const cwd = opts.cwd ? `--starting-directory "${opts.cwd}"` : '';
  const child = spawn(bin.exe, [cwd, cmd].filter(Boolean), {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}
