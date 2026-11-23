#!/bin/sh
# Builds the archive of a release for Linux and WSL, for docs/install.sh: dist/ already built, and node-pty with the
# binaries CI compiled (scripts/fetch-linux-pty.sh). No app and no binaries of a Mac: those are in the archive of
# scripts/package-release.sh, which this one does not touch. Run after it, so that both have the same dist/. Prints the
# path of the archive and of its sha256: both go in the release.
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$SRC/package.json').version")
OUT="$SRC/build/release"
NAME="forchetta-$VERSION"
ARCHIVE="$NAME-linux.tar.gz"
STAGE="$OUT/linux/$NAME"
for arch in x64 arm64; do
  if [ ! -f "$SRC/build/node-pty-linux/linux-$arch/pty.node" ]; then
    echo "no node-pty for linux-$arch: run scripts/fetch-linux-pty.sh first" >&2
    exit 1
  fi
done
if [ ! -f "$SRC/dist/daemon.js" ]; then
  echo "no dist/: run scripts/package-release.sh first" >&2
  exit 1
fi
rm -rf "$OUT/linux" "$OUT/$ARCHIVE" "$OUT/$ARCHIVE.sha256"
mkdir -p "$STAGE/node_modules/node-pty/prebuilds"
cp "$SRC/package.json" "$SRC/LICENSE" "$STAGE/"
cp -R "$SRC/bin" "$SRC/config" "$STAGE/"
rsync -a --exclude '*.map' "$SRC/dist/" "$STAGE/dist/"
PTY=$(cd "$SRC/node_modules/node-pty" && pwd -P)
cp "$PTY/package.json" "$PTY/LICENSE" "$STAGE/node_modules/node-pty/"
rsync -a --exclude '*.map' --exclude '*.test.js' "$PTY/lib/" "$STAGE/node_modules/node-pty/lib/"
for arch in x64 arm64; do
  mkdir -p "$STAGE/node_modules/node-pty/prebuilds/linux-$arch"
  cp "$SRC/build/node-pty-linux/linux-$arch/pty.node" "$STAGE/node_modules/node-pty/prebuilds/linux-$arch/"
done
COPYFILE_DISABLE=1 tar -czf "$OUT/$ARCHIVE" -C "$OUT/linux" "$NAME"
rm -rf "$OUT/linux"
(cd "$OUT" && shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256")
echo "$OUT/$ARCHIVE"
echo "$OUT/$ARCHIVE.sha256"
