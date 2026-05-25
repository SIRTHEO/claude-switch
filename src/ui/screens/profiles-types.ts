// src/ui/screens/profiles-types.ts
// Shared types for the profiles submenu: the launch requests the screen hands
// back to the wrapper, the screen-exit union, and the internal step machine.

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

export type Step =
  | { kind: 'home' }
  | { kind: 'pick-account'; purpose: 'isolated' | 'import' }
  | { kind: 'pick-profile'; purpose: 'use' | 'login' | 'remove' }
  | { kind: 'enter-name'; purpose: 'create' | 'import'; importEmail?: string; defaultName?: string; error?: string }
  | { kind: 'confirm-remove'; profileName: string }
  | { kind: 'note'; title: string; body: string };
