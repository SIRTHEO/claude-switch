// src/routing-glob.ts
// Minimal glob → RegExp for path globs, plus `~`/home-relative expansion.
// No dependencies. Used by routing.ts global-rules resolution.

import path from 'node:path';

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
