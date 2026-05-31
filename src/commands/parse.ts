// src/commands/parse.ts
// Top-level argv → Command parser for the CLI, split out of bin/cli.ts to keep
// that entry (the dispatcher) within the file-size budget. Pure: no I/O, no
// side effects. The `profile` sub-tree lives in parse-profile.ts and the
// `Command` type in command-types.ts (so the split has no import cycle).
// `bin/cli.ts` re-exports `parseCommand` + `Command`, so existing importers
// (tests) keep importing them from '../bin/cli.js' unchanged.

import { ExitError } from '../platform/errors.js';
import { parseProfileCommand } from './parse-profile.js';
import type { Command } from './command-types.js';

export type { Command };

export function parseCommand(args: string[]): Command {
  if (args[0] === '--as') {
    return { action: 'temporary-switch', target: args[1], args: args.slice(2) };
  }

  if (args[0] !== 'switch') {
    return { action: 'passthrough', args };
  }

  const sub = args[1];
  if (!sub) return { action: 'switch-interactive' };

  switch (sub) {
    case 'add': return { action: 'add' };
    case 'list':
    case 'ls': return { action: 'list', json: args.includes('--json') };
    case 'dashboard':
    case 'dash': return { action: 'dashboard' };
    case 'remove':
    case 'rm': return { action: 'remove', email: args[2] };
    case 'status': return { action: 'status' };
    case 'help':
    case '--help':
    case '-h': return { action: 'help' };
    case '--version':
    case '-v': return { action: 'version' };
    case '--completions': return { action: 'completions', shell: args[2] };
    case 'setup': return { action: 'setup' };
    case 'update': {
      // No target → legacy self-update (interactive). Target → new per-target install.
      const t = args[2];
      if (!t || t.startsWith('-')) return { action: 'update' };
      if (t !== 'claude' && t !== 'switch' && t !== 'gui') throw new ExitError('Usage: claude switch update [claude|switch|gui] [--check] [--json]');
      return { action: 'update-target', target: t, check: args.includes('--check'), json: args.includes('--json') };
    }
    case 'versions': return { action: 'versions', json: args.includes('--json'), force: args.includes('--force') };
    case 'apikey': {
      const sub2 = args[2];
      if (sub2 === 'set') return { action: 'apikey-set', target: args[3] };
      if (sub2 === 'remove' || sub2 === 'rm') return { action: 'apikey-remove', target: args[3] };
      if (sub2 === 'show') return { action: 'apikey-show', target: args[3] };
      throw new ExitError('Usage: claude switch apikey <set|remove|show> <alias|email>');
    }
    case 'fallback': {
      const sub2 = args[2];
      const fbJson = args.includes('--json');
      if (!sub2 || sub2 === 'status') return { action: 'fallback', mode: 'status', json: fbJson };
      if (sub2 === 'on') return { action: 'fallback', mode: 'on', json: fbJson };
      if (sub2 === 'off') return { action: 'fallback', mode: 'off', json: fbJson };
      // Sub-tree map. The legacy `auto` alias was retired after v3.4 —
      // `auto-revert` is the only canonical name now.
      const SUBTREE_ACTIONS: Record<string, 'fallback-auto' | 'fallback-auto-engage'> = {
        'auto-revert': 'fallback-auto',
        'auto-engage': 'fallback-auto-engage',
      };
      if (sub2 && sub2 in SUBTREE_ACTIONS) {
        const action = SUBTREE_ACTIONS[sub2]!;
        const sub3 = args[3];
        if (!sub3 || sub3 === 'status') return { action, mode: 'status' };
        if (sub3 === 'off') return { action, mode: 'off' };
        if (sub3 === 'on') {
          const tIdx = args.indexOf('--threshold');
          if (tIdx >= 4 && args[tIdx + 1] !== undefined) {
            const t = parseInt(args[tIdx + 1]!, 10);
            if (!Number.isFinite(t) || t < 1 || t > 100) {
              throw new ExitError('--threshold must be an integer between 1 and 100');
            }
            return { action, mode: 'on', threshold: t };
          }
          return { action, mode: 'on' };
        }
        throw new ExitError(`Usage: claude switch fallback ${sub2} <on|off|status> [--threshold <1-100>]`);
      }
      throw new ExitError('Usage: claude switch fallback <on|off|status|auto-revert|auto-engage>');
    }
    case 'usage': {
      const flags = args.slice(2);
      const force = flags.includes('--force');
      const refreshOnly = flags.includes('--refresh-only');
      const accountFlagIdx = flags.indexOf('--account');
      const account = accountFlagIdx >= 0 ? flags[accountFlagIdx + 1] : undefined;
      return { action: 'usage', force, refreshOnly, account };
    }
    case 'usage-snapshot': {
      const rest = args.slice(2);
      const email = rest.find((a) => !a.startsWith('--')) ?? '';
      if (!email) {
        throw new ExitError('Usage: claude switch usage-snapshot <email> [--json]');
      }
      const json = rest.includes('--json');
      return { action: 'usage-snapshot', email, json };
    }
    case 'statusline':
    case 'sl': {
      const sub2 = args[2];
      if (sub2 === 'install') {
        const variant = args.includes('--ccstatusline')
          ? 'ccstatusline'
          : args.includes('--embedded')
            ? 'embedded'
            : 'plain';
        return { action: 'statusline-install', variant };
      }
      if (sub2 === 'uninstall' || sub2 === 'remove') {
        return { action: 'statusline-uninstall' };
      }
      if (sub2 === 'status') {
        return { action: 'statusline-status' };
      }
      const rest = args.slice(2);
      const fmt = rest.includes('--embedded')
        ? 'embedded'
        : rest.includes('--full')
          ? 'full'
          : rest.includes('--json')
            ? 'json'
            : 'compact';
      // Honour both the CLI flag and the de-facto NO_COLOR env standard
      // (https://no-color.org). Either turning colour off is enough.
      const color = !rest.includes('--no-color') && !process.env.NO_COLOR;
      const noCacheHealth = rest.includes('--no-cache-health');
      return {
        action: 'statusline',
        format: fmt as 'compact' | 'full' | 'json' | 'embedded',
        color,
        noCacheHealth,
      };
    }
    case 'alias': {
      const sub2 = args[2];
      if (!sub2 || sub2 === '--list') {
        return { action: 'alias-list', json: args.includes('--json') };
      }
      if (sub2 === '--remove') {
        if (!args[3]) throw new ExitError('Usage: claude switch alias --remove <name>');
        return { action: 'alias-remove', name: args[3] };
      }
      if (!args[3]) throw new ExitError('Usage: claude switch alias <name> <email>');
      return { action: 'alias-set', name: sub2, email: args[3] };
    }
    case 'skills': {
      const sub2 = args[2];
      if (!sub2 || sub2 === 'list' || sub2 === 'ls') {
        return { action: 'skills-list', json: args.includes('--json') };
      }
      throw new ExitError('Usage: claude switch skills list [--json]');
    }
    case 'profile':
      return parseProfileCommand(args);
    case 'route': {
      const sub2 = args[2];
      if (!sub2 || sub2 === 'list' || sub2 === 'ls') {
        return { action: 'route-list', json: args.includes('--json') };
      }
      if (sub2 === 'add') {
        return { action: 'route-add', pattern: args[3], target: args[4] };
      }
      if (sub2 === 'remove' || sub2 === 'rm') {
        return { action: 'route-remove', pattern: args[3] };
      }
      if (sub2 === 'test') {
        return { action: 'route-test', cwd: args[3], json: args.includes('--json') };
      }
      throw new ExitError('Usage: claude switch route <add|list|remove|test> [args]');
    }
    case 'cache-health': {
      const rest = args.slice(2);
      const json = rest.includes('--json');
      const sessionIdx = rest.indexOf('--session');
      const sessionPath = sessionIdx >= 0 ? rest[sessionIdx + 1] : undefined;
      return { action: 'cache-health', sessionPath, json };
    }
    case 'doctor':
      return { action: 'doctor', json: args.includes('--json'), fix: args.includes('--fix') };
    case 'sessions':
      return { action: 'sessions', json: args.includes('--json') };
    case 'terminals': return { action: 'terminals', json: args.includes('--json') };
    default: return { action: 'switch-to', target: sub };
  }
}
