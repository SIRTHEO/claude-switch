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
//
// Glob matching lives in routing-glob.ts, schema validators in routing-parse.ts,
// `.claude-switch` discovery in routing-discovery.ts, shared types in
// routing-types.ts. They are re-exported below so importers keep using
// `./routing.js`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeSwitchFile } from './routing-discovery.js';
import { expandPattern, globToRegExp } from './routing-glob.js';
import { parseClaudeSwitchFile, parseRoutingFile } from './routing-parse.js';
import type {
  ClaudeSwitchMatch,
  ResolveRoutingInput,
  RoutingDecision,
} from './routing-types.js';

export { expandPattern, findClaudeSwitchFile, globToRegExp, parseClaudeSwitchFile, parseRoutingFile };
export type {
  RoutingDecision,
  RoutingFile,
  RoutingRule,
} from './routing-types.js';

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
    // Env var set but unresolvable. It was an explicit override, so don't
    // silently fall through to repo/global rules (that would surprise a user
    // who thought they pinned an account). Stay on the active account and
    // surface a warning so they can fix the value.
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
  } catch { // routing file absent → no decision
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
  } catch { // no routing file → no rules
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
