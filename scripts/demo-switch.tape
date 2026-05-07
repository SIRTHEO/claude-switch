# scripts/demo-switch.tape
# Renders docs/images/switch.gif — second README beat.
#
# Story: one entry point (`claude switch`) drops you in the dashboard;
# you flip the active account by moving the cursor and pressing Enter.
# No subcommand muscle-memory required.

Output docs/images/switch.gif

Set FontSize 16
Set Width 1100
Set Height 700
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 60ms

Hide
Type "alias claude='node $CS_DEMO_ROOT/dist/bin/cli.js'"
Enter
Sleep 200ms
Type "clear"
Enter
Sleep 200ms
Show

# Beat 1: open the dashboard.
Type "claude switch"
Sleep 500ms
Enter
Sleep 2.5s

# Beat 2: move the account cursor to the other row. Cursor starts
# on the active account (work, last row), so we step Up to land on
# personal — the row we actually want to switch into.
Up
Sleep 1s

# Beat 3: switch by pressing Enter on the highlighted row. The TUI
# stays open and re-renders with a "Switched to ..." notice and
# the new active account — that IS the resting frame.
Enter
Sleep 4s
