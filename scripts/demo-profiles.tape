# scripts/demo-profiles.tape
# Renders docs/images/profiles.gif — third README beat.
#
# Story: same single entry point (`claude switch`) reaches the profile
# system through the menu (hotkey `p`), reinforcing that everything
# lives behind the dashboard rather than scattered subcommands.

Output docs/images/profiles.gif

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
Sleep 2s

# Beat 2: jump into Profiles via the universal hotkey.
Type "p"
Sleep 2.5s

# Beat 3: move the cursor inside the Profiles screen.
Down
Sleep 800ms
Down
Sleep 800ms
Up
Sleep 800ms

# Beat 4: hold so the loop's resting frame is the Profiles screen,
# not an empty shell.
Sleep 2s
