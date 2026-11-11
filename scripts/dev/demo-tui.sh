#!/bin/sh
# A program for the panes of the simulation: lines like those of Claude Code, with colors and wide symbols, for
# ten minutes; then it ends by itself, and its tmux session with it.
name=${1:-demo}
case "$name" in
  api-gateway)
    ask='Add retries with backoff to the order client, then the tests'
    plan="I'll add retries with exponential backoff to the order client, then cover them with tests."
    file='src/clients/orders.ts' ;;
  frontend)
    ask='Move the settings page to the new layout'
    plan="I'll move the settings page onto the new layout, one section at a time."
    file='src/pages/Settings.tsx' ;;
  docs)
    ask='Rebuild the docs site and fix the broken links'
    plan="I'll rebuild the site, then check every link it reports."
    file='guide/install.md' ;;
  *)
    ask="Work on the $name module"
    plan="I'll start from the $name module."
    file='src/index.ts' ;;
esac
printf '\033[38;5;209m ▐▛███▜▌\033[0m   \033[1mClaude Code\033[0m (simulation)\n'
printf '\033[38;5;209m▝▜█████▛▘\033[0m  %s · Opus 5.5\n' "$name"
printf '\033[38;5;209m  ▘▘ ▝▝\033[0m    ~/projects/%s\n\n' "$name"
printf '\033[2m> %s\033[0m\n\n' "$ask"
printf '\033[1m⏺\033[0m %s\n\n' "$plan"
printf '\033[1m⏺\033[0m Read(%s)\n' "$file"
printf '  ⎿  Read 214 lines\n\n'
printf '\033[1m⏺\033[0m Update(%s)\n' "$file"
printf '  ⎿  Updated %s with \033[32m18 additions\033[0m and \033[31m4 removals\033[0m\n\n' "$file"
i=0
while [ "$i" -lt 100 ]; do
  i=$((i + 1))
  printf '\033[1m⏺\033[0m Bash(npm test -- --run)\n'
  printf '  ⎿  \033[32m✓\033[0m %d tests passed · %s\n\n' "$((i * 2 + 126))" "$(date +%H:%M:%S)"
  sleep 6
done
