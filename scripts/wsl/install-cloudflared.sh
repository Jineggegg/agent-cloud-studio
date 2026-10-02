#!/usr/bin/env bash
# Installs the official cloudflared binary (Linux amd64) into ~/.local/bin, without sudo.
# Run it yourself inside WSL:  bash scripts/wsl/install-cloudflared.sh [--update]
#
# Idempotent: when cloudflared is already installed it only prints the version, unless --update is
# given, which downloads the latest release and replaces the binary only if the version changed.
# It does not log in to Cloudflare, create a tunnel or start anything; see docs/network.md.
set -euo pipefail

BIN_DIR="$HOME/.local/bin"
TARGET="$BIN_DIR/cloudflared"
# Cloudflare's own release channel on GitHub.
URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"

update=false
case "${1:-}" in
  "") ;;
  --update) update=true ;;
  *) echo "Usage: bash scripts/wsl/install-cloudflared.sh [--update]" >&2; exit 2 ;;
esac

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "This script installs the Linux amd64 build; this machine is $(uname -s) $(uname -m)." >&2
  exit 1
fi

if [ -x "$TARGET" ] && [ "$update" = false ]; then
  echo "Already installed: $("$TARGET" --version)"
  echo "Run with --update to fetch the latest release."
  exit 0
fi

mkdir -p "$BIN_DIR"
download="$(mktemp "$BIN_DIR/.cloudflared.XXXXXX")"
trap 'rm -f "$download"' EXIT

echo "Downloading the latest cloudflared release ..."
curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$download" "$URL"
chmod 0755 "$download"

# The new binary must actually run before it replaces anything.
if ! new_version="$("$download" --version 2>&1)"; then
  echo "The downloaded file does not run: $new_version" >&2
  exit 1
fi

if [ -x "$TARGET" ] && [ "$("$TARGET" --version 2>&1)" = "$new_version" ]; then
  echo "Already up to date: $new_version"
  exit 0
fi

mv -f "$download" "$TARGET"
trap - EXIT
echo "Installed: $("$TARGET" --version)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on PATH in this shell; open a new terminal or call $TARGET directly." ;;
esac
echo "Next: cloudflared tunnel login   (see docs/network.md)"
