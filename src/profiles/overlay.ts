// src/profiles/overlay.ts
// Overlay ("as-global") profile primitive.
//
// An overlay profile isolates ONLY the identity (its own .credentials.json +
// .claude.json, written later by the login / ensureProfileForAccount flow) and
// SHARES the rest of the global Claude home via whole-dir symlinks:
//   <profile>/skills   -> ~/.claude/skills    (every global skill, zero upkeep)
//   <profile>/projects -> ~/.claude/projects  (transcripts, so history and
//                                              `claude --resume` work in the overlay)
//
// It is the middle ground between routing (everything shared, but two live
// accounts collide on the shared default config dir) and a classic profile
// (fully isolated, but starts empty). The identity/config split limits sharing
// to skills + projects (the credential vault stays per-overlay).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProfile, profilePath } from './profiles.js';

/** Sentinel marking a profile as overlay. A file (not a dir) so it never reads
 *  as a profile name and the dir-only `listProfiles` scan ignores it. */
const OVERLAY_MARKER = '.cs-overlay';

/** A global Claude home subdirectory (e.g. 'skills', 'projects'). */
function globalHomeDir(sub: string): string {
  return path.join(os.homedir(), '.claude', sub);
}

function safeLstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null; // absent -> caller treats as "nothing there"
  }
}

/**
 * Symlink `<profileDir>/<sub>` -> `~/.claude/<sub>`. Ensures the global target
 * exists first (a fresh machine may have no `projects/` yet) so the link is
 * never born broken. Idempotent when our own link is already in place; refuses
 * to clobber a real dir or a foreign symlink.
 */
function linkGlobalDir(profileDir: string, sub: string): void {
  const target = globalHomeDir(sub);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const link = path.join(profileDir, sub);
  const existing = safeLstat(link);
  if (existing) {
    if (existing.isSymbolicLink() && fs.readlinkSync(link) === target) return; // already ours
    throw new Error(`"${sub}" already exists in the profile and is not our symlink.`);
  }
  fs.symlinkSync(target, link, 'dir');
}

/**
 * Create an overlay profile: a fresh profile dir whose `skills/` and
 * `projects/` are whole-dir symlinks to the global `~/.claude`, plus the overlay
 * marker. Credentials are intentionally NOT created here — the login /
 * `ensureProfileForAccount` flow writes the isolated `.credentials.json` +
 * `.claude.json` afterwards. Throws (via `createProfile`) on an invalid name or
 * when the profile already exists.
 */
export function createOverlayProfile(name: string): string {
  const dir = createProfile(name);
  linkGlobalDir(dir, 'skills');
  linkGlobalDir(dir, 'projects');
  fs.writeFileSync(path.join(dir, OVERLAY_MARKER), '', { mode: 0o600 });
  return dir;
}

/** True when the named profile carries the overlay marker. */
export function isOverlayProfile(name: string): boolean {
  try {
    return fs.statSync(path.join(profilePath(name), OVERLAY_MARKER)).isFile();
  } catch {
    return false; // no marker / no profile -> not overlay
  }
}
