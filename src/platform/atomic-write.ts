// src/atomic-write.ts
// Atomic write helpers. Write to <file>.tmp with a restricted mode, then
// rename into place. The temp file is created restricted from the start so a
// concurrent reader on the same uid can never observe credentials in a
// world-readable file even briefly.
//
// All credential / config files in claude-switch funnel through writeJsonAtomic:
//   - account JSON files (accounts.ts, apikey.ts)
//   - aliases.json (aliases.ts)
//   - .auto-fallback.json (auto-fallback.ts)
//   - .usage-cache.json (usage.ts)
// — keeping the safety pattern in one place avoids drift like the bug
// where aliases.ts shipped without { mode: 0o600 }.
//
// writeFileAtomic is the raw-string core for non-JSON payloads (e.g. the saved
// claude-bin pointer), which are read back verbatim and must not be wrapped in
// JSON quoting.
//
// Symlink safety: the temp file is opened with O_CREAT|O_EXCL on POSIX
// platforms so that a pre-existing symlink at the .tmp path cannot
// redirect the write into an attacker-controlled location. fs.writeFile-
// Sync without the flag silently follows symlinks; we don't.

import fs from 'node:fs';

export function writeFileAtomic(file: string, payload: string, mode = 0o600): void {
  const tmp = `${file}.tmp`;

  if (process.platform === 'win32') {
    // O_EXCL on Windows over node:fs doesn't deny symlink targets the
    // way it does on POSIX (NTFS ACL model is different). Fall back to
    // the simpler writeFileSync path; the 0o700 directory protections
    // around credential dirs are the load-bearing defense there.
    fs.writeFileSync(tmp, payload, { mode });
  } else {
    // O_WRONLY|O_CREAT|O_EXCL refuses if `tmp` already exists, so a
    // symlink planted there can't redirect this write. Any stale .tmp
    // from a crashed previous write is unlinked first so we still make
    // forward progress on retry.
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      // ENOENT (no stale file) is expected; anything else is fatal.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      mode,
    );
    try {
      fs.writeSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
  }

  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, data: unknown, indent = 2): void {
  writeFileAtomic(file, JSON.stringify(data, null, indent), 0o600);
}
