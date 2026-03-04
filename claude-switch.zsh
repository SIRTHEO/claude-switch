# claude-switch — Claude Code account wrapper
# Source this file from your .zshrc to enable `claude switch`

claude() {
  case "$1" in
    # Native commands: pass through directly
    auth|--help|-h|--version)
      command claude "$@"
      ;;

    # Switch account
    switch)
      echo "Logging out of current account..."
      command claude auth logout 2>/dev/null
      echo ""
      echo "Complete the login in your browser."
      echo ""
      command claude auth login

      if command claude auth status 2>&1 | grep -q '"loggedIn": true'; then
        local email
        email=$(command claude auth status 2>&1 | grep '"email"' | sed 's/.*"email": *"//;s/".*//')
        echo ""
        echo "Active account: $email"
      else
        echo "Login failed or cancelled."
        return 1
      fi
      ;;

    # Everything else: show active account, then run claude
    *)
      local email
      email=$(command claude auth status 2>&1 | grep '"email"' | sed 's/.*"email": *"//;s/".*//')
      if [[ -n "$email" ]]; then
        echo "🔑 $email"
        echo ""
      else
        echo "⚠️  No account connected. Run: claude switch"
        return 1
      fi
      command claude "$@"
      ;;
  esac
}
