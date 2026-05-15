import { platform } from 'node:os';

export interface SavedHome {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
}

/**
 * Set fake home dir for tests. Works on darwin, linux, AND Windows.
 * `os.homedir()` reads HOME on POSIX, USERPROFILE on Windows.
 */
export function setFakeHome(dir: string): SavedHome {
  const saved: SavedHome = {
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
  };
  process.env['HOME'] = dir;
  if (platform() === 'win32') {
    process.env['USERPROFILE'] = dir;
  }
  return saved;
}

/** Restore original HOME / USERPROFILE env vars. */
export function restoreFakeHome(saved: SavedHome): void {
  if (saved.HOME === undefined) delete process.env['HOME'];
  else process.env['HOME'] = saved.HOME;
  if (platform() === 'win32') {
    if (saved.USERPROFILE === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = saved.USERPROFILE;
  }
}
