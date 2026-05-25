export class ExitError extends Error {
  public readonly code: number;

  constructor(message: string, code: number = 1) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}

/**
 * Pull a human-readable string out of an unknown error value.
 *
 * `try/catch` clauses bind `e` as `unknown` under strict TS, but
 * 95% of the time we want either `e.message` (when it's an Error)
 * or `String(e)` (when something threw a non-Error). This helper
 * collapses both into one call and removes the per-callsite
 * `(e as Error).message` cast that was littering the codebase.
 */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Read the `.code` field from an fs / child_process error.
 *
 * Node's filesystem errors are `Error & { code: string; ... }` —
 * the `NodeJS.ErrnoException` shape. The cast appears at every
 * callsite that wants to distinguish ENOENT from a real failure;
 * this helper centralises the unwrap so the cast lives in one place.
 *
 * Returns `undefined` for non-Error values or for Errors that don't
 * carry a `.code` field, so callers can `errnoCode(e) === 'ENOENT'`
 * without an extra typeof check.
 */
export function errnoCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/**
 * Diagnostic logger for the profiles subsystem.
 *
 * Writes a single line to stderr only when `CLAUDE_SWITCH_DEBUG_PROFILES=1`.
 * Used by `ensureProfileForAccount` and related helpers to expose the
 * decision path that determines whether a profile has valid credentials.
 *
 * Enable at the shell:
 *   CLAUDE_SWITCH_DEBUG_PROFILES=1 claude switch <email>
 */
export function debugProfiles(...args: unknown[]): void {
  if (process.env.CLAUDE_SWITCH_DEBUG_PROFILES === '1') {
    process.stderr.write(`[claude-switch:profiles] ${args.map(String).join(' ')}\n`);
  }
}
