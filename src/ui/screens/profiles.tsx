// src/ui/screens/profiles.tsx
// Ink port of the profiles submenu (per-terminal isolated sessions).
//
// Architecture: Ink owns the visual flow + non-spawn ops (create, list,
// remove, import). Spawn-bearing actions (open isolated, use profile,
// authenticate profile) return a `LaunchRequest` to the wrapper, which
// unmounts Ink and runs the subprocess with the terminal to itself.
//
// This split keeps the screen testable + side-effect free, and avoids the
// TTY corruption you'd get if Ink stayed mounted across `claude` spawns.

import { useEffect, useState } from 'react';
import { spawnSync } from 'node:child_process';
import { Box, Text, render, useApp, useInput } from 'ink';
import { clearScreen } from '../screen-buffer.js';import { Badge, StatusMessage, TextInput } from '@inkjs/ui';

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
} from '../../profiles.js';
import { list as listAccounts } from '../../accounts.js';
import { buildSpawnArgs } from '../../proxy.js';
import { ExitError } from '../../errors.js';
import { ORANGE } from '../theme.js';
import { awaitInkScreen } from '../utils/ink-screen.js';
import { type Action, type MenuItem, buildHomeItems, profileLabel } from './profiles/menu-items.js';
import { PickList } from './profiles/pick-list.js';

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type LaunchRequest =
  | { kind: 'isolated'; email: string; profileName: string; profileDir: string }
  | { kind: 'use-profile'; profileName: string; profileDir: string; emailAddress: string }
  | { kind: 'login-profile'; profileName: string; profileDir: string }
  // login-then-isolated: profile exists but creds are unrecoverable
  // (refresh_token also expired). Wrapper drives a browser login then
  // continues into the isolated launch — single user-visible action,
  // not a "go run this command first" note.
  | { kind: 'login-then-isolated'; email: string; profileName: string; profileDir: string };

export type ScreenExit =
  | { kind: 'back' }
  | { kind: 'launch'; req: LaunchRequest };

// ---------------------------------------------------------------------------
// Internal step machine
// ---------------------------------------------------------------------------

type Step =
  | { kind: 'home' }
  | { kind: 'pick-account'; purpose: 'isolated' | 'import' }
  | { kind: 'pick-profile'; purpose: 'use' | 'login' | 'remove' }
  | { kind: 'enter-name'; purpose: 'create' | 'import'; importEmail?: string; defaultName?: string; error?: string }
  | { kind: 'confirm-remove'; profileName: string }
  | { kind: 'note'; title: string; body: string };

// ---------------------------------------------------------------------------
// Reusable list-pick component (used for accounts + profiles).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

interface ScreenProps {
  accountsDirPath: string;
  initialNotice: string | null;
  onExit: (e: ScreenExit) => void;
}

export function ProfilesScreen({ accountsDirPath, initialNotice, onExit }: ScreenProps) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(initialNotice ? { kind: 'note', title: 'Profiles', body: initialNotice } : { kind: 'home' });
  const [items, setItems] = useState<MenuItem[]>(() => buildHomeItems(accountsDirPath));
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refresh menu items when we land back on home (profile/account count may have changed).
  useEffect(() => {
    if (step.kind === 'home') {
      setItems(buildHomeItems(accountsDirPath));
      setCursor((c) => Math.min(c, Math.max(0, buildHomeItems(accountsDirPath).length - 1)));
    }
  }, [step.kind, accountsDirPath]);

  const finishLaunch = (req: LaunchRequest): void => {
    onExit({ kind: 'launch', req });
    exit();
  };
  const finishBack = (): void => {
    onExit({ kind: 'back' });
    exit();
  };

  const onHomeSelect = (action: Action): void => {
    setError(null);
    switch (action) {
      case 'back':
        finishBack();
        return;
      case 'list': {
        const profiles = listProfiles();
        const body = profiles.length === 0
          ? 'No profiles. Use "Create profile" to get started.'
          : profiles.map((name) => {
              try {
                const info = readProfile(name);
                return `${name.padEnd(20)} ${info.emailAddress ?? '(not logged in)'}`;
              } catch { return `${name.padEnd(20)} (error reading)`; } // corrupt profile → show inline, don't crash the list
            }).join('\n');
        setStep({ kind: 'note', title: 'Profiles', body });
        return;
      }
      case 'isolated':
        setStep({ kind: 'pick-account', purpose: 'isolated' });
        return;
      case 'import':
        setStep({ kind: 'pick-account', purpose: 'import' });
        return;
      case 'use':
        setStep({ kind: 'pick-profile', purpose: 'use' });
        return;
      case 'login':
        setStep({ kind: 'pick-profile', purpose: 'login' });
        return;
      case 'remove':
        setStep({ kind: 'pick-profile', purpose: 'remove' });
        return;
      case 'create':
        setStep({ kind: 'enter-name', purpose: 'create' });
        return;
    }
  };

  // Home navigation
  useInput((_input, key) => {
    if (step.kind !== 'home') return;
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    else if (key.escape) finishBack();
    else if (key.return) {
      const item = items[cursor];
      if (item) onHomeSelect(item.value);
    }
  });

  // Pick handlers
  const onAccountPick = (email: string): void => {
    if (step.kind !== 'pick-account') return;
    if (step.purpose === 'isolated') {
      // ensureProfileForAccount is async and handles the legacy-snapshot
      // refresh internally. We fire-and-await it inside an IIFE because
      // this Ink handler must remain synchronous.
      void (async () => {
        try {
          const ensured = await ensureProfileForAccount(email, accountsDirPath);
          if (ensured.needsLogin) {
            // Refresh-token is also expired (or never existed). Instead of
            // dropping the user back to the menu with "go run this command
            // separately", drive the browser login ourselves and resume
            // the isolated launch on the other side. Single click on the
            // user's part — they don't have to remember the second step.
            finishLaunch({
              kind: 'login-then-isolated',
              email,
              profileName: ensured.profileName,
              profileDir: ensured.profilePath,
            });
            return;
          }
          finishLaunch({
            kind: 'isolated',
            email,
            profileName: ensured.profileName,
            profileDir: ensured.profilePath,
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setStep({ kind: 'home' });
        }
      })();
      return;
    }
    // import
    const defaultName = (email.split('@')[0] ?? email).replace(/[^A-Za-z0-9_-]/g, '_');
    setStep({ kind: 'enter-name', purpose: 'import', importEmail: email, defaultName });
  };

  const onProfilePick = (name: string): void => {
    if (step.kind !== 'pick-profile') return;
    if (step.purpose === 'use') {
      try {
        const info = readProfile(name);
        if (!info.hasLogin) {
          setStep({
            kind: 'note',
            title: 'Login required',
            body: `Profile "${name}" has no login yet. Run "Authenticate profile".`,
          });
          return;
        }
        finishLaunch({
          kind: 'use-profile',
          profileName: name,
          profileDir: profilePath(name),
          emailAddress: info.emailAddress!,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStep({ kind: 'home' });
      }
      return;
    }
    if (step.purpose === 'login') {
      try {
        finishLaunch({ kind: 'login-profile', profileName: name, profileDir: profilePath(name) });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStep({ kind: 'home' });
      }
      return;
    }
    // remove
    setStep({ kind: 'confirm-remove', profileName: name });
  };

  const onNameSubmit = (raw: string): void => {
    if (step.kind !== 'enter-name') return;
    const trimmed = raw.trim() || step.defaultName || '';
    if (!trimmed) {
      setStep({ ...step, error: 'Name required.' });
      return;
    }
    if (!isValidProfileName(trimmed)) {
      setStep({ ...step, error: 'Use letters, digits, _ or - (max 64 chars). Reserved: list, create, use, login, remove, rm, status, help.' });
      return;
    }
    if (profileExists(trimmed)) {
      setStep({ ...step, error: `Profile "${trimmed}" already exists.` });
      return;
    }
    try {
      if (step.purpose === 'create') {
        const dir = createProfile(trimmed);
        setStep({
          kind: 'note',
          title: `Profile "${trimmed}" created`,
          body: `Created at: ${dir}\n\nNext: "Authenticate profile" to sign in via browser.`,
        });
      } else {
        const result = importProfileFromAccount(step.importEmail!, accountsDirPath, trimmed);
        const lines = [
          `Account:  ${result.emailAddress}`,
          `Profile:  ${result.profileName}`,
          `User ID:  ${result.userID.slice(0, 16)}…`,
        ];
        if (result.wroteToKeychain) lines.push('Tokens:   written to macOS Keychain');
        else if (result.needsLogin) lines.push('', '⚠ No credential snapshot found.', 'Run "Authenticate profile" to complete setup.');
        else lines.push('Tokens:   written to profile .claude.json');
        setStep({ kind: 'note', title: 'Imported', body: lines.join('\n') });
      }
    } catch (e) {
      setStep({ ...step, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const onRemoveConfirm = (yes: boolean): void => {
    if (step.kind !== 'confirm-remove') return;
    if (!yes) {
      setStep({ kind: 'home' });
      return;
    }
    try {
      const result = removeProfile(step.profileName);
      const lines = [`Removed: ${result.dir}`];
      if (result.userID && process.platform === 'darwin') {
        lines.push('', 'Note: the macOS Keychain entry was not removed.', 'Manual cleanup:', `  security delete-generic-password -a "${result.userID}" -s "Claude Code-credentials"`);
      }
      setStep({ kind: 'note', title: 'Removed', body: lines.join('\n') });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep({ kind: 'home' });
    }
  };

  // Esc shortcut on note + confirm-remove returns to home.
  useInput((input, key) => {
    if (step.kind === 'note' && (key.escape || key.return)) {
      setStep({ kind: 'home' });
      return;
    }
    if (step.kind === 'confirm-remove') {
      if (input === 'y' || input === 'Y') onRemoveConfirm(true);
      else if (input === 'n' || input === 'N' || key.escape) onRemoveConfirm(false);
    }
  });

  // ---- Render ----
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>Profiles</Badge>
        <Text color="gray"> per-terminal isolated sessions</Text>
      </Box>

      {error && (
        <Box marginBottom={1}>
          <StatusMessage variant="error">{error}</StatusMessage>
        </Box>
      )}

      {step.kind === 'home' && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {items.map((item, i) => {
            const selected = i === cursor;
            return (
              <Box key={item.value}>
                <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
                <Text bold={selected}>{item.label}</Text>
                {item.hint && <Text color="gray">  · {item.hint}</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      {step.kind === 'pick-account' && (
        <PickList<string>
          title={step.purpose === 'isolated' ? 'Open which account isolated?' : 'Import which account?'}
          items={listAccounts(accountsDirPath)}
          keyOf={(a) => a}
          formatLabel={(a) => a}
          onPick={onAccountPick}
          onCancel={() => setStep({ kind: 'home' })}
        />
      )}

      {step.kind === 'pick-profile' && (
        <PickList<string>
          title={
            step.purpose === 'use' ? 'Use which profile?'
            : step.purpose === 'login' ? 'Authenticate which profile?'
            : 'Remove which profile?'
          }
          items={listProfiles()}
          keyOf={(name) => name}
          formatLabel={(name) => profileLabel(name).label}
          formatHint={(name) => profileLabel(name).hint}
          onPick={onProfilePick}
          onCancel={() => setStep({ kind: 'home' })}
        />
      )}

      {step.kind === 'enter-name' && (
        <Box flexDirection="column">
          <Text>{step.purpose === 'create' ? 'Profile name' : 'Profile name (Enter for default)'}</Text>
          <Box>
            <Text>› </Text>
            <TextInput
              defaultValue={step.defaultName ?? ''}
              placeholder={step.defaultName ?? 'work, personal, project-x'}
              onSubmit={onNameSubmit}
            />
          </Box>
          {step.error && <StatusMessage variant="error">{step.error}</StatusMessage>}
          <Text color="gray">(esc not supported here — type a name then Enter)</Text>
        </Box>
      )}

      {step.kind === 'confirm-remove' && (
        <Box flexDirection="column">
          <Text>Delete profile "<Text bold>{step.profileName}</Text>" and all its state?</Text>
          <Text color="yellow">(y / n)</Text>
        </Box>
      )}

      {step.kind === 'note' && (
        <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
          <Text bold color={ORANGE}>{step.title}</Text>
          {(() => {
            // De-duplicate identical lines (blank lines especially) before
            // mapping so React keys can be derived from content alone.
            const seen = new Map<string, number>();
            return step.body.split('\n').map((line) => {
              const n = (seen.get(line) ?? 0) + 1;
              seen.set(line, n);
              return <Text key={`${line}#${n}`} color="gray">{line}</Text>;
            });
          })()}
          <Box marginTop={1}>
            <Text color="gray">(enter or esc to go back)</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">↑↓ select · enter activate · esc back</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Wrapper: handles spawn requests outside Ink so the subprocess owns the TTY.
// ---------------------------------------------------------------------------

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
