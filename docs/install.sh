#!/bin/sh
# Installs Forchetta on Linux, and on Windows inside WSL 2:
#
#   curl -fsSL https://forchetta.dev/install.sh | sh
#
# It needs no root: Forchetta goes in ~/.local/lib/forchetta, its command in ~/.local/bin, its data in
# ~/.local/share/forchetta. Without Node.js 22 or later, one from nodejs.org goes in ~/.local/lib/forchetta-node, only
# for Forchetta. Run it again to update. On a Mac: brew install alessiodonato/tap/forchetta.
set -eu

# In the copy that a release has, its version and the sha256 of its archive (scripts/package-linux.sh). Empty here.
PINNED_VERSION=
PINNED_SHA256=

REPO=alessiodonato/forchetta
GITHUB=https://github.com/$REPO/releases
RELEASES=${FORCHETTA_RELEASES:-$GITHUB}
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

# The file is the one of this checksum; what is not a checksum is of no file.
intact() {
  case $2 in '' | *[!0-9a-f]*) return 1 ;; esac
  [ ${#2} -eq 64 ] && [ "$(sha256 "$1")" = "$2" ]
}

# A folder takes the place of another in three steps: a copy next to it, which may fail and changes nothing; two
# renames; the old one goes. What is cut short in between, restore puts back.
stage() {
  rm -rf "$2.new"
  mkdir -p "$(dirname "$2")" || return 1
  cp -R "$1" "$2.new"
}
swap() {
  rm -rf "$1.old"
  if [ -e "$1" ]; then mv "$1" "$1.old" || return 1; fi
  mv "$1.new" "$1" || return 1
  rm -rf "$1.old"
}
restore() {
  rm -rf "$1.new"
  if [ ! -e "$1" ] && [ -e "$1.old" ]; then mv "$1.old" "$1"; fi
}
cleanup() {
  rm -rf "$WORK"
  restore "$LIB"
  restore "$NODE_LIB"
}

# Node.js for Forchetta: the one of the system when it is recent enough, else one of its own, which an update brings up
# to date.
node_version() { "$1" -p 'process.versions.node' 2>/dev/null || true; }
recent() {
  case ${1%%.*} in '' | *[!0-9]*) return 1 ;; esac
  [ "${1%%.*}" -ge 22 ]
}

install_node() {
  own=$(node_version "$NODE_LIB/bin/node")
  if [ -z "$own" ] && [ -z "${FORCHETTA_NODE_ALWAYS:-}" ] && recent "$(node_version node)"; then return 0; fi
  if ! get "$NODE_DIST/SHASUMS256.txt" "$WORK/SHASUMS256.txt"; then
    recent "$own" || fail "Node.js could not be downloaded" "install Node.js 22 or later from https://nodejs.org, then run this again"
    say "nodejs.org does not answer: the Node.js of Forchetta stays at $own."
    return 0
  fi
  file=$(sed -n "s/^[0-9a-f]*  \(node-v[0-9.]*-linux-$ARCH\.tar\.gz\)\$/\1/p" "$WORK/SHASUMS256.txt" | head -n 1)
  want=$(sed -n "s/^\([0-9a-f]*\)  node-v[0-9.]*-linux-$ARCH\.tar\.gz\$/\1/p" "$WORK/SHASUMS256.txt" | head -n 1)
  [ -n "$file" ] || fail "nodejs.org has no Node.js for linux-$ARCH"
  if [ "$file" = "node-v$own-linux-$ARCH.tar.gz" ]; then return 0; fi
  say "Downloading a Node.js for Forchetta alone…"
  get "$NODE_DIST/$file" "$WORK/node.tar.gz" || fail "Node.js could not be downloaded"
  intact "$WORK/node.tar.gz" "$want" || fail "the download of Node.js is not the one nodejs.org lists: nothing was installed"
  mkdir -p "$WORK/node"
  tar -xzf "$WORK/node.tar.gz" -C "$WORK/node" --strip-components 1
  stage "$WORK/node" "$NODE_LIB" || fail "Node.js could not be copied to $NODE_LIB" "is the disk full?"
  recent "$(node_version "$NODE_LIB.new/bin/node")" || fail "the Node.js of nodejs.org does not run on this Linux: nothing was installed"
  swap "$NODE_LIB" || fail "Node.js could not be put in $NODE_LIB"
}

# The archive comes from the workflow of Forchetta on GitHub, for the tag of this version: its attestation says so
# (SECURITY.md). Only with the GitHub CLI signed in, which can check it; without, the checksum is what counts. Not for
# the archives of a test.
attested() {
  if [ "$RELEASES" != "$GITHUB" ] || ! have gh; then return 0; fi
  if ! gh attestation verify --help 2>/dev/null | grep -q -e '--source-ref' || ! gh auth token --hostname github.com >/dev/null 2>&1; then
    say "Only the checksum is checked, not the attestation of GitHub: the GitHub CLI is old, or not signed in."
    return 0
  fi
  if ! gh attestation verify "$1" --hostname github.com --repo "$REPO" --signer-workflow "$REPO/.github/workflows/linux-release.yml" --source-ref "refs/tags/v$version" --deny-self-hosted-runners >"$WORK/gh" 2>&1; then
    sed 's/^/  /' "$WORK/gh" >&2
    return 1
  fi
  say "GitHub made it from the source of Forchetta: checked."
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
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  # What an update before this one left half done.
  restore "$LIB"
  restore "$NODE_LIB"

  # Only the Node.js: for scripts/from-source.sh.
  if [ -n "${FORCHETTA_NODE_ONLY:-}" ]; then
    install_node
    return 0
  fi

  version=${FORCHETTA_VERSION:-$PINNED_VERSION}
  if [ -z "$version" ]; then
    latest=$(curl --proto "$PROTO" --proto-redir "$PROTO" -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES/latest") || fail "GitHub does not answer" "try again in a moment"
    version=${latest##*/v}
  fi
  # 0.13.0, 0.13.0-beta.1.
  case $version in
    '' | *[!0-9a-z.-]* | [!0-9]* | *..*) fail "the last version of Forchetta was not found" "see $RELEASES" ;;
  esac
  say "Forchetta $version, for linux-$ARCH…"
  get "$RELEASES/download/v$version/forchetta-$version-linux.tar.gz" "$WORK/forchetta.tar.gz" || fail "Forchetta $version for Linux could not be downloaded" "see $RELEASES"
  if [ -n "$PINNED_SHA256" ] && [ "$version" = "$PINNED_VERSION" ]; then
    want=$PINNED_SHA256
  else
    get "$RELEASES/download/v$version/forchetta-$version-linux.tar.gz.sha256" "$WORK/forchetta.sha256" || fail "the checksum of Forchetta $version could not be downloaded"
    want=$(cut -d' ' -f1 "$WORK/forchetta.sha256")
  fi
  intact "$WORK/forchetta.tar.gz" "$want" || fail "the download is not the one of the release: nothing was installed"
  attested "$WORK/forchetta.tar.gz" || fail "GitHub did not confirm that it made this archive from the source of Forchetta $version: nothing was installed"
  mkdir -p "$WORK/app"
  tar -xzf "$WORK/forchetta.tar.gz" -C "$WORK/app" --strip-components 1
  [ -f "$WORK/app/node_modules/node-pty/prebuilds/linux-$ARCH/pty.node" ] || fail "Forchetta $version has no terminals for linux-$ARCH" "see $RELEASES"

  install_node
  node=node
  if [ -x "$NODE_LIB/bin/node" ]; then node=$NODE_LIB/bin/node; fi
  stage "$WORK/app" "$LIB" || fail "Forchetta could not be copied to $LIB: the one there is as it was" "is the disk full?"
  "$node" -e 'require(process.argv[1])' "$LIB.new/node_modules/node-pty" >/dev/null 2>&1 || fail "the terminals of Forchetta $version do not open on this Linux: nothing was installed"
  swap "$LIB" || fail "Forchetta could not be put in $LIB: the one there is as it was"
  mkdir -p "$BIN"
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
