// src/profiles/overlay.ts
// Overlay ("as-global") profile primitive.
//
// An overlay profile isolates ONLY the identity (its own .credentials.json +
// .claude.json, written later by the login / ensureProfileForAccount flow) and
// SHARES EVERYTHING ELSE with the global Claude home — an overlay is the global
// home with a different identity attached. Each shared data container is a
// whole-dir symlink into `~/.claude/<container>` (skills, projects/transcripts,
// sessions, shell-snapshots, file-history, todos — `PROFILE_DATA_CONTAINERS`),
// so history / `--resume` / skills behave exactly as in the global, and two
// as-global accounts intentionally share one working experience.
//
// It is the middle ground between routing (everything shared, but two live
// accounts collide on the shared default config dir) and a classic profile
// (fully isolated, but starts empty). Only identity + credentials stay
// per-overlay. (settings.json is per-overlay for now; aligning it to the global
// is copy/reconcile work — never a fragile file-symlink.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProfile, profilePath } from './profiles.js';
import { ensureDirSymlink } from './link-dir.js';

/** Sentinel marking a profile as overlay. A file (not a dir) so it never reads
 *  as a profile name and the dir-only `listProfiles` scan ignores it. */
const OVERLAY_MARKER = '.cs-overlay';

/** The data containers a profile holds — shared (overlay → symlinked to the
 *  global) or isolated (classic → real dirs). Single source of truth, also used
 *  by the per-session work-dir seeder. Single-FILE accumulators (history.jsonl)
 *  are NOT here — a file-symlink is clobbered by claude's atomic temp+rename;
 *  they are handled by reconcile. */
export const PROFILE_DATA_CONTAINERS = [
  'skills', 'projects', 'sessions', 'shell-snapshots', 'file-history', 'todos',
] as const;

/**
 * Ensure a profile's data container `<sub>` exists with the CORRECT topology for
 * the profile type, idempotently:
 *   - overlay (as-global): the container is a whole-dir symlink to the global
 *     home (`<globalConfigDir>/<sub>`), so every as-global session shares it;
 *   - classic: the container is a real, isolated directory inside the profile.
 *
 * Shared (via `ensureProfileDataContainers`) by the overlay builder and the
 * per-session work-dir seeder so the two never disagree on a container's shape —
 * a raw `mkdir` from the seeder would later make the overlay's symlink throw
 * ("exists and not our symlink"). On an already-correct container both branches
 * are a safe no-op. `globalConfigDir` (normally `~/.claude`) is a parameter so
 * tests isolate it from the real home.
 */
function ensureProfileContainer(canonicalDir: string, sub: string, globalConfigDir: string): void {
  if (fs.existsSync(path.join(canonicalDir, OVERLAY_MARKER))) {
    ensureDirSymlink(path.join(canonicalDir, sub), path.resolve(globalConfigDir, sub));
  } else {
    fs.mkdirSync(path.join(canonicalDir, sub), { recursive: true, mode: 0o700 });
  }
}

/**
 * Ensure ALL of a profile's data containers exist with the correct topology
 * (idempotent). For a NEW overlay this links the full set to the global; on an
 * EXISTING overlay (e.g. one created before the set was extended, with only
 * skills+projects) it adds the missing links — the on-read migration. Used by
 * `createOverlayProfile` and the per-session work-dir seeder.
 */
export function ensureProfileDataContainers(profileDir: string, globalConfigDir: string): void {
  for (const sub of PROFILE_DATA_CONTAINERS) ensureProfileContainer(profileDir, sub, globalConfigDir);
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
  // Marker FIRST — `ensureProfileContainer` reads it to choose the symlink
  // (overlay) vs real-dir (classic) topology, so it must be present before we
  // link the containers, or they'd be created as isolated real dirs.
  fs.writeFileSync(path.join(dir, OVERLAY_MARKER), '', { mode: 0o600 });
  ensureProfileDataContainers(dir, path.join(os.homedir(), '.claude'));
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
