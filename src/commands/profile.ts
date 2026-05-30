// src/commands/profile.ts
// `claude switch profile …` — per-terminal isolated claude sessions via
// CLAUDE_CONFIG_DIR. Each profile lives at ~/.claude/profiles/<name>/
// with its own userID, Keychain entry, sessions.
//
// All sub-commands here use dynamic `import('../profiles/profiles.js')` so cli.ts
// startup doesn't pay the profiles module cost on the hot path
// (statusline, passthrough). The module itself pulls in node:crypto +
// keychain helpers.

import fs from 'node:fs';
import path from 'node:path';
import { ExitError, errMessage } from '../platform/errors.js';
import { getTokenHealth } from '../credentials/token.js';
import { findClaude } from './_helpers.js';
import type { CommandContext } from './context.js';
import type { ProfileEntry } from '../contract.js';

interface ProfileListOptions {
  json: boolean;
}

export async function handleProfileList(
  opts: ProfileListOptions = { json: false },
): Promise<void> {
  const { listProfiles, readProfile } = await import('../profiles/profiles.js');
  const { isOverlayProfile } = await import('../profiles/overlay.js');
  const profiles = listProfiles();

  if (opts.json) {
    const payload: ProfileEntry[] = profiles.map((name) => {
      const info = readProfile(name);
      return {
        name,
        account: info.hasLogin ? info.emailAddress ?? null : null,
        hasLogin: info.hasLogin,
        path: info.path,
        overlay: isOverlayProfile(name),
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

export async function handleProfileCreate(
  name: string,
  opts: { overlay?: boolean } = {},
): Promise<void> {
  let dir: string;
  try {
    if (opts.overlay) {
      const { createOverlayProfile } = await import('../profiles/overlay.js');
      dir = createOverlayProfile(name);
    } else {
      const { createProfile } = await import('../profiles/profiles.js');
      dir = createProfile(name);
    }
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  console.log(`Created ${opts.overlay ? 'overlay (as-global) profile' : 'profile'} "${name}" at ${dir}`);
  if (opts.overlay) {
    console.log('  Shares global skills + session history; isolates only credentials.');
  }
  console.log('');
  console.log('Next steps:');
  console.log(`  1. claude switch profile login ${name}    # browser opens, sign in`);
  console.log(`  2. claude switch profile use ${name}      # start using the profile`);
}

export async function handleProfileStatus(name: string | undefined): Promise<void> {
  const { readProfile, listProfiles } = await import('../profiles/profiles.js');
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

    // Credentials backend status: read through the CredentialStore port (the
    // file vault by default on every platform; the macOS Keychain only under
    // CLAUDE_SWITCH_USE_KEYCHAIN=1) instead of probing the deprecated Keychain
    // directly — so the line reflects where the tokens actually live.
    const { readProfileCredentials } = await import('../credentials/keychain.js');
    const credsBackend = process.env.CLAUDE_SWITCH_USE_KEYCHAIN === '1' ? 'macOS Keychain' : 'file vault';
    const credsLine = readProfileCredentials(info.path)?.claudeAiOauth
      ? `present (${credsBackend})`
      : `absent — run: claude switch profile login ${info.name}`;

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
    console.log(`Creds:    ${credsLine}`);
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
  const { profilePath, profileExists, createProfile, readProfile } = await import('../profiles/profiles.js');
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
  const { buildSpawnArgs } = await import('../proxy/proxy.js');
  const { command, args, options } = buildSpawnArgs(claudeBin, ['auth', 'login'], process.platform, {
    CLAUDE_CONFIG_DIR: dir,
  });
  const { nodeProcessAdapter } = await import('../platform/process.js');
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

// The profile launch/run handlers (`use`, `launch`) and their shared
// resolveActiveProfile preamble live in profile-launch.ts; re-exported here so
// the command dispatcher's import surface is unchanged.
export { handleProfileLaunch, handleProfileUse } from './profile-launch.js';

export async function handleProfileImport(
  ctx: CommandContext,
  email: string,
  profileName: string | undefined,
  overlay = false,
): Promise<void> {
  const { importProfileFromAccount, refreshLegacySnapshotIfStale } = await import('../profiles/profiles.js');

  // Refresh the snapshot's access token if it's stale before we
  // import — otherwise the imported profile lands with an expired
  // token and claude 401s on first run.
  try {
    await refreshLegacySnapshotIfStale(email, ctx.accountsDirPath);
  } catch { /* network failure → fall through, importProfileFromAccount may still be useful */ }

  // --as-global: build the profile as an overlay (shared global skills +
  // session history, isolated identity) instead of a classic empty one.
  // Injected so profiles.ts doesn't import overlay.ts (cycle-free).
  const createDir = overlay
    ? (await import('../profiles/overlay.js')).createOverlayProfile
    : undefined;

  let result: ReturnType<typeof importProfileFromAccount>;
  try {
    result = importProfileFromAccount(email, ctx.accountsDirPath, profileName, { createDir });
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  if (overlay) {
    console.log('  (overlay: shares global skills + session history; isolates only credentials)');
  }
  console.log(`✔ Imported "${result.emailAddress}" into profile "${result.profileName}"`);
  console.log(`  Path:    ${result.profilePath}`);
  console.log(`  User ID: ${result.userID.slice(0, 16)}…`);
  if (result.wroteToKeychain) {
    // `wroteToKeychain` is legacy naming: the credentials went through the
    // CredentialStore port, which since v4.0.0 is the file vault by default —
    // the macOS Keychain is used only under CLAUDE_SWITCH_USE_KEYCHAIN=1.
    // Report the backend that actually received the tokens, not "Keychain".
    const backend =
      process.env.CLAUDE_SWITCH_USE_KEYCHAIN === '1'
        ? `macOS Keychain (account=${result.userID.slice(0, 16)}…)`
        : `the file vault (${result.profilePath}/.credentials.json)`;
    console.log(`  Tokens:  written to ${backend}`);
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
  const { removeProfile } = await import('../profiles/profiles.js');
  let result: ReturnType<typeof removeProfile>;
  try {
    result = removeProfile(name);
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  console.log(`Removed profile dir: ${result.dir}`);
  if (process.platform === 'darwin') {
    const { claudeKeychainServiceFor, claudeKeychainAccount, deleteProfileCredentials } =
      await import('../credentials/keychain.js');
    const service = claudeKeychainServiceFor(result.dir);
    const account = claudeKeychainAccount();
    const removed = deleteProfileCredentials(result.dir);
    if (removed) {
      console.log(`Removed Keychain entry: service="${service}" account="${account}"`);
    } else {
      console.log('');
      console.log('Note: no Keychain entry found for this profile (or it was already removed).');
      console.log(`Expected location: service="${service}", account="${account}".`);
    }
  }
}
