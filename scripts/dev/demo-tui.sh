#!/bin/sh
# A program for the panes of the simulation: lines like those of Claude Code, with colors and wide symbols, for
# ten minutes; then it ends by itself, and its tmux session with it.
name=${1:-demo}
printf '\033[38;5;209m ▐▛███▜▌\033[0m   \033[1mClaude Code\033[0m (simulazione)\n'
printf '\033[38;5;209m▝▜█████▛▘\033[0m  %s · Opus 5.5\n' "$name"
printf '\033[38;5;209m  ▘▘ ▝▝\033[0m    ~/progetti/%s\n\n' "$name"
printf '\033[2m> Sistema i test e aggiorna la documentazione\033[0m\n\n'
i=0
while [ "$i" -lt 300 ]; do
  i=$((i + 1))
  printf '\033[1m⏺\033[0m Bash(npm test -- --run %s)\n' "$i"
  printf '  ⎿  \033[32m✓\033[0m %d test passati · %s\n' "$((i * 3))" "$(date +%H:%M:%S)"
  sleep 2
done
