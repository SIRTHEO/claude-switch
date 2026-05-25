// test/oauth-refresh.test.ts
// Coverage for the Anthropic OAuth refresh-token client. Uses an
// injected `fetch` so no network calls leave the runner — the contract
// pinned here is purely "given response shape X, produce ClaudeAiOauth Y".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAccessTokenStale,
  refreshAccessToken,
  refreshIfStale,
} from '../src/credentials/oauth-refresh.js';

describe('isAccessTokenStale', () => {
  it('returns true when oauth is undefined', () => {
    assert.equal(isAccessTokenStale(undefined), true);
  });

  it('returns true when expiresAt is missing', () => {
    assert.equal(isAccessTokenStale({ accessToken: 'a', refreshToken: 'r' } as never), true);
  });

  it('returns true when token already expired', () => {
    assert.equal(isAccessTokenStale({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() - 1_000,
    }), true);
  });

  it('returns true when token is within the 60s buffer', () => {
    assert.equal(isAccessTokenStale({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 30_000, // 30s left → inside buffer
    }), true);
  });

  it('returns false when token has plenty of time left', () => {
    assert.equal(isAccessTokenStale({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000, // 1h ahead
    }), false);
  });

  it('handles expiresAt as a numeric string (some snapshots store it that way)', () => {
    assert.equal(isAccessTokenStale({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: String(Date.now() + 3_600_000) as unknown as number,
    }), false);
  });
});

describe('refreshAccessToken', () => {
  function fakeFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): typeof globalThis.fetch {
    return ((url: RequestInfo | URL, init?: RequestInit) => Promise.resolve(impl(String(url), init ?? {}))) as typeof globalThis.fetch;
  }

  it('returns null when refresh_token is empty', async () => {
    const result = await refreshAccessToken('');
    assert.equal(result, null);
  });

  it('POSTs to the production token endpoint with the right body shape', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fetch = fakeFetch((url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 7200 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const result = await refreshAccessToken('rt-1', { http: fetch });
    assert.ok(result, 'expected a refreshed oauth block');
    assert.equal(captured.url, 'https://platform.claude.com/v1/oauth/token');
    assert.equal((captured.init as RequestInit).method, 'POST');

    const headers = (captured.init as RequestInit).headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');

    const body = JSON.parse(String((captured.init as RequestInit).body));
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.refresh_token, 'rt-1');
    assert.equal(body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  });

  it('parses access_token + computes expiresAt = now + expires_in*1000', async () => {
    const before = Date.now();
    const fetch = fakeFetch(() => new Response(
      JSON.stringify({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 7200 }),
      { status: 200 },
    ));
    const result = await refreshAccessToken('rt', { http: fetch });
    const after = Date.now();
    assert.ok(result);
    assert.equal(result?.accessToken, 'new-at');
    assert.equal(result?.refreshToken, 'new-rt');
    assert.ok(typeof result?.expiresAt === 'number');
    const expiresAt = result?.expiresAt as number;
    assert.ok(expiresAt >= before + 7200 * 1000, 'expiresAt should be at least now + expires_in*1000');
    assert.ok(expiresAt <= after + 7200 * 1000 + 100, 'expiresAt should not be more than now + expires_in*1000 + 100ms');
  });

  it('falls back to the input refresh_token when the response omits it (no rotation)', async () => {
    const fetch = fakeFetch(() => new Response(
      JSON.stringify({ access_token: 'new-at', expires_in: 100 }),
      { status: 200 },
    ));
    const result = await refreshAccessToken('original-rt', { http: fetch });
    assert.equal(result?.refreshToken, 'original-rt');
  });

  it('returns null on non-2xx response', async () => {
    const fetch = fakeFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const result = await refreshAccessToken('rt', { http: fetch });
    assert.equal(result, null);
  });

  it('returns null when fetch itself throws (network down, DNS failure, etc.)', async () => {
    const fetch = (() => Promise.reject(new Error('network down'))) as typeof globalThis.fetch;
    const result = await refreshAccessToken('rt', { http: fetch });
    assert.equal(result, null);
  });

  it('returns null when the body is missing access_token', async () => {
    const fetch = fakeFetch(() => new Response(JSON.stringify({ expires_in: 100 }), { status: 200 }));
    const result = await refreshAccessToken('rt', { http: fetch });
    assert.equal(result, null);
  });

  it('returns null when the body is malformed JSON', async () => {
    const fetch = fakeFetch(() => new Response('not-json', { status: 200 }));
    const result = await refreshAccessToken('rt', { http: fetch });
    assert.equal(result, null);
  });

  it('parses scope into an array', async () => {
    const fetch = fakeFetch(() => new Response(
      JSON.stringify({ access_token: 'a', expires_in: 100, scope: 'user:inference user:profile' }),
      { status: 200 },
    ));
    const result = await refreshAccessToken('rt', { http: fetch });
    assert.deepEqual(result?.scopes, ['user:inference', 'user:profile']);
  });

  it('rejects a response body that exceeds the 1MB DoS cap', async () => {
    // Pad valid JSON with whitespace inside a string field so the wire
    // bytes blow past 1 MB while staying syntactically valid — the cap
    // must catch this before parsing.
    const padding = 'x'.repeat(2 * 1024 * 1024); // 2 MB
    const fetch = fakeFetch(() => new Response(
      JSON.stringify({ access_token: 'a', expires_in: 100, _pad: padding }),
      { status: 200 },
    ));
    const result = await refreshAccessToken('rt', { http: fetch });
    assert.equal(result, null, 'oversize body must fall through to needsLogin');
  });
});

describe('refreshIfStale', () => {
  it('returns null when oauth is undefined', async () => {
    assert.equal(await refreshIfStale(undefined), null);
  });

  it('returns the input as-is when access token is fresh', async () => {
    const oauth = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
    };
    const result = await refreshIfStale(oauth);
    assert.equal(result, oauth, 'should be the same reference — no refresh');
  });

  it('returns null when stale and no refresh_token is present', async () => {
    const result = await refreshIfStale({
      accessToken: 'a',
      refreshToken: '',
      expiresAt: Date.now() - 1_000,
    });
    assert.equal(result, null);
  });
});
