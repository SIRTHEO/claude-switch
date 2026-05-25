// test/api-proxy-fixtures.test.ts
// Corpus-based regression test for `looksLikeErrorBody`.
//
// Reads every `.txt` fixture under test/fixtures/anthropic-errors/.
// Files whose basename contains "NOT-error" must NOT match (these are
// the negative-control: a normal SSE stream that the proxy must
// pipe through unchanged). Every other file MUST match.
//
// The point: our test corpus IS the contract. To register a new
// "the proxy didn't fall back on this error" report, drop the captured
// (sanitized) response body in the fixtures dir and rebuild — this
// suite picks it up automatically. No new test code needed.
//
// History: the previous matcher had test fixtures that were guesses
// ("out of extra usage" — what claude renders to the user, not what
// Anthropic actually puts on the wire). The bug shipped silently for
// months. This corpus-based approach forces fixtures to come from
// real wire captures (or close approximations sourced from the
// production claude binary's strings).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { looksLikeErrorBody } from '../src/proxy/api-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'anthropic-errors');

function fixtures(): string[] {
  try {
    return fs.readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith('.txt'))
      .sort();
  } catch {
    return [];
  }
}

describe('looksLikeErrorBody — corpus of real Anthropic error response shapes', () => {
  const files = fixtures();

  it('the corpus is non-empty (otherwise the test is uselessly green)', () => {
    assert.ok(files.length > 0,
      `expected at least one .txt fixture in ${FIXTURES_DIR} — found none`);
  });

  for (const file of files) {
    const expectError = !file.includes('NOT-error');
    const label = expectError
      ? `recognises ${file} as an error envelope`
      : `does NOT match ${file} (negative control — normal SSE stream)`;

    it(label, () => {
      const body = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');
      const matched = looksLikeErrorBody(body);
      if (expectError && !matched) {
        // Show the first 200 chars in the failure message so the
        // person extending the matcher can see what they're dealing
        // with without opening the fixture file.
        assert.fail(
          `expected ${file} to match looksLikeErrorBody but it didn't.\n` +
          `head[0:200]: ${JSON.stringify(body.slice(0, 200))}\n` +
          `add a regex to src/api-proxy.ts looksLikeErrorBody() to cover this case.`,
        );
      }
      if (!expectError && matched) {
        assert.fail(
          `${file} is the negative control and MUST NOT match — looksLikeErrorBody is now too permissive.\n` +
          `head[0:200]: ${JSON.stringify(body.slice(0, 200))}`,
        );
      }
    });
  }
});
