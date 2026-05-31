#!/usr/bin/env node
// claude-switch — Claude Code multi-account wrapper

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkPendingRestore } from '../src/switching/switcher.js';
import { claudeJsonPath, accountsDir } from '../src/platform/paths.js';
import { VERSION } from '../src/setup/version.js';
import { ExitError } from '../src/platform/errors.js';
import { checkForUpdate, performUpdate, formatUpdateNotice } from '../src/setup/update-check.js';
import { runApp } from '../src/ui/run-app.js';
import { handleHelp } from '../src/commands/help.js';
import { handleVersion } from '../src/commands/version.js';
import { handleCompletions } from '../src/commands/completions.js';
import { handleList } from '../src/commands/list.js';
import { handleProfileMcpAdd, handleProfileMcpList, handleProfileMcpRemove } from '../src/commands/mcp.js';
import { parseCommand, type Command } from '../src/commands/parse.js';
import { handleProfileSkillsLink, handleProfileSkillsList, handleProfileSkillsUnlink, handleSkillsList } from '../src/commands/skills.js';
import { handleStatus } from '../src/commands/status.js';
import { handleAliasSet, handleAliasList, handleAliasRemove } from '../src/commands/alias.js';
import { handleApikeySet, handleApikeyShow, handleApikeyRemove } from '../src/commands/apikey.js';
import { migrateApiKeysToKeychain } from '../src/credentials/apikey.js';
import { handleFallback, handleFallbackAuto, handleFallbackAutoEngage } from '../src/commands/fallback.js';
import { handleUsage } from '../src/commands/usage.js';
import { handleUsageSnapshot } from '../src/commands/usage-snapshot.js';
import { handleAdd, handleRemove } from '../src/commands/account.js';
import { handleSetup } from '../src/commands/setup.js';
import { handleUpdate } from '../src/commands/update.js';
import { handleUpdateTarget } from '../src/commands/update-target.js';
import { handleVersions } from '../src/commands/versions.js';
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
  handleProfileLaunch,
  handleProfileImport,
  handleProfileRemove,
} from '../src/commands/profile.js';
import { handleRouteAdd, handleRouteList, handleRouteRemove, handleRouteTest } from '../src/commands/route.js';
import { handlePassthrough } from '../src/commands/passthrough.js';
import { handleCacheHealth } from '../src/commands/cache-health.js';
import { handleDoctor } from '../src/commands/doctor.js';
import { handleSessions } from '../src/commands/sessions.js';
import { askYN } from '../src/commands/_helpers.js';
import type { CommandContext } from '../src/commands/context.js';

// `Command` + `parseCommand` live in src/commands/parse.ts (keeps this entry
// thin); re-exported here so importers (tests) keep using '../bin/cli.js'.
export { parseCommand };
export type { Command };

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

  // macOS file-vault (v4.0.0): drain Claude Code's Keychain OAuth item into the file
  // vault, then delete it, so Claude Code reads our file and subsequent swaps
  // touch only files (zero dialogs). Idempotent — a no-op cheap probe when no
  // item exists (the steady state). Runs after the statusline early-return
  // above so the high-frequency redraw never pays a `security` spawn, and is
  // self-gated off-darwin / under the disable + no-prompt flags.
  const { reconcileClaudeCodeKeychain } = await import('../src/credentials/keychain-reconcile.js');
  reconcileClaudeCodeKeychain();
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

  // One-shot migration of legacy plaintext API keys into the active
  // credential vault (the cross-platform file vault by default; the macOS
  // Keychain only under CLAUDE_SWITCH_USE_KEYCHAIN=1). Idempotent and silent —
  // runs on every non-statusline invocation on every platform, but is
  // essentially free once everything is migrated (it just confirms each key
  // already exists in the vault). The legacy `_apiKey` field is left in place
  // as a fallback, so a missed write self-heals on the next run.
  migrateApiKeysToKeychain(aDir);

  // Profile subcommands — isolated per-terminal claude sessions via
  // CLAUDE_CONFIG_DIR. Early-return so they skip the update-check / pending
  // -restore preludes; profile flows manage their own spawn lifecycle.
  if (cmd.action === 'skills-list')    { await handleSkillsList({ json: cmd.json }); return; }
  if (cmd.action === 'profile-skills-list')   { await handleProfileSkillsList(cmd.name, { json: cmd.json }); return; }
  if (cmd.action === 'profile-skills-link')   { await handleProfileSkillsLink(cmd.name, cmd.skill); return; }
  if (cmd.action === 'profile-skills-unlink') { await handleProfileSkillsUnlink(cmd.name, cmd.skill); return; }
  if (cmd.action === 'profile-mcp-list')   { await handleProfileMcpList(cmd.name, { json: cmd.json }); return; }
  if (cmd.action === 'profile-mcp-add')    { await handleProfileMcpAdd(cmd.name, cmd.server, cmd.spec); return; }
  if (cmd.action === 'profile-mcp-remove') { await handleProfileMcpRemove(cmd.name, cmd.server); return; }
  if (cmd.action === 'profile-list')   { await handleProfileList({ json: cmd.json, includeDefault: cmd.includeDefault }, statuslineCtx); return; }
  if (cmd.action === 'profile-create') { await handleProfileCreate(cmd.name, { overlay: cmd.overlay }); return; }
  if (cmd.action === 'profile-status') { await handleProfileStatus(cmd.name); return; }
  if (cmd.action === 'profile-login')  { await handleProfileLogin(statuslineCtx, cmd.name); return; }
  if (cmd.action === 'profile-use')    { await handleProfileUse(statuslineCtx, cmd.name, cmd.args); /* never returns */ }
  if (cmd.action === 'profile-launch') { await handleProfileLaunch(statuslineCtx, cmd.name, cmd.terminal); return; }
  if (cmd.action === 'terminals') {
    const { handleTerminals } = await import('../src/commands/terminals.js');
    handleTerminals({ json: cmd.json });
    return;
  }
  if (cmd.action === 'profile-import') { await handleProfileImport(statuslineCtx, cmd.email, cmd.profileName, cmd.overlay); return; }
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
      // Interactive terminal: surface the notice (loud for a critical/security
      // update, quiet otherwise) and offer to update now.
      process.stderr.write('\n' + formatUpdateNotice(updateInfo, VERSION, { color: true }));
      // Default-N even for critical (the banner carries the urgency) — never
      // auto-install on Enter for a credential tool.
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
      // Non-interactive (piped/scripted): print the hint to stderr, no colour.
      process.stderr.write('\n' + formatUpdateNotice(updateInfo, VERSION, { color: false }) + '\n');
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
      await handleUsage(ctx, {
        force: cmd.force,
        refreshOnly: cmd.refreshOnly,
        account: cmd.account,
      });
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

    case 'update': await handleUpdate(); break;
    case 'update-target': { const code = await handleUpdateTarget({ target: cmd.target, check: cmd.check, json: cmd.json }); if (code !== 0) process.exitCode = code; break; }
    case 'versions': await handleVersions({ json: cmd.json, force: cmd.force }); break;

    case 'cache-health':
      handleCacheHealth({ sessionPath: cmd.sessionPath, json: cmd.json });
      break;

    case 'doctor':
      handleDoctor({ claudeJsonPath: cJson, accountsDirPath: aDir }, { json: cmd.json, fix: cmd.fix });
      break;

    case 'sessions':
      handleSessions({ accountsDirPath: aDir }, { json: cmd.json });
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
