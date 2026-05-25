// src/ui/screens/profiles-screen.tsx
// The profiles submenu Ink component: step state machine + handlers + input
// wiring. Spawn-bearing actions return a LaunchRequest via onExit (the wrapper
// in profiles.tsx runs the subprocess); the JSX render lives in
// profiles-view.tsx.

import { useEffect, useState } from 'react';
import { useApp, useInput } from 'ink';
import {
  createProfile,
  ensureProfileForAccount,
  importProfileFromAccount,
  isValidProfileName,
  listProfiles,
  profileExists,
  profilePath,
  readProfile,
  removeProfile,
} from '../../profiles/profiles.js';
import { type Action, type MenuItem, buildHomeItems } from './profiles/menu-items.js';
import { ProfilesView } from './profiles-view.js';
import type { LaunchRequest, ScreenExit, Step } from './profiles-types.js';

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

  return (
    <ProfilesView
      step={step}
      items={items}
      cursor={cursor}
      error={error}
      accountsDirPath={accountsDirPath}
      onAccountPick={onAccountPick}
      onProfilePick={onProfilePick}
      onNameSubmit={onNameSubmit}
      onCancelToHome={() => setStep({ kind: 'home' })}
    />
  );
}
