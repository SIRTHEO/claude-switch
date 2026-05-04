// src/ui/auto-fallback-menu.ts
// TUI submenu for auto-fallback settings: auto-revert (fallback ON→OFF) and
// auto-engage (fallback OFF→ON). Both are opt-in and driven by the cached
// subscription usage so they require no extra network calls.

import * as p from '@clack/prompts';
import { getAutoFallbackConfig, setAutoFallbackConfig, type AutoFallbackConfig } from '../auto-fallback.js';

type AutoFallbackAction =
  | 'toggle-revert'
  | 'set-revert-threshold'
  | 'toggle-engage'
  | 'set-engage-threshold'
  | 'show-config'
  | 'back';

function buildMenuOptions(cfg: AutoFallbackConfig): Array<{ value: AutoFallbackAction; label: string; hint?: string }> {
  const options: Array<{ value: AutoFallbackAction; label: string; hint?: string }> = [];

  options.push({
    value: 'toggle-revert',
    label: cfg.enabled
      ? 'Disable auto-revert'
      : 'Enable auto-revert',
    hint: cfg.enabled
      ? `armed: fallback OFF when 5h+7d < ${cfg.threshold}%`
      : 'turn fallback OFF automatically when subscription frees up',
  });

  if (cfg.enabled) {
    options.push({
      value: 'set-revert-threshold',
      label: `Set auto-revert threshold (now: ${cfg.threshold}%)`,
      hint: 'fallback flips OFF when both 5h and 7d drop below this',
    });
  }

  options.push({
    value: 'toggle-engage',
    label: cfg.engageEnabled
      ? 'Disable auto-engage'
      : 'Enable auto-engage',
    hint: cfg.engageEnabled
      ? `armed: fallback ON when 5h or 7d ≥ ${cfg.engageThreshold}%`
      : 'turn fallback ON automatically when you approach the rate limit',
  });

  if (cfg.engageEnabled) {
    options.push({
      value: 'set-engage-threshold',
      label: `Set auto-engage threshold (now: ${cfg.engageThreshold}%)`,
      hint: 'fallback flips ON when either 5h or 7d crosses this',
    });
  }

  options.push({
    value: 'show-config',
    label: 'Show current config',
    hint: 'dump the full .auto-fallback.json settings',
  });

  options.push({ value: 'back', label: 'Back to main menu' });
  return options;
}

/**
 * Run the auto-fallback settings submenu loop. Returns when the user picks
 * Back / Esc / Ctrl+C.
 */
export async function runAutoFallbackMenu(accountsDirPath: string): Promise<void> {
  while (true) {
    const cfg = getAutoFallbackConfig(accountsDirPath);
    const options = buildMenuOptions(cfg);
    const choice = await p.select<AutoFallbackAction>({
      message: 'Auto-fallback settings',
      options,
    });
    if (p.isCancel(choice)) return;

    try {
      switch (choice) {
        case 'back':
          return;

        case 'toggle-revert': {
          if (cfg.enabled) {
            setAutoFallbackConfig(accountsDirPath, { enabled: false });
            p.note('Auto-revert OFF. Fallback toggle is fully manual again.', 'Done');
          } else {
            const tRaw = await p.text({
              message: 'Threshold % — fallback flips OFF when both 5h and 7d drop below this',
              placeholder: String(cfg.threshold),
              initialValue: String(cfg.threshold),
              validate: (val) => {
                const n = parseInt(val || '0', 10);
                if (!Number.isFinite(n) || n < 1 || n > 100) return 'Pick a number between 1 and 100.';
                return undefined;
              },
            });
            if (p.isCancel(tRaw)) break;
            const t = tRaw ? parseInt(tRaw, 10) : cfg.threshold;
            const next = setAutoFallbackConfig(accountsDirPath, { enabled: true, threshold: t });
            p.note(
              `Auto-revert ON (threshold ${next.threshold}%).\n\n` +
              `When fallback is on, the next "claude" run turns it off\n` +
              `as soon as both 5h and 7d utilisation drop below ${next.threshold}%.`,
              'Done',
            );
          }
          break;
        }

        case 'set-revert-threshold': {
          const tRaw = await p.text({
            message: 'New auto-revert threshold %',
            placeholder: String(cfg.threshold),
            initialValue: String(cfg.threshold),
            validate: (val) => {
              const n = parseInt(val || '0', 10);
              if (!Number.isFinite(n) || n < 1 || n > 100) return 'Pick a number between 1 and 100.';
              if (n >= cfg.engageThreshold) {
                return `Must be strictly less than the auto-engage threshold (${cfg.engageThreshold}%) to avoid oscillation.`;
              }
              return undefined;
            },
          });
          if (p.isCancel(tRaw)) break;
          const t = parseInt(tRaw, 10);
          const next = setAutoFallbackConfig(accountsDirPath, { threshold: t });
          p.note(`Auto-revert threshold set to ${next.threshold}%.`, 'Done');
          break;
        }

        case 'toggle-engage': {
          if (cfg.engageEnabled) {
            setAutoFallbackConfig(accountsDirPath, { engageEnabled: false });
            p.note('Auto-engage OFF. Fallback will not be turned on automatically.', 'Done');
          } else {
            const tRaw = await p.text({
              message: 'Threshold % — fallback flips ON when 5h or 7d crosses this',
              placeholder: String(cfg.engageThreshold),
              initialValue: String(cfg.engageThreshold),
              validate: (val) => {
                const n = parseInt(val || '0', 10);
                if (!Number.isFinite(n) || n < 1 || n > 100) return 'Pick a number between 1 and 100.';
                if (n <= cfg.threshold) {
                  return `Must be strictly greater than the auto-revert threshold (${cfg.threshold}%) to avoid oscillation.`;
                }
                return undefined;
              },
            });
            if (p.isCancel(tRaw)) break;
            const t = tRaw ? parseInt(tRaw, 10) : cfg.engageThreshold;
            const next = setAutoFallbackConfig(accountsDirPath, { engageEnabled: true, engageThreshold: t });
            p.note(
              `Auto-engage ON (threshold ${next.engageThreshold}%).\n\n` +
              `The next "claude" run turns fallback ON as soon as 5h or 7d\n` +
              `utilisation hits ${next.engageThreshold}% — requires a saved API key.`,
              'Done',
            );
          }
          break;
        }

        case 'set-engage-threshold': {
          const tRaw = await p.text({
            message: 'New auto-engage threshold %',
            placeholder: String(cfg.engageThreshold),
            initialValue: String(cfg.engageThreshold),
            validate: (val) => {
              const n = parseInt(val || '0', 10);
              if (!Number.isFinite(n) || n < 1 || n > 100) return 'Pick a number between 1 and 100.';
              if (n <= cfg.threshold) {
                return `Must be strictly greater than the auto-revert threshold (${cfg.threshold}%) to avoid oscillation.`;
              }
              return undefined;
            },
          });
          if (p.isCancel(tRaw)) break;
          const t = parseInt(tRaw, 10);
          const next = setAutoFallbackConfig(accountsDirPath, { engageThreshold: t });
          p.note(`Auto-engage threshold set to ${next.engageThreshold}%.`, 'Done');
          break;
        }

        case 'show-config': {
          const lines = [
            `Auto-revert:  ${cfg.enabled ? `ON (threshold ${cfg.threshold}%)` : 'OFF'}`,
            `Auto-engage:  ${cfg.engageEnabled ? `ON (threshold ${cfg.engageThreshold}%)` : 'OFF'}`,
            '',
            'Hysteresis: engage ≥ engage-threshold, revert < revert-threshold.',
            `Current: engage at ${cfg.engageThreshold}% → revert at ${cfg.threshold}%.`,
          ];
          p.note(lines.join('\n'), 'Auto-fallback config');
          break;
        }
      }
    } catch (e) {
      p.note((e as Error).message, 'Error');
    }
  }
}
