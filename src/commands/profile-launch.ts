// src/commands/profile-launch.ts
// The `claude switch profile use` / `… launch` handlers — running a profile's
// isolated `claude` session — split out of profile.ts to keep that file within
// the size budget. Both share the resolveActiveProfile preamble (resolve +
// validate the profile), kept private here so the error messages stay in one
// place.

import { ExitError, errMessage } from '../platform/errors.js';
import { findClaude } from './_helpers.js';
import type { CommandContext } from './context.js';

/**
 * Resolve a profile name into a launchable bundle (info + isolated config-dir
 * + the real claude binary), throwing ExitError on every precondition: the
 * profile doesn't exist, can't be read, or hasn't been logged in yet. Two
 * handlers below run the exact same preamble — keep it in one place so the
 * error messages stay consistent.
 */
async function resolveActiveProfile(
  ctx: CommandContext,
  name: string,
) {
  const { profilePath, profileExists, readProfile } = await import('../profiles/profiles.js');
  if (!profileExists(name)) {
    throw new ExitError(
      `Profile "${name}" does not exist. Create it with: claude switch profile create ${name}`,
    );
  }
  let info: ReturnType<typeof readProfile>;
  try {
    info = readProfile(name);
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  if (!info.hasLogin) {
    throw new ExitError(
      `Profile "${name}" has no login yet. Run: claude switch profile login ${name}`,
    );
  }
  return {
    info,
    dir: profilePath(name),
    claudeBin: findClaude(ctx.selfUrl),
  };
}

/**
 * Spawn the profile's `claude` session inside a NEW window of the
 * specified terminal emulator. The current process exits immediately
 * after handing the launch off so the GUI / launching shell returns
 * focus to the user. Used by the GUI's per-profile "Launch in ▾"
 * picker.
 */
export async function handleProfileLaunch(
  ctx: CommandContext,
  name: string,
  terminalId: string,
): Promise<void> {
  const { dir, claudeBin } = await resolveActiveProfile(ctx, name);
  const { launchInTerminal } = await import('../sessions/terminals.js');
  try {
    launchInTerminal({
      terminalId,
      cwd: process.env.HOME ?? '/',
      env: { CLAUDE_CONFIG_DIR: dir },
      command: [claudeBin],
    });
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  console.log(`Opening claude under profile "${name}" in ${terminalId}…`);
}

export async function handleProfileUse(
  ctx: CommandContext,
  name: string,
  passthroughArgs: string[],
): Promise<never> {
  const { info, dir, claudeBin } = await resolveActiveProfile(ctx, name);
  process.stderr.write(`🔑 ${name} (profile, isolated) — ${info.emailAddress}\n\n`);
  const { buildSpawnArgs } = await import('../proxy/proxy.js');
  const { command, args, options } = buildSpawnArgs(claudeBin, passthroughArgs, process.platform, {
    CLAUDE_CONFIG_DIR: dir,
  });
  const { nodeProcessAdapter } = await import('../platform/process.js');
  const result = nodeProcessAdapter.spawnSync(command, args, options);
  if (result.error) {
    console.error(`Error: could not run claude: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}
