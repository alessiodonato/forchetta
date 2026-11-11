#!/bin/sh
# Builds build/Forchetta.app from native/ with the Command Line Tools: no Xcode needed.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/build/Forchetta.app"
VERSION=$(node -p "require('$ROOT/package.json').version")
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -target "$(uname -m)-apple-macos12.0" -framework AppKit -framework WebKit -framework UserNotifications -framework Carbon \
  "$ROOT"/native/*.swift -o "$APP/Contents/MacOS/Forchetta"
sed -e "s|@ROOT@|$ROOT|g" -e "s|@VERSION@|$VERSION|g" "$ROOT/native/Info.plist" > "$APP/Contents/Info.plist"
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
