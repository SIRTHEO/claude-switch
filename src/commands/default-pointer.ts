// src/commands/default-pointer.ts
// `claude switch default <name>` — re-point which workspace bare `claude`
// launches (the unified-profile default-pointer). `default` selects the global
// ~/.claude; any other value must be an existing profile. This sets the pointer
// only — the bare-`claude` path reads it and diverts to the pointed profile
// (see passthrough's default-pointer divert). It does NOT touch the global
// ~/.claude or any credential file.

import { ExitError, errMessage } from '../platform/errors.js';

export async function handleDefaultSet(accountsDirPath: string, name: string): Promise<void> {
  const { setDefaultPointer } = await import('../profiles/workspaces.js');
  try {
    setDefaultPointer(accountsDirPath, name);
  } catch (e) {
    throw new ExitError(errMessage(e));
  }
  if (name === 'default') {
    console.log('Default workspace set to the global account (~/.claude). Bare `claude` runs it.');
  } else {
    console.log(`Default workspace set to profile "${name}". Bare \`claude\` now launches it isolated.`);
  }
}
