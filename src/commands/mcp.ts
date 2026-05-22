// src/commands/mcp.ts
// `claude switch profile mcp …` — curate which MCP servers a profile runs.
// `list` (+ `--json` for the GUI contract), `add` (compose from the global
// config, or define inline), `remove`. MCP children inherit
// `CLAUDE_CONFIG_DIR` from the spawned `claude`, so a profile's servers are
// isolated automatically (see profiles-mcp-inheritance design note).

import type { McpTransport, ProfileMcpEntry } from '../contract.js';
import { ExitError } from '../errors.js';
import type { McpServerDef } from '../mcp.js';

interface JsonOpt {
  json: boolean;
}

/** Parsed `add` flags. Empty (all undefined) → compose from the global config. */
export interface McpAddSpec {
  transport?: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

async function requireProfile(profileName: string): Promise<void> {
  const { profileExists } = await import('../profiles.js');
  if (!profileExists(profileName)) {
    throw new ExitError(`Profile "${profileName}" does not exist.`);
  }
}

export async function handleProfileMcpList(
  profileName: string,
  opts: JsonOpt = { json: false },
): Promise<void> {
  await requireProfile(profileName);
  const { listProfileMcp } = await import('../mcp.js');
  const entries = listProfileMcp(profileName);

  if (opts.json) {
    const payload: ProfileMcpEntry[] = entries.map((e) => ({
      name: e.name,
      configured: e.configured,
      inGlobal: e.inGlobal,
      globalDrift: e.globalDrift,
      transport: e.transport,
      detail: e.detail,
    }));
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  const configured = entries.filter((e) => e.configured);
  console.log(`MCP servers configured in profile "${profileName}":\n`);
  if (configured.length === 0) {
    console.log('  (none)');
  } else {
    for (const e of configured) {
      const drift = e.globalDrift ? ' — differs from global' : '';
      const detail = e.detail ? ` (${e.detail})` : '';
      console.log(`  ${e.name.padEnd(24)}${e.transport ?? '?'}${detail}${drift}`);
    }
  }
  const available = entries.filter((e) => !e.configured && e.inGlobal);
  if (available.length > 0) {
    console.log(
      `\nAvailable to compose from global (${available.length}): ${available
        .map((e) => e.name)
        .join(', ')}`,
    );
  }
}

/** Turn the parsed flags into an `mcpServers` entry. */
function buildDef(spec: McpAddSpec): McpServerDef {
  if (spec.command != null) {
    return {
      type: 'stdio',
      command: spec.command,
      ...(spec.args && spec.args.length > 0 ? { args: spec.args } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    };
  }
  // Remote transport.
  return {
    type: spec.transport === 'http' ? 'http' : 'sse',
    url: spec.url as string,
    ...(spec.headers ? { headers: spec.headers } : {}),
  };
}

export async function handleProfileMcpAdd(
  profileName: string,
  server: string,
  spec: McpAddSpec,
): Promise<void> {
  await requireProfile(profileName);
  const { addProfileMcpFromGlobal, addProfileMcpInline } = await import('../mcp.js');

  const inline = spec.command != null || spec.url != null || spec.transport != null;
  if (inline) {
    addProfileMcpInline(profileName, server, buildDef(spec));
    console.log(`Added MCP server "${server}" to profile "${profileName}".`);
    return;
  }
  addProfileMcpFromGlobal(profileName, server);
  console.log(`Composed MCP server "${server}" into profile "${profileName}" from the global config.`);
}

export async function handleProfileMcpRemove(
  profileName: string,
  server: string,
): Promise<void> {
  await requireProfile(profileName);
  const { removeProfileMcp } = await import('../mcp.js');
  removeProfileMcp(profileName, server);
  console.log(`Removed MCP server "${server}" from profile "${profileName}".`);
}
