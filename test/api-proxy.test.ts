import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  startFallbackProxy,
  buildPassthroughHeaders,
  buildApiKeyHeaders,
  stripOauthBeta,
  looksLikeErrorBody,
  isRetryableStatus,
} from '../src/api-proxy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10),
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'POST',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Unit: stripOauthBeta
// ---------------------------------------------------------------------------

describe('stripOauthBeta', () => {
  it('removes oauth-2025-04-20 from a multi-value string', () => {
    const input = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14';
    assert.equal(stripOauthBeta(input), 'claude-code-20250219,interleaved-thinking-2025-05-14');
  });

  it('handles value consisting solely of oauth-2025-04-20', () => {
    assert.equal(stripOauthBeta('oauth-2025-04-20'), '');
  });

  it('is a no-op when oauth token is absent', () => {
    assert.equal(stripOauthBeta('claude-code-20250219,some-other-beta'), 'claude-code-20250219,some-other-beta');
  });

  it('trims whitespace around tokens', () => {
    assert.equal(stripOauthBeta(' oauth-2025-04-20 , claude-code-20250219 '), 'claude-code-20250219');
  });
});

// ---------------------------------------------------------------------------
// Unit: buildPassthroughHeaders / buildApiKeyHeaders
// ---------------------------------------------------------------------------

describe('buildPassthroughHeaders', () => {
  it('forwards headers unchanged, drops host', () => {
    const out = buildPassthroughHeaders({
      host: 'api.anthropic.com',
      authorization: 'Bearer sk-ant-oat01-orig',
      'content-type': 'application/json',
    });
    assert.equal(out['host'], undefined);
    assert.equal(out['authorization'], 'Bearer sk-ant-oat01-orig');
    assert.equal(out['content-type'], 'application/json');
  });
});

describe('buildApiKeyHeaders', () => {
  it('replaces OAuth Authorization with x-api-key', () => {
    const out = buildApiKeyHeaders(
      { authorization: 'Bearer sk-ant-oat01-abc' },
      'sk-ant-api03-xyz',
    );
    assert.equal(out['authorization'], undefined);
    assert.equal(out['x-api-key'], 'sk-ant-api03-xyz');
  });

  it('strips oauth-2025-04-20 from anthropic-beta', () => {
    const out = buildApiKeyHeaders(
      { 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,prompt-caching' },
      'sk-ant-api03-key',
    );
    assert.equal(out['anthropic-beta'], 'claude-code-20250219,prompt-caching');
  });

  it('removes anthropic-beta entirely when only oauth token was present', () => {
    const out = buildApiKeyHeaders(
      { 'anthropic-beta': 'oauth-2025-04-20' },
      'sk-ant-api03-key',
    );
    assert.equal(out['anthropic-beta'], undefined);
  });

  it('drops the host header', () => {
    const out = buildApiKeyHeaders({ host: 'api.anthropic.com' }, 'sk-ant-api03-key');
    assert.equal(out['host'], undefined);
  });
});

describe('retry/error detection helpers', () => {
  it('treats subscription quota statuses as retryable', () => {
    for (const code of [402, 403, 429]) {
      assert.equal(isRetryableStatus(code), true, `${code} should retry`);
    }
    assert.equal(isRetryableStatus(500), false);
    assert.equal(isRetryableStatus(503), false);
    assert.equal(isRetryableStatus(529), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(200), false);
  });

  it('detects SSE error envelopes and quota body text', () => {
    assert.equal(looksLikeErrorBody('event: error\ndata: {"type":"error"}\n\n'), true);
    assert.equal(looksLikeErrorBody('data: {"type":"error","error":{"message":"out of extra usage"}}\n\n'), true);
    assert.equal(looksLikeErrorBody('data: {"type":"message_start"}\n\n'), false);
  });
});

// ---------------------------------------------------------------------------
// Integration: normal flow (no 429) — OAuth forwarded unchanged
// ---------------------------------------------------------------------------

describe('startFallbackProxy — normal flow', () => {
  it('forwards original OAuth Authorization unchanged on non-429 response', async () => {
    let receivedAuth = '';
    const upstream = await createUpstream((req, res) => {
      receivedAuth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer sk-ant-oat01-original', 'content-type': 'application/json' },
        body: '{"model":"claude-3"}',
      });
      assert.equal(receivedAuth, 'Bearer sk-ant-oat01-original');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('does NOT strip oauth-2025-04-20 from anthropic-beta on the first attempt', async () => {
    let receivedBeta = '';
    const upstream = await createUpstream((req, res) => {
      receivedBeta = req.headers['anthropic-beta'] as string ?? '';
      res.writeHead(200); res.end('ok');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' },
      });
      assert.ok(receivedBeta.includes('oauth-2025-04-20'), 'oauth beta preserved on first attempt');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('passes through the response status unchanged', async () => {
    const upstream = await createUpstream((_req, res) => {
      res.writeHead(401); res.end('{"error":"unauthorized"}');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    try {
      const { status } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' },
      });
      assert.equal(status, 401);
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('pipes the request body to the upstream unchanged', async () => {
    let receivedBody = '';
    const upstream = await createUpstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => { receivedBody = Buffer.concat(chunks).toString(); res.writeHead(200); res.end(); });
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' }, body,
      });
      assert.equal(receivedBody, body);
    } finally {
      proxy.close();
      await upstream.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: 429 fallback — switches to API key on the same account
// ---------------------------------------------------------------------------

describe('startFallbackProxy — 429 fallback', () => {
  it('retries with API key after a 429 and returns the successful response', async () => {
    let callCount = 0;
    let lastAuth = '';
    const upstream = await createUpstream((req, res) => {
      callCount++;
      lastAuth = req.headers['authorization'] ?? '';
      if (callCount === 1) {
        res.writeHead(429, { 'content-type': 'application/json' }); res.end('{}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      }
    });
    const proxy = await startFallbackProxy('sk-ant-api03-mykey', true, upstream.url);
    try {
      const { status } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer sk-ant-oat01-orig' },
        body: 'payload',
      });
      assert.equal(status, 200);
      assert.equal(callCount, 2, 'upstream called twice');
      assert.equal(lastAuth, '', 'retry strips OAuth Authorization');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('sends x-api-key on the retry', async () => {
    let callCount = 0;
    let retryApiKey = '';
    const upstream = await createUpstream((req, res) => {
      callCount++;
      if (callCount === 1) {
        res.writeHead(429); res.end();
      } else {
        retryApiKey = req.headers['x-api-key'] as string ?? '';
        res.writeHead(200); res.end('ok');
      }
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer sk-ant-oat01-x' },
      });
      assert.equal(retryApiKey, 'sk-ant-api03-key');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('strips oauth-2025-04-20 from anthropic-beta on the API key retry', async () => {
    let callCount = 0;
    let retryBeta = '';
    const upstream = await createUpstream((req, res) => {
      callCount++;
      if (callCount === 1) {
        res.writeHead(429); res.end();
      } else {
        retryBeta = req.headers['anthropic-beta'] as string ?? '';
        res.writeHead(200); res.end('ok');
      }
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: {
          authorization: 'Bearer sk-ant-oat01-x',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,prompt-caching',
        },
      });
      assert.ok(!retryBeta.includes('oauth-2025-04-20'), 'oauth beta stripped on retry');
      assert.ok(retryBeta.includes('claude-code-20250219'), 'other betas preserved on retry');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('sends the same request body on the retry', async () => {
    const bodies: string[] = [];
    const upstream = await createUpstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString());
        if (bodies.length === 1) { res.writeHead(429); res.end(); }
        else { res.writeHead(200); res.end('ok'); }
      });
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    const body = 'original-request-body';
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' }, body,
      });
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0], body);
      assert.equal(bodies[1], body);
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('passes through 429 from the API key retry (both paths exhausted)', async () => {
    const upstream = await createUpstream((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' }); res.end('{}');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    try {
      const { status } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' },
      });
      assert.equal(status, 429, 'final 429 passed back to client');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });
});

describe('startFallbackProxy — conservative retry policy', () => {
  it('does not retry ambiguous 5xx responses', async () => {
    let callCount = 0;
    const upstream = await createUpstream((_req, res) => {
      callCount++;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"server error"}');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    try {
      const { status, body } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' },
      });
      assert.equal(status, 500);
      assert.equal(body, '{"error":"server error"}');
      assert.equal(callCount, 1);
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('rejects oversized request bodies before forwarding upstream', async () => {
    let callCount = 0;
    const upstream = await createUpstream((_req, res) => {
      callCount++;
      res.writeHead(200);
      res.end('ok');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', false, upstream.url, 8);
    try {
      const { status, body } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' },
        body: '0123456789',
      });
      assert.equal(status, 413);
      assert.match(body, /request_too_large/);
      assert.equal(callCount, 0);
    } finally {
      proxy.close();
      await upstream.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: startWithOAuth = false (API-key-first mode)
// ---------------------------------------------------------------------------

describe('startFallbackProxy — API-key-first mode (startWithOAuth=false)', () => {
  it('uses API key from the first request, no OAuth attempt', async () => {
    let receivedAuth = '';
    const upstream = await createUpstream((req, res) => {
      receivedAuth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-mykey', false, upstream.url);
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer sk-ant-oat01-original' },
        body: 'payload',
      });
      assert.equal(receivedAuth, '', 'OAuth Authorization removed from first request');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('sends x-api-key from the first request', async () => {
    let receivedApiKey = '';
    const upstream = await createUpstream((req, res) => {
      receivedApiKey = req.headers['x-api-key'] as string ?? '';
      res.writeHead(200); res.end('ok');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-mykey', false, upstream.url);
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer sk-ant-oat01-original' },
      });
      assert.equal(receivedApiKey, 'sk-ant-api03-mykey');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('strips oauth-2025-04-20 from anthropic-beta on the first request', async () => {
    let receivedBeta = '';
    const upstream = await createUpstream((req, res) => {
      receivedBeta = req.headers['anthropic-beta'] as string ?? '';
      res.writeHead(200); res.end('ok');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', false, upstream.url);
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: {
          authorization: 'Bearer sk-ant-oat01-x',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,prompt-caching',
        },
      });
      assert.ok(!receivedBeta.includes('oauth-2025-04-20'), 'oauth beta stripped');
      assert.ok(receivedBeta.includes('claude-code-20250219'), 'other betas preserved');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('passes 429 through without retrying (only one upstream call)', async () => {
    let callCount = 0;
    const upstream = await createUpstream((_req, res) => {
      callCount++;
      res.writeHead(429, { 'content-type': 'application/json' }); res.end('{}');
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', false, upstream.url);
    try {
      const { status } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' },
      });
      assert.equal(status, 429, '429 passed through');
      assert.equal(callCount, 1, 'upstream called exactly once (no retry)');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: SSE passthrough
// ---------------------------------------------------------------------------

describe('startFallbackProxy — SSE passthrough', () => {
  it('pipes a streaming response without buffering', async () => {
    const upstream = await createUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: chunk1\n\n');
      res.write('data: chunk2\n\n');
      res.end();
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    try {
      const { status, body, headers } = await httpRequest(
        `http://127.0.0.1:${proxy.port}/v1/messages`,
        { headers: { authorization: 'Bearer tok' } },
      );
      assert.equal(status, 200);
      assert.ok(headers['content-type']?.includes('text/event-stream'));
      assert.ok(body.includes('chunk1'));
      assert.ok(body.includes('chunk2'));
    } finally {
      proxy.close();
      await upstream.close();
    }
  });
});

describe('startFallbackProxy — body error fallback', () => {
  it('retries with API key when HTTP 200 SSE starts with an error event', async () => {
    let callCount = 0;
    let retryApiKey = '';
    const upstream = await createUpstream((req, res) => {
      callCount++;
      if (callCount === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: error\ndata: {"type":"error","error":{"message":"out of extra usage"}}\n\n');
      } else {
        retryApiKey = req.headers['x-api-key'] as string ?? '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
    const proxy = await startFallbackProxy('sk-ant-api03-key', true, upstream.url);
    try {
      const { status, body } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer sk-ant-oat01-original' },
      });
      assert.equal(status, 200);
      assert.equal(body, '{"ok":true}');
      assert.equal(callCount, 2);
      assert.equal(retryApiKey, 'sk-ant-api03-key');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });
});
