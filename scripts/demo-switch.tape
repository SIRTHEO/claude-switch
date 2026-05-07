# scripts/demo-switch.tape
# Renders docs/images/switch.gif — shows the one-shot switch flow
# (`claude switch <alias>`) which is the muscle-memory pitch of the
# whole project. Pairs with the home-dashboard GIF as the second beat
# of the README story.

Output docs/images/switch.gif

Set FontSize 16
Set Width 1000
Set Height 540
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

# Beat 1: where are we now?
Type "claude switch status"
Enter
Sleep 2s

# Beat 2: flip to personal
Type "claude switch personal"
Enter
Sleep 1.5s

# Beat 3: confirm we're there
Type "claude switch status"
Enter
Sleep 2s

# Beat 4: flip back to work in one shot
Type "claude switch work"
Enter
Sleep 1.5s

Sleep 1s
