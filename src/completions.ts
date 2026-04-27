// src/completions.ts

const SUBCOMMANDS = ['add', 'list', 'ls', 'remove', 'rm', 'status', 'alias', 'apikey', 'fallback', 'update', 'setup', 'help'];

export function generateBash(): string {
  return `_claude_switch() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [[ "\${COMP_WORDS[1]}" == "switch" ]]; then
    if [[ $COMP_CWORD -eq 2 ]]; then
      COMPREPLY=($(compgen -W "${SUBCOMMANDS.join(' ')}" -- "$cur"))
      local accounts_dir="$HOME/.claude/accounts"
      if [[ -d "$accounts_dir" ]]; then
        local emails=""
        for f in "$accounts_dir"/*.json; do
          [[ -f "$f" ]] || continue
          local name="\${f##*/}"; name="\${name%.json}"
          emails="$emails $name"
        done
        COMPREPLY+=($(compgen -W "$emails" -- "$cur"))
      fi
    fi
  fi
}
complete -F _claude_switch claude`;
}

export function generateZsh(): string {
  return `#compdef claude
_claude_switch() {
  local -a subcommands accounts
  subcommands=(${SUBCOMMANDS.map(s => `'${s}'`).join(' ')})

  if (( CURRENT == 3 )) && [[ "\${words[2]}" == "switch" ]]; then
    local accounts_dir="$HOME/.claude/accounts"
    if [[ -d "$accounts_dir" ]]; then
      for f in "$accounts_dir"/*.json; do
        [[ -f "$f" ]] && accounts+=("\${\${f##*/}%.json}")
      done
    fi
    _describe 'subcommand' subcommands
    _describe 'account' accounts
  fi
}
compdef _claude_switch claude`;
}

export function generateFish(): string {
  return `complete -c claude -n '__fish_seen_subcommand_from switch' -a '${SUBCOMMANDS.join(' ')}' -d 'switch subcommand'
complete -c claude -n '__fish_seen_subcommand_from switch' -a '(for f in ~/.claude/accounts/*.json; basename "$f" .json; end)' -d 'account'`;
}

export function generatePowerShell(): string {
  return `Register-ArgumentCompleter -CommandName claude -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $subcommands = @(${SUBCOMMANDS.map(s => `'${s}'`).join(', ')})
  $words = $commandAst.ToString().Split()

  if ($words.Count -ge 2 -and $words[1] -eq 'switch') {
    $subcommands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
    $accountsDir = Join-Path $env:USERPROFILE '.claude' 'accounts'
    if (Test-Path $accountsDir) {
      Get-ChildItem "$accountsDir\\*.json" | ForEach-Object {
        $email = $_.BaseName
        if ($email -like "$wordToComplete*") {
          [System.Management.Automation.CompletionResult]::new($email, $email, 'ParameterValue', $email)
        }
      }
    }
  }
}`;
}
