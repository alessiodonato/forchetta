#!/bin/sh
# Builds the archive of a release, for Homebrew, for docs/install.sh and for anyone who installs without cloning: what
# Forchetta needs to run and to build its app, with dist/ already built and node-pty with its binaries for macOS and
# Linux (those of Linux from scripts/fetch-linux-pty.sh). No sources of the
# page or the daemon, no tests, no source maps. Prints the path of the archive and its sha256, which the formula
# of the tap needs (homebrew-tap/Formula/forchetta.rb), and writes it in a file for docs/install.sh: both go in the release.
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$SRC/package.json').version")
OUT="$SRC/build/release"
NAME="forchetta-$VERSION"
STAGE="$OUT/$NAME"
rm -rf "$STAGE" "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256"
mkdir -p "$STAGE/scripts" "$STAGE/node_modules/node-pty/prebuilds"
(cd "$SRC" && pnpm build >/dev/null)

cp "$SRC/package.json" "$SRC/LICENSE" "$STAGE/"
cp -R "$SRC/bin" "$SRC/config" "$SRC/native" "$STAGE/"
cp "$SRC/scripts/build-app.sh" "$STAGE/scripts/"
rsync -a --exclude '*.map' "$SRC/dist/" "$STAGE/dist/"

# node-pty: its code and its binaries for macOS and Linux; not its sources, nor its binaries for Windows.
PTY=$(cd "$SRC/node_modules/node-pty" && pwd -P)
cp "$PTY/package.json" "$PTY/LICENSE" "$STAGE/node_modules/node-pty/"
rsync -a --exclude '*.map' --exclude '*.test.js' "$PTY/lib/" "$STAGE/node_modules/node-pty/lib/"
cp -R "$PTY/prebuilds/darwin-arm64" "$PTY/prebuilds/darwin-x64" "$STAGE/node_modules/node-pty/prebuilds/"
# node-pty 1.1.0 ships its helper without the executable bit (see scripts/fix-node-pty.mjs).
chmod 755 "$STAGE"/node_modules/node-pty/prebuilds/darwin-*/spawn-helper

for arch in x64 arm64; do
  if [ -f "$SRC/build/node-pty-linux/linux-$arch/pty.node" ]; then
    mkdir -p "$STAGE/node_modules/node-pty/prebuilds/linux-$arch"
    cp "$SRC/build/node-pty-linux/linux-$arch/pty.node" "$STAGE/node_modules/node-pty/prebuilds/linux-$arch/"
  else
    echo "WARNING: no node-pty for linux-$arch: this archive does not run there (scripts/fetch-linux-pty.sh)" >&2
  fi
done

COPYFILE_DISABLE=1 tar -czf "$OUT/$NAME.tar.gz" -C "$OUT" "$NAME"
rm -rf "$STAGE"
(cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "$OUT/$NAME.tar.gz"
cut -d' ' -f1 "$OUT/$NAME.tar.gz.sha256"
