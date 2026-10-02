#!/usr/bin/env bash
# Builds the Trading 212 order broker from a clean export of a reviewed commit and stages it for
# scripts/wsl/install-t212-broker.sh, which runs this as the throwaway user studio-trader-build: never root, never
# the Studio user, with a Node.js whose tarball the installer verified. A dry run needs no privileges:
#   git archive <commit> | tar -x -C /tmp/src
#   bash /tmp/src/scripts/wsl/build-t212-broker.sh --node-prefix /path/to/node-v<version>-linux-x64 --out /tmp/stage
#
# Steps, all inside this export:
#   1. npm ci --ignore-scripts: exactly the packages in package-lock.json, each checked against its integrity
#      hash; no package install script runs.
#   2. better-sqlite3's native addon compiled from its own sources with node-gyp against this Node's headers
#      (no prebuilt binary is downloaded). Needs make, a C/C++ compiler and python3.
#   3. The broker alone compiled with scripts/wsl/tsconfig.t212-broker.json.
#   4. scripts/wsl/stage-t212-broker.mjs copies it and its runtime packages to --out, refusing links.
set -euo pipefail

NODE_PREFIX=""
OUT=""
REGISTRY=""
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n-- %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --node-prefix) NODE_PREFIX="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    *) die "unknown option: $1 (usage: build-t212-broker.sh --node-prefix DIR --out DIR [--registry URL])" ;;
  esac
done

[ "$(id -u)" -ne 0 ] || die "do not build as root: the installer runs this as studio-trader-build"
[ -n "$NODE_PREFIX" ] && [ -n "$OUT" ] || die "--node-prefix and --out are required"
NODE="$NODE_PREFIX/bin/node"
NPM_CLI="$NODE_PREFIX/lib/node_modules/npm/bin/npm-cli.js"
NODE_GYP="$NODE_PREFIX/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
for file in "$NODE" "$NPM_CLI" "$NODE_GYP" "$NODE_PREFIX/include/node/common.gypi"; do
  [ -f "$file" ] || die "missing $file: --node-prefix must be an unpacked official Node.js tarball"
done
for name in node_modules dist-server; do
  [ ! -e "$SRC/$name" ] || die "$SRC/$name already exists: build only from a fresh git archive export"
done
[ ! -e "$OUT" ] || die "$OUT already exists"
for tool in make c++ python3; do
  command -v "$tool" >/dev/null || die "$tool is missing; node-gyp needs it (sudo apt-get install build-essential python3)"
done

# Everything the build writes outside the export (npm's cache, temporary files) stays in this user's own HOME.
export npm_config_cache="${HOME:?HOME must be set}/npm-cache" npm_config_update_notifier=false \
  npm_config_fund=false npm_config_audit=false
export TMPDIR="${TMPDIR:-$HOME/tmp}"
mkdir -p -m 0700 "$TMPDIR"
if [ -n "$REGISTRY" ]; then export npm_config_registry="$REGISTRY"; fi
cd "$SRC"

step "npm ci --ignore-scripts (package-lock.json integrity)"
"$NODE" "$NPM_CLI" ci --ignore-scripts --no-audit --no-fund --loglevel=warn

step "better-sqlite3 addon from source"
(cd node_modules/better-sqlite3 && "$NODE" "$NODE_GYP" rebuild --release --nodedir="$NODE_PREFIX" --jobs=max)
ADDON=node_modules/better-sqlite3/build/Release/better_sqlite3.node
[ -f "$ADDON" ] || die "node-gyp did not produce $ADDON"
# Keep only the addon: node-gyp leaves object files and a python3 link (build/node_gyp_bins) behind.
mv "$ADDON" "$SRC/better_sqlite3.node.built"
rm -rf node_modules/better-sqlite3/build
mkdir -p node_modules/better-sqlite3/build/Release
mv "$SRC/better_sqlite3.node.built" "$ADDON"

step "compile the broker"
"$NODE" node_modules/typescript/bin/tsc -p scripts/wsl/tsconfig.t212-broker.json

step "stage"
"$NODE" scripts/wsl/stage-t212-broker.mjs --from "$SRC" --to "$OUT"
# Smoke test: the staged app and its native addon load from the staged modules alone.
(cd "$OUT" && "$NODE" app/main.js help >/dev/null \
  && "$NODE" -e "const Database = require('better-sqlite3'); new Database(':memory:').prepare('SELECT 1').get();")
echo "build ok: $OUT"
