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
import { ensureDirSymlink } from './link-dir.js';

/** Sentinel marking a profile as overlay. A file (not a dir) so it never reads
 *  as a profile name and the dir-only `listProfiles` scan ignores it. */
const OVERLAY_MARKER = '.cs-overlay';

/** A global Claude home subdirectory (e.g. 'skills', 'projects'). */
function globalHomeDir(sub: string): string {
  return path.join(os.homedir(), '.claude', sub);
}

/**
 * Symlink `<profileDir>/<sub>` -> `~/.claude/<sub>` (absolute target). The link
 * primitive (ensure-target-exists + idempotent + refuse-clobber) lives in
 * `link-dir.ts`, shared with the per-session work-dir seeder.
 */
function linkGlobalDir(profileDir: string, sub: string): void {
  ensureDirSymlink(path.join(profileDir, sub), globalHomeDir(sub));
}

/**
 * Ensure a profile's data container `<sub>` exists with the CORRECT topology for
 * the profile type, idempotently:
 *   - overlay (as-global): the container is a whole-dir symlink to the global
 *     home (`<globalConfigDir>/<sub>`), so every as-global session shares it;
 *   - classic: the container is a real, isolated directory inside the profile.
 *
 * Shared by the overlay builder and the per-session work-dir seeder so the two
 * never disagree on a container's shape — a raw `mkdir` from the seeder would
 * later make the overlay's symlink throw ("exists and not our symlink"). On an
 * already-correct container both branches are a safe no-op. `globalConfigDir`
 * (normally `~/.claude`) is a parameter so tests isolate it from the real home.
 */
export function ensureProfileContainer(
  canonicalDir: string,
  sub: string,
  globalConfigDir: string,
): void {
  if (fs.existsSync(path.join(canonicalDir, OVERLAY_MARKER))) {
    ensureDirSymlink(path.join(canonicalDir, sub), path.resolve(globalConfigDir, sub));
  } else {
    fs.mkdirSync(path.join(canonicalDir, sub), { recursive: true, mode: 0o700 });
  }
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
