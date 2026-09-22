#!/usr/bin/env bash
#
# Install a claude-terminal release into /Applications, quarantine stripped.
#
#   scripts/install-release.sh              # latest release
#   scripts/install-release.sh 0.12.1       # that one (v0.12.1 works too)
#   scripts/install-release.sh --open       # ...and launch it afterwards
#   scripts/install-release.sh --force      # reinstall the version you have
#
# The whole download-mount-drag-xattr dance in one command. That last step is
# the point: these builds are ad-hoc signed rather than Developer ID signed, so
# Gatekeeper calls a quarantined copy "damaged" and offers only Move to Bin.
# Stripping the flag is needed once per download — which means again after
# every update, which is what makes this worth a script.
#
# Verifies the published SHA256 before mounting anything, because stripping
# Gatekeeper from an unsigned binary is exactly when you want to know the bytes
# are the ones the release workflow built. Keeps the app it replaces until the
# new one is in place, so a failure halfway leaves you with a working app.
set -euo pipefail

REPO='ritwik-g/claude-terminal'
APP='/Applications/Claude Terminal.app'

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

version=''
open_after=0
force=0
for arg in "$@"; do
  case "$arg" in
    --open) open_after=1 ;;
    --force) force=1 ;;
    -h|--help)
      sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option: $arg" ;;
    *) version="$arg" ;;
  esac
done

[ "$(uname -s)" = 'Darwin' ] || die 'macOS only — this mounts a .dmg and strips quarantine.'
command -v gh >/dev/null 2>&1 || die 'needs the GitHub CLI: brew install gh'

case "$(uname -m)" in
  arm64) arch='arm64' ;;
  x86_64) arch='x64' ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

if [ -n "$version" ]; then
  tag="v${version#v}"
else
  tag=$(gh release view --repo "$REPO" --json tagName -q .tagName) \
    || die "could not ask GitHub for the latest release of $REPO."
fi
num="${tag#v}"

installed=''
if [ -d "$APP" ]; then
  installed=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$APP/Contents/Info.plist" 2>/dev/null || true)
fi
if [ -n "$installed" ] && [ "$installed" = "$num" ] && [ "$force" -eq 0 ]; then
  say "Claude Terminal $num is already installed. Pass --force to reinstall."
  exit 0
fi

tmp=$(mktemp -d)
mnt="$tmp/mnt"
backup=''
cleanup() {
  [ -d "$mnt" ] && hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true
  # Only if we moved the old app aside and never got a new one into place.
  if [ -n "$backup" ] && [ -d "$backup" ] && [ ! -d "$APP" ]; then
    mv "$backup" "$APP" >/dev/null 2>&1 || true
    say "Put the previous app back."
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

dmg="Claude.Terminal-${num}-mac-${arch}.dmg"
say "Downloading $dmg …"
gh release download "$tag" --repo "$REPO" --dir "$tmp" \
  --pattern "$dmg" --pattern 'SHA256SUMS-macos-*.txt' \
  || die "no $tag release, or it has no mac-$arch build."

sums=$(find "$tmp" -maxdepth 1 -name 'SHA256SUMS-macos-*.txt' | head -1)
[ -n "$sums" ] || die "$tag publishes no checksums — refusing to install unverified."
# The workflow records digests under the DOWNLOADED name (spaces become dots),
# which is what we asked for, so the filenames line up.
expected=$(awk -v f="$dmg" '$2 == f { print $1 }' "$sums")
[ -n "$expected" ] || die "no digest for $dmg in $(basename "$sums")."
actual=$(shasum -a 256 "$tmp/$dmg" | awk '{print $1}')
[ "$expected" = "$actual" ] || die "checksum mismatch for $dmg — refusing to install."
say 'Checksum OK.'

# Replacing the bundle under a running app gives you a half-old app. Quitting
# it may raise its own "terminals are still running" dialog, so wait for the
# process to actually go rather than assuming the quit took.
if pgrep -x 'Claude Terminal' >/dev/null 2>&1; then
  say 'Claude Terminal is running — quitting it.'
  osascript -e 'quit app "Claude Terminal"' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -x 'Claude Terminal' >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -x 'Claude Terminal' >/dev/null 2>&1; then
    die 'still running — it may be asking whether to close busy terminals. Answer it, then re-run.'
  fi
fi

mkdir -p "$mnt"
# An explicit mountpoint, because every one of these DMGs wants to be
# /Volumes/Claude Terminal and one may already be mounted there.
hdiutil attach "$tmp/$dmg" -nobrowse -readonly -mountpoint "$mnt" -quiet
src="$mnt/Claude Terminal.app"
[ -d "$src" ] || die "no Claude Terminal.app inside $dmg."

if [ -d "$APP" ]; then
  mkdir -p "$tmp/previous"
  backup="$tmp/previous/Claude Terminal.app"
  mv "$APP" "$backup"
fi
say 'Installing to /Applications …'
# ditto rather than cp -R: it is the one that carries a bundle across whole.
ditto "$src" "$APP" || die "could not write to /Applications — try: sudo $0 $*"

# Downloading with gh may not set the quarantine flag at all (it is browsers
# that attach it), but strip and then CHECK, so the result does not depend on
# how the file arrived.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
  die "quarantine survived — run: xattr -dr com.apple.quarantine \"$APP\""
fi

now=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$APP/Contents/Info.plist" 2>/dev/null || echo '?')
say ''
if [ -n "$installed" ]; then
  say "Installed Claude Terminal $now (was $installed) — quarantine stripped."
else
  say "Installed Claude Terminal $now — quarantine stripped."
fi

if [ "$open_after" -eq 1 ]; then
  open "$APP"
else
  say 'Launch it:  open -a "Claude Terminal"'
fi
