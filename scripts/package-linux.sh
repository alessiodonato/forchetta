#!/bin/sh
# Packs the archive of a release for Linux and WSL, and the installer that goes with it: dist/ already built, and node-pty
# with the binaries of the job before (.github/workflows/linux-archive.yml, which is where this runs). No app and no
# binaries of a Mac: those are in the archive of scripts/package-release.sh, which this one does not touch. The same
# source gives the same bytes: the files are in order, of root, with the date of the commit. Prints what it made.
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$SRC/package.json').version")
OUT="$SRC/build/release"
NAME="forchetta-$VERSION"
ARCHIVE="$NAME-linux.tar.gz"
STAGE="$OUT/linux/$NAME"
if ! tar --version 2>/dev/null | grep -q 'GNU tar'; then
  echo "this runs on Linux: the workflow \"Archive for Linux and Windows\" does" >&2
  exit 1
fi
for arch in x64 arm64; do
  if [ ! -f "$SRC/build/node-pty-linux/linux-$arch/pty.node" ]; then
    echo "no node-pty for linux-$arch in build/node-pty-linux" >&2
    exit 1
  fi
done
if [ ! -f "$SRC/dist/daemon.js" ]; then
  echo "no dist/: run pnpm build first" >&2
  exit 1
fi
rm -rf "$OUT/linux" "$OUT/$ARCHIVE" "$OUT/$ARCHIVE.sha256" "$OUT/install.sh"
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
DATE=$(git -C "$SRC" log -1 --format=%ct)
tar --sort=name --mtime="@$DATE" --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' -cf "$OUT/linux/archive.tar" -C "$OUT/linux" "$NAME"
gzip -9n < "$OUT/linux/archive.tar" > "$OUT/$ARCHIVE"
rm -rf "$OUT/linux"
(cd "$OUT" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")
# The installer of this version: it takes this archive and no other.
SUM=$(cut -d' ' -f1 "$OUT/$ARCHIVE.sha256")
printf '%s\n' "$SUM" | grep -Eqx '[0-9a-f]{64}'
printf '%s\n' "$VERSION" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?'
sed -e "s/^PINNED_VERSION=\$/PINNED_VERSION=$VERSION/" -e "s/^PINNED_SHA256=\$/PINNED_SHA256=$SUM/" "$SRC/docs/install.sh" > "$OUT/install.sh"
grep -qx "PINNED_VERSION=$VERSION" "$OUT/install.sh"
grep -qx "PINNED_SHA256=$SUM" "$OUT/install.sh"
echo "$OUT/$ARCHIVE"
echo "$OUT/$ARCHIVE.sha256"
echo "$OUT/install.sh"
