// test/ui/ink-keystroke-helper.ts
// Helper to simulate ANSI/CSI multi-byte keystrokes via ink-testing-library
// instances. ink's useInput hook processes escape sequences asynchronously,
// so each method awaits a setImmediate tick to let Ink handle the input
// before control returns to the caller.

// ink-testing-library does not export the Instance type, so we extract the
// minimum structural requirement we depend on: a stdin with a write method.
interface InkInstance {
  stdin: { write(data: string): void };
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface KeystrokeHelper {
  /** Send ESC (\x1B). */
  pressEsc(): Promise<void>;
  /** Send an arrow key CSI sequence. */
  pressArrow(direction: 'up' | 'down' | 'left' | 'right'): Promise<void>;
  /** Send carriage-return (\r). */
  pressEnter(): Promise<void>;
  /** Send horizontal tab (\t). */
  pressTab(): Promise<void>;
  /** Send DEL / Backspace (\x7F). */
  pressBackspace(): Promise<void>;
  /** Send a single printable character. */
  pressKey(key: string): Promise<void>;
  /** Write an arbitrary string directly (useful for multi-char input fields). */
  type(text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// ANSI / CSI byte sequences
// ---------------------------------------------------------------------------

const SEQ = {
  ESC: '\x1B',
  UP: '\x1B[A',
  DOWN: '\x1B[B',
  RIGHT: '\x1B[C',
  LEFT: '\x1B[D',
  ENTER: '\r',
  TAB: '\t',
  BACKSPACE: '\x7F',
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Ink buffers standalone ESC bytes with a ~20 ms timer before deciding
// whether to flush them as a literal escape or wait for a CSI tail.
// We wait long enough to guarantee the flush has happened.
const ESC_FLUSH_DELAY_MS = 50;

/** Creates a KeystrokeHelper bound to the provided ink-testing-library instance. */
export function makeKeystrokeHelper(instance: InkInstance): KeystrokeHelper {
  async function write(data: string): Promise<void> {
    instance.stdin.write(data);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function writeWithDelay(data: string, delayMs: number): Promise<void> {
    instance.stdin.write(data);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  return {
    // ESC alone triggers a 20 ms internal timer in Ink's App component before
    // the key is emitted as `key.escape`. Use a longer wait to clear it.
    pressEsc: () => writeWithDelay(SEQ.ESC, ESC_FLUSH_DELAY_MS),
    pressArrow: (direction) => {
      switch (direction) {
        case 'up':    return write(SEQ.UP);
        case 'down':  return write(SEQ.DOWN);
        case 'right': return write(SEQ.RIGHT);
        case 'left':  return write(SEQ.LEFT);
      }
    },
    pressEnter:     () => write(SEQ.ENTER),
    pressTab:       () => write(SEQ.TAB),
    pressBackspace: () => write(SEQ.BACKSPACE),
    pressKey:       (key: string) => write(key),
    type:           (text: string) => write(text),
  };
}
