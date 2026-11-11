#!/bin/sh
# A claude for the simulation. `claude agents --json` finds no session; any other call shows the lines of
# demo-tui.sh under the name of the session (--name), and takes the other arguments of a real claude (the
# system prompt of a team, its MCP configuration, a worktree) without doing anything with them. So the app can
# start sessions and teams in the simulation, and show them, with no real Claude.
if [ "${1:-}" = agents ]; then
  echo '[]'
  exit 0
fi
name=demo
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name=$2; shift ;;
    --) break ;;
  esac
  shift
done
# The lines end after ten minutes; the session stays up to an hour more, for screenshots that take longer.
/bin/sh "$(dirname "$0")/demo-tui.sh" "$name"
exec sleep 3600
