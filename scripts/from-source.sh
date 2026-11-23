#!/bin/sh
# Builds Forchetta in this clone, on Linux and on Windows inside WSL 2, as your user: nothing here runs as root. Without
# a recent Node.js, one from nodejs.org goes next to the clone, only for Forchetta, checked against the list of
# nodejs.org; pnpm is the version package.json names; the packages are those of pnpm-lock.yaml, each checked against its
# hash there. Run it again after a git pull.
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
NODE_LIB="$(dirname "$SRC")/forchetta-node"
for tool in make c++ python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'forchetta: %s is missing: node-pty is compiled here\n  sudo apt install build-essential python3\n' "$tool" >&2
    exit 1
  fi
done
# The nodejs of Ubuntu comes without npx.
if command -v npx >/dev/null 2>&1; then ALWAYS=; else ALWAYS=1; fi
FORCHETTA_NODE_ONLY=1 FORCHETTA_NODE_ALWAYS=$ALWAYS FORCHETTA_NODE_LIB="$NODE_LIB" sh "$SRC/docs/install.sh"
if [ -x "$NODE_LIB/bin/node" ]; then
  PATH="$NODE_LIB/bin:$PATH"
  export PATH
fi
cd "$SRC"
PNPM=$(node -p "require('./package.json').packageManager")
npx --yes "$PNPM" install --frozen-lockfile
npx --yes "$PNPM" build
printf '\nBuilt. Now run:\n  %s/bin/forchetta setup\n' "$SRC"
