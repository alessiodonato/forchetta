#!/bin/sh
# Builds Forchetta.app from native/ with the Command Line Tools: no Xcode needed. By default in build/; with an
# argument, at that path (forchetta setup builds it there, then moves it to ~/Applications). The app runs the Forchetta
# folder written in its Info.plist: FORCHETTA_ROOT when given (the stable path of an installed copy), else this one.
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
ROOT=${FORCHETTA_ROOT:-$SRC}
APP=${1:-$SRC/build/Forchetta.app}
case $APP in
  *.app) ;;
  *) echo "build-app.sh: the app must end in .app: $APP" >&2; exit 2 ;;
esac
VERSION=$(node -p "require('$SRC/package.json').version")
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -target "$(uname -m)-apple-macos12.0" -framework AppKit -framework WebKit -framework UserNotifications -framework Carbon \
  "$SRC"/native/*.swift -o "$APP/Contents/MacOS/Forchetta"
sed -e "s|@ROOT@|$ROOT|g" -e "s|@VERSION@|$VERSION|g" "$SRC/native/Info.plist" > "$APP/Contents/Info.plist"
# The icon: drawn by scripts/make-icon.swift (swift scripts/make-icon.swift <folder.iconset>, then iconutil).
cp "$SRC/native/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
# With the local certificate (scripts/make-signing-cert.sh) macOS keeps the permissions of the app across builds;
# without it, an ad-hoc signature, as before.
IDENTITY="Forchetta (firma locale)"
if security find-certificate -c "$IDENTITY" >/dev/null 2>&1 && codesign --force --sign "$IDENTITY" "$APP" >/dev/null 2>&1; then
  echo "firmata con il certificato \"$IDENTITY\""
else
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
  echo "firma ad-hoc: macOS chiederà di nuovo i permessi dell'app (scripts/make-signing-cert.sh li fa ricordare)"
fi
echo "$APP"
