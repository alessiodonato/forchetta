#!/bin/sh
# Packs the archive of a release for Windows, and the installer that goes with it: dist/ already built, and the binaries for
# Windows that come with node-pty (pnpm-lock.yaml says which, with their checksum). It runs on Linux, in
# .github/workflows/linux-archive.yml, next to scripts/package-linux.sh. The same source gives the same bytes: the files are
# in order, with the date of the commit. Windows opens it with its own tar. Prints what it made.
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$SRC/package.json').version")
OUT="$SRC/build/release"
NAME="forchetta-$VERSION"
ARCHIVE="$NAME-windows.tar.gz"
STAGE="$OUT/windows/$NAME"
if ! tar --version 2>/dev/null | grep -q 'GNU tar'; then
  echo "this runs on Linux: the workflow \"Archive for Linux and Windows\" does" >&2
  exit 1
fi
if [ ! -f "$SRC/dist/windows/host.js" ]; then
  echo "no dist/: run pnpm build first" >&2
  exit 1
fi
mkdir -p "$OUT"
rm -rf "$OUT/windows" "$OUT/$ARCHIVE" "$OUT/$ARCHIVE.sha256" "$OUT/install.ps1"
mkdir -p "$STAGE/bin" "$STAGE/node_modules/node-pty/prebuilds"
cp "$SRC/package.json" "$SRC/LICENSE" "$STAGE/"
cp "$SRC/bin/forchetta.cmd" "$SRC/bin/forchetta-statusline.cmd" "$STAGE/bin/"
rsync -a --exclude '*.map' "$SRC/dist/" "$STAGE/dist/"
PTY=$(cd "$SRC/node_modules/node-pty" && pwd -P)
cp "$PTY/package.json" "$PTY/LICENSE" "$STAGE/node_modules/node-pty/"
rsync -a --exclude '*.map' --exclude '*.test.js' "$PTY/lib/" "$STAGE/node_modules/node-pty/lib/"
for arch in x64 arm64; do
  from="$PTY/prebuilds/win32-$arch"
  to="$STAGE/node_modules/node-pty/prebuilds/win32-$arch"
  mkdir -p "$to/conpty"
  cp "$from/conpty.node" "$from/conpty_console_list.node" "$to/"
  cp "$from/conpty/conpty.dll" "$from/conpty/OpenConsole.exe" "$to/conpty/"
done
DATE=$(git -C "$SRC" log -1 --format=%ct)
tar --sort=name --mtime="@$DATE" --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' -cf "$OUT/windows/archive.tar" -C "$OUT/windows" "$NAME"
gzip -9n < "$OUT/windows/archive.tar" > "$OUT/$ARCHIVE"
rm -rf "$OUT/windows"
(cd "$OUT" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")
# The installer of this version: it takes this archive and no other. Lines as Windows ends them.
SUM=$(cut -d' ' -f1 "$OUT/$ARCHIVE.sha256")
printf '%s\n' "$SUM" | grep -Eqx '[0-9a-f]{64}'
printf '%s\n' "$VERSION" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?'
sed -e 's/\r$//' -e "s/^  \$PinnedVersion = ''\$/  \$PinnedVersion = '$VERSION'/" -e "s/^  \$PinnedSha256 = ''\$/  \$PinnedSha256 = '$SUM'/" -e 's/$/\r/' "$SRC/docs/install.ps1" > "$OUT/install.ps1"
grep -qx "  \$PinnedVersion = '$VERSION'"$(printf '\r') "$OUT/install.ps1"
grep -qx "  \$PinnedSha256 = '$SUM'"$(printf '\r') "$OUT/install.ps1"
echo "$OUT/$ARCHIVE"
echo "$OUT/$ARCHIVE.sha256"
echo "$OUT/install.ps1"
