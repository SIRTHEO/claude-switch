// src/oauth-refresh.ts
// Anthropic OAuth refresh-token client.
//
// Why this exists: account snapshots saved by `claude switch add` may
// sit dormant for weeks before the user opens the matching profile
// isolated. By the time we restore that snapshot's `_keychain` block
// into a profile's Keychain entry, the access_token is almost
// certainly expired. Real claude in non-interactive mode (`--print`)
// won't auto-refresh from a profile config — it just emits 401. So
// claude-switch refreshes BEFORE handing tokens over.
//
// Endpoint shape reverse-engineered from the production claude binary
// (v2.x). All values are public OAuth client metadata, not secrets.
//
// Failure mode is silent — if the refresh fails (network, expired
// refresh_token, endpoint moved), we return null and the caller falls
// through to "needsLogin: true". Better UX than re-throwing into the
// "Open account isolated" hot path.

import type { ClaudeAiOauth } from './keychain.js';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_BETA = 'oauth-2025-04-20';

// Refresh access tokens that are less than this many milliseconds from
// expiry. Mirrors the buffer claude itself uses (≈60s) so behaviour
// stays consistent — we don't want claude-switch to call refresh after
// claude already did, or vice versa.
const EXPIRY_BUFFER_MS = 60_000;

/** True when the access token is expired or within the refresh buffer. */
export function isAccessTokenStale(oauth: ClaudeAiOauth | undefined): boolean {
  if (!oauth?.expiresAt) return true;
  const expiresAt = typeof oauth.expiresAt === 'number'
    ? oauth.expiresAt
    : Number(oauth.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return Date.now() >= expiresAt - EXPIRY_BUFFER_MS;
}

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Exchange a refresh_token for a fresh access_token by hitting the
 * Anthropic OAuth endpoint. Returns the FULL refreshed
 * `claudeAiOauth` block (mirroring the shape we already store in the
 * Keychain) or null on any failure.
 *
 * The fetch is gated behind `globalThis.fetch` so this stays
 * compatible with Node 18+ without a runtime dependency. Tests can
 * inject a mock via `deps.fetch`.
 */
export async function refreshAccessToken(
  refreshToken: string,
  deps: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<ClaudeAiOauth | null> {
  if (!refreshToken) return null;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': ANTHROPIC_BETA,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: deps.signal,
    });
  } catch {
    // Network error — caller falls through to needsLogin.
    return null;
  }

  if (!res.ok) return null;

  let body: RefreshResponse;
  try {
    body = (await res.json()) as RefreshResponse;
  } catch {
    return null;
  }

  if (!body.access_token || !body.expires_in) return null;

  const expiresAt = Date.now() + body.expires_in * 1000;

  return {
    accessToken: body.access_token,
    // Refresh tokens are usually long-lived but the server CAN issue a
    // new one (rotation). Honour rotation: prefer the new value, fall
    // back to the one we had.
    refreshToken: body.refresh_token ?? refreshToken,
    expiresAt,
    scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : undefined,
  };
}

/**
 * Convenience wrapper: refreshes only if the access token is stale.
 * Returns the (possibly-refreshed) oauth block, or null if refresh
 * failed and we have no usable fallback.
 */
export async function refreshIfStale(
  oauth: ClaudeAiOauth | undefined,
): Promise<ClaudeAiOauth | null> {
  if (!oauth) return null;
  if (!isAccessTokenStale(oauth)) return oauth;
  if (!oauth.refreshToken) return null;
  const refreshed = await refreshAccessToken(oauth.refreshToken);
  return refreshed;
}
