#!/usr/bin/env bash
# Installs the Trading 212 order broker (docs/t212-broker.md) as the dedicated OS user studio-trader.
#
# Run it yourself, once, as root. Best from Windows PowerShell, so no shell profile of the Studio user is involved:
#   wsl.exe -d Ubuntu -u root -- bash /home/laosong/projects/agent-cloud-studio/scripts/wsl/install-t212-broker.sh \
#     --studio-user laosong --origins https://studio.example.com --allowed-envs demo
# Build first, as the Studio user:  npm run build:server
#
# It creates the studio-trader user and the studio-broker group, adds the Studio user to that group, creates
# /var/lib/studio-trader (0700), optionally moves order key files there (0600), copies the broker, its Node binary
# and its modules into a root-owned /opt/studio-trader, installs and enables the systemd socket and service, and
# checks the result. It never prints key material. Re-running it upgrades the code and keeps state and config.
set -euo pipefail

STATE_DIR=/var/lib/studio-trader
APP_DIR=/opt/studio-trader
TRADER_USER=studio-trader
BROKER_GROUP=studio-broker
UNIT_DIR=/etc/systemd/system
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

STUDIO_USER=laosong
NODE_SRC=""
LIVE_KEY=""
DEMO_KEY=""
REMOVE_SOURCE=0
ORIGINS=""
ALLOWED_ENVS=""
MAX_ORDER_VALUE=""
START=1

usage() {
  cat <<'EOF'
Usage: install-t212-broker.sh [options]   (as root)
  --studio-user NAME       OS user that runs Studio; added to the studio-broker group (default: laosong)
  --node PATH              Node binary to copy into /opt/studio-trader/bin (default: the Studio user's node)
  --live-key-file PATH     copy this order key file (TRADING212_API_KEY / TRADING212_API_SECRET) in as live.env
  --demo-key-file PATH     the same for demo.env
  --remove-source          delete the key files given above after copying them
  --origins LIST           comma-separated Studio origins for a new config.json, e.g. https://studio.example.com
  --allowed-envs LIST      comma-separated accounts for a new config.json: demo, live (default: none = off)
  --max-order-value N      per-order cap for a new config.json (default 500, in the account currency)
  --no-start               install and enable, but do not start or restart anything
An existing config.json is never overwritten: edit it and restart the broker instead.
Prefer "studio-trader set-key" over key files: a file the Studio user could read may already be copied.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --studio-user) STUDIO_USER="$2"; shift 2 ;;
    --node) NODE_SRC="$2"; shift 2 ;;
    --live-key-file) LIVE_KEY="$2"; shift 2 ;;
    --demo-key-file) DEMO_KEY="$2"; shift 2 ;;
    --remove-source) REMOVE_SOURCE=1; shift ;;
    --origins) ORIGINS="$2"; shift 2 ;;
    --allowed-envs) ALLOWED_ENVS="$2"; shift 2 ;;
    --max-order-value) MAX_ORDER_VALUE="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# "a,b" -> ["a","b"] after checking each item against a pattern (no JSON tooling needed).
json_list() {
  local list="$1" pattern="$2" out="" item
  IFS=',' read -r -a items <<< "$list"
  for item in "${items[@]}"; do
    item="$(printf '%s' "$item" | tr -d '[:space:]')"
    [ -z "$item" ] && continue
    printf '%s' "$item" | grep -Eq "$pattern" || die "invalid value: $item"
    out="${out:+$out,}\"$item\""
  done
  printf '[%s]' "$out"
}

[ "$(id -u)" -eq 0 ] || die "run as root (for example: wsl.exe -d Ubuntu -u root -- bash $0 ...)"
id "$STUDIO_USER" >/dev/null 2>&1 || die "no such user: $STUDIO_USER"
[ "$STUDIO_USER" != "$TRADER_USER" ] || die "--studio-user must not be $TRADER_USER"
command -v systemctl >/dev/null || die "systemd is required (WSL: [boot] systemd=true in /etc/wsl.conf)"
[ -f "$ROOT/dist-server/server/modules/t212-broker/main.js" ] || die "build first, as $STUDIO_USER: cd $ROOT && npm run build:server"

say "Checks that decide whether the isolation can hold"
# Each of these lets the Studio user become root (or Windows) and read everything, broker included.
if [ -r /proc/sys/fs/binfmt_misc/WSLInterop ] && grep -q '^enabled' /proc/sys/fs/binfmt_misc/WSLInterop; then
  warn "WSL interop is active: Linux users can start Windows programs such as wsl.exe -u root. Set [interop] enabled=false in /etc/wsl.conf, then run wsl.exe --shutdown from Windows."
fi
if sudo -l -U "$STUDIO_USER" 2>/dev/null | grep -q 'NOPASSWD'; then
  warn "$STUDIO_USER may use sudo without a password: anyone with a Studio terminal is root. Remove NOPASSWD."
fi
for group in docker lxd incus disk; do
  if id -nG "$STUDIO_USER" | tr ' ' '\n' | grep -qx "$group"; then warn "$STUDIO_USER is in the $group group, which is root-equivalent."; fi
done
for path in "$ROOT" "$ROOT/dist-server" "$ROOT/node_modules"; do
  owner="$(stat -Lc %U "$path")"
  [ "$owner" = root ] || echo "note: $path is owned by $owner. The broker is copied from it, so install only from a checkout you trust right now (git status clean, the reviewed commit)."
done

if [ -z "$NODE_SRC" ]; then
  NODE_SRC="$(runuser -u "$STUDIO_USER" -- bash -lc 'command -v node' 2>/dev/null || true)"
fi
[ -n "$NODE_SRC" ] && [ -x "$NODE_SRC" ] || die "Node binary not found; pass --node /path/to/node"
NODE_SRC="$(readlink -f "$NODE_SRC")"
NODE_MAJOR="$("$NODE_SRC" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20 or newer is required (found $NODE_MAJOR)"
echo "node: $NODE_SRC ($("$NODE_SRC" -v), sha256 $(sha256sum "$NODE_SRC" | cut -c1-16)...)"

say "User, group and state directory"
getent group "$BROKER_GROUP" >/dev/null || groupadd --system "$BROKER_GROUP"
if ! id "$TRADER_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$TRADER_USER"
fi
usermod -aG "$BROKER_GROUP" "$STUDIO_USER"
install -d -m 0700 -o "$TRADER_USER" -g "$TRADER_USER" "$STATE_DIR"
chown "$TRADER_USER:$TRADER_USER" "$STATE_DIR"
chmod 0700 "$STATE_DIR"
echo "$STATE_DIR is $(stat -c '%U:%G %a' "$STATE_DIR"); $STUDIO_USER is in: $(id -nG "$STUDIO_USER")"

copy_key() {
  local source="$1" env="$2"
  [ -z "$source" ] && return 0
  [ -f "$source" ] || die "key file not found: $source"
  grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?TRADING212_API_KEY[[:space:]]*=' "$source" || die "$source has no TRADING212_API_KEY line"
  grep -q '^[[:space:]]*\(export[[:space:]]\+\)\?TRADING212_API_SECRET[[:space:]]*=' "$source" || die "$source has no TRADING212_API_SECRET line"
  install -m 0600 -o "$TRADER_USER" -g "$TRADER_USER" "$source" "$STATE_DIR/$env.env"
  echo "copied the $env order key into $STATE_DIR/$env.env (0600, $TRADER_USER)"
  if [ "$REMOVE_SOURCE" -eq 1 ]; then
    rm -f -- "$source"
    echo "removed $source"
  else
    warn "$source still exists and $STUDIO_USER may read it: delete it (and any copy, e.g. under /mnt/c) or rotate the key."
  fi
  case "$source" in /mnt/*) warn "$source is on a Windows drive: Windows copies, backups and synced folders may keep it. Rotating the key is safest." ;; esac
}
copy_key "$LIVE_KEY" live
copy_key "$DEMO_KEY" demo

if [ ! -f "$STATE_DIR/config.json" ]; then
  envs="$(json_list "$ALLOWED_ENVS" '^(live|demo)$')"
  origins="$(json_list "$ORIGINS" '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$')"
  value="${MAX_ORDER_VALUE:-500}"
  printf '%s' "$value" | grep -Eq '^[0-9]+(\.[0-9]+)?$' || die "invalid --max-order-value: $value"
  umask 077
  printf '{\n  "allowedEnvs": %s,\n  "maxOrderValue": %s,\n  "maxOrdersPerHour": 10,\n  "origins": %s,\n  "demoConfirmWithoutPasskey": false\n}\n' \
    "$envs" "$value" "$origins" > "$STATE_DIR/config.json"
  chown "$TRADER_USER:$TRADER_USER" "$STATE_DIR/config.json"
  chmod 0600 "$STATE_DIR/config.json"
  echo "wrote $STATE_DIR/config.json"
else
  echo "kept the existing $STATE_DIR/config.json"
fi

say "Root-owned program copy in $APP_DIR"
STAGE="$(mktemp -d /opt/studio-trader.new.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
install -d -m 0755 "$STAGE/bin"
install -m 0755 "$NODE_SRC" "$STAGE/bin/node"
"$STAGE/bin/node" "$ROOT/scripts/wsl/stage-t212-broker.mjs" --from "$ROOT" --to "$STAGE"
cat > "$STAGE/bin/studio-trader" <<EOF
#!/bin/sh
# Broker CLI; run it as the broker's user, e.g. from Windows: wsl.exe -d Ubuntu -u $TRADER_USER -e $APP_DIR/bin/studio-trader enroll-code
export STUDIO_TRADER_STATE_DIR="\${STUDIO_TRADER_STATE_DIR:-$STATE_DIR}"
exec $APP_DIR/bin/node $APP_DIR/app/main.js "\$@"
EOF
chmod 0755 "$STAGE/bin/studio-trader"
chown -R root:root "$STAGE"
chmod -R go-w,a+rX "$STAGE"
chmod 0755 "$STAGE"
if [ -d "$APP_DIR" ]; then rm -rf "$APP_DIR.old"; mv "$APP_DIR" "$APP_DIR.old"; fi
mv "$STAGE" "$APP_DIR"
trap - EXIT
rm -rf "$APP_DIR.old"
echo "$APP_DIR: $(stat -c '%U:%G %a' "$APP_DIR"), main.js sha256 $(sha256sum "$APP_DIR/app/main.js" | cut -c1-16)..."

say "systemd units"
install -m 0644 -o root -g root "$ROOT/scripts/wsl/studio-trader-broker.socket" "$UNIT_DIR/studio-trader-broker.socket"
install -m 0644 -o root -g root "$ROOT/scripts/wsl/studio-trader-broker.service" "$UNIT_DIR/studio-trader-broker.service"
systemctl daemon-reload
systemctl enable studio-trader-broker.socket studio-trader-broker.service
if [ "$START" -eq 1 ]; then
  systemctl restart studio-trader-broker.socket
  systemctl restart studio-trader-broker.service
  sleep 2
  systemctl --no-pager --lines=5 status studio-trader-broker.service || true
fi

say "Self-check (as $TRADER_USER, no network)"
runuser -u "$TRADER_USER" -- "$APP_DIR/bin/studio-trader" check || warn "the check above reported something to fix"
ls -l /run/studio-trader/broker.sock 2>/dev/null || true

cat <<EOF

Next steps (docs/t212-broker.md):
  1. Order key, if not copied above (typed, never echoed):
       wsl.exe -d Ubuntu -u $TRADER_USER -e $APP_DIR/bin/studio-trader set-key live
  2. In $ROOT/.env set  STUDIO_T212_BROKER_SOCKET=/run/studio-trader/broker.sock
     and remove orders:execute from the key in STUDIO_T212_ENV_FILE (Studio now only reads).
  3. Restart WSL so $STUDIO_USER's services get the new group:  wsl.exe --shutdown  (from Windows)
  4. Enrollment code for each domain's passkey (valid 10 minutes, one passkey):
       wsl.exe -d Ubuntu -u $TRADER_USER -e $APP_DIR/bin/studio-trader enroll-code
EOF
