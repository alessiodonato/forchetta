#!/bin/sh
# A claude for the simulation (scripts/dev/sim.sh). `claude agents --json` finds no session, `claude update` installs
# nothing; any other call runs scripts/dev/fake-agent.mjs, a scripted Claude Code: it draws the input box, takes
# requests and sends the hooks of a real session, so the app can start sessions and teams of agents in the
# simulation, with no real Claude.
if [ "${1:-}" = agents ]; then
  echo '[]'
  exit 0
fi
# The button of a failed automatic update in the top line runs these two: nothing is installed.
if [ "${1:-}" = --version ]; then
  echo '2.1.322 (Claude Code)'
  exit 0
fi
if [ "${1:-}" = update ]; then
  echo 'Checking for updates to latest version...'
  sleep 3
  echo 'Claude Code is up to date (2.1.322)'
  exit 0
fi
exec node "$(dirname "$0")/fake-agent.mjs" "$@"
