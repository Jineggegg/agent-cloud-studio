#!/usr/bin/env bash
# Builds Agent Cloud Studio and installs it as a systemd *user* service inside WSL.
# Run it yourself from the repository root:  bash scripts/wsl/install-studio-service.sh
# It does not touch Tailscale, Windows networking or the existing CloudCLI service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/agent-cloud-studio.service"

if [ ! -f "$ROOT/.env" ]; then
  echo "Missing $ROOT/.env - copy .env.example and fill in STUDIO_PUBLIC_ORIGIN and the key-file paths first." >&2
  exit 1
fi
if ss -ltn | grep -q '127.0.0.1:3002 '; then
  echo "Port 3002 is already in use (the Windows Studio preview?). Stop it first, then rerun." >&2
  exit 1
fi

cd "$ROOT"
npm ci --no-audit --no-fund
npm rebuild bcrypt node-pty @vscode/ripgrep || echo "Warning: native rebuild was skipped; search or terminals may be limited."
npm run build

mkdir -p "$UNIT_DIR" "$ROOT/.data"
sed -e "s#__ROOT__#$ROOT#g" -e "s#__NODE__#$NODE#g" "$ROOT/scripts/wsl/agent-cloud-studio.service" > "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now agent-cloud-studio.service
sleep 3
systemctl --user --no-pager status agent-cloud-studio.service | head -n 12
curl -fsS -o /dev/null -w "Studio answered with HTTP %{http_code} on 127.0.0.1:3002\n" http://127.0.0.1:3002/ || true
