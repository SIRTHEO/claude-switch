import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startRotatingProxy, buildForwardHeaders, stripOauthBeta } from '../src/api-proxy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spin up a minimal HTTP server that handles one request at a time. */
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

/** Make a simple HTTP request and return status + body + headers received by upstream. */
function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
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
// Unit: buildForwardHeaders
// ---------------------------------------------------------------------------

describe('buildForwardHeaders', () => {
  it('replaces authorization header with API key', () => {
    const headers = buildForwardHeaders(
      { authorization: 'Bearer sk-ant-oat01-abc', host: 'api.anthropic.com' },
      'sk-ant-api03-xyz',
    );
    assert.equal(headers['authorization'], 'Bearer sk-ant-api03-xyz');
  });

  it('drops the host header', () => {
    const headers = buildForwardHeaders(
      { host: 'api.anthropic.com', 'content-type': 'application/json' },
      'sk-ant-api03-key',
    );
    assert.equal(headers['host'], undefined);
    assert.equal(headers['content-type'], 'application/json');
  });

  it('strips oauth-2025-04-20 from anthropic-beta', () => {
    const headers = buildForwardHeaders(
      {
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking',
        authorization: 'Bearer sk-ant-oat01-abc',
      },
      'sk-ant-api03-key',
    );
    assert.equal(headers['anthropic-beta'], 'claude-code-20250219,interleaved-thinking');
  });

  it('removes anthropic-beta entirely when only oauth token was present', () => {
    const headers = buildForwardHeaders(
      { 'anthropic-beta': 'oauth-2025-04-20', authorization: 'Bearer sk-ant-oat01-abc' },
      'sk-ant-api03-key',
    );
    assert.equal(headers['anthropic-beta'], undefined);
  });

  it('keeps anthropic-beta unchanged when no oauth token present', () => {
    const headers = buildForwardHeaders(
      { 'anthropic-beta': 'claude-code-20250219,some-beta', authorization: 'Bearer tok' },
      'sk-ant-api03-key',
    );
    assert.equal(headers['anthropic-beta'], 'claude-code-20250219,some-beta');
  });
});

// ---------------------------------------------------------------------------
// Integration: proxy forwarding
// ---------------------------------------------------------------------------

describe('startRotatingProxy — forwarding', () => {
  let upstream: { url: string; close: () => Promise<void> };
  let receivedHeaders: http.IncomingHttpHeaders;
  let receivedBody: string;

  before(async () => {
    upstream = await createUpstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedHeaders = req.headers;
        receivedBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
  });

  after(() => upstream.close());

  it('replaces Authorization with the first account API key', async () => {
    const proxy = await startRotatingProxy(
      [{ email: 'a@test.com', apiKey: 'sk-ant-api03-first' }],
      upstream.url,
    );
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: {
          authorization: 'Bearer sk-ant-oat01-original',
          'content-type': 'application/json',
        },
        body: '{"model":"claude-3"}',
      });
      assert.equal(receivedHeaders['authorization'], 'Bearer sk-ant-api03-first');
    } finally {
      proxy.close();
    }
  });

  it('strips oauth-2025-04-20 from anthropic-beta before forwarding', async () => {
    const proxy = await startRotatingProxy(
      [{ email: 'a@test.com', apiKey: 'sk-ant-api03-key' }],
      upstream.url,
    );
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: {
          authorization: 'Bearer sk-ant-oat01-x',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,prompt-caching',
        },
      });
      assert.equal(receivedHeaders['anthropic-beta'], 'claude-code-20250219,prompt-caching');
    } finally {
      proxy.close();
    }
  });

  it('forwards the request body unchanged', async () => {
    const proxy = await startRotatingProxy(
      [{ email: 'a@test.com', apiKey: 'sk-ant-api03-key' }],
      upstream.url,
    );
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body,
      });
      assert.equal(receivedBody, body);
    } finally {
      proxy.close();
    }
  });

  it('passes through non-429 response status', async () => {
    const alt = await createUpstream((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    const proxy = await startRotatingProxy(
      [{ email: 'a@test.com', apiKey: 'sk-ant-api03-key' }],
      alt.url,
    );
    try {
      const { status } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' },
      });
      assert.equal(status, 401);
    } finally {
      proxy.close();
      await alt.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: 429 rotation
// ---------------------------------------------------------------------------

describe('startRotatingProxy — 429 rotation', () => {
  it('rotates to second account on 429 and uses its API key', async () => {
    let callCount = 0;
    let lastAuthHeader = '';

    const upstream = await createUpstream((req, res) => {
      callCount++;
      lastAuthHeader = req.headers['authorization'] ?? '';
      if (callCount === 1) {
        // First account: simulate rate limit
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate_limit' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    const proxy = await startRotatingProxy(
      [
        { email: 'a@test.com', apiKey: 'sk-ant-api03-first' },
        { email: 'b@test.com', apiKey: 'sk-ant-api03-second' },
      ],
      upstream.url,
    );

    try {
      const { status } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer sk-ant-oat01-orig' },
        body: 'request-body',
      });
      assert.equal(status, 200);
      assert.equal(callCount, 2);
      assert.equal(lastAuthHeader, 'Bearer sk-ant-api03-second');
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('returns 429 when all accounts are exhausted', async () => {
    const upstream = await createUpstream((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_limit' }));
    });

    const proxy = await startRotatingProxy(
      [
        { email: 'a@test.com', apiKey: 'sk-ant-api03-a' },
        { email: 'b@test.com', apiKey: 'sk-ant-api03-b' },
      ],
      upstream.url,
    );

    try {
      const { status, body } = await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' },
      });
      assert.equal(status, 429);
      const parsed: unknown = JSON.parse(body);
      assert.ok(parsed && typeof parsed === 'object' && 'error' in parsed);
    } finally {
      proxy.close();
      await upstream.close();
    }
  });

  it('retries each account with the same request body', async () => {
    const receivedBodies: string[] = [];

    const upstream = await createUpstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(Buffer.concat(chunks).toString());
        if (receivedBodies.length === 1) {
          res.writeHead(429); res.end();
        } else {
          res.writeHead(200); res.end('ok');
        }
      });
    });

    const proxy = await startRotatingProxy(
      [
        { email: 'a@test.com', apiKey: 'sk-ant-api03-a' },
        { email: 'b@test.com', apiKey: 'sk-ant-api03-b' },
      ],
      upstream.url,
    );

    const body = 'the-original-body';
    try {
      await httpRequest(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        headers: { authorization: 'Bearer tok' },
        body,
      });
      assert.equal(receivedBodies.length, 2);
      assert.equal(receivedBodies[0], body);
      assert.equal(receivedBodies[1], body);
    } finally {
      proxy.close();
      await upstream.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: SSE passthrough
// ---------------------------------------------------------------------------

describe('startRotatingProxy — SSE passthrough', () => {
  it('pipes a streaming response without buffering', async () => {
    const upstream = await createUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.write('data: chunk1\n\n');
      res.write('data: chunk2\n\n');
      res.end();
    });

    const proxy = await startRotatingProxy(
      [{ email: 'a@test.com', apiKey: 'sk-ant-api03-key' }],
      upstream.url,
    );

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
