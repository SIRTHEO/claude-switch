// src/ui/screen-buffer.ts
// Terminal alt-buffer + clear helpers shared by every Ink wrapper. Ink
// itself does NOT clear the scrollback when render() is called, so a
// persistent menu that mounts → unmounts → mounts a sub-screen leaves
// every previous frame stacked above the latest one (the "scrollback
// accumulation" bug).
//
// The fix is the convention every cmdline tool uses: enter the alt buffer
// once at the top of the persistent loop, clear-and-home before each new
// render(), exit the alt buffer when the loop ends.

export const ALT_BUFFER_ENTER = '\x1b[?1049h';
export const ALT_BUFFER_EXIT = '\x1b[?1049l';
export const CLEAR_AND_HOME = '\x1b[2J\x1b[H';

export function altBufferSupported(): boolean {
  if (process.env.NO_ALT_SCREEN === '1') return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

/** Clear the visible terminal area + park the cursor at the top-left. */
export function clearScreen(): void {
  if (process.stdout.isTTY) process.stdout.write(CLEAR_AND_HOME);
}
