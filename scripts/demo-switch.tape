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

# Beat 2: move the account cursor to the other row.
Down
Sleep 1s

# Beat 3: switch by pressing Enter on the highlighted row.
Enter
Sleep 2.5s

# Beat 4: hold the post-switch dashboard so the loop's resting frame
# is the informative state, not an empty shell.
Sleep 2s
