#!/usr/bin/env node
// claude-switch — Claude Code multi-account wrapper

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkPendingRestore } from '../src/switcher.js';
import { claudeJsonPath, accountsDir } from '../src/paths.js';
import { VERSION } from '../src/version.js';
import { ExitError } from '../src/errors.js';
import { checkForUpdate, performUpdate } from '../src/update-check.js';
import { runApp } from '../src/ui/run-app.js';
import { handleHelp } from '../src/commands/help.js';
import { handleVersion } from '../src/commands/version.js';
import { handleCompletions } from '../src/commands/completions.js';
import { handleList } from '../src/commands/list.js';
import { handleStatus } from '../src/commands/status.js';
import { handleAliasSet, handleAliasList, handleAliasRemove } from '../src/commands/alias.js';
import { handleApikeySet, handleApikeyShow, handleApikeyRemove } from '../src/commands/apikey.js';
import { migrateApiKeysToKeychain } from '../src/apikey.js';
import { handleFallback, handleFallbackAuto, handleFallbackAutoEngage } from '../src/commands/fallback.js';
import { handleUsage } from '../src/commands/usage.js';
import { handleUsageSnapshot } from '../src/commands/usage-snapshot.js';
import { handleAdd, handleRemove } from '../src/commands/account.js';
import { handleSetup } from '../src/commands/setup.js';
import { handleUpdate } from '../src/commands/update.js';
import { handleTemporarySwitch } from '../src/commands/temporary-switch.js';
import { handleSwitchInteractive, handleSwitchTo } from '../src/commands/switch.js';
import {
  handleStatusline,
  handleStatuslineInstall,
  handleStatuslineUninstall,
  handleStatuslineStatus,
} from '../src/commands/statusline.js';
import {
  handleProfileList,
  handleProfileCreate,
  handleProfileStatus,
  handleProfileLogin,
  handleProfileUse,
  handleProfileImport,
  handleProfileRemove,
} from '../src/commands/profile.js';
import {
  handleRouteAdd,
  handleRouteList,
  handleRouteRemove,
  handleRouteTest,
} from '../src/commands/route.js';
import { handlePassthrough } from '../src/commands/passthrough.js';
import { handleCacheHealth } from '../src/commands/cache-health.js';
import { askYN } from '../src/commands/_helpers.js';
import type { CommandContext } from '../src/commands/context.js';

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
  | { action: 'apikey-set'; target: string | undefined }
  | { action: 'apikey-remove'; target: string | undefined }
  | { action: 'apikey-show'; target: string | undefined }
  | { action: 'fallback'; mode: 'on' | 'off' | 'status'; json: boolean }
  | { action: 'fallback-auto'; mode: 'on' | 'off' | 'status'; threshold?: number }
  | { action: 'fallback-auto-engage'; mode: 'on' | 'off' | 'status'; threshold?: number }
  | { action: 'usage'; force: boolean; refreshOnly: boolean }
  | { action: 'usage-snapshot'; email: string; json: boolean }
  | { action: 'statusline'; format: 'compact' | 'full' | 'json' | 'embedded'; color: boolean; noCacheHealth: boolean }
  | { action: 'statusline-install'; variant: 'plain' | 'embedded' | 'ccstatusline' }
  | { action: 'statusline-uninstall' }
  | { action: 'statusline-status' }
  | { action: 'profile-list'; json: boolean }
  | { action: 'profile-create'; name: string }
  | { action: 'profile-use'; name: string; args: string[] }
  | { action: 'profile-login'; name: string }
  | { action: 'profile-remove'; name: string }
  | { action: 'profile-status'; name: string | undefined }
  | { action: 'profile-import'; email: string; profileName?: string }
  | { action: 'route-add'; pattern: string | undefined; target: string | undefined }
  | { action: 'route-list'; json: boolean }
  | { action: 'route-remove'; pattern: string | undefined }
  | { action: 'route-test'; cwd: string | undefined; json: boolean }
  | { action: 'dashboard' }
  | { action: 'cache-health'; sessionPath: string | undefined; json: boolean };

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
    case 'update': return { action: 'update' };
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
      return { action: 'usage', force, refreshOnly };
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
    case 'profile': {
      const sub2 = args[2];
      if (!sub2 || sub2 === 'list' || sub2 === 'ls') {
        return { action: 'profile-list', json: args.includes('--json') };
      }
      if (sub2 === 'create') {
        if (!args[3]) throw new ExitError('Usage: claude switch profile create <name>');
        return { action: 'profile-create', name: args[3] };
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
      if (sub2 === 'import' || sub2 === 'import-from-account') {
        if (!args[3]) throw new ExitError('Usage: claude switch profile import <email> [--as <profile-name>]');
        const asIdx = args.indexOf('--as');
        const profileName = asIdx >= 4 && args[asIdx + 1] ? args[asIdx + 1] : undefined;
        return { action: 'profile-import', email: args[3], profileName };
      }
      throw new ExitError('Usage: claude switch profile <list|create|use|login|import|remove|status> [name]');
    }
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
    default: return { action: 'switch-to', target: sub };
  }
}

// `_findClaude`, `promptSecret`, `resolveTargetEmail`, and `askYN` moved to
// src/commands/_helpers.ts so per-command handlers can share them without
// dragging cli.ts as a dependency. cli.ts imports `askYN` directly from there.

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = parseCommand(args);
  const cJson = claudeJsonPath();
  const aDir = accountsDir();

  // Statusline is called on every Claude Code redraw — return as fast as
  // possible. Skip every check that touches the filesystem beyond what we
  // strictly need.
  const statuslineCtx: CommandContext = {
    claudeJsonPath: cJson,
    accountsDirPath: aDir,
    updateInfo: null,
    selfUrl: import.meta.url,
  };
  if (cmd.action === 'statusline') {
    handleStatusline(statuslineCtx, { format: cmd.format, color: cmd.color, noCacheHealth: cmd.noCacheHealth });
    return;
  }
  if (cmd.action === 'statusline-install') {
    await handleStatuslineInstall(cmd.variant);
    return;
  }
  if (cmd.action === 'statusline-uninstall') {
    await handleStatuslineUninstall();
    return;
  }
  if (cmd.action === 'statusline-status') {
    await handleStatuslineStatus();
    return;
  }

  // One-shot migration of legacy plaintext API keys into the macOS
  // Keychain. Idempotent and silent — runs on every non-statusline
  // invocation but is essentially free once everything is migrated
  // (just reads each Keychain entry name to confirm it exists). Skipped
  // on non-macOS automatically by `migrateApiKeysToKeychain`.
  migrateApiKeysToKeychain(aDir);

  // Profile subcommands — isolated per-terminal claude sessions via
  // CLAUDE_CONFIG_DIR. Early-return so they skip the update-check / pending
  // -restore preludes; profile flows manage their own spawn lifecycle.
  if (cmd.action === 'profile-list')   { await handleProfileList({ json: cmd.json }); return; }
  if (cmd.action === 'profile-create') { await handleProfileCreate(cmd.name); return; }
  if (cmd.action === 'profile-status') { await handleProfileStatus(cmd.name); return; }
  if (cmd.action === 'profile-login')  { await handleProfileLogin(statuslineCtx, cmd.name); return; }
  if (cmd.action === 'profile-use')    { await handleProfileUse(statuslineCtx, cmd.name, cmd.args); /* never returns */ }
  if (cmd.action === 'profile-import') { await handleProfileImport(statuslineCtx, cmd.email, cmd.profileName); return; }
  if (cmd.action === 'profile-remove') { await handleProfileRemove(cmd.name); return; }

  // Route subcommands — manage the per-machine global routing rules
  // (`<accountsDirPath>/.routing.json`). Read-only `list` + `test` are
  // safe to run anywhere; `add` and `remove` mutate the file under the
  // accounts-dir lock. Early-return so we skip the update prompt.
  if (cmd.action === 'route-list')   { handleRouteList(statuslineCtx, { json: cmd.json }); return; }
  if (cmd.action === 'route-add')    { handleRouteAdd(statuslineCtx, cmd.pattern, cmd.target); return; }
  if (cmd.action === 'route-remove') { handleRouteRemove(statuslineCtx, cmd.pattern); return; }
  if (cmd.action === 'route-test')   { handleRouteTest(statuslineCtx, cmd.cwd, { json: cmd.json }); return; }

  // Check for update (reads cache synchronously — never blocks). Passthrough
  // is included so long Claude sessions can show a hint, but updates are
  // explicit: this tool handles credentials, so it must never install code in
  // the background while the user is trying to work.
  const updateInfo = cmd.action !== 'temporary-switch'
    ? checkForUpdate(VERSION)
    : null;

  if (updateInfo && cmd.action !== 'update' && cmd.action !== 'passthrough') {
    const isTTY = process.stdin.isTTY && process.stderr.isTTY;
    if (isTTY) {
      // Interactive terminal: offer to update now.
      process.stderr.write(
        `\n  Update available: ${VERSION} → ${updateInfo.latestVersion}\n`
      );
      const answer = await askYN('  Update now? [y/N] ');
      if (answer) {
        const ok = performUpdate();
        if (ok) {
          console.log(`\nUpdated to v${updateInfo.latestVersion}. Open a new terminal to use the new version.`);
          process.exit(0);
        } else {
          console.error('\nUpdate failed. Run manually:');
          console.error(`  ${updateInfo.installCommand}`);
        }
      } else {
        process.stderr.write(`  Run: ${updateInfo.installCommand}\n\n`);
      }
    } else {
      // Non-interactive (piped/scripted): just print the hint to stderr.
      process.stderr.write(
        `\n  Update available: ${VERSION} → ${updateInfo.latestVersion}\n` +
        `  Run: ${updateInfo.installCommand}\n\n`
      );
    }
  }

  // Recover from a previously interrupted --as session before any switch operation.
  // This must run at the top of the dispatch so that switch-to and switch-interactive
  // also benefit, not just passthrough commands.
  if (cmd.action === 'switch-interactive' || cmd.action === 'switch-to' || cmd.action === 'temporary-switch') {
    const recovered = checkPendingRestore(cJson, aDir);
    if (recovered) {
      console.log(`Restored account: ${recovered} (from interrupted --as)\n`);
    }
  }

  // Shared context for the per-command handlers extracted under
  // `src/commands/`. Keeps the dispatcher thin: parse → handler.
  const ctx: CommandContext = {
    claudeJsonPath: cJson,
    accountsDirPath: aDir,
    updateInfo,
    selfUrl: import.meta.url,
  };

  switch (cmd.action) {
    case 'switch-interactive':
      await handleSwitchInteractive(ctx);
      break;

    case 'switch-to':
      await handleSwitchTo(ctx, cmd.target);
      break;

    case 'add':
      await handleAdd(ctx);
      break;

    case 'dashboard':
      // Alias for the persistent menu — same screen.
      await runApp(cJson, aDir);
      break;

    case 'list':
      handleList(ctx, { json: cmd.json });
      break;

    case 'alias-set':
      handleAliasSet(ctx, cmd.name, cmd.email);
      break;

    case 'alias-list':
      handleAliasList(ctx, { json: cmd.json });
      break;

    case 'alias-remove':
      handleAliasRemove(ctx, cmd.name);
      break;

    case 'remove':
      await handleRemove(ctx, cmd.email);
      break;

    case 'status':
      handleStatus(ctx);
      break;

    case 'apikey-set':
      await handleApikeySet(ctx, cmd.target);
      break;

    case 'apikey-show':
      handleApikeyShow(ctx, cmd.target);
      break;

    case 'apikey-remove':
      handleApikeyRemove(ctx, cmd.target);
      break;

    case 'fallback':
      handleFallback(ctx, cmd.mode, { json: cmd.json });
      break;

    case 'fallback-auto':
      handleFallbackAuto(ctx, cmd.mode, cmd.threshold);
      break;

    case 'fallback-auto-engage':
      handleFallbackAutoEngage(ctx, cmd.mode, cmd.threshold);
      break;

    case 'usage':
      await handleUsage(ctx, { force: cmd.force, refreshOnly: cmd.refreshOnly });
      break;
    case 'usage-snapshot':
      await handleUsageSnapshot(ctx, { email: cmd.email, json: cmd.json });
      break;

    case 'completions':
      handleCompletions(cmd.shell);
      break;

    case 'version':
      handleVersion();
      break;

    case 'help':
      handleHelp();
      break;

    case 'temporary-switch':
      await handleTemporarySwitch(ctx, cmd.target, cmd.args);
      break;

    case 'setup':
      await handleSetup(ctx);
      break;

    case 'update':
      await handleUpdate();
      break;

    case 'cache-health':
      handleCacheHealth({ sessionPath: cmd.sessionPath, json: cmd.json });
      break;

    case 'passthrough':
      await handlePassthrough(ctx, cmd.args);
      break;
  }
}

const selfUrl = fileURLToPath(import.meta.url);
const invoked = process.argv[1];
if (invoked) {
  try {
    if (fs.realpathSync(invoked) === fs.realpathSync(selfUrl)) {
      main().catch(handleError);
    }
  } catch {
    // If realpathSync fails, we're likely being imported for testing
  }
}

function handleError(e: unknown): void {
  if (e instanceof ExitError) {
    if (e.message) console.error(e.message);
    process.exit(e.code);
  }
  // Anything else is an unexpected internal error. Print the message
  // without the raw stack trace — stack frames leak install paths and
  // sometimes credential-adjacent state on stderr. Set CLAUDE_SWITCH_DEBUG=1
  // to opt back into the full trace for bug reports.
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Internal error: ${msg}`);
  if (process.env.CLAUDE_SWITCH_DEBUG === '1' && e instanceof Error && e.stack) {
    console.error(e.stack);
  } else {
    console.error('Set CLAUDE_SWITCH_DEBUG=1 to see the stack trace.');
  }
  process.exit(1);
}
