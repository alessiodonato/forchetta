#!/bin/sh
# A program for the panes of the simulation: lines like those of Claude Code inside tmux, for ten minutes; then it
# ends by itself, and its tmux session with it. The colors are the indices of the 256 that Claude Code 2.1 sends
# there with its dark theme (see src/ui/terminal-theme.ts), so the panes show what the real ones show: the orange
# of Claude, the green dot of a tool, gray results, your message on its background, a diff with the colors of
# the syntax, and for docs the question of a permission.
name=${1:-demo}

e=$(printf '\033')
claude="$e[38;5;174m"   # claude
gray="$e[38;5;246m"     # inactive: results and hints
green="$e[38;5;114m"    # success: the dot of a tool
blue="$e[38;5;153m"     # permission
num="$e[38;5;242m"      # line numbers of a diff
kw="$e[38;5;197m"       # syntax: keywords
fn="$e[38;5;148m"       # syntax: names and calls
str="$e[38;5;186m"      # syntax: strings
lit="$e[38;5;141m"      # syntax: numbers
fg="$e[39m"
bold="$e[1m"
unbold="$e[22m"
reset="$e[0m"
added="$e[48;5;22m"
removed="$e[48;5;52m"
mine="$e[48;5;237m"
eol="$e[K"

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
    plan="I'll fix the links first, then rebuild the site from scratch."
    file='guide/install.md' ;;
  *)
    ask="Work on the $name module"
    plan="I'll start from the $name module."
    file='src/index.ts' ;;
esac

printf '%s ▐▛███▜▌%s   %sClaude Code%s %s(simulation)%s\n' "$claude" "$reset" "$bold" "$unbold" "$gray" "$reset"
printf '%s▝▜█████▛▘%s  %s%s · Opus 5.5%s\n' "$claude" "$reset" "$gray" "$name" "$reset"
printf '%s  ▘▘ ▝▝%s    %s~/projects/%s%s\n\n' "$claude" "$reset" "$gray" "$name" "$reset"
printf '%s❯ %s %s\n\n' "$mine" "$ask" "$reset"
printf '⏺ %s\n\n' "$plan"
printf '%s⏺%s %sRead%s(%s)\n' "$green" "$fg" "$bold" "$unbold" "$file"
printf '  %s⎿  Read %s214%s lines%s\n\n' "$gray" "$bold" "$unbold" "$reset"
printf '%s⏺%s %sUpdate%s(%s)\n' "$green" "$fg" "$bold" "$unbold" "$file"

# One diff per project: the removed lines on 52, the added ones on 22, as Claude Code shows an edit.
same() { printf '      %s%s%s  %s\n' "$num" "$1" "$fg" "$2"; }
minus() { printf '      %s%s%s -%s%s%s\n' "$removed" "$num" "$1" "$fg" "$2" "$eol$reset"; }
plus() { printf '      %s%s%s +%s%s%s\n' "$added" "$num" "$1" "$fg" "$2" "$eol$reset"; }
case "$name" in
  docs)
    printf '  %s⎿  Added %s2%s lines, removed %s2%s lines%s\n' "$gray" "$bold" "$unbold" "$bold" "$unbold" "$reset"
    same 11 "## Install"
    minus 12 "See ${fn}[the steps]${fg}(${str}./instal.md${fg}) and the ${fn}[FAQ]${fg}(${str}/faq.htm${fg})."
    minus 13 "Node ${lit}20${fg} or later."
    plus 12 "See ${fn}[the steps]${fg}(${str}./install.md${fg}) and the ${fn}[FAQ]${fg}(${str}/faq.html${fg})."
    plus 13 "Node ${lit}22${fg} or later."
    same 14 "" ;;
  frontend)
    printf '  %s⎿  Added %s3%s lines, removed %s1%s line%s\n' "$gray" "$bold" "$unbold" "$bold" "$unbold" "$reset"
    same 18 "${kw}export function${fg} ${fn}Settings${fg}() {"
    minus 19 "  ${kw}return${fg} <${fn}Page${fg}>{sections}</${fn}Page${fg}>;"
    plus 19 "  ${kw}return${fg} ("
    plus 20 "    <${fn}Layout${fg} columns={${lit}2${fg}}>"
    plus 21 "      {sections}</${fn}Layout${fg}>);"
    same 22 "}" ;;
  *)
    # Short lines: in a narrow pane a long one would wrap.
    printf '  %s⎿  Added %s3%s lines, removed %s1%s line%s\n' "$gray" "$bold" "$unbold" "$bold" "$unbold" "$reset"
    same 41 "${kw}async function${fg} ${fn}fetchOrder${fg}(id) {"
    minus 42 "  ${kw}return${fg} ${fn}get${fg}(${str}\`/orders/\${id}\`${fg});"
    plus 42 "  ${kw}return${fg} ${fn}withRetry${fg}(() =>"
    plus 43 "    ${fn}get${fg}(${str}\`/orders/\${id}\`${fg}), {"
    plus 44 "    attempts: ${lit}3${fg} });"
    same 45 "}" ;;
esac
printf '\n'

if [ "$name" = docs ]; then
  # The session waits for a permission: the question Claude Code asks, in the blue of permissions.
  printf '%s⏺%s %sBash%s(rm -rf dist && npm run build)\n' "$gray" "$fg" "$bold" "$unbold"
  printf '  %s⎿  Waiting for permission…%s\n\n' "$gray" "$reset"
  printf '%s%s%s\n' "$blue" "──────────────────────────────────────────────────────────────" "$reset"
  printf ' %sBash command%s\n\n' "$blue$bold" "$unbold$reset"
  printf '   rm -rf dist && npm run build\n'
  printf '   %sRebuild the site from scratch%s\n\n' "$gray" "$reset"
  printf ' Do you want to proceed?\n'
  printf ' %s❯ 1. Yes%s\n' "$blue" "$reset"
  printf '   2. Yes, and don'"'"'t ask again for %srm%s commands in this project\n' "$bold" "$unbold"
  printf '   3. No, and tell Claude what to do differently %s(esc)%s\n' "$gray" "$reset"
  sleep 600
  exit 0
fi

i=0
while [ "$i" -lt 100 ]; do
  i=$((i + 1))
  printf '%s⏺%s %sBash%s(npm test -- --run)\n' "$green" "$fg" "$bold" "$unbold"
  printf '  %s⎿  %s✓%s %d tests passed · %s%s\n\n' "$gray" "$green" "$gray" "$((i * 2 + 126))" "$(date +%H:%M:%S)" "$reset"
  sleep 6
done
