#!/bin/sh
# Downloads the binaries of node-pty for Linux that CI compiled (the workflow "node-pty for Linux"), for
# package-linux.sh: node-pty comes with those for a Mac and for Windows, not for Linux. Needed again only when the
# version of node-pty in package.json changes. Only from a run on main; it prints their sha256, which the log of the run has.
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
OUT="$SRC/build/node-pty-linux"
RUN=$(cd "$SRC" && gh run list --workflow node-pty-linux.yml --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')
if [ -z "$RUN" ]; then
  echo "no run of the workflow yet: gh workflow run node-pty-linux.yml" >&2
  exit 1
fi
rm -rf "$OUT"
for arch in x64 arm64; do
  (cd "$SRC" && gh run download "$RUN" --name "node-pty-linux-$arch" --dir "$OUT/linux-$arch")
  test -f "$OUT/linux-$arch/pty.node"
  shasum -a 256 "$OUT/linux-$arch/pty.node"
done
echo "$OUT"
