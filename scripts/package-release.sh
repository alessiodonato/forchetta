#!/bin/sh
# Builds the archive of a release, for Homebrew and for anyone who installs without cloning: what Forchetta needs to
# run and to build its app, with dist/ already built and node-pty with its binaries for macOS. No sources of the
# page or the daemon, no tests, no source maps. Prints the path of the archive and its sha256, which the formula
# of the tap needs (homebrew-tap/Formula/forchetta.rb).
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$SRC/package.json').version")
OUT="$SRC/build/release"
NAME="forchetta-$VERSION"
STAGE="$OUT/$NAME"
rm -rf "$STAGE" "$OUT/$NAME.tar.gz"
mkdir -p "$STAGE/scripts" "$STAGE/node_modules/node-pty/prebuilds"
(cd "$SRC" && pnpm build >/dev/null)

cp "$SRC/package.json" "$SRC/LICENSE" "$STAGE/"
cp -R "$SRC/bin" "$SRC/config" "$SRC/native" "$STAGE/"
cp "$SRC/scripts/build-app.sh" "$STAGE/scripts/"
rsync -a --exclude '*.map' "$SRC/dist/" "$STAGE/dist/"

# node-pty: its code and its binaries for macOS; not its sources, nor its binaries for Windows.
PTY=$(cd "$SRC/node_modules/node-pty" && pwd -P)
cp "$PTY/package.json" "$PTY/LICENSE" "$STAGE/node_modules/node-pty/"
rsync -a --exclude '*.map' --exclude '*.test.js' "$PTY/lib/" "$STAGE/node_modules/node-pty/lib/"
cp -R "$PTY/prebuilds/darwin-arm64" "$PTY/prebuilds/darwin-x64" "$STAGE/node_modules/node-pty/prebuilds/"
# node-pty 1.1.0 ships its helper without the executable bit (see scripts/fix-node-pty.mjs).
chmod 755 "$STAGE"/node_modules/node-pty/prebuilds/darwin-*/spawn-helper

COPYFILE_DISABLE=1 tar -czf "$OUT/$NAME.tar.gz" -C "$OUT" "$NAME"
rm -rf "$STAGE"
echo "$OUT/$NAME.tar.gz"
shasum -a 256 "$OUT/$NAME.tar.gz" | cut -d' ' -f1
