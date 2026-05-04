// src/ui/profiles-menu.ts
// TUI submenu for managing per-terminal isolated profiles.

import * as p from '@clack/prompts';
import { spawnSync } from 'node:child_process';
import {
  listProfiles,
  readProfile,
  createProfile,
  removeProfile,
  importProfileFromAccount,
  ensureProfileForAccount,
  profilePath,
  isValidProfileName,
  profileExists,
} from '../profiles.js';
import { list as listAccounts } from '../accounts.js';
import { buildSpawnArgs } from '../proxy.js';

type ProfileAction =
  | 'isolated'
  | 'list'
  | 'use'
  | 'login'
  | 'create'
  | 'import'
  | 'remove'
  | 'back';

async function pickProfileAction(accountsDirPath: string): Promise<ProfileAction> {
  const profiles = listProfiles();
  const accounts = listAccounts(accountsDirPath);

  const options: Array<{ value: ProfileAction; label: string; hint?: string }> = [];

  if (accounts.length > 0) {
    options.push({
      value: 'isolated',
      label: 'Open account isolated',
      hint: 'pick an account → launch it in its own isolated session',
    });
  }

  if (profiles.length > 0) {
    options.push({
      value: 'use',
      label: 'Use saved profile',
      hint: 'launch claude with per-terminal isolation',
    });
    options.push({
      value: 'list',
      label: 'List profiles',
      hint: `${profiles.length} profile${profiles.length === 1 ? '' : 's'} saved`,
    });
    options.push({
      value: 'login',
      label: 'Authenticate profile',
      hint: 'open browser to sign in to a profile',
    });
    options.push({
      value: 'remove',
      label: 'Remove profile',
      hint: 'delete a profile and its state',
    });
  }

  options.push({
    value: 'create',
    label: 'Create profile',
    hint: 'new isolated profile directory',
  });

  if (accounts.length > 0) {
    options.push({
      value: 'import',
      label: 'Import account as profile',
      hint: 'convert a saved account — no browser re-login needed',
    });
  }

  options.push({ value: 'back', label: 'Back to main menu' });

  const choice = await p.select<ProfileAction>({ message: 'Profiles', options });
  if (p.isCancel(choice)) return 'back';
  return choice;
}

/**
 * Run the profiles submenu loop. Returns when the user picks Back / Esc.
 *
 * `restoreBuffer` is called before any operation that takes over the terminal
 * (profile login / profile use) so the alt-buffer is properly cleared before
 * handing stdio to the spawned claude process.
 */
export async function runProfilesMenu(
  accountsDirPath: string,
  claudeBin: string,
  restoreBuffer: () => void,
): Promise<void> {
  while (true) {
    const action = await pickProfileAction(accountsDirPath);

    if (action === 'back') return;

    try {
      switch (action) {
        case 'isolated': {
          const accounts = listAccounts(accountsDirPath);
          if (accounts.length === 0) {
            p.note('No saved accounts. Add one with "claude switch add".', 'Empty');
            break;
          }
          const emailPick = await p.select<string>({
            message: 'Open which account isolated?',
            options: accounts.map(a => ({ value: a, label: a })),
          });
          if (p.isCancel(emailPick)) break;

          const spinner = p.spinner();
          spinner.start('Setting up isolated session…');
          let ensured: ReturnType<typeof ensureProfileForAccount>;
          try {
            ensured = ensureProfileForAccount(emailPick, accountsDirPath);
          } catch (e) {
            spinner.stop('Failed');
            p.note((e as Error).message, 'Error');
            break;
          }
          spinner.stop(ensured.created ? `Profile "${ensured.profileName}" created` : `Using profile "${ensured.profileName}"`);

          if (ensured.needsLogin) {
            p.note(
              `Profile "${ensured.profileName}" needs a one-time browser login.\n` +
              `Run: claude switch profile login ${ensured.profileName}`,
              'Authentication required',
            );
            break;
          }

          restoreBuffer();
          process.stderr.write(`🔑 ${emailPick} (isolated) — profile: ${ensured.profileName}\n\n`);
          const { command, args: spawnArgs, options: spawnOpts } = buildSpawnArgs(
            claudeBin, [], process.platform, { CLAUDE_CONFIG_DIR: ensured.profilePath },
          );
          const result = spawnSync(command, spawnArgs, spawnOpts);
          if (result.error) {
            process.stderr.write(`Error: could not run claude: ${result.error.message}\n`);
            process.exit(1);
          }
          process.exit(result.status ?? 0);
          break;
        }

        case 'list': {
          const profiles = listProfiles();
          if (profiles.length === 0) {
            p.note('No profiles. Use "Create profile" to get started.', 'Profiles');
            break;
          }
          const lines = profiles.map(name => {
            try {
              const info = readProfile(name);
              const account = info.emailAddress ?? '(not logged in)';
              return `${name.padEnd(20)} ${account}`;
            } catch {
              return `${name.padEnd(20)} (error reading)`;
            }
          });
          p.note(lines.join('\n'), 'Profiles');
          break;
        }

        case 'use': {
          const profiles = listProfiles();
          if (profiles.length === 0) {
            p.note('No profiles yet.', 'Empty');
            break;
          }
          const options = profiles.map(name => {
            try {
              const info = readProfile(name);
              return {
                value: name,
                label: name,
                hint: info.emailAddress ?? '(not logged in)',
              };
            } catch {
              return { value: name, label: name, hint: '(error)' };
            }
          });
          const pick = await p.select<string>({ message: 'Use which profile?', options });
          if (p.isCancel(pick)) break;

          let info: ReturnType<typeof readProfile>;
          try { info = readProfile(pick); }
          catch (e) { p.note((e as Error).message, 'Error'); break; }

          if (!info.hasLogin) {
            p.note(
              `Profile "${pick}" has no login yet.\nRun "Authenticate profile" to sign in.`,
              'Login required',
            );
            break;
          }

          const dir = profilePath(pick);
          restoreBuffer();
          process.stderr.write(`🔑 ${pick} (profile, isolated) — ${info.emailAddress}\n\n`);
          const { command, args: spawnArgs, options: spawnOpts } = buildSpawnArgs(
            claudeBin, [], process.platform, { CLAUDE_CONFIG_DIR: dir },
          );
          const result = spawnSync(command, spawnArgs, spawnOpts);
          if (result.error) {
            process.stderr.write(`Error: could not run claude: ${result.error.message}\n`);
            process.exit(1);
          }
          process.exit(result.status ?? 0);
          break;
        }

        case 'login': {
          const profiles = listProfiles();
          if (profiles.length === 0) {
            p.note('No profiles yet. Create one first.', 'Empty');
            break;
          }
          const options = profiles.map(name => {
            try {
              const info = readProfile(name);
              return {
                value: name,
                label: name,
                hint: info.hasLogin ? info.emailAddress! : '(not logged in)',
              };
            } catch {
              return { value: name, label: name, hint: '(error)' };
            }
          });
          const pick = await p.select<string>({ message: 'Authenticate which profile?', options });
          if (p.isCancel(pick)) break;

          let dir: string;
          try { dir = profilePath(pick); }
          catch (e) { p.note((e as Error).message, 'Error'); break; }

          restoreBuffer();
          process.stderr.write(`🔐 Opening browser to authenticate profile "${pick}"...\n\n`);
          const { command, args: spawnArgs, options: spawnOpts } = buildSpawnArgs(
            claudeBin, ['auth', 'login'], process.platform, { CLAUDE_CONFIG_DIR: dir },
          );
          spawnSync(command, spawnArgs, spawnOpts);

          const info = readProfile(pick);
          if (info.emailAddress) {
            p.note(`Logged in as ${info.emailAddress}`, `Profile "${pick}" ready`);
          } else {
            p.note('Login did not complete. Try again.', 'Not logged in');
          }
          break;
        }

        case 'create': {
          const nameRaw = await p.text({
            message: 'Profile name',
            placeholder: 'work, personal, project-x, …',
            validate: (val) => {
              if (!val) return 'Name required.';
              if (!isValidProfileName(val)) {
                return 'Use letters, digits, _ or - (max 64 chars). Reserved: list, create, use, login, remove, rm, status, help.';
              }
              if (profileExists(val)) return `Profile "${val}" already exists.`;
              return undefined;
            },
          });
          if (p.isCancel(nameRaw)) break;
          const name = nameRaw.trim();
          try {
            const dir = createProfile(name);
            p.note(
              `Created at: ${dir}\n\nNext: "Authenticate profile" to sign in via browser.`,
              `Profile "${name}" created`,
            );
          } catch (e) {
            p.note((e as Error).message, 'Error');
          }
          break;
        }

        case 'import': {
          const accounts = listAccounts(accountsDirPath);
          if (accounts.length === 0) {
            p.note('No saved accounts to import.', 'Empty');
            break;
          }
          const emailPick = await p.select<string>({
            message: 'Import which account?',
            options: accounts.map(a => ({ value: a, label: a })),
          });
          if (p.isCancel(emailPick)) break;

          const defaultName = (emailPick.split('@')[0] ?? emailPick).replace(/[^A-Za-z0-9_-]/g, '_');
          const nameRaw = await p.text({
            message: 'Profile name',
            placeholder: defaultName,
            initialValue: defaultName,
            validate: (val) => {
              const n = val || defaultName;
              if (!isValidProfileName(n)) {
                return 'Use letters, digits, _ or - (max 64 chars). Reserved words not allowed.';
              }
              if (profileExists(n)) return `Profile "${n}" already exists.`;
              return undefined;
            },
          });
          if (p.isCancel(nameRaw)) break;
          const profileName = nameRaw.trim() || defaultName;

          try {
            const result = importProfileFromAccount(emailPick, accountsDirPath, profileName);
            const lines = [
              `Account:  ${result.emailAddress}`,
              `Profile:  ${result.profileName}`,
              `User ID:  ${result.userID.slice(0, 16)}…`,
            ];
            if (result.wroteToKeychain) {
              lines.push('Tokens:   written to macOS Keychain');
            } else if (result.needsLogin) {
              lines.push('');
              lines.push('⚠ No credential snapshot found.');
              lines.push('Run "Authenticate profile" to complete setup.');
            } else {
              lines.push('Tokens:   written to profile .claude.json');
            }
            p.note(lines.join('\n'), 'Imported');
          } catch (e) {
            p.note((e as Error).message, 'Error');
          }
          break;
        }

        case 'remove': {
          const profiles = listProfiles();
          if (profiles.length === 0) {
            p.note('No profiles.', 'Empty');
            break;
          }
          const options = profiles.map(name => {
            try {
              const info = readProfile(name);
              return {
                value: name,
                label: name,
                hint: info.emailAddress ?? '(not logged in)',
              };
            } catch {
              return { value: name, label: name, hint: '(error)' };
            }
          });
          const pick = await p.select<string>({ message: 'Remove which profile?', options });
          if (p.isCancel(pick)) break;

          const confirm = await p.confirm({
            message: `Delete profile "${pick}" and all its state?`,
            initialValue: false,
          });
          if (p.isCancel(confirm) || !confirm) break;

          try {
            const result = removeProfile(pick);
            const lines = [`Removed: ${result.dir}`];
            if (result.userID && process.platform === 'darwin') {
              lines.push('');
              lines.push('Note: the macOS Keychain entry created by claude was not removed.');
              lines.push('To clean it up manually:');
              lines.push(`  security delete-generic-password -a "${result.userID}" -s "Claude Code-credentials"`);
            }
            p.note(lines.join('\n'), 'Removed');
          } catch (e) {
            p.note((e as Error).message, 'Error');
          }
          break;
        }
      }
    } catch (e) {
      p.note((e as Error).message, 'Error');
    }
  }
}
