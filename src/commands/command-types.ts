// src/commands/command-types.ts
// The `Command` discriminated union — the parsed shape of every CLI invocation,
// the SSOT both the parser (`parse.ts` / `parse-profile.ts`) and the dispatcher
// (`bin/cli.ts`) depend on. Kept in its own module so the parser can be split
// across files without an import cycle (each sub-parser imports the type from
// here, never from a sibling parser).

import type { McpAddSpec } from './mcp.js';

export type Command =
  | { action: 'switch-interactive' }
  | { action: 'switch-to'; target: string }
  | { action: 'add' }
  | { action: 'list'; json: boolean }
  | { action: 'remove'; email: string | undefined }
  | { action: 'status' }
  | { action: 'help' }
  | { action: 'version' }
  | { action: 'completions'; shell: string | undefined }
  | { action: 'passthrough'; args: string[] }
  | { action: 'alias-set'; name: string; email: string }
  | { action: 'alias-list'; json: boolean }
  | { action: 'alias-remove'; name: string | undefined }
  | { action: 'temporary-switch'; target: string | undefined; args: string[] }
  | { action: 'setup' }
  | { action: 'update' }
  | { action: 'update-target'; target: 'claude' | 'switch' | 'gui'; check: boolean; json: boolean }
  | { action: 'versions'; json: boolean; force: boolean }
  | { action: 'apikey-set'; target: string | undefined }
  | { action: 'apikey-remove'; target: string | undefined }
  | { action: 'apikey-show'; target: string | undefined }
  | { action: 'fallback'; mode: 'on' | 'off' | 'status'; json: boolean }
  | { action: 'fallback-auto'; mode: 'on' | 'off' | 'status'; threshold?: number }
  | { action: 'fallback-auto-engage'; mode: 'on' | 'off' | 'status'; threshold?: number }
  | { action: 'usage'; force: boolean; refreshOnly: boolean; account?: string }
  | { action: 'usage-snapshot'; email: string; json: boolean }
  | { action: 'statusline'; format: 'compact' | 'full' | 'json' | 'embedded'; color: boolean; noCacheHealth: boolean }
  | { action: 'statusline-install'; variant: 'plain' | 'embedded' | 'ccstatusline' }
  | { action: 'statusline-uninstall' }
  | { action: 'statusline-status' }
  | { action: 'skills-list'; json: boolean }
  | { action: 'profile-skills-list'; name: string; json: boolean }
  | { action: 'profile-skills-link'; name: string; skill: string }
  | { action: 'profile-skills-unlink'; name: string; skill: string }
  | { action: 'profile-mcp-list'; name: string; json: boolean }
  | { action: 'profile-mcp-add'; name: string; server: string; spec: McpAddSpec }
  | { action: 'profile-mcp-remove'; name: string; server: string }
  | { action: 'profile-list'; json: boolean; includeDefault: boolean }
  | { action: 'profile-create'; name: string; overlay: boolean }
  | { action: 'profile-use'; name: string; args: string[] }
  | { action: 'profile-login'; name: string }
  | { action: 'profile-remove'; name: string }
  | { action: 'profile-status'; name: string | undefined }
  | { action: 'profile-import'; email: string; profileName?: string; overlay: boolean }
  | { action: 'route-add'; pattern: string | undefined; target: string | undefined }
  | { action: 'route-list'; json: boolean }
  | { action: 'route-remove'; pattern: string | undefined }
  | { action: 'route-test'; cwd: string | undefined; json: boolean }
  | { action: 'dashboard' }
  | { action: 'cache-health'; sessionPath: string | undefined; json: boolean }
  | { action: 'doctor'; json: boolean; fix: boolean }
  | { action: 'sessions'; json: boolean }
  | { action: 'terminals'; json: boolean }
  | { action: 'profile-launch'; name: string; terminal: string };
