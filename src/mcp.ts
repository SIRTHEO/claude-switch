// src/mcp.ts
// MCP server composition for profiles.
//
// A profile's MCP servers live in its `<profile>/.claude.json` under
// `mcpServers` — the same shape Claude Code reads at startup. A profile can
// either COMPOSE a server (copy a definition from the global `~/.claude.json`)
// or DEFINE one inline. Unlike skills (symlinks), an MCP entry is a JSON
// object, so composing copies the definition: a later edit to the global
// definition does NOT propagate. That staleness is surfaced as `globalDrift`
// in the listing rather than silently hidden.
//
// Reads tolerate a missing or corrupt config (→ empty). Writes read the whole
// config and rewrite it atomically so every unrelated key is preserved.

import fs from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import type { McpTransport } from './contract.js';
import { claudeJsonPath } from './paths.js';
import { profilePath } from './profiles.js';

export type { McpTransport };

/** A single `mcpServers` entry. Fields are optional and we tolerate extras we
 *  don't model (Claude Code may carry more). */
export interface McpServerDef {
  type?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface ProfileMcpStatus {
  name: string;
  configured: boolean;
  inGlobal: boolean;
  globalDrift: boolean;
  transport: McpTransport | null;
  detail: string | null;
}

const MCP_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/** Server names are JSON keys, not path components, but a strict charset keeps
 *  them clear of argv/flag edge cases. */
function isValidMcpName(name: string): boolean {
  return MCP_NAME_RE.test(name);
}

function profileJsonPath(name: string): string {
  // profilePath validates the profile name + refuses traversal.
  return path.join(profilePath(name), '.claude.json');
}

function readConfig(jsonPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // missing or corrupt → treat as empty config
  }
}

function mcpServersOf(config: Record<string, unknown>): Record<string, McpServerDef> {
  const m = config.mcpServers;
  return typeof m === 'object' && m !== null ? (m as Record<string, McpServerDef>) : {};
}

function globalMcpServers(): Record<string, McpServerDef> {
  return mcpServersOf(readConfig(claudeJsonPath()));
}

function profileMcpServers(name: string): Record<string, McpServerDef> {
  return mcpServersOf(readConfig(profileJsonPath(name)));
}

function transportOf(def: McpServerDef): McpTransport | null {
  if (def.type === 'stdio' || def.type === 'sse' || def.type === 'http') return def.type;
  if (typeof def.command === 'string') return 'stdio';
  return null;
}

function detailOf(def: McpServerDef): string | null {
  if (typeof def.command === 'string') return def.command;
  if (typeof def.url === 'string') return def.url;
  return null;
}

/** Order-independent structural compare, so a global definition with the same
 *  content but different key order isn't flagged as drift. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** Every MCP server known to the profile: configured, available globally, or
 *  both. Names are the union of profile + global, sorted. */
export function listProfileMcp(name: string): ProfileMcpStatus[] {
  const global = globalMcpServers();
  const profile = profileMcpServers(name);
  const names = [...new Set([...Object.keys(global), ...Object.keys(profile)])].sort();
  return names.map((n) => {
    const profileDef = profile[n];
    const globalDef = global[n];
    const effective = profileDef ?? globalDef;
    return {
      name: n,
      configured: profileDef !== undefined,
      inGlobal: globalDef !== undefined,
      globalDrift:
        profileDef !== undefined &&
        globalDef !== undefined &&
        stableStringify(profileDef) !== stableStringify(globalDef),
      transport: effective ? transportOf(effective) : null,
      detail: effective ? detailOf(effective) : null,
    };
  });
}

/** Rewrite the profile's `.claude.json` with new mcpServers, preserving every
 *  other key. */
function writeProfileMcpServers(name: string, servers: Record<string, McpServerDef>): void {
  const jsonPath = profileJsonPath(name);
  const config = readConfig(jsonPath);
  config.mcpServers = servers;
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeJsonAtomic(jsonPath, config);
}

/** Copy a server's definition from the global config into the profile. */
export function addProfileMcpFromGlobal(name: string, server: string): void {
  if (!isValidMcpName(server)) throw new Error(`Invalid MCP server name "${server}".`);
  const def = globalMcpServers()[server];
  if (!def) {
    throw new Error(
      `MCP server "${server}" is not in the global config (~/.claude.json). ` +
        'Define it inline with "--transport sse|http --url <url>" or "-- <command> [args]".',
    );
  }
  const servers = profileMcpServers(name);
  servers[server] = def;
  writeProfileMcpServers(name, servers);
}

/** Define a server inline in the profile (overwrites any existing entry). */
export function addProfileMcpInline(name: string, server: string, def: McpServerDef): void {
  if (!isValidMcpName(server)) throw new Error(`Invalid MCP server name "${server}".`);
  const servers = profileMcpServers(name);
  servers[server] = def;
  writeProfileMcpServers(name, servers);
}

/** Remove a server from the profile. Throws if it isn't configured. */
export function removeProfileMcp(name: string, server: string): void {
  if (!isValidMcpName(server)) throw new Error(`Invalid MCP server name "${server}".`);
  const servers = profileMcpServers(name);
  if (!(server in servers)) {
    throw new Error(`MCP server "${server}" is not configured in profile "${name}".`);
  }
  delete servers[server];
  writeProfileMcpServers(name, servers);
}
