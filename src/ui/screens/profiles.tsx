// src/ui/screens/profiles.tsx
// Profiles submenu wrapper: handles spawn requests OUTSIDE Ink so the
// subprocess owns the TTY. The screen component lives in profiles-screen.tsx
// (state + handlers), its render in profiles-view.tsx, shared types in
// profiles-types.ts — all re-exported here so importers keep using
// `screens/profiles.js`.

import { spawnSync } from 'node:child_process';
import { render } from 'ink';
import { clearScreen } from '../screen-buffer.js';
import { buildSpawnArgs } from '../../proxy.js';
import { ExitError } from '../../errors.js';
import { readProfile } from '../../profiles.js';
import { awaitInkScreen } from '../utils/ink-screen.js';
import { ProfilesScreen } from './profiles-screen.js';
import type { ScreenExit } from './profiles-types.js';

export { ProfilesScreen } from './profiles-screen.js';
export type { ScreenExit } from './profiles-types.js';

/**
 * Run `claude` via spawnSync and propagate the exit status as an ExitError
 * instead of calling process.exit() directly. This lets the caller (run-app.ts
 * → runApp's finally block) restore the alt-buffer before the process exits.
 *
 * Exported for unit testing without needing to drive the Ink UI.
 */
export function spawnClaudeAndExit(
  command: string,
  args: string[],
  options: ReturnType<typeof buildSpawnArgs>['options'],
): never {
  const result = spawnSync(command, args, options);
  if (result.error) {
    throw new ExitError(`Error: could not run claude: ${result.error.message}`, 1);
  }
  throw new ExitError('', result.status ?? 0);
}

async function renderProfilesScreen(
  accountsDirPath: string,
  initialNotice: string | null,
): Promise<ScreenExit> {
  let result: ScreenExit = { kind: 'back' };
  clearScreen();
  const instance = render(
    <ProfilesScreen
      accountsDirPath={accountsDirPath}
      initialNotice={initialNotice}
      onExit={(e) => {
        result = e;
      }}
    />,
    { exitOnCtrlC: true },
  );
  return awaitInkScreen(instance, () => result);
}

export async function runProfilesScreen(
  accountsDirPath: string,
  claudeBin: string,
  restoreBuffer: () => void,
): Promise<void> {
  let nextNotice: string | null = null;
  while (true) {
    const r = await renderProfilesScreen(accountsDirPath, nextNotice);
    nextNotice = null;
    if (r.kind === 'back') return;

    const req = r.req;
    if (req.kind === 'isolated') {
      restoreBuffer();
      process.stderr.write(`🔑 ${req.email} (isolated) — profile: ${req.profileName}\n\n`);
      const { command, args, options } = buildSpawnArgs(
        claudeBin, [], process.platform, { CLAUDE_CONFIG_DIR: req.profileDir },
      );
      spawnClaudeAndExit(command, args, options);
    }
    if (req.kind === 'use-profile') {
      restoreBuffer();
      process.stderr.write(`🔑 ${req.profileName} (profile, isolated) — ${req.emailAddress}\n\n`);
      const { command, args, options } = buildSpawnArgs(
        claudeBin, [], process.platform, { CLAUDE_CONFIG_DIR: req.profileDir },
      );
      spawnClaudeAndExit(command, args, options);
    }
    if (req.kind === 'login-profile') {
      restoreBuffer();
      process.stderr.write(`🔐 Opening browser to authenticate profile "${req.profileName}"...\n\n`);
      const { command, args, options } = buildSpawnArgs(
        claudeBin, ['auth', 'login'], process.platform, { CLAUDE_CONFIG_DIR: req.profileDir },
      );
      spawnSync(command, args, options);
      try {
        const info = readProfile(req.profileName);
        nextNotice = info.emailAddress
          ? `Logged in as ${info.emailAddress}`
          : 'Login did not complete. Try again.';
      } catch (e) {
        nextNotice = e instanceof Error ? e.message : String(e);
      }
      // Loop back to the screen with the post-login notice.
    }
    if (req.kind === 'login-then-isolated') {
      // Two-step flow we drive in one go: browser login → isolated
      // claude session. The user picked an account whose stored tokens
      // were unrecoverable (refresh_token also expired), so we
      // authenticate first and continue straight into the session
      // without bouncing back through the menu.
      restoreBuffer();
      process.stderr.write(
        `🔐 Refreshing credentials for "${req.email}" — opening browser...\n\n`,
      );
      const login = buildSpawnArgs(
        claudeBin, ['auth', 'login'], process.platform, { CLAUDE_CONFIG_DIR: req.profileDir },
      );
      spawnSync(login.command, login.args, login.options);

      // Verify login actually completed before launching the session.
      // If the user closed the browser or auth failed, claude itself
      // would just re-prompt — better to surface that as a notice and
      // bounce back to the menu.
      let loggedIn = false;
      try {
        const info = readProfile(req.profileName);
        loggedIn = !!info.emailAddress && info.hasLogin;
      } catch { loggedIn = false; } // unreadable profile → treat as not-logged-in

      if (!loggedIn) {
        nextNotice = `Login did not complete for "${req.profileName}". Try again from the menu.`;
        continue;
      }

      process.stderr.write(`\n🔑 ${req.email} (isolated) — profile: ${req.profileName}\n\n`);
      const launch = buildSpawnArgs(
        claudeBin, [], process.platform, { CLAUDE_CONFIG_DIR: req.profileDir },
      );
      spawnClaudeAndExit(launch.command, launch.args, launch.options);
    }
  }
}
