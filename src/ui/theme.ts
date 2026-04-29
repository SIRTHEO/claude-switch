// src/ui/theme.ts
// Centralised palette so every TUI flow has a consistent brand identity.
//
// Anthropic's Claude brand colour is a warm orange around #D97757. We use
// that for primary accents (intro/outro labels, summary headers, key
// brand moments). @clack/prompts symbols stay on their default cyan/green
// since those are widely recognised as "step in progress / success" cues
// across the ecosystem (create-vite, create-astro, etc.) and changing them
// would only confuse users who already know the convention.

const SUPPORTS_TRUECOLOR = !!(
  process.env.COLORTERM &&
  /(truecolor|24bit)/i.test(process.env.COLORTERM)
);

// 24-bit if available (vivid Claude orange); fall back to ANSI-256 code 209
// (closest match to #D97757) and finally to plain bright yellow on dumb
// terminals so accents are still visible.
function orange(s: string): string {
  if (process.env.NO_COLOR) return s;
  if (SUPPORTS_TRUECOLOR) return `\x1b[38;2;217;119;87m${s}\x1b[0m`;
  return `\x1b[38;5;209m${s}\x1b[0m`;
}

function bold(s: string): string {
  if (process.env.NO_COLOR) return s;
  return `\x1b[1m${s}\x1b[0m`;
}

function dim(s: string): string {
  if (process.env.NO_COLOR) return s;
  return `\x1b[2m${s}\x1b[0m`;
}

export const theme = {
  /** Brand orange — use sparingly for the highest-priority accent. */
  brand: orange,
  /** Bold + brand orange for primary headings. */
  heading: (s: string): string => bold(orange(s)),
  /** De-emphasised secondary text. */
  dim,
  /** Standard bold (no colour) for emphasis without theming. */
  bold,
  /** A short branded title used for intro() arguments. */
  title: (label: string): string => bold(orange(`◆ ${label}`)),
};
