import type { KeychainData } from './keychain.js';
import type { StoredAccountPrefs } from './preferences.js';

/**
 * On-disk shape of `~/.claude/accounts/<email>.json`.
 *
 * It is Claude Code's `oauthAccount` block (emailAddress + assorted fields the
 * binary writes — accountUuid, organization, … left untyped via the index
 * signature) plus claude-switch's internal snapshot fields, all `_`-prefixed.
 *
 * This interface is the single source of truth for those internal field names.
 * A field added to `accounts.save()` must be added here; TypeScript then flags
 * every reader (`accounts.load()`, migration, `apikey`, `usage`, `profiles`)
 * that forgot it — closing the "added on write, dropped on read" drift class.
 */
export interface AccountSnapshot {
  emailAddress?: string;
  /** OAuth + API-key credentials captured from the Keychain (macOS) or JSON. */
  _keychain?: KeychainData;
  /** Per-account API key used as fallback when subscription limits are hit. */
  _apiKey?: string;
  /** Per-account preferences embedded in the snapshot. */
  _prefs?: StoredAccountPrefs;
  /** Snapshot of Claude Code's `customApiKeyResponses` to stop cross-account leak. */
  _customApiKeyResponses?: unknown;
  /** API key the binary wrote top-level into `~/.claude.json` (billing-leak guard). */
  _claudeJsonApiKey?: string;
  // …other oauthAccount fields (accountUuid, organization, etc.) flow through.
  [k: string]: unknown;
}
