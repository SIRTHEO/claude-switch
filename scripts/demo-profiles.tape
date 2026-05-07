# scripts/demo-profiles.tape
# Renders docs/images/profiles.gif — shows the profile system
# (per-terminal isolated sessions) without spawning a real claude.
# Demonstrates `profile list` and `profile status` so the viewer sees
# the management surface; the actual `profile use` spawn would launch
# claude itself, which is out of scope for a synthetic demo.

Output docs/images/profiles.gif

Set FontSize 16
Set Width 1000
Set Height 600
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

# Beat 1: list profiles
Type "claude switch profile list"
Enter
Sleep 2s

# Beat 2: status of the personal profile
Type "claude switch profile status personal"
Enter
Sleep 3s

Sleep 1s
