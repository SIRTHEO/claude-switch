// src/atomic-write.ts
// Atomic JSON write helper. Writes to <file>.tmp with mode 0600, then
// renames into place. The temp file is created restricted from the start
// so a concurrent reader on the same uid can never observe credentials
// in a world-readable file even briefly.
//
// All credential / config files in claude-switch funnel through this:
//   - account JSON files (accounts.ts, apikey.ts)
//   - aliases.json (aliases.ts)
//   - .auto-fallback.json (auto-fallback.ts)
//   - .usage-cache.json (usage.ts)
// — keeping the safety pattern in one place avoids drift like the bug
// where aliases.ts shipped without { mode: 0o600 }.

import fs from 'node:fs';

export function writeJsonAtomic(file: string, data: unknown, indent = 2): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent), { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(tmp, 0o600);
  }
  fs.renameSync(tmp, file);
}
