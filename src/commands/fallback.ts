// src/commands/fallback.ts
// `claude switch fallback …` and `… auto-revert / auto-engage` — manage
// the global fallback flag + the auto-fallback config.

import { ExitError, errMessage } from '../errors.js';
import { getCurrent } from '../accounts.js';
import { getApiKey } from '../apikey.js';
import { isFallbackEnabled, setFallbackEnabled } from '../fallback.js';
import { getAutoFallbackConfig, setAutoFallbackConfig } from '../auto-fallback.js';
import type { CommandContext } from './context.js';
import type { FallbackStatus } from '../contract.js';

export interface FallbackOptions {
  json: boolean;
}

export function handleFallback(
  ctx: CommandContext,
  mode: 'on' | 'off' | 'status',
  opts: FallbackOptions = { json: false },
): void {
  const { claudeJsonPath, accountsDirPath } = ctx;
  if (mode === 'status') {
    const on = isFallbackEnabled(accountsDirPath);
    const auto = getAutoFallbackConfig(accountsDirPath);
    const current = getCurrent(claudeJsonPath);
    const hasKey = current ? !!getApiKey(current, accountsDirPath) : false;

    if (opts.json) {
      // Atomic snapshot — the GUI reads fallback + auto-revert + auto-engage
      // off a single command instead of stitching three text outputs.
      const status: FallbackStatus = {
        enabled: on,
        autoRevert: {
          enabled: auto.enabled,
          threshold: auto.threshold,
        },
        autoEngage: {
          enabled: auto.engageEnabled,
          threshold: auto.engageThreshold,
        },
        activeAccount: current || null,
        hasApiKey: hasKey,
      };
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return;
    }

    console.log(`Fallback to API key:           ${on ? 'ON' : 'OFF'}`);
    console.log(
      `auto-revert (5h+7d below ${auto.threshold}%): ${auto.enabled ? 'ON' : 'OFF'}`,
    );
    console.log(
      `auto-engage (5h or 7d ≥ ${auto.engageThreshold}%):  ${auto.engageEnabled ? 'ON' : 'OFF'}`,
    );
    if (current) {
      console.log(
        `\nActive account ${current}: ${hasKey ? 'has API key' : 'no API key (run: claude switch apikey set)'}`,
      );
    }
    if (on && current && !hasKey) {
      console.log('Warning: fallback is on but the active account has no saved API key — claude will use OAuth.');
    }
    return;
  }
  const on = mode === 'on';
  setFallbackEnabled(accountsDirPath, on);
  console.log(`Fallback: ${on ? 'on' : 'off'}`);
  if (on) {
    const current = getCurrent(claudeJsonPath);
    if (current && !getApiKey(current, accountsDirPath)) {
      console.log(`Note: active account ${current} has no saved API key. Run: claude switch apikey set ${current}`);
    } else if (current) {
      console.log('Subsequent `claude` runs will inject the saved API key as ANTHROPIC_API_KEY.');
      console.log('');
      console.log('IMPORTANT: the first time, Claude Code will prompt:');
      console.log('    "Use this API key? [y/N]"');
      console.log('Press y to approve — your choice is remembered.');
      console.log('If you miss it or press N, claude silently keeps using OAuth.');
    }
  }
}

export function handleFallbackAuto(
  ctx: CommandContext,
  mode: 'on' | 'off' | 'status',
  threshold: number | undefined,
): void {
  const { claudeJsonPath, accountsDirPath } = ctx;
  const config = getAutoFallbackConfig(accountsDirPath);
  if (mode === 'status') {
    console.log(`Smart-switch: ${config.enabled ? 'on' : 'off'}`);
    console.log(`Threshold:    ${config.threshold}% (5h and 7d must drop below this)`);
    if (config.enabled) {
      const current = getCurrent(claudeJsonPath);
      const hasKey = current ? !!getApiKey(current, accountsDirPath) : false;
      if (!current) {
        console.log('No active account — smart-switch only acts on the active one.');
      } else if (!hasKey) {
        console.log(`Note: ${current} has no saved API key, so fallback would do nothing anyway.`);
      }
    }
    return;
  }
  const enabled = mode === 'on';
  const next = setAutoFallbackConfig(accountsDirPath, {
    enabled,
    ...(threshold !== undefined ? { threshold } : {}),
  });
  console.log(`Smart-switch: ${next.enabled ? 'on' : 'off'}`);
  if (enabled) {
    console.log(`Threshold:    ${next.threshold}%`);
    console.log(
      `\nWhen fallback is on, claude-switch will turn it back off the next ` +
      `time you run \`claude\` if both 5h and 7d utilisation drop below ` +
      `${next.threshold}% — saving your API credits the moment your ` +
      `subscription has headroom again.`,
    );
  }
}

export function handleFallbackAutoEngage(
  ctx: CommandContext,
  mode: 'on' | 'off' | 'status',
  threshold: number | undefined,
): void {
  const { claudeJsonPath, accountsDirPath } = ctx;
  const config = getAutoFallbackConfig(accountsDirPath);
  if (mode === 'status') {
    console.log(`Auto-engage:  ${config.engageEnabled ? 'on' : 'off'}`);
    console.log(`Threshold:    ${config.engageThreshold}% (either 5h or 7d at/above flips fallback ON)`);
    if (config.engageEnabled) {
      const current = getCurrent(claudeJsonPath);
      const hasKey = current ? !!getApiKey(current, accountsDirPath) : false;
      if (!current) {
        console.log('No active account — auto-engage only acts on the active one.');
      } else if (!hasKey) {
        console.log(`Note: ${current} has no saved API key, so auto-engage would be blocked.`);
      }
    }
    return;
  }
  const engageEnabled = mode === 'on';
  try {
    const next = setAutoFallbackConfig(accountsDirPath, {
      engageEnabled,
      ...(threshold !== undefined ? { engageThreshold: threshold } : {}),
    });
    console.log(`Auto-engage:  ${next.engageEnabled ? 'on' : 'off'}`);
    if (engageEnabled) {
      console.log(`Threshold:    ${next.engageThreshold}%`);
      console.log(
        `\nWhen fallback is off and either 5h or 7d utilisation reaches ` +
        `${next.engageThreshold}%, claude-switch will turn fallback ON on ` +
        `the next \`claude\` run (provided the active account has a saved ` +
        `API key) — so you don't stare at a rate-limit error mid-session.`,
      );
    }
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
}
