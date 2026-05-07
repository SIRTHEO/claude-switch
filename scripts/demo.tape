# scripts/demo.tape
# VHS script that renders the marketing GIF for the README.
#
# Render with:
#   brew install vhs    # one-time
#   npm run gif         # outputs to docs/images/dashboard.gif
#
# VHS docs: https://github.com/charmbracelet/vhs

# ── Output ──────────────────────────────────────────────────────────
Output docs/images/dashboard.gif

# ── Frame settings ──────────────────────────────────────────────────
Set FontSize 16
Set Width 1100
Set Height 700
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 60ms
Set PlaybackSpeed 1

# ── Demo storyboard ─────────────────────────────────────────────────
# 1. Run claude-switch dashboard. We invoke our local dist directly so
#    the recording works without a global install of claude-switch
#    (HOME is already pointed at the synthetic fixture by render-demo.sh).
Hide
Type "alias claude='node $CS_DEMO_ROOT/dist/bin/cli.js'"
Enter
Sleep 200ms
Type "clear"
Enter
Sleep 200ms
Show
Type "claude switch"
Sleep 500ms
Enter
Sleep 2.5s

# 2. Pause on the dashboard so the viewer reads the layout (accounts,
#    fallback flag, usage glyphs, hotkey footer).
Sleep 3s

# 3. Move the cursor across accounts so the row highlight is visible.
Down
Sleep 600ms
Down
Sleep 600ms
Up
Sleep 600ms

# 4. Hold on the dashboard. The GIF loops, and the resting frame
#    needs to be the informative TUI — not an empty shell prompt.
Sleep 2.5s
