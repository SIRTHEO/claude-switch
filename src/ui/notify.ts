// src/ui/notify.ts
// One-line notification helpers that funnel every TUI status message
// through a consistent surface. The five p.note(...) variants currently
// scattered across src/ui/main-menu.ts disagree on title conventions —
// some say "Setup needed", some "Done" (for both success and failure),
// some "Cannot continue". This module is the single helper to migrate
// to during the 5.2 main-menu split (Plans.md).
//
// Adopt one of the four kinds rather than calling p.note() directly:
//
//   notifyError(message, opts?) — recoverable error; offers a next-step.
//   notifyOk(message)           — successful operation; brief.
//   notifyInfo(message, title?) — neutral status; e.g. "Status", "Account".
//   notifyWarn(message, opts?)  — degraded but proceeding; informational.
//
// All four wrap @clack/prompts' p.note() under a fixed title vocabulary
// so the user sees the same shape every time.
//
// Why a helper, not a class: there's no shared state to encapsulate.
// Free functions compose with @clack flows without surprise.

import * as p from '@clack/prompts';

export interface NotifyErrorOpts {
  /** Optional one-line follow-up: "Run: claude switch add" */
  hint?: string;
  /** Title override (default: "Error"). */
  title?: string;
}

export interface NotifyWarnOpts {
  hint?: string;
  title?: string;
}

/**
 * Surface a recoverable error with a stable "Error" title (or override).
 * If `hint` is provided, append it on a new line so the user has a
 * concrete next step.
 */
export function notifyError(message: string, opts: NotifyErrorOpts = {}): void {
  const title = opts.title ?? 'Error';
  const body = opts.hint ? `${message}\n\n${opts.hint}` : message;
  p.note(body, title);
}

/**
 * Surface a successful operation with the title "Done".
 */
export function notifyOk(message: string): void {
  p.note(message, 'Done');
}

/**
 * Surface neutral status (e.g. account details, current state). Title
 * defaults to "Info" but most callers will want a domain-specific title
 * like "Status", "Account", or "Profile".
 */
export function notifyInfo(message: string, title: string = 'Info'): void {
  p.note(message, title);
}

/**
 * Surface a non-fatal warning with a stable "Warning" title (or override).
 * Use when an operation completed in a degraded state but is not an error.
 */
export function notifyWarn(message: string, opts: NotifyWarnOpts = {}): void {
  const title = opts.title ?? 'Warning';
  const body = opts.hint ? `${message}\n\n${opts.hint}` : message;
  p.note(body, title);
}
