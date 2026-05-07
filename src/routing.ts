// src/routing.ts
// Project-aware account routing.
//
// Pure resolver — given the cwd, the saved roster and the lastUsed-by-domain
// snapshot, decide which account this `claude` invocation should run as. No
// filesystem WRITES happen here (state mutations are the caller's job inside
// the existing accounts-dir lock). The resolver only READS:
//   - process.env.CLAUDE_SWITCH_ACCOUNT (override)
//   - <cwd>/.claude-switch (walk up until a `.git/` boundary, $HOME, or fs root)
//   - <accountsDirPath>/.routing.json (global per-machine rules)
//
// Resolution order (first non-null wins):
//   1. CLAUDE_SWITCH_ACCOUNT env var
//   2. .claude-switch (committed, team-shared, expresses a constraint)
//   3. .routing.json (local, expresses a glob → account map)
//   4. null → caller falls back to the active account (today's behaviour)
//
// `--as` is handled by the caller before invoking us; if the caller is in
// `temporary-switch` it skips routing entirely. Likewise, when the caller
// detects an externally-provided CLAUDE_CONFIG_DIR (we are already inside a
// profile) it MUST NOT call resolveRouting() — profile is an explicit user
// choice. We don't double-check here because the caller has the full env
// context and we want the resolver to remain pure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClaudeSwitchMatch {
  email?: string;
  emailDomain?: string;
  any?: ClaudeSwitchMatch[];
  disable?: boolean;
}

export interface ClaudeSwitchFile {
  match?: ClaudeSwitchMatch;
}

export interface RoutingFile {
  version: 1;
  rules: RoutingRule[];
}

export interface RoutingRule {
  match: string;
  account?: string;
  alias?: string;
}

export type RoutingSource =
  | 'env'
  | 'claude-switch-file'
  | 'global-rules';

export interface RoutingDecision {
  /** Canonical email of the chosen account. */
  email: string;
  source: RoutingSource;
  /** stderr-friendly banner line (without trailing newline). Optional —
   *  the env source is silent when it matches the active account. */
  banner?: string;
  /** Warning to surface in addition to the chosen email — used for the
   *  0-match fallback case to make the misalignment visible. */
  warning?: string;
}

export interface ResolveRoutingInput {
  cwd: string;
  accountsDirPath: string;
  env: NodeJS.ProcessEnv;
  /** Currently active email (from getCurrent()) or null. */
  activeEmail: string | null;
  /** All locally saved account emails. */
  savedEmails: string[];
  /** Snapshot from state.json: emailDomain → email of the last account
   *  routed to under that domain. Empty object is fine. */
  lastUsedByDomain: Record<string, string>;
  /** Optional resolver for local aliases → email. Used by global rules
   *  whose `alias` field needs to be canonicalised before matching against
   *  `savedEmails`. Returns null when the alias is unknown. */
  resolveAlias?: (alias: string) => string | null;
}

// ---------------------------------------------------------------------------
// Glob → RegExp (minimal — no deps)
// ---------------------------------------------------------------------------

/**
 * Tiny glob matcher tailored for path globs:
 *   - `**` → match across path separators (zero or more components)
 *   - `*`  → match within a single component (no separator)
 *   - `?`  → match a single character (no separator)
 *   - any other character is matched literally
 *
 * Patterns must be already tilde-expanded and resolved to absolute paths
 * by the caller via `expandPattern`.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    // `<prefix>/**` → match `<prefix>` itself OR any descendant. So
    // `~/work/**` matches `~/work`, `~/work/a`, `~/work/a/b`. We swap
    // the leading `/` of the segment for `(?:/.*)?`.
    if (c === '/' && pattern[i + 1] === '*' && pattern[i + 2] === '*') {
      re += '(?:/.*)?';
      i += 2; // skip the two `*`s
      if (pattern[i + 1] === '/') i++; // swallow trailing `/`
      continue;
    }
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // Bare `**` not preceded by `/` — match anything across separators.
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Expand `~` and `~/...` against the provided home, then resolve to an
 *  absolute path. Returns null when the resulting path escapes `home` (a
 *  pattern like `~/../etc/**` would otherwise allow rules outside the
 *  user's tree). */
export function expandPattern(pattern: string, home: string): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  let expanded = pattern;
  if (expanded === '~') {
    expanded = home;
  } else if (expanded.startsWith('~/')) {
    expanded = path.join(home, expanded.slice(2));
  }
  // Absolute patterns are honoured as-is when they live under `home`,
  // otherwise rejected. Relative patterns are resolved against `home`.
  if (!path.isAbsolute(expanded)) {
    expanded = path.resolve(home, expanded);
  }
  // Normalise without expanding a trailing `**` — `path.resolve` would
  // collapse `..` but we want the pattern shape preserved.
  // Strategy: split at the separator BEFORE the first `*` segment so the
  // glob suffix retains its leading separator after `path.resolve`
  // strips trailing slashes from the prefix.
  const starIdx = expanded.indexOf('*');
  let prefix: string;
  let suffix: string;
  if (starIdx === -1) {
    prefix = expanded;
    suffix = '';
  } else {
    const sepIdx = expanded.lastIndexOf(path.sep, starIdx);
    if (sepIdx === -1) {
      prefix = '.';
      suffix = expanded;
    } else {
      prefix = expanded.slice(0, sepIdx) || path.sep;
      suffix = expanded.slice(sepIdx);
    }
  }
  prefix = path.resolve(prefix);
  if (!withinHome(prefix, home)) return null;
  return suffix.startsWith(path.sep) || suffix === '' ? prefix + suffix : `${prefix}${path.sep}${suffix}`;
}

function withinHome(absPath: string, home: string): boolean {
  const h = path.resolve(home);
  return absPath === h || absPath.startsWith(h + path.sep);
}

// ---------------------------------------------------------------------------
// Schema validators (tolerant — invalid input becomes "null", never throws)
// ---------------------------------------------------------------------------

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function parseClaudeSwitchFile(raw: string): ParseResult<ClaudeSwitchFile> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!isPlainObject(json)) {
    return { ok: false, error: 'top-level value must be an object' };
  }
  const m = (json as Record<string, unknown>).match;
  if (m === undefined) return { ok: true, value: {} };
  const parsed = parseMatch(m);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, value: { match: parsed.value } };
}

function parseMatch(m: unknown): ParseResult<ClaudeSwitchMatch> {
  if (!isPlainObject(m)) return { ok: false, error: 'match must be an object' };
  const out: ClaudeSwitchMatch = {};
  const obj = m as Record<string, unknown>;
  if (obj.disable === true) {
    return { ok: true, value: { disable: true } };
  }
  if (typeof obj.email === 'string' && obj.email.length > 0) {
    out.email = obj.email;
  }
  if (typeof obj.emailDomain === 'string' && obj.emailDomain.length > 0) {
    out.emailDomain = obj.emailDomain;
  }
  if (Array.isArray(obj.any)) {
    const inner: ClaudeSwitchMatch[] = [];
    for (const item of obj.any) {
      const p = parseMatch(item);
      if (!p.ok) return { ok: false, error: `match.any: ${p.error}` };
      if (p.value) inner.push(p.value);
    }
    out.any = inner;
  }
  if (!out.email && !out.emailDomain && !out.any) {
    return { ok: false, error: 'match must specify email, emailDomain, any, or disable' };
  }
  return { ok: true, value: out };
}

export function parseRoutingFile(raw: string): ParseResult<RoutingFile> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!isPlainObject(json)) {
    return { ok: false, error: 'top-level value must be an object' };
  }
  const obj = json as Record<string, unknown>;
  if (obj.version !== 1) {
    return { ok: false, error: `unsupported version: ${String(obj.version)}` };
  }
  if (!Array.isArray(obj.rules)) {
    return { ok: false, error: 'rules must be an array' };
  }
  const rules: RoutingRule[] = [];
  for (let i = 0; i < obj.rules.length; i++) {
    const r = obj.rules[i];
    if (!isPlainObject(r)) {
      return { ok: false, error: `rules[${i}] must be an object` };
    }
    const rec = r as Record<string, unknown>;
    if (typeof rec.match !== 'string' || rec.match.length === 0) {
      return { ok: false, error: `rules[${i}].match must be a non-empty string` };
    }
    const hasAccount = typeof rec.account === 'string' && rec.account.length > 0;
    const hasAlias = typeof rec.alias === 'string' && rec.alias.length > 0;
    if (hasAccount === hasAlias) {
      return { ok: false, error: `rules[${i}] must specify exactly one of account or alias` };
    }
    rules.push({
      match: rec.match,
      ...(hasAccount ? { account: rec.account as string } : {}),
      ...(hasAlias ? { alias: rec.alias as string } : {}),
    });
  }
  return { ok: true, value: { version: 1, rules } };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// .claude-switch discovery (walk up from cwd)
// ---------------------------------------------------------------------------

const CLAUDE_SWITCH_FILENAME = '.claude-switch';

/** Walk up from `cwd` until either a `.claude-switch` is found, a `.git/`
 *  boundary stops us, or we reach `os.homedir()` / fs root. Returns the
 *  absolute path of the first `.claude-switch` we hit (closest to cwd) or
 *  null. */
export function findClaudeSwitchFile(
  cwd: string,
  home: string = os.homedir(),
): string | null {
  let dir = path.resolve(cwd);
  const homeAbs = path.resolve(home);
  // Bound the walk by depth as a sanity guard (deeply nested paths).
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, CLAUDE_SWITCH_FILENAME);
    try {
      const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (stat && stat.isFile()) return candidate;
    } catch { /* unreadable — continue */ }

    // Stop walking at the first `.git` boundary (the repo root).
    try {
      const gitStat = fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false });
      if (gitStat && (gitStat.isDirectory() || gitStat.isFile())) {
        // We're at the repo root — last chance for the file at this level
        // already checked above. Stop walking past the boundary.
        return null;
      }
    } catch { /* no .git here — continue up */ }

    if (dir === homeAbs) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached fs root
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Constraint evaluation
// ---------------------------------------------------------------------------

function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).toLowerCase();
}

function matches(email: string, m: ClaudeSwitchMatch): boolean {
  if (m.disable) return false;
  if (m.email && m.email.toLowerCase() === email.toLowerCase()) return true;
  if (m.emailDomain && emailDomainOf(email) === m.emailDomain.toLowerCase()) return true;
  if (m.any) {
    for (const inner of m.any) {
      if (matches(email, inner)) return true;
    }
  }
  return false;
}

function describeConstraint(m: ClaudeSwitchMatch): string {
  if (m.disable) return 'routing disabled';
  const parts: string[] = [];
  if (m.email) parts.push(m.email);
  if (m.emailDomain) parts.push(`@${m.emailDomain}`);
  if (m.any) {
    for (const inner of m.any) parts.push(describeConstraint(inner));
  }
  return parts.length > 0 ? parts.join(' or ') : 'unspecified';
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

export function resolveRouting(input: ResolveRoutingInput): RoutingDecision | null {
  // 1. Env override
  const envAccount = input.env.CLAUDE_SWITCH_ACCOUNT;
  if (envAccount && typeof envAccount === 'string' && envAccount.length > 0) {
    const target = input.savedEmails.includes(envAccount)
      ? envAccount
      : (input.resolveAlias?.(envAccount) ?? null);
    if (target && input.savedEmails.includes(target)) {
      const banner = target === input.activeEmail
        ? undefined
        : `🎯 routed to ${target} via CLAUDE_SWITCH_ACCOUNT`;
      return { email: target, source: 'env', ...(banner ? { banner } : {}) };
    }
    // Env var set but unresolvable. Don't pretend it routed — emit a
    // warning so the user notices, then continue resolution.
    if (input.activeEmail) {
      return {
        email: input.activeEmail,
        source: 'env',
        warning:
          `⚠ CLAUDE_SWITCH_ACCOUNT="${envAccount}" is not a saved account or alias. ` +
          `Falling back to active: ${input.activeEmail}`,
      };
    }
    return null;
  }

  // 2. .claude-switch in repo
  const cwdFile = findClaudeSwitchFile(input.cwd);
  if (cwdFile) {
    const decision = resolveFromClaudeSwitch(cwdFile, input);
    if (decision) return decision;
  }

  // 3. Global rules
  const globalDecision = resolveFromGlobalRules(input);
  if (globalDecision) return globalDecision;

  // 4. No opinion — caller uses the active account
  return null;
}

function resolveFromClaudeSwitch(
  filePath: string,
  input: ResolveRoutingInput,
): RoutingDecision | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseClaudeSwitchFile(raw);
  if (!parsed.ok || !parsed.value?.match) {
    if (!parsed.ok) {
      return {
        email: input.activeEmail ?? '',
        source: 'claude-switch-file',
        warning: `⚠ ${path.basename(filePath)} is unreadable: ${parsed.error}. Falling back to active.`,
      };
    }
    return null;
  }
  const m = parsed.value.match;
  if (m.disable) return null;

  const constraintLabel = describeConstraint(m);
  const matchingSaved = input.savedEmails.filter((e) => matches(e, m));

  // Active already satisfies → silent
  if (input.activeEmail && matches(input.activeEmail, m)) {
    return { email: input.activeEmail, source: 'claude-switch-file' };
  }

  // 0 match
  if (matchingSaved.length === 0) {
    if (!input.activeEmail) return null;
    return {
      email: input.activeEmail,
      source: 'claude-switch-file',
      warning:
        `⚠ this repo expects ${constraintLabel} — no saved account matches. ` +
        `Run: claude switch add. Falling back to active: ${input.activeEmail}`,
    };
  }

  // 1 match
  if (matchingSaved.length === 1) {
    const picked = matchingSaved[0]!;
    return {
      email: picked,
      source: 'claude-switch-file',
      banner: `🎯 routed to ${picked} via .claude-switch (repo requires ${constraintLabel})`,
    };
  }

  // N match → prefer last-used among matches; if none recorded, pick the
  // first saved match deterministically (alphabetical).
  const sorted = [...matchingSaved].sort();
  const lastUsedCandidates = Object.values(input.lastUsedByDomain).filter((e) =>
    matchingSaved.includes(e),
  );
  const usedLastUsed = lastUsedCandidates.length > 0;
  const picked = lastUsedCandidates[0] ?? sorted[0]!;
  const reason = usedLastUsed ? 'using last-used' : 'using alphabetical first';
  return {
    email: picked,
    source: 'claude-switch-file',
    banner:
      `🎯 routed to ${picked} via .claude-switch ` +
      `(${matchingSaved.length} accounts match ${constraintLabel}; ${reason}). ` +
      `Override: claude --as <other>`,
  };
}

function resolveFromGlobalRules(input: ResolveRoutingInput): RoutingDecision | null {
  const file = path.join(input.accountsDirPath, '.routing.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseRoutingFile(raw);
  if (!parsed.ok || !parsed.value) {
    return {
      email: input.activeEmail ?? '',
      source: 'global-rules',
      warning: `⚠ .routing.json is unreadable: ${parsed.error}. Falling back to active.`,
    };
  }

  const home = os.homedir();
  const cwdAbs = path.resolve(input.cwd);

  for (const rule of parsed.value.rules) {
    const expanded = expandPattern(rule.match, home);
    if (!expanded) continue; // pattern escapes $HOME — silently ignore
    if (!globToRegExp(expanded).test(cwdAbs)) continue;

    let target: string | null = null;
    if (rule.account) {
      target = input.savedEmails.includes(rule.account) ? rule.account : null;
    } else if (rule.alias) {
      const resolved = input.resolveAlias?.(rule.alias) ?? null;
      target = resolved && input.savedEmails.includes(resolved) ? resolved : null;
    }
    if (!target) continue;

    if (target === input.activeEmail) {
      return { email: target, source: 'global-rules' };
    }
    return {
      email: target,
      source: 'global-rules',
      banner: `🎯 routed to ${target} via .routing.json (rule: ${rule.match})`,
    };
  }

  return null;
}
