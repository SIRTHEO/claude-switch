// src/commands/passthrough-banners.ts
// Transition / status banners for the passthrough hot path, split out of
// passthrough.ts to keep that handler within the file-size budget. Pure
// stderr emission: takes the resolved snapshot fields and writes the routing,
// auto-revert, auto-engage, update, and active-account banners in order.

import { VERSION } from '../setup/version.js';
import { formatUpdateNotice } from '../setup/update-check.js';
import { getApiKey } from '../credentials/apikey.js';
import { readUsageCacheForAccount } from '../usage/usage.js';
import type { maybeAutoDisableFallback, maybeAutoEngageFallback } from '../fallback/auto-fallback.js';
import type { resolveRoutingForPassthrough } from './passthrough-routing.js';
import type { CommandContext } from './context.js';

// Infer the shapes from their producers so this module needs no new exports
// from the internal fallback / routing modules (keeps the API surface tight).
type AutoDisable = ReturnType<typeof maybeAutoDisableFallback>;
type AutoEngage = ReturnType<typeof maybeAutoEngageFallback>;
type Routing = ReturnType<typeof resolveRoutingForPassthrough>;

export function emitPassthroughBanners(params: {
  accountsDirPath: string;
  email: string;
  wasUnsaved: boolean;
  auto: AutoDisable;
  engage: AutoEngage;
  routing: Routing;
  extraEnv: NodeJS.ProcessEnv | null;
  updateInfo: CommandContext['updateInfo'];
}): void {
  const { accountsDirPath, email, wasUnsaved, auto, engage, routing, extraEnv, updateInfo } = params;

  // Routing banners — emitted BEFORE the standard "🔑 <email>" banner so
  // the user sees the cause-and-effect chain.
  if (routing.flipped && routing.decision?.banner) {
    process.stderr.write(`${routing.decision.banner}\n\n`);
  } else if (routing.isolatedHint) {
    process.stderr.write(`${routing.isolatedHint}\n\n`);
  }
  if (routing.decision?.warning) {
    process.stderr.write(`${routing.decision.warning}\n\n`);
  }

  if (wasUnsaved) {
    process.stderr.write(`Detected account: ${email} (saved automatically)\n\n`);
  }
  if (auto.disabled) {
    const sevenStr = auto.sevenPct !== undefined ? `, 7d:${auto.sevenPct.toFixed(0)}%` : '';
    process.stderr.write(
      `📈 Subscription back online (5h:${auto.fivePct!.toFixed(0)}%${sevenStr}, ` +
      `threshold ${auto.threshold}%) — switched back to OAuth\n\n`,
    );
  }
  if (engage.engaged) {
    const win = engage.reason === '5h'
      ? `5h:${engage.fivePct!.toFixed(0)}%`
      : `7d:${engage.sevenPct!.toFixed(0)}%`;
    process.stderr.write(
      `📉 Subscription near cap (${win}, threshold ${engage.threshold}%) — ` +
      `switched to API key fallback\n\n`,
    );
  } else if (engage.blocked) {
    process.stderr.write(`⚠ auto-engage wanted to switch to API key but ${engage.blocked}\n\n`);
  }
  if (updateInfo) {
    // Critical updates render a loud banner even on this hot path; routine ones
    // stay a one-liner. Never blocks — claude still launches.
    process.stderr.write(
      formatUpdateNotice(updateInfo, VERSION, { color: process.stderr.isTTY === true }) + '\n',
    );
  }
  // Banner on stderr so we don't pollute structured stdout (e.g. when
  // claude is piped into jq with --output-format json).
  process.stderr.write(`🔑 ${email}\n\n`);
  if (extraEnv) {
    process.stderr.write('(fallback on — using saved API key)\n\n');
  } else {
    // Read-only check: if a recent usage snapshot says we're near the
    // limit and smart fallback isn't enabled (no config + key exists),
    // remind the user to save an API key to unlock auto-switching.
    // Never fetches — only consults whatever the user already cached.
    const cache = readUsageCacheForAccount(accountsDirPath, email);
    if (cache?.payload && cache.payload.five_hour.utilization >= 85 && getApiKey(email, accountsDirPath)) {
      process.stderr.write(
        `⚠ subscription 5h window at ${cache.payload.five_hour.utilization.toFixed(0)}%. ` +
        `Smart fallback will switch to your API key automatically.\n\n`,
      );
    }
  }
}
