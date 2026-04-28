// src/ui/set-apikey.ts
// Polished TUI for `claude switch apikey set`.

import * as p from '@clack/prompts';
import { getApiKey, maskApiKey, setApiKey } from '../apikey.js';

const KEY_PREFIX = 'sk-ant-';

export interface SetApiKeyResult {
  saved: boolean;
  cancelled: boolean;
  email: string;
}

export async function setApiKeyInteractive(
  email: string,
  accountsDirPath: string,
): Promise<SetApiKeyResult> {
  p.intro(`API key for ${email}`);

  const existing = getApiKey(email, accountsDirPath);
  if (existing) {
    const overwrite = await p.confirm({
      message: `An API key is already saved (${maskApiKey(existing)}). Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel('Cancelled. Existing key kept.');
      return { saved: false, cancelled: true, email };
    }
  }

  p.note(
    `Get your key at https://console.anthropic.com/settings/keys\nIt should start with "${KEY_PREFIX}"`,
    'Where to find a key',
  );

  const key = await p.password({
    message: 'Paste the key (input is hidden)',
    validate: (val) => {
      if (!val) return 'A key is required.';
      if (val.length < 20) return 'That looks too short to be a real key.';
      return undefined;
    },
  });

  if (p.isCancel(key)) {
    p.cancel('Cancelled. No key saved.');
    return { saved: false, cancelled: true, email };
  }

  const looksValid = key.startsWith(KEY_PREFIX);
  if (!looksValid) {
    p.note(
      `What you entered does not look like an Anthropic key.\n` +
      `Got: ${maskApiKey(key)}\n` +
      `Anthropic keys start with "${KEY_PREFIX}".`,
      'Heads up',
    );
    const proceed = await p.confirm({
      message: 'Save it anyway?',
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel('Cancelled. No key saved.');
      return { saved: false, cancelled: true, email };
    }
  }

  const spin = p.spinner();
  spin.start('Saving key');
  try {
    setApiKey(email, key, accountsDirPath);
    spin.stop(`Saved (${maskApiKey(key)})`);
  } catch (e) {
    spin.stop('Save failed');
    p.cancel((e as Error).message);
    return { saved: false, cancelled: false, email };
  }

  p.note(
    `Enable the fallback whenever you want to bill against API credits:\n` +
    `  claude switch fallback on\n\n` +
    `Claude Code may prompt to approve the key the first time it is used.`,
    'Next',
  );
  p.outro('Done.');

  return { saved: true, cancelled: false, email };
}
