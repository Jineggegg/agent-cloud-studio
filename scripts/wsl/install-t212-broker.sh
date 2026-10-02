#!/bin/bash
# Installs or upgrades the Trading 212 order broker (docs/t212-broker.md): the order-capable key lives only with
# the OS user studio-trader, whose program is a root-owned copy in /opt/studio-trader built from a reviewed commit.
#
# The OS user that runs Studio is untrusted, so this script, run as root through sudo:
#   - must itself come from the reviewed commit, not from that user's checkout. docs/t212-broker.md (step 2) runs
#     it from a root-owned export; it refuses to run from a directory another account can write;
#   - first closes WSL interop for this boot, then checks that the Studio user cannot become root or the Windows
#     user, and stops if it can (only --accept-insecure continues, loudly; --check-only runs just the checks);
#   - never runs git inside that user's repository: it clones it with --no-local (served by git upload-pack, the
#     git command meant to be safe against an untrusted repository) into a root-only directory and exports the
#     commit from there with git archive;
#   - never uses that user's node, shell profile, dist-server or node_modules: the throwaway system user
#     studio-trader-build builds the export (scripts/wsl/build-t212-broker.sh) with a Node.js tarball checked
#     against the SHA-256 the owner copied from nodejs.org;
#   - installs only plain, root-owned files, and never edits /etc/wsl.conf or prints key material.
# Re-running it upgrades the program and keeps the state directory, the keys and config.json.
set -euo pipefail
umask 022

STATE_DIR=/var/lib/studio-trader
APP_DIR=/opt/studio-trader
TRADER_USER=studio-trader
BROKER_GROUP=studio-broker
BUILD_USER=studio-trader-build
UNIT_DIR=/etc/systemd/system
UNITS=(studio-trader-isolation.service studio-trader-broker.socket studio-trader-broker.service)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/wsl/t212-broker-install-lib.sh
. "$SCRIPT_DIR/t212-broker-install-lib.sh"

STUDIO_USER=laosong
REPO=""
COMMIT=""
NODE_TARBALL=""
NODE_SHA256=""
REGISTRY=""
ORIGINS=""
# Defaults for a new config.json; the broker's parser (broker.config.ts) uses the same ones for absent fields,
# except allowedEnvs and origins, which it leaves empty (trading off).
ALLOWED_ENVS=demo
MAX_ORDER_VALUE=500
MAX_DAILY_ORDER_VALUE=2000
LIVE_COOLDOWN_SECONDS=60
MAX_ORDERS_PER_HOUR=10
CHECK_ONLY=0
ACCEPT_INSECURE=0
ASSUME_YES=0
START=1

usage() {
  cat <<'EOF'
Usage (as root, through sudo, from a root-owned export of the reviewed commit; see docs/t212-broker.md step 2):
  install-t212-broker.sh --repo PATH [--commit SHA] --node-tarball FILE --node-sha256 HEX --origins LIST [options]
  install-t212-broker.sh --check-only [--studio-user NAME]

  --studio-user NAME          OS user that runs Studio; joins the studio-broker group (default: laosong)
  --check-only                only check that NAME cannot become root or the Windows user; changes nothing
  --accept-insecure           install even though those checks fail: the broker then CANNOT protect the key
  --repo PATH                 git repository to build from; cloned with --no-local, never used in place
  --commit SHA                commit to build (default: the repository's HEAD, shown for you to confirm);
                              give the full SHA you reviewed and nothing is asked
  --yes                       do not ask to confirm a commit that was not given as a full SHA
  --node-tarball FILE         official node-v<version>-linux-x64.tar.xz from nodejs.org (Node 20 or newer)
  --node-sha256 HEX           its SHA-256 from nodejs.org/dist/v<version>/SHASUMS256.txt
  --registry URL              npm registry for the build (default: npm's own)
New config.json only (an existing one is never changed; edit it and restart the broker instead). Either way the
new broker's own parser checks the config before anything is installed:
  --origins LIST              comma-separated Studio origins (at most 8), e.g. https://studio.example.com
  --allowed-envs LIST         accounts that may trade: demo, live (default: demo)
  --max-order-value N         per-order cap in the account currency (default: 500)
  --max-daily-order-value N   rolling 24 h cumulative cap, 0 = off (default: 2000)
  --live-cooldown-seconds N   minimum seconds between two live orders, 0 = off (default: 60)
  --max-orders-per-hour N     orders per rolling hour (default: 10)
  --no-start                  install and enable, but do not (re)start the broker
EOF
}

need() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value (see --help)"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --studio-user) need "$@"; STUDIO_USER="$2"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --accept-insecure) ACCEPT_INSECURE=1; shift ;;
    --repo) need "$@"; REPO="$2"; shift 2 ;;
    --commit) need "$@"; COMMIT="$(printf '%s' "$2" | tr 'A-F' 'a-f')"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --node-tarball) need "$@"; NODE_TARBALL="$2"; shift 2 ;;
    --node-sha256) need "$@"; NODE_SHA256="$2"; shift 2 ;;
    --registry) need "$@"; REGISTRY="$2"; shift 2 ;;
    --origins) need "$@"; ORIGINS="$2"; shift 2 ;;
    --allowed-envs) [ "$#" -ge 2 ] || die "--allowed-envs needs a value"; ALLOWED_ENVS="$2"; shift 2 ;;
    --max-order-value) need "$@"; MAX_ORDER_VALUE="$2"; shift 2 ;;
    --max-daily-order-value) need "$@"; MAX_DAILY_ORDER_VALUE="$2"; shift 2 ;;
    --live-cooldown-seconds) need "$@"; LIVE_COOLDOWN_SECONDS="$2"; shift 2 ;;
    --max-orders-per-hour) need "$@"; MAX_ORDERS_PER_HOUR="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root, through sudo (docs/t212-broker.md, step 2)"
# Catches running the copy in the Studio user's checkout by mistake. It cannot catch a modified copy, which is why
# docs/t212-broker.md runs this from a root-owned export of the reviewed commit.
if ! (require_trusted_path "$SCRIPT_DIR/install-t212-broker.sh" && require_trusted_path "$SCRIPT_DIR/t212-broker-install-lib.sh" \
  && require_trusted_path "$SCRIPT_DIR/studio-trader-isolation.sh"); then
  die "run this installer from a root-owned export of the reviewed commit, not from $SCRIPT_DIR (docs/t212-broker.md, step 2)"
fi
id "$STUDIO_USER" >/dev/null 2>&1 || die "no such user: $STUDIO_USER"
case "$STUDIO_USER" in
  root|"$TRADER_USER"|"$BUILD_USER") die "--studio-user must be the ordinary account that runs Studio" ;;
esac
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || die "systemd is required ([boot] systemd=true in /etc/wsl.conf)"

if [ "$CHECK_ONLY" -eq 1 ]; then
  say "Isolation checks for $STUDIO_USER (--check-only: nothing is changed)"
  echo "(Problems about the WSL interop handler or /run/WSL are closed by the install itself, at once and at every"
  echo " boot; everything else has to be fixed first.)"
  enforce_isolation "$STUDIO_USER" 0
  exit 0
fi

[ -n "$REPO" ] || die "--repo is required: the git repository to build from (e.g. /home/$STUDIO_USER/projects/agent-cloud-studio)"
[ -n "$NODE_TARBALL" ] && [ -n "$NODE_SHA256" ] || die "--node-tarball and --node-sha256 are required (docs/t212-broker.md, step 1)"
# The config.json for a new state directory, checked here for what the shell can check; the new broker's own
# parser checks it again (validate-config) before anything is installed.
CONFIG_JSON="$(broker_config_json "$ALLOWED_ENVS" "$ORIGINS" "$MAX_ORDER_VALUE" "$MAX_DAILY_ORDER_VALUE" \
  "$LIVE_COOLDOWN_SECONDS" "$MAX_ORDERS_PER_HOUR")"
for tool in git tar sha256sum runuser useradd userdel pkill make c++ python3; do
  command -v "$tool" >/dev/null || die "$tool is missing (the build needs: sudo apt-get install git build-essential python3)"
done

say "Closing WSL interop for this boot (studio-trader-isolation; installed below for every boot)"
bash "$SCRIPT_DIR/studio-trader-isolation.sh" || warn "studio-trader-isolation could not close interop; the checks below say what is open"

say "Isolation checks for $STUDIO_USER"
enforce_isolation "$STUDIO_USER" "$ACCEPT_INSECURE"

WORK="$(mktemp -d /var/tmp/studio-trader-install.XXXXXX)"
NEW=""
remove_build_user() {
  id "$BUILD_USER" >/dev/null 2>&1 || return 0
  pkill -KILL -u "$BUILD_USER" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -u "$BUILD_USER" >/dev/null || break; sleep 0.5; done
  crontab -r -u "$BUILD_USER" 2>/dev/null || true
  find /tmp /var/tmp /dev/shm -xdev -user "$BUILD_USER" -prune -exec rm -rf -- {} + 2>/dev/null || true
  userdel "$BUILD_USER" 2>/dev/null || warn "could not remove the build user $BUILD_USER; remove it with: userdel $BUILD_USER"
}
cleanup() {
  rm -rf -- "$WORK"
  [ -z "$NEW" ] || rm -rf -- "$NEW"
  remove_build_user
}
trap cleanup EXIT
# Root-only except for search: the build user reaches its own directories inside by name; nobody can list them.
chmod 0711 "$WORK"
git_export() { git -C "$WORK/repo.git" "$@"; }

say "Source: $REPO"
git -c safe.directory='*' -c protocol.file.allow=always clone --quiet --mirror --no-local -- "$REPO" "$WORK/repo.git"
SPEC="${COMMIT:-HEAD}"
SHA="$(git_export rev-parse --verify --quiet "$SPEC^{commit}")" || die "no commit $SPEC in $REPO"
echo "commit $SHA"
git_export log -1 --format='  %s%n  %an, %cd' "$SHA"
if [ "$COMMIT" != "$SHA" ]; then
  # Not given as the exact SHA: the owner compares it with the reviewed commit before anything is built.
  if [ "$ASSUME_YES" -ne 1 ]; then
    { exec 3<>/dev/tty; } 2>/dev/null || die "pass the full SHA you reviewed with --commit (no terminal to confirm $SHA)"
    printf 'Build and install %s? It must be the commit you reviewed. [y/N] ' "$SHA" >&3
    read -r answer <&3 || answer=""
    exec 3>&-
    [ "$answer" = y ] || [ "$answer" = Y ] || die "not confirmed"
  fi
fi

say "Node.js: $NODE_TARBALL"
install_node_tarball "$NODE_TARBALL" "$NODE_SHA256" "$WORK"
NODE_VERSION="$("$NODE_PREFIX/bin/node" -v)" || die "the Node binary does not run here (wrong architecture?)"
major="${NODE_VERSION#v}"
[ "${major%%.*}" -ge 20 ] || die "Node 20 or newer is required (the tarball is $NODE_VERSION)"
echo "node $NODE_VERSION, SHA-256 verified"

say "Build as $BUILD_USER (npm ci --ignore-scripts, better-sqlite3 from source, tsc)"
# Two exports: the build user gets one to work in; the unit files and the isolation script come from the other,
# which stays root-only, so nothing the build runs can change them.
install -d -m 0700 "$WORK/trusted"
install -d -m 0755 "$WORK/src"
git_export archive --format=tar "$SHA" scripts/wsl | tar -x -C "$WORK/trusted" --no-same-owner
git_export archive --format=tar "$SHA" | tar -x -C "$WORK/src" --no-same-owner
if ! id "$BUILD_USER" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$BUILD_USER"
fi
install -d -m 0700 -o "$BUILD_USER" -g "$BUILD_USER" "$WORK/home" "$WORK/out"
chown -R "$BUILD_USER:$BUILD_USER" "$WORK/src"
runuser -u "$BUILD_USER" -- env -i HOME="$WORK/home" TMPDIR="$WORK/home/tmp" LANG=C.UTF-8 \
  PATH="$NODE_PREFIX/bin:/usr/local/bin:/usr/bin:/bin" \
  /bin/bash "$WORK/src/scripts/wsl/build-t212-broker.sh" --node-prefix "$NODE_PREFIX" --out "$WORK/out/stage" \
  ${REGISTRY:+--registry "$REGISTRY"}
# Nothing the build started may keep running while its output is copied.
pkill -KILL -u "$BUILD_USER" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -u "$BUILD_USER" >/dev/null || break; sleep 0.5; done
! pgrep -u "$BUILD_USER" >/dev/null || die "processes of $BUILD_USER are still running"

say "Root-owned program in $APP_DIR"
STAGE="$WORK/out/stage"
[ -d "$STAGE" ] && [ ! -L "$STAGE" ] || die "the build produced no $STAGE"
require_plain_tree "$STAGE"
NEW="$(mktemp -d "$APP_DIR.new.XXXXXX")"
cp -R --no-dereference -- "$STAGE/." "$NEW/"
install -d -m 0755 "$NEW/bin"
install -m 0755 "$NODE_PREFIX/bin/node" "$NEW/bin/node"
install -m 0755 "$WORK/trusted/scripts/wsl/studio-trader-isolation.sh" "$NEW/bin/studio-trader-isolation"
cat > "$NEW/bin/studio-trader" <<EOF
#!/bin/sh
# Broker CLI. Run it as the broker's user through sudo, e.g. from Windows PowerShell:
#   wsl.exe -d Ubuntu --cd / -e sudo -u $TRADER_USER $APP_DIR/bin/studio-trader enroll-code
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_REPL_EXTERNAL_MODULE
export STUDIO_TRADER_STATE_DIR="\${STUDIO_TRADER_STATE_DIR:-$STATE_DIR}"
exec $APP_DIR/bin/node $APP_DIR/app/main.js "\$@"
EOF
chmod 0755 "$NEW/bin/studio-trader"
printf '%s\n' "$SHA" > "$NEW/COMMIT"
chown -R root:root "$NEW"
chmod -R go-w "$NEW"
chmod 0755 "$NEW"
require_plain_tree "$NEW"
require_trusted_tree "$NEW"

say "Configuration, checked by the new broker's own parser"
CONFIG="$STATE_DIR/config.json"
# Runs the new broker's validate-config as nobody, with the config on standard input: it is the parser the broker
# starts with (at most 8 origins, each exactly scheme://host[:port], HTTPS except loopback, every limit in range).
validate_config() {
  runuser -u nobody -- env -i PATH=/usr/bin:/bin LANG=C.UTF-8 "$NEW/bin/node" "$NEW/app/main.js" validate-config
}
if [ -e "$CONFIG" ] || [ -L "$CONFIG" ]; then
  { [ -f "$CONFIG" ] && [ ! -L "$CONFIG" ]; } || die "$CONFIG is not a regular file"
  validate_config < "$CONFIG" \
    || die "the existing $CONFIG is not valid for this version (see above). Fix it (sudo nano $CONFIG) and run this" \
      "again; nothing was installed"
  WRITE_CONFIG=0
else
  printf '%s\n' "$CONFIG_JSON" | validate_config \
    || die "the new config.json would not be valid (see above): check --origins (at most 8, each exactly like" \
      "https://studio.example.com, no trailing /), --allowed-envs and the limits; nothing was installed"
  WRITE_CONFIG=1
fi

say "Users, group and state directory"
getent group "$BROKER_GROUP" >/dev/null || groupadd --system "$BROKER_GROUP"
if ! id "$TRADER_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$TRADER_USER"
fi
usermod -aG "$BROKER_GROUP" "$STUDIO_USER"
! groups_of "$STUDIO_USER" | grep -qx "$TRADER_USER" || die "$STUDIO_USER must not be in the $TRADER_USER group"
[ ! -L "$STATE_DIR" ] || die "$STATE_DIR is a symbolic link"
install -d -m 0700 -o "$TRADER_USER" -g "$TRADER_USER" "$STATE_DIR"
chown "$TRADER_USER:$TRADER_USER" "$STATE_DIR"
chmod 0700 "$STATE_DIR"
echo "$STATE_DIR is $(stat -c '%U:%G %a' "$STATE_DIR"); $STUDIO_USER is in: $(id -nG "$STUDIO_USER")"
if [ "$WRITE_CONFIG" -eq 0 ]; then
  echo "kept the existing $CONFIG"
else
  [ -n "$ORIGINS" ] || warn "no --origins: no Studio address may trade until you add origins to $CONFIG"
  tmp="$(mktemp "$STATE_DIR/.config.json.XXXXXX")"
  printf '%s\n' "$CONFIG_JSON" > "$tmp"
  chown "$TRADER_USER:$TRADER_USER" "$tmp"
  chmod 0600 "$tmp"
  mv -T -- "$tmp" "$CONFIG"
  echo "wrote $CONFIG:"
  cat "$CONFIG"
fi

say "Install $APP_DIR (commit $SHA) and the systemd units"
if [ -e "$APP_DIR" ] || [ -L "$APP_DIR" ]; then
  rm -rf -- "$APP_DIR.old"
  mv -T -- "$APP_DIR" "$APP_DIR.old"
fi
mv -T -- "$NEW" "$APP_DIR"
NEW=""
rm -rf -- "$APP_DIR.old"
for unit in "${UNITS[@]}"; do
  install -m 0644 -o root -g root "$WORK/trusted/scripts/wsl/$unit" "$UNIT_DIR/$unit"
done
systemctl daemon-reload
systemctl enable "${UNITS[@]}"
systemctl restart studio-trader-isolation.service || warn "studio-trader-isolation.service failed: systemctl status studio-trader-isolation"
if [ "$START" -eq 1 ]; then
  systemctl restart studio-trader-broker.socket
  systemctl restart studio-trader-broker.service
  sleep 2
  systemctl --no-pager --lines=5 status studio-trader-broker.service || true
fi
echo "$APP_DIR: $(stat -c '%U:%G %a' "$APP_DIR"), commit $(cat "$APP_DIR/COMMIT")"

say "Self-check (as $TRADER_USER, no network)"
runuser -u "$TRADER_USER" -- "$APP_DIR/bin/studio-trader" check || warn "studio-trader check reported something to fix (above)"

cat <<EOF

Next steps (docs/t212-broker.md, from Windows PowerShell; sudo asks for your password):
  1. Order key, typed and never echoed (a new key; delete the old order-capable key in Trading 212 afterwards):
       wsl.exe -d Ubuntu --cd / -e sudo -u $TRADER_USER $APP_DIR/bin/studio-trader set-key live
  2. In Studio's .env set  STUDIO_T212_BROKER_SOCKET=/run/studio-trader/broker.sock ; Studio's own Trading 212
     key (STUDIO_T212_ENV_FILE) must be read-only and live inside WSL, not under /mnt/c.
  3. wsl.exe --shutdown, then open WSL again: $STUDIO_USER's services pick up the studio-broker group.
  4. Enrollment code for each Studio address's passkey (valid 10 minutes, one passkey):
       wsl.exe -d Ubuntu --cd / -e sudo -u $TRADER_USER $APP_DIR/bin/studio-trader enroll-code
     then check what was enrolled:
       wsl.exe -d Ubuntu --cd / -e sudo -u $TRADER_USER $APP_DIR/bin/studio-trader passkeys
EOF
