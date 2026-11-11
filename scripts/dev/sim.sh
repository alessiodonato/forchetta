#!/bin/sh
# Starts the test daemon of the simulation: port 47822, state in var/sim, a fake arricurdAI, no real session
# (claude is /usr/bin/false, so `claude agents --json` finds nothing). The real daemon is not touched.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export FORCHETTA_VAR="$ROOT/var/sim"
mkdir -p "$FORCHETTA_VAR"
chmod 700 "$FORCHETTA_VAR"
NODE=$(command -v node)
TMUX_BIN=$(command -v tmux || echo /usr/local/bin/tmux)
cat > "$FORCHETTA_VAR/config.json" <<JSON
{
  "port": 47822,
  "paths": { "node": "$NODE", "tmux": "$TMUX_BIN", "claude": "/usr/bin/false" },
  "arricurdai": ["$NODE", "$ROOT/scripts/dev/fake-arricurdai.mjs"]
}
JSON
"$NODE" "$ROOT/dist/cli.js" daemon start
