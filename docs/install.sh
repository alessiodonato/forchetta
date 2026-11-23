#!/bin/sh
# Installs Forchetta on Linux, and on Windows inside WSL 2:
#
#   curl -fsSL https://forchetta.dev/install.sh | sh
#
# It needs no root: Forchetta goes in ~/.local/lib/forchetta, its command in ~/.local/bin, its data in
# ~/.local/share/forchetta. Without Node.js 22 or later, one from nodejs.org goes in ~/.local/lib/forchetta-node, only
# for Forchetta. Run it again to update. On a Mac: brew install alessiodonato/tap/forchetta.
set -eu

RELEASES=${FORCHETTA_RELEASES:-https://github.com/alessiodonato/forchetta/releases}
NODE_DIST=${FORCHETTA_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}
PROTO=${FORCHETTA_PROTO:-=https}
LIB="$HOME/.local/lib/forchetta"
NODE_LIB=${FORCHETTA_NODE_LIB:-"$HOME/.local/lib/forchetta-node"}
BIN="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'forchetta: %s\n' "$1" >&2
  if [ $# -gt 1 ]; then printf '  %s\n' "$2" >&2; fi
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
get() { curl --proto "$PROTO" --proto-redir "$PROTO" -fsSL --retry 2 -o "$2" "$1"; }
sha256() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# How to install a package here.
package() {
  if have apt-get; then say "sudo apt install $1"
  elif have dnf; then say "sudo dnf install $1"
  elif have pacman; then say "sudo pacman -S $1"
  elif have zypper; then say "sudo zypper install $1"
  else say "install $1"
  fi
}

# Node.js for Forchetta: the one of the system when it is recent enough, else one of its own.
node_ready() {
  have node || return 1
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "$major" -ge 22 ] 2>/dev/null
}

install_node() {
  if [ -x "$NODE_LIB/bin/node" ] || node_ready; then return 0; fi
  say "Node.js 22 is not here: downloading one for Forchetta alone…"
  get "$NODE_DIST/SHASUMS256.txt" "$WORK/SHASUMS256.txt" || fail "Node.js could not be downloaded" "install Node.js 22 or later from https://nodejs.org, then run this again"
  file=$(sed -n "s/^[0-9a-f]*  \(node-v[0-9.]*-linux-$ARCH\.tar\.gz\)\$/\1/p" "$WORK/SHASUMS256.txt" | head -n 1)
  want=$(sed -n "s/^\([0-9a-f]*\)  node-v[0-9.]*-linux-$ARCH\.tar\.gz\$/\1/p" "$WORK/SHASUMS256.txt" | head -n 1)
  [ -n "$file" ] || fail "nodejs.org has no Node.js for linux-$ARCH"
  get "$NODE_DIST/$file" "$WORK/node.tar.gz" || fail "Node.js could not be downloaded"
  [ "$(sha256 "$WORK/node.tar.gz")" = "$want" ] || fail "the download of Node.js is not the one nodejs.org lists: nothing was installed"
  mkdir -p "$WORK/node"
  tar -xzf "$WORK/node.tar.gz" -C "$WORK/node" --strip-components 1
  rm -rf "$NODE_LIB"
  mkdir -p "$(dirname "$NODE_LIB")"
  mv "$WORK/node" "$NODE_LIB"
}

main() {
  case $(uname -s) in
    Linux) ;;
    Darwin) fail "on a Mac install it with Homebrew:" "brew install alessiodonato/tap/forchetta" ;;
    *) fail "on Windows Forchetta runs inside WSL 2: run this in a terminal of WSL" "see https://forchetta.dev/manual.html#windows" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) fail "Forchetta has no terminals for $(uname -m) yet" ;;
  esac
  case $HOME in
    /mnt/[a-z] | /mnt/[a-z]/*) fail "your home is a folder of Windows ($HOME): Forchetta needs one of WSL" ;;
  esac
  if [ ! -x /usr/bin/curl ] && [ -z "${FORCHETTA_ANY_CURL:-}" ]; then fail "curl is missing" "$(package curl)"; fi
  have tar || fail "tar is missing" "$(package tar)"
  have tmux || fail "tmux is missing: Forchetta runs the sessions in it" "$(package tmux), then run this again"

  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  trap 'exit 1' HUP INT TERM

  # Only the Node.js: for scripts/from-source.sh.
  if [ -n "${FORCHETTA_NODE_ONLY:-}" ]; then
    install_node
    return 0
  fi

  version=${FORCHETTA_VERSION:-}
  if [ -z "$version" ]; then
    latest=$(curl --proto "$PROTO" --proto-redir "$PROTO" -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES/latest") || fail "GitHub does not answer" "try again in a moment"
    version=${latest##*/v}
  fi
  case $version in
    '' | *[!0-9.]*) fail "the last version of Forchetta was not found" "see $RELEASES" ;;
  esac
  say "Forchetta $version, for linux-$ARCH…"
  get "$RELEASES/download/v$version/forchetta-$version-linux.tar.gz" "$WORK/forchetta.tar.gz" || fail "Forchetta $version for Linux could not be downloaded" "see $RELEASES"
  get "$RELEASES/download/v$version/forchetta-$version-linux.tar.gz.sha256" "$WORK/forchetta.sha256" || fail "the checksum of Forchetta $version could not be downloaded"
  want=$(cut -d' ' -f1 "$WORK/forchetta.sha256")
  [ "$(sha256 "$WORK/forchetta.tar.gz")" = "$want" ] || fail "the download is not the one of the release: nothing was installed"
  mkdir -p "$WORK/app"
  tar -xzf "$WORK/forchetta.tar.gz" -C "$WORK/app" --strip-components 1
  [ -f "$WORK/app/node_modules/node-pty/prebuilds/linux-$ARCH/pty.node" ] || fail "Forchetta $version has no terminals for linux-$ARCH" "see $RELEASES"

  install_node
  mkdir -p "$(dirname "$LIB")" "$BIN"
  rm -rf "$LIB.old"
  if [ -e "$LIB" ]; then mv "$LIB" "$LIB.old"; fi
  mv "$WORK/app" "$LIB"
  rm -rf "$LIB.old"
  ln -sf "$LIB/bin/forchetta" "$BIN/forchetta"
  say "Installed in ~/.local/lib/forchetta."
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *) say "~/.local/bin is not in your PATH yet: open a new terminal, or add it, to have the command forchetta." ;;
  esac
  if [ -n "${FORCHETTA_NO_SETUP:-}" ]; then return 0; fi
  # The setup asks before it writes the hooks: from a terminal, also when this script comes through a pipe.
  if [ -t 0 ]; then
    "$LIB/bin/forchetta" setup
  elif (exec </dev/tty) 2>/dev/null; then
    "$LIB/bin/forchetta" setup </dev/tty
  else
    say "Now run: forchetta setup"
  fi
}

main "$@"
