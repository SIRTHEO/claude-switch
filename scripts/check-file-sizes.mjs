#!/usr/bin/env node
// Per-file line-count ratchet for src/ and bin/.
//
// New files must stay at or under HARD_LIMIT lines. Files already over it are
// grandfathered in scripts/file-size-baseline.json at their current count and
// may only shrink — never grow past their recorded ceiling. This mirrors the
// coverage-floor and jscpd-baseline patterns already used here: monotonic
// improvement, no new drift, enforced by gate instead of "by review".
//
// Usage:
//   node scripts/check-file-sizes.mjs            check (exit 1 on violation)
//   node scripts/check-file-sizes.mjs --update   regenerate the baseline

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARD_LIMIT = 280;
const ROOTS = ['src', 'bin'];
const EXT = new Set(['.ts', '.tsx']);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const BASELINE = path.join(here, 'file-size-baseline.json');

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (EXT.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

function countLines(file) {
  const txt = fs.readFileSync(file, 'utf8');
  if (txt === '') return 0;
  let n = 0;
  for (let i = 0; i < txt.length; i++) if (txt[i] === '\n') n++;
  return txt.endsWith('\n') ? n : n + 1;
}

const files = ROOTS.flatMap((r) => {
  const abs = path.join(repoRoot, r);
  return fs.existsSync(abs) ? walk(abs, []) : [];
})
  .map((p) => path.relative(repoRoot, p).split(path.sep).join('/'))
  .sort();

const sizes = new Map(files.map((f) => [f, countLines(path.join(repoRoot, f))]));

if (process.argv.includes('--update')) {
  const baseline = {};
  for (const [f, n] of sizes) if (n > HARD_LIMIT) baseline[f] = n;
  const keys = Object.keys(baseline).sort();
  fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, keys, 2)}\n`);
  console.log(`Baseline updated: ${keys.length} file(s) grandfathered over ${HARD_LIMIT} lines.`);
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
const failures = [];
const canTighten = [];

for (const [f, n] of sizes) {
  if (f in baseline) {
    if (n > baseline[f]) {
      failures.push(`${f}: ${n} lines > baseline ${baseline[f]} (grandfathered file grew — split it, don't grow it)`);
    } else if (n <= HARD_LIMIT) {
      canTighten.push(`${f}: ${n} lines now ≤ ${HARD_LIMIT} — drop from baseline (run --update)`);
    }
  } else if (n > HARD_LIMIT) {
    failures.push(`${f}: ${n} lines > hard limit ${HARD_LIMIT} (new files must stay under)`);
  }
}
for (const f of Object.keys(baseline)) {
  if (!sizes.has(f)) canTighten.push(`${f}: in baseline but no longer present — drop from baseline (run --update)`);
}

if (canTighten.length) {
  console.log('ℹ file-size ratchet — baseline can tighten:');
  for (const s of canTighten) console.log(`  - ${s}`);
}
if (failures.length) {
  console.error(`\n✗ file-size ratchet failed (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\nHard limit ${HARD_LIMIT} lines/file. Grandfathered files (scripts/file-size-baseline.json) may only shrink.`);
  process.exit(1);
}
console.log(`✓ file-size ratchet: ${sizes.size} files checked, ${Object.keys(baseline).length} grandfathered, limit ${HARD_LIMIT}.`);
