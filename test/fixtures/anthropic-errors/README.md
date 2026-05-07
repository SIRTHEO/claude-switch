# Anthropic error response fixtures

Realistic captures of error response bodies that the production claude
binary either receives from `api.anthropic.com` or generates itself
when it surfaces a quota exhaustion to the user. Used by
`api-proxy.test.ts` to validate that `looksLikeErrorBody` matches
every shape we've observed in the wild.

## How these were sourced

The strings inside each fixture come from `strings $(cat ~/.claude/accounts/.claude-bin)`
on a real claude v2.1.x install — ie. the literal text the binary
constructs when it wraps an Anthropic-side error for display. The SSE
framing (`event:`, `data:`) and the JSON envelope shape mirror what
Anthropic emits on its `/v1/messages` endpoint in streaming mode.

These are NOT raw mitmproxy captures. We don't have a way to legally
exhaust an Anthropic test account on demand to capture one, and even
if we did, the response payload would contain account-identifying
metadata. Instead each fixture is a minimum-credible reconstruction:
- correct SSE framing per the documented public format
- exact error strings as they appear in the production binary
- the exact `error.type` tags Anthropic uses (`rate_limit_error`,
  `overloaded_error`, etc.)

## Adding a new fixture

When a user reports a "the proxy didn't fall back on this error"
incident:

1. Reproduce the failure (or get them to set
   `CLAUDE_SWITCH_PROXY_DEBUG=1` and capture the response head).
2. Sanitize: drop any `request-id`, `account-id`, model-version
   strings, replace timestamps with placeholders.
3. Add a new `<short-description>.txt` here. One per scenario.
4. The blanket test in `api-proxy.test.ts` will pick it up
   automatically and fail until `looksLikeErrorBody` recognises it.

The point is to build the corpus from REAL responses over time, not
from imagination. The previous matcher was wrong precisely because
its test fixtures were guesses (`"out of extra usage"` — what the user
sees rendered, not what's on the wire).
