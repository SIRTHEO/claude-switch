// src/commands/help.ts
// `claude switch help` / --help / -h — prints the canonical command tree.
// Static text, no I/O — kept here just to keep the dispatcher uniform.

export function handleHelp(): void {
  console.log(`claude-switch — multi-account wrapper for Claude Code

Usage:
  claude switch                          Switch account (interactive menu)
  claude switch <alias|email>            Switch to account (alias or fuzzy match)
  claude switch add                      Add a new account (opens browser)
  claude switch list                     List saved accounts
  claude switch remove <email>           Remove a saved account
  claude switch status                   Show active account, token, fallback
  claude switch alias <n> <email>        Set an alias
  claude switch alias --list             List aliases
  claude switch alias --remove <n>       Remove an alias
  claude switch apikey set <a|e>         Save an Anthropic API key for an account
  claude switch apikey show <a|e>        Show saved API key (masked)
  claude switch apikey remove <a|e>      Delete saved API key
  claude switch fallback on|off|status   Toggle API key fallback (overrides OAuth)
  claude switch fallback auto-revert     auto-OFF fallback when 5h+7d drop below threshold
    on|off|status                        opts: --threshold <1-100> (default 80)
  claude switch fallback auto-engage     auto-ON fallback when 5h or 7d cross threshold
    on|off|status                        opts: --threshold <1-100> (default 95)
  claude switch usage [--force]          Show subscription usage % (5h, 7d)
  claude switch cache-health             Show cache hit ratio, flush count and
    [--session <path>] [--json]          effective token cost for active session
                                         opts: --session <path> (specific JSONL)
                                               --json (machine-readable output)
  claude switch doctor [--json] [--fix]  Check credential-store health (token
                                         collisions, stale usage cache); --fix
                                         clears poisoned tokens so re-login is clean
  claude switch sessions [--json]        List live claude sessions (account,
                                         isolated/global, cwd); warns when two
                                         accounts run global-bound at once
  claude switch statusline [opts]        One-line account/mode for shell prompt
                                         opts: --full | --json | --no-color
  claude switch statusline install       Add badge to Claude Code status bar
                                         opts: --ccstatusline (chain instead of replace)
  claude switch statusline uninstall     Remove the badge from Claude Code
  claude switch statusline status        Show what's configured in settings.json
  claude switch profile import <email>   Convert an existing saved account into an
                                         isolated profile (no browser re-login needed
                                         on macOS — uses the saved Keychain snapshot)
                                         opt: --as <profile-name>
  claude switch profile create <name>    Create an isolated profile (separate from
                                         the global account swap flow above)
  claude switch profile login <name>     Authenticate a profile (browser opens)
  claude switch profile use <name>       Start claude using only that profile
                                         — other terminals are unaffected
  claude switch profile list             List profiles + which account each has
  claude switch profile remove <name>    Delete a profile and its state
  claude switch profile status [<name>]  Show profile metadata
  claude switch update                   Check for updates and install if available
  claude switch help                     Show this help
  claude switch setup                    Re-run first-time setup
  claude --as <alias|email> ...          Use account temporarily
  claude switch --completions <shell>    Generate shell completions

All other commands are passed through to the real claude binary.`);
}
