// src/profiles/link-dir.ts
// Idempotent whole-dir symlink primitive, shared by the overlay profile builder
// (which links a profile's containers up to the global home) and the per-session
// work-dir seeder (which links a session's containers down to its profile). It
// ensures the target dir exists first so the link is never born broken, and
// refuses to clobber a real dir or a foreign symlink (don't destroy user data;
// the same anti-surprise guard the overlay builder always had).

import fs from 'node:fs';

function safeLstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null; // absent → caller treats as "nothing there"
  }
}

/**
 * Symlink `linkPath` → `targetDir` (a directory link). Creates `targetDir`
 * (recursive, mode 0700) first. Idempotent when our own link is already in
 * place; throws rather than clobber a real directory or a symlink that points
 * somewhere else. `targetDir` should be an ABSOLUTE path — a relative target
 * resolves against the link's location and breaks depending on cwd.
 */
export function ensureDirSymlink(linkPath: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const existing = safeLstat(linkPath);
  if (existing) {
    if (existing.isSymbolicLink() && fs.readlinkSync(linkPath) === targetDir) return; // already ours
    throw new Error(
      `Refusing to link "${linkPath}": it already exists and is not our symlink to "${targetDir}".`,
    );
  }
  fs.symlinkSync(targetDir, linkPath, 'dir');
}
