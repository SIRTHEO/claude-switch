// src/routing-parse.ts
// Tolerant schema validators for `.claude-switch` and `.routing.json`.
// Invalid input becomes a `{ ok: false }` result — never throws.

import { errMessage } from '../platform/errors.js';
import type {
  ClaudeSwitchFile,
  ClaudeSwitchMatch,
  RoutingFile,
  RoutingRule,
} from './routing-types.js';

interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

// `match.any` nests recursively. A `.claude-switch` file is discovered by
// walking up from the cwd, so it is effectively repo-controlled (untrusted)
// input — an adversarial file with deeply-nested `any` would overflow the
// stack in parseMatch and throw an uncaught RangeError, breaking this module's
// "never throws" contract. Cap the depth well above any legitimate rule.
const MAX_MATCH_DEPTH = 32;

export function parseClaudeSwitchFile(raw: string): ParseResult<ClaudeSwitchFile> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${errMessage(e)}` };
  }
  if (!isPlainObject(json)) {
    return { ok: false, error: 'top-level value must be an object' };
  }
  const m = json.match;
  if (m === undefined) return { ok: true, value: {} };
  const parsed = parseMatch(m, 0);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, value: { match: parsed.value } };
}

function parseMatch(m: unknown, depth: number): ParseResult<ClaudeSwitchMatch> {
  if (depth > MAX_MATCH_DEPTH) {
    return { ok: false, error: 'match nesting too deep' };
  }
  if (!isPlainObject(m)) return { ok: false, error: 'match must be an object' };
  const out: ClaudeSwitchMatch = {};
  const obj = m;
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
      const p = parseMatch(item, depth + 1);
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
    return { ok: false, error: `invalid JSON: ${errMessage(e)}` };
  }
  if (!isPlainObject(json)) {
    return { ok: false, error: 'top-level value must be an object' };
  }
  const obj = json;
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
    const rec = r;
    if (typeof rec.match !== 'string' || rec.match.length === 0) {
      return { ok: false, error: `rules[${i}].match must be a non-empty string` };
    }
    const accountVal = typeof rec.account === 'string' && rec.account.length > 0 ? rec.account : null;
    const aliasVal = typeof rec.alias === 'string' && rec.alias.length > 0 ? rec.alias : null;
    if ((accountVal !== null) === (aliasVal !== null)) {
      return { ok: false, error: `rules[${i}] must specify exactly one of account or alias` };
    }
    rules.push({
      match: rec.match,
      ...(accountVal !== null ? { account: accountVal } : {}),
      ...(aliasVal !== null ? { alias: aliasVal } : {}),
    });
  }
  return { ok: true, value: { version: 1, rules } };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
