// src/commands/profile.ts
// `claude switch profile …` — per-terminal isolated claude sessions via
// CLAUDE_CONFIG_DIR. Each profile lives at ~/.claude/profiles/<name>/
// with its own userID, Keychain entry, sessions.
//
// All sub-commands here use dynamic `import('../profiles.js')` so cli.ts
// startup doesn't pay the profiles module cost on the hot path
// (statusline, passthrough). The module itself pulls in node:crypto +
// keychain helpers.

import fs from 'node:fs';
import path from 'node:path';
import { ExitError, errMessage } from '../errors.js';
import { getTokenHealth } from '../token.js';
import { findClaude } from './_helpers.js';
import type { CommandContext } from './context.js';
import type { ProfileEntry } from '../contract.js';

interface ProfileListOptions {
  json: boolean;
}

export async function handleProfileList(
  opts: ProfileListOptions = { json: false },
): Promise<void> {
  const { listProfiles, readProfile } = await import('../profiles.js');
  const profiles = listProfiles();

  if (opts.json) {
    const payload: ProfileEntry[] = profiles.map((name) => {
      const info = readProfile(name);
      return {
        name,
        account: info.hasLogin ? info.emailAddress ?? null : null,
        hasLogin: info.hasLogin,
      };
    });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (profiles.length === 0) {
    console.log('No profiles. Create one with: claude switch profile create <name>');
    return;
  }
  console.log('Profiles:\n');
  for (const name of profiles) {
    const info = readProfile(name);
    const right = info.hasLogin
      ? `→  ${info.emailAddress ?? '<unknown>'}`
      : `(not logged in — run: claude switch profile login ${name})`;
    console.log(`  ${name.padEnd(20)} ${right}`);
  }
}

export async function handleProfileCreate(name: string): Promise<void> {
  const { createProfile } = await import('../profiles.js');
  let dir: string;
  try {
    dir = createProfile(name);
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  console.log(`Created profile "${name}" at ${dir}`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. claude switch profile login ${name}    # browser opens, sign in`);
  console.log(`  2. claude switch profile use ${name}      # start using the profile`);
}

export async function handleProfileStatus(name: string | undefined): Promise<void> {
  const { readProfile, listProfiles } = await import('../profiles.js');
  if (name) {
    let info: ReturnType<typeof readProfile>;
    try {
      info = readProfile(name);
    } catch (e) {
      throw new ExitError(errMessage(e));
    }

    const profileClaudeJson = path.join(info.path, '.claude.json');
    const tokenHealth = info.hasLogin ? getTokenHealth(profileClaudeJson) : null;
    const tokenLine = (() => {
      if (!tokenHealth) return '(not logged in yet)';
      switch (tokenHealth.status) {
        case 'valid': return `valid (expires ${tokenHealth.expiresIn})`;
        case 'expired': return `EXPIRED (${tokenHealth.expiresIn}) — run: claude switch profile login ${info.name}`;
        case 'present': return 'present (expiry unknown)';
        case 'missing': return `missing — run: claude switch profile login ${info.name}`;
      }
    })();

    let keychainLine = '(not applicable on this platform)';
    if (process.platform === 'darwin') {
      const { claudeKeychainServiceFor, claudeKeychainAccount } = await import('../keychain.js');
      // Keychain probe — stays on raw spawnSync until CredentialStore lands
      // (this `security` call belongs to that port, not ProcessPort).
      const { spawnSync } = await import('node:child_process');
      const service = claudeKeychainServiceFor(info.path);
      const account = claudeKeychainAccount();
      const r = spawnSync('security', [
        'find-generic-password', '-s', service, '-a', account,
      ], { stdio: 'pipe' });
      keychainLine = r.status === 0
        ? `present (service=${service}, account=${account})`
        : `absent (would be at service=${service}, account=${account})`;
    }

    let lastUsed = '(never)';
    try {
      const mtime = fs.statSync(profileClaudeJson).mtime;
      lastUsed = mtime.toLocaleString();
    } catch {
      /* fresh profile */
    }

    console.log(`Profile: ${info.name}`);
    console.log(`Path:    ${info.path}`);
    console.log(`Email:   ${info.emailAddress ?? '(not logged in yet)'}`);
    console.log(`Token:   ${tokenLine}`);
    console.log(`Keychain: ${keychainLine}`);
    console.log(`Last run: ${lastUsed}`);
    console.log(`User ID: ${info.userID ?? '(not yet assigned — run claude once in this profile)'}`);
    return;
  }

  // No name: short summary of all profiles.
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('No profiles configured.');
    return;
  }
  for (const n of profiles) {
    const info = readProfile(n);
    const status = info.hasLogin ? (info.emailAddress ?? '(email unknown)') : '(not logged in)';
    console.log(`${n}: ${status} [${info.userID?.slice(0, 12) ?? '-'}…]`);
  }
}

export async function handleProfileLogin(ctx: CommandContext, name: string): Promise<void> {
  const { profilePath, profileExists, createProfile, readProfile } = await import('../profiles.js');
  let dir: string;
  try {
    if (!profileExists(name)) {
      createProfile(name);
      console.log(`Created profile "${name}".`);
    }
    dir = profilePath(name);
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  const claudeBin = findClaude(ctx.selfUrl);
  process.stderr.write(`🔐 Opening browser to authenticate profile "${name}"...\n\n`);
  const { buildSpawnArgs } = await import('../proxy.js');
  const { command, args, options } = buildSpawnArgs(claudeBin, ['auth', 'login'], process.platform, {
    CLAUDE_CONFIG_DIR: dir,
  });
  const { nodeProcessAdapter } = await import('../process.js');
  nodeProcessAdapter.spawnSync(command, args, options);

  const info = readProfile(name);
  if (info.emailAddress) {
    console.log(`\n✔ Profile "${name}" logged in as ${info.emailAddress}`);
    console.log(`Use it with:  claude switch profile use ${name}`);
  } else {
    console.log(`\nLogin did not complete for profile "${name}". Try again with:`);
    console.log(`  claude switch profile login ${name}`);
  }
}

/**
 * Resolve a profile name into a launchable bundle (info + isolated config-dir
 * + the real claude binary), throwing ExitError on every precondition: the
 * profile doesn't exist, can't be read, or hasn't been logged in yet. Two
 * handlers below ran the exact same preamble — keep it in one place so the
 * error messages stay consistent.
 */
async function resolveActiveProfile(
  ctx: CommandContext,
  name: string,
) {
  const { profilePath, profileExists, readProfile } = await import('../profiles.js');
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
  const { launchInTerminal } = await import('../terminals.js');
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
  const { buildSpawnArgs } = await import('../proxy.js');
  const { command, args, options } = buildSpawnArgs(claudeBin, passthroughArgs, process.platform, {
    CLAUDE_CONFIG_DIR: dir,
  });
  const { nodeProcessAdapter } = await import('../process.js');
  const result = nodeProcessAdapter.spawnSync(command, args, options);
  if (result.error) {
    console.error(`Error: could not run claude: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

export async function handleProfileImport(
  ctx: CommandContext,
  email: string,
  profileName: string | undefined,
): Promise<void> {
  const { importProfileFromAccount, refreshLegacySnapshotIfStale } = await import('../profiles.js');

  // Refresh the snapshot's access token if it's stale before we
  // import — otherwise the imported profile lands with an expired
  // token and claude 401s on first run.
  try {
    await refreshLegacySnapshotIfStale(email, ctx.accountsDirPath);
  } catch { /* network failure → fall through, importProfileFromAccount may still be useful */ }

  let result: ReturnType<typeof importProfileFromAccount>;
  try {
    result = importProfileFromAccount(email, ctx.accountsDirPath, profileName);
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  console.log(`✔ Imported "${result.emailAddress}" into profile "${result.profileName}"`);
  console.log(`  Path:    ${result.profilePath}`);
  console.log(`  User ID: ${result.userID.slice(0, 16)}…`);
  if (result.wroteToKeychain) {
    console.log(`  Tokens:  written to macOS Keychain (account=${result.userID.slice(0, 16)}…)`);
  } else if (result.needsLogin) {
    console.log('');
    console.log('⚠ This account predates v2.2 (no _keychain snapshot saved).');
    console.log(`  Run:  claude switch profile login ${result.profileName}`);
    console.log('  to authenticate the profile.');
  } else {
    console.log(`  Tokens:  written to ${result.profilePath}/.claude.json`);
  }
  if (!result.needsLogin) {
    console.log('');
    console.log(`Use it now with:  claude switch profile use ${result.profileName}`);
  }
}

export async function handleProfileRemove(name: string): Promise<void> {
  const { removeProfile } = await import('../profiles.js');
  let result: ReturnType<typeof removeProfile>;
  try {
    result = removeProfile(name);
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  console.log(`Removed profile dir: ${result.dir}`);
  if (process.platform === 'darwin') {
    const { claudeKeychainServiceFor, claudeKeychainAccount, deleteKeychainForConfigDir } =
      await import('../keychain.js');
    const service = claudeKeychainServiceFor(result.dir);
    const account = claudeKeychainAccount();
    const removed = deleteKeychainForConfigDir(result.dir);
    if (removed) {
      console.log(`Removed Keychain entry: service="${service}" account="${account}"`);
    } else {
      console.log('');
      console.log('Note: no Keychain entry found for this profile (or it was already removed).');
      console.log(`Expected location: service="${service}", account="${account}".`);
    }
  }
}
