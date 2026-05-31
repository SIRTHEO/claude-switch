// src/commands/parse-profile.ts
// Parser for the `claude switch profile …` sub-tree, split out of parse.ts to
// keep both files within the size budget. Pure arg→Command translation; the
// top-level parser delegates the whole `profile` case here.

import { ExitError } from '../platform/errors.js';
import { parseMcpAddSpec } from './mcp-parse.js';
import type { Command } from './command-types.js';

/** Parse `claude switch profile <…>` (args = the full argv incl. `switch`). */
export function parseProfileCommand(args: string[]): Command {
  const sub2 = args[2];
  if (sub2 === 'skills') {
    const action3 = args[3];
    const profileName = args[4];
    if (!action3 || action3 === 'list' || action3 === 'ls') {
      if (!profileName) {
        throw new ExitError('Usage: claude switch profile skills list <profile> [--json]');
      }
      return { action: 'profile-skills-list', name: profileName, json: args.includes('--json') };
    }
    if (action3 === 'link') {
      if (!profileName || !args[5]) {
        throw new ExitError('Usage: claude switch profile skills link <profile> <skill>');
      }
      return { action: 'profile-skills-link', name: profileName, skill: args[5] };
    }
    if (action3 === 'unlink') {
      if (!profileName || !args[5]) {
        throw new ExitError('Usage: claude switch profile skills unlink <profile> <skill>');
      }
      return { action: 'profile-skills-unlink', name: profileName, skill: args[5] };
    }
    throw new ExitError('Usage: claude switch profile skills <list|link|unlink> <profile> [skill]');
  }
  if (sub2 === 'mcp') {
    const action3 = args[3];
    const profileName = args[4];
    if (!action3 || action3 === 'list' || action3 === 'ls') {
      if (!profileName) {
        throw new ExitError('Usage: claude switch profile mcp list <profile> [--json]');
      }
      return { action: 'profile-mcp-list', name: profileName, json: args.includes('--json') };
    }
    if (action3 === 'add') {
      const server = args[5];
      if (!profileName || !server) {
        throw new ExitError(
          'Usage: claude switch profile mcp add <profile> <server> ' +
            '[--transport sse|http --url <url> [--header K:V]… | [--env K=V]… -- <command> [args]…]',
        );
      }
      return {
        action: 'profile-mcp-add',
        name: profileName,
        server,
        spec: parseMcpAddSpec(args.slice(6)),
      };
    }
    if (action3 === 'remove' || action3 === 'rm') {
      if (!profileName || !args[5]) {
        throw new ExitError('Usage: claude switch profile mcp remove <profile> <server>');
      }
      return { action: 'profile-mcp-remove', name: profileName, server: args[5] };
    }
    throw new ExitError('Usage: claude switch profile mcp <list|add|remove> <profile> [server]');
  }
  if (!sub2 || sub2 === 'list' || sub2 === 'ls') {
    return { action: 'profile-list', json: args.includes('--json'), includeDefault: args.includes('--include-default') };
  }
  if (sub2 === 'create') {
    const createName = args[3];
    if (!createName || createName.startsWith('--')) {
      throw new ExitError('Usage: claude switch profile create <name> [--as-global]');
    }
    // --as-global (alias --overlay): overlay profile — isolate only the
    // identity, share global skills + session history via symlink.
    const overlay = args.includes('--as-global') || args.includes('--overlay');
    return { action: 'profile-create', name: createName, overlay };
  }
  if (sub2 === 'use') {
    if (!args[3]) throw new ExitError('Usage: claude switch profile use <name> [extra claude args]');
    return { action: 'profile-use', name: args[3], args: args.slice(4) };
  }
  if (sub2 === 'login') {
    if (!args[3]) throw new ExitError('Usage: claude switch profile login <name>');
    return { action: 'profile-login', name: args[3] };
  }
  if (sub2 === 'remove' || sub2 === 'rm') {
    if (!args[3]) throw new ExitError('Usage: claude switch profile remove <name>');
    return { action: 'profile-remove', name: args[3] };
  }
  if (sub2 === 'status') return { action: 'profile-status', name: args[3] };
  if (sub2 === 'launch') {
    if (!args[3]) throw new ExitError('Usage: claude switch profile launch <name> --terminal <id>');
    const terminalIdx = args.indexOf('--terminal');
    const terminal = terminalIdx >= 4 ? args[terminalIdx + 1] : undefined;
    if (!terminal) {
      throw new ExitError('Usage: claude switch profile launch <name> --terminal <id>');
    }
    return { action: 'profile-launch', name: args[3], terminal };
  }
  if (sub2 === 'import' || sub2 === 'import-from-account') {
    if (!args[3]) throw new ExitError('Usage: claude switch profile import <email> [--as <profile-name>] [--as-global]');
    const asIdx = args.indexOf('--as');
    const asVal = asIdx >= 4 ? args[asIdx + 1] : undefined;
    const profileName = asVal && !asVal.startsWith('--') ? asVal : undefined;
    // --as-global (alias --overlay): import the account INTO an overlay
    // profile (shared global skills + sessions, isolated identity).
    const overlay = args.includes('--as-global') || args.includes('--overlay');
    return { action: 'profile-import', email: args[3], profileName, overlay };
  }
  throw new ExitError('Usage: claude switch profile <list|create|use|login|launch|import|remove|status> [name]');
}
