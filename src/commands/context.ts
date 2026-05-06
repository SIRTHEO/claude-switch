// src/commands/context.ts
// Shared shape passed to every per-command handler. Keeps `bin/cli.ts`'s
// dispatcher thin: parse → look up handler → `handle(cmd, ctx)`. Handlers
// own their own multi-step business logic (no more 1400-line god switch).

import type { UpdateInfo } from '../update-check.js';

export interface CommandContext {
  /** Resolved path to `~/.claude.json` (Claude Code's per-user config). */
  claudeJsonPath: string;
  /** Resolved path to `~/.claude/accounts/`. */
  accountsDirPath: string;
  /** Pending update notification — null when no update is available, or
   *  the dispatcher hasn't fetched yet. Some commands (passthrough, dashboard)
   *  surface it; others ignore. */
  updateInfo: UpdateInfo | null;
  /** The url-style path to `bin/cli.ts` itself (for `findClaudeBinary` / setup). */
  selfUrl: string;
}
