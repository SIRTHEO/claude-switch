// src/ui/menu/lifecycle.ts
// Alternate-screen buffer constants + capability check.
//
// Entering the alt-buffer swaps the terminal to a fresh canvas (preserving
// the user's scrollback); exiting restores the original view. Without this,
// every menu iteration leaves a trail of status panels in the user's
// terminal history, which is what the menu is trying to NOT do — it should
// feel like a single live screen.
//
// Extracted from `main-menu.ts` during the 5.2 split so the orchestrator
// can keep its imports tight and so future menu files can reuse the
// constants without re-deriving them.

export const ALT_BUFFER_ENTER = '\x1b[?1049h';
export const ALT_BUFFER_EXIT = '\x1b[?1049l';
export const CLEAR_AND_HOME = '\x1b[2J\x1b[H';

/**
 * True when the terminal supports the alt-screen buffer. Only meaningful
 * on a real TTY — CI runners and piped output fall through to plain
 * inline rendering.
 */
export function altBufferSupported(): boolean {
  return !!process.stdout.isTTY && process.env.TERM !== 'dumb';
}
