#!/bin/sh
# A claude for the simulation (scripts/dev/sim.sh). `claude agents --json` finds no session; any other call runs
# scripts/dev/fake-agent.mjs, a scripted Claude Code: it draws the input box, takes requests and sends the hooks of
# a real session, so the app can start sessions and teams of agents in the simulation, with no real Claude.
if [ "${1:-}" = agents ]; then
  echo '[]'
  exit 0
fi
exec node "$(dirname "$0")/fake-agent.mjs" "$@"
