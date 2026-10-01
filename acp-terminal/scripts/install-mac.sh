#!/usr/bin/env bash
# Install the latest local CodePit build into /Applications and start it.
#
#   scripts/install-mac.sh            install what is in release/ (built by `npm run dist:mac`)
#   scripts/install-mac.sh --build    build first, then install
#   scripts/install-mac.sh --no-open  install without starting it
#
# CodePit runs its server and the agents inside the app, so quitting it to swap the
# bundle ends every running agent turn. Sessions are kept in ~/.codepit and continue
# their agent sessions after the restart.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# CODEPIT_INSTALL_DIR installs somewhere else (e.g. ~/Applications, or a temp dir to try the script)
DEST="${CODEPIT_INSTALL_DIR:-/Applications}/CodePit.app"
BUILD=0
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --no-open) OPEN=0 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script installs the macOS app; run it on a Mac." >&2
  exit 1
fi

# electron-builder puts arm64 builds in release/mac-arm64 and Intel ones in release/mac
case "$(uname -m)" in
  arm64) APP="$ROOT/release/mac-arm64/CodePit.app" ;;
  *) APP="$ROOT/release/mac/CodePit.app" ;;
esac

if [[ $BUILD -eq 1 ]]; then
  echo "==> Building CodePit (npm run dist:mac)"
  (cd "$ROOT" && npm run dist:mac)
fi

if [[ ! -d "$APP" ]]; then
  echo "No build found at $APP. Run with --build, or run 'npm run dist:mac' in $ROOT first." >&2
  exit 1
fi

built_at="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$APP/Contents/MacOS/CodePit")"
commit="$(git -C "$ROOT" log -1 --format='%h %s' 2>/dev/null || echo 'unknown')"
echo "==> Installing the build from $built_at"
echo "    Repo HEAD: $commit"
if [[ -n "$(git -C "$ROOT" status --porcelain -- server web electron 2>/dev/null)" ]]; then
  echo "    Note: the repo has uncommitted changes; the build may or may not include them."
fi

running() { pgrep -f "$DEST/Contents/MacOS/CodePit" >/dev/null 2>&1; }

if running; then
  echo "==> Quitting the running CodePit (approve its quit prompt if it asks)"
  osascript -e 'tell application "CodePit" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 120); do
    running || break
    sleep 1
  done
  if running; then
    echo "CodePit is still running after 2 minutes. Quit it yourself (or answer its quit prompt) and run this again." >&2
    exit 1
  fi
fi

echo "==> Copying to $DEST"
STAGE="$(mktemp -d /tmp/codepit-install.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
# Copy next to the old bundle first so a failed copy never leaves /Applications without CodePit
ditto "$APP" "$STAGE/CodePit.app"
xattr -dr com.apple.quarantine "$STAGE/CodePit.app" 2>/dev/null || true
if [[ -d "$DEST" ]]; then
  rm -rf "$DEST.previous"
  mv "$DEST" "$DEST.previous"
fi
if ! mv "$STAGE/CodePit.app" "$DEST"; then
  echo "Copy failed; putting the previous app back." >&2
  [[ -d "$DEST.previous" ]] && mv "$DEST.previous" "$DEST"
  exit 1
fi
rm -rf "$DEST.previous"
echo "    Installed $(defaults read "$DEST/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?') built $built_at"

if [[ $OPEN -eq 1 ]]; then
  echo "==> Starting CodePit"
  open "$DEST"
fi
echo "Done."
