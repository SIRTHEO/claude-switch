// src/statusline-install.ts
// Install / uninstall the claude-switch account badge into Claude Code's
// own status line, by editing ~/.claude/settings.json.
//
// We never silently overwrite a user's existing statusLine — the caller
// (setup wizard or `claude switch statusline install`) decides what to do
// when something different is already configured. This module just exposes
// pure functions: read the current config, classify it, and write back.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';

/** Path to Claude Code's user-level settings file. */
export function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Direct command: just our badge, no chaining. Simplest, no dependency. */
export const PLAIN_COMMAND = 'claude switch sl --no-color';

/** Embedded: our badge AND the model/cwd/version that ccstatusline used to
 *  provide. Reads CC's per-redraw JSON from stdin internally; no npx, no
 *  dependency, no subshell. This is the recommended default — supersedes
 *  the ccstatusline chain. */
export const EMBEDDED_COMMAND = 'claude switch sl --embedded --no-color';

export const CCSTATUSLINE_VERSION = '2.2.12';

/** Chained with ccstatusline so the user keeps the rest of their bar.
 *  Pinned for deterministic installs; avoid executing registry `latest`
 *  inside Claude Code's frequently-rendered statusline hook. */
export const CCSTATUSLINE_COMMAND =
  `bash -c 'INPUT=$(cat); claude switch sl; echo "$INPUT" | npx -y ccstatusline@${CCSTATUSLINE_VERSION}'`;

type ExistingStatus =
  | { kind: 'absent' }
  | { kind: 'ours-plain' }
  | { kind: 'ours-embedded' }
  | { kind: 'ours-ccstatusline' }
  | { kind: 'foreign'; command: string };

/**
 * Read the current statusLine block from `~/.claude/settings.json` and
 * classify it. Returns 'absent' if the file or block is missing, 'ours-*'
 * if the command is one we ourselves would have written, or 'foreign'
 * with the raw command otherwise.
 */
export function detectExistingStatusLine(settingsPath: string = claudeSettingsPath()): ExistingStatus {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8');
  } catch {
    return { kind: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Settings file is malformed. We don't try to repair it — the user
    // gets to fix or delete it before we touch anything.
    return { kind: 'foreign', command: '<settings.json is not valid JSON>' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'absent' };
  const status = (parsed as Record<string, unknown>).statusLine;
  if (typeof status !== 'object' || status === null) return { kind: 'absent' };
  const command = (status as Record<string, unknown>).command;
  if (typeof command !== 'string') return { kind: 'absent' };

  // Heuristic: a command containing "claude switch sl" is unmistakably ours,
  // since it's the exact subcommand we wrote.
  if (command.includes('claude switch sl')) {
    if (command.includes('ccstatusline')) return { kind: 'ours-ccstatusline' };
    if (command.includes('--embedded')) return { kind: 'ours-embedded' };
    return { kind: 'ours-plain' };
  }
  return { kind: 'foreign', command };
}

/**
 * Write `statusLine.command` to `settingsPath`, preserving every other key
 * in the file. Creates the file (and `~/.claude/`) if they don't exist.
 */
export function installStatusLine(
  command: string,
  settingsPath: string = claudeSettingsPath(),
): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  let settings: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // No file yet, or unreadable — start fresh. We don't preserve a
    // malformed settings.json (the caller has already shown it to the user).
  }
  settings.statusLine = { type: 'command', command };
  writeJsonAtomic(settingsPath, settings);
}

/**
 * Remove the statusLine block we previously installed. If the current
 * statusLine is foreign (not ours), do nothing. Returns true if a
 * removal actually happened.
 */
export function uninstallStatusLine(settingsPath: string = claudeSettingsPath()): boolean {
  const status = detectExistingStatusLine(settingsPath);
  if (
    status.kind !== 'ours-plain' &&
    status.kind !== 'ours-embedded' &&
    status.kind !== 'ours-ccstatusline'
  ) {
    return false;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  delete settings.statusLine;
  writeJsonAtomic(settingsPath, settings);
  return true;
}
