// src/commands/mcp-parse.ts
// Parser for the `claude switch profile mcp add <profile> <server> …` tail,
// split out of bin/cli.ts to keep the command dispatcher within the size
// budget. Pure arg→spec translation; the dispatcher calls it and hands the
// result to handleProfileMcpAdd.

import { ExitError } from '../platform/errors.js';
import type { McpAddSpec } from './mcp.js';

/**
 * Parse the tail of `profile mcp add <profile> <server> …`.
 *
 * Forms:
 *   (empty)                                    → compose from the global config
 *   --transport sse|http --url <url> [--header K:V]…
 *   [--env K=V]… -- <command> [args]…          → stdio
 *
 * The literal `--` separates the stdio command + args from preceding flags.
 */
export function parseMcpAddSpec(rest: string[]): McpAddSpec {
  const sepIdx = rest.indexOf('--');
  const flags = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
  const afterSep = sepIdx === -1 ? [] : rest.slice(sepIdx + 1);

  const spec: McpAddSpec = {};
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--transport') {
      const v = flags[++i];
      if (v !== 'sse' && v !== 'http') {
        throw new ExitError('--transport must be sse or http (stdio is the "-- <command>" form).');
      }
      spec.transport = v;
    } else if (flag === '--url') {
      spec.url = flags[++i];
      if (!spec.url) throw new ExitError('--url needs a value.');
    } else if (flag === '--env') {
      const kv = flags[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new ExitError(`--env expects KEY=VALUE, got "${kv}".`);
      const key = kv.slice(0, eq);
      if (key in env) throw new ExitError(`Duplicate --env key "${key}".`);
      env[key] = kv.slice(eq + 1);
    } else if (flag === '--header') {
      const kv = flags[++i] ?? '';
      const colon = kv.indexOf(':');
      if (colon <= 0) throw new ExitError(`--header expects KEY:VALUE, got "${kv}".`);
      const key = kv.slice(0, colon);
      if (key in headers) throw new ExitError(`Duplicate --header key "${key}".`);
      headers[key] = kv.slice(colon + 1).trim();
    } else {
      throw new ExitError(`Unknown flag "${flag}" for profile mcp add.`);
    }
  }

  if (Object.keys(env).length > 0) spec.env = env;
  if (Object.keys(headers).length > 0) spec.headers = headers;
  if (afterSep.length > 0) {
    spec.command = afterSep[0];
    spec.args = afterSep.slice(1);
  }

  // Validate the combination so a half-specified server can't be written.
  if (sepIdx !== -1 && afterSep.length === 0) {
    throw new ExitError('Expected a command after "--" for a stdio MCP server.');
  }
  if (spec.command != null && (spec.transport != null || spec.url != null)) {
    throw new ExitError('Cannot combine a "-- <command>" (stdio) with --transport/--url (remote).');
  }
  if ((spec.transport != null) !== (spec.url != null)) {
    throw new ExitError('A remote MCP server needs both --transport and --url.');
  }
  if (spec.headers && spec.url == null) {
    throw new ExitError('--header only applies to a remote (--url) MCP server.');
  }
  if (spec.env && spec.command == null) {
    throw new ExitError('--env only applies to a stdio (-- <command>) MCP server.');
  }

  return spec;
}
