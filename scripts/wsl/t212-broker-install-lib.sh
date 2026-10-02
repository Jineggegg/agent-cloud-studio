# shellcheck shell=bash
# Checks used by scripts/wsl/install-t212-broker.sh, kept apart so the broker tests
# (server/modules/t212-broker/tests/broker-install.test.ts) can run each one without root.
# Sourced, never executed. Each function succeeds quietly, prints findings, or dies.
#
# Threat model (docs/t212-broker.md): the OS user that runs Studio is untrusted. Root must never run, copy or
# trust anything that user can write, and the install must stop while that user can become root or Windows.

say() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Overridable locations of the live WSL state, so tests can describe a machine instead of reading this one.
T212_BINFMT_DIR="${T212_BINFMT_DIR:-/proc/sys/fs/binfmt_misc}"
T212_WSL_RUN_DIR="${T212_WSL_RUN_DIR:-/run/WSL}"
T212_MOUNTS_FILE="${T212_MOUNTS_FILE:-/proc/self/mounts}"

# Runs a command as another OS user, directly: no shell profile or rc file of that user is involved.
# Tests replace it to run as themselves.
as_user() {
  local user="$1"
  shift
  runuser -u "$user" -- "$@"
}

# sudo rules that apply to a user, and that user's groups (one per line). Tests replace both.
sudo_rules_for() { sudo -l -U "$1" 2>/dev/null || true; }
groups_of() { id -nG "$1" | tr ' ' '\n'; }

# Owner uid, group gid and octal mode of a path after following links, e.g. "0 0 755". Used by the interop socket
# check; tests replace it to describe root-owned files they cannot create.
path_stat() { stat -L -c '%u %g %a' -- "$1"; }

# Succeeds when an account other than root may use permission BIT (1 search or execute, 2 write) on PATH: its
# owner when that is not root, its group when that is not root, or everyone else. A path that cannot be inspected
# counts as usable, so that an unchecked path never passes as a safe one.
nonroot_may() {
  local target="$1" bit="$2" info uid gid mode
  info="$(path_stat "$target")" || return 0
  read -r uid gid mode <<< "$info"
  mode=$((8#$mode))
  [ "$uid" != 0 ] && return 0
  if [ "$gid" != 0 ] && (( mode & (bit << 3) )); then return 0; fi
  (( mode & bit ))
}

# Walks from PATH up to / and dies unless each directory (and PATH itself) belongs to root and is not writable by
# group or others.
trusted_chain() {
  local target="$1" current="$2" info uid mode
  while :; do
    info="$(stat -L -c '%u %a' -- "$current")" || die "cannot inspect $current (for $target)"
    uid="${info%% *}"
    mode="${info##* }"
    [ "$uid" = 0 ] || die "$current (for $target) belongs to uid $uid, not root: that account can change it"
    (( (8#$mode & 8#022) == 0 )) || die "$current (for $target) is writable by group or others (mode $mode)"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

# Dies unless only root can change what PATH names: the file it resolves to and every directory above that, and
# every directory the given path passes through (a link inside a directory someone else can write could be
# swapped later). Only then may root execute or copy it.
require_trusted_path() {
  local target="$1" resolved lexical
  resolved="$(readlink -e -- "$target")" || die "$target does not exist"
  lexical="$(realpath -s -- "$target")"
  trusted_chain "$target" "$resolved"
  [ "$lexical" = "$resolved" ] || trusted_chain "$target" "$(dirname -- "$lexical")"
}

# require_trusted_path for a directory and everything inside it (links are judged by their owner only).
require_trusted_tree() {
  local dir="$1" bad
  require_trusted_path "$dir"
  bad="$(find "$dir" \( ! -uid 0 -o \( ! -type l -perm /022 \) \) -print -quit)"
  [ -z "$bad" ] || die "$bad is not root-owned and read-only for others"
}

# Dies if the tree holds anything but regular files and directories (links, FIFOs, sockets, devices), or a
# file with a set-user-ID, set-group-ID or sticky bit. Run on the root-owned copy, so the answer cannot change.
require_plain_tree() {
  local dir="$1" bad
  bad="$(find "$dir" ! -type f ! -type d -print -quit)"
  [ -z "$bad" ] || die "refusing $bad: $(stat -c %F -- "$bad"), only regular files and directories may be installed"
  bad="$(find "$dir" -perm /7000 ! -type d -print -quit)"
  [ -z "$bad" ] || die "refusing $bad: it has a set-user-ID, set-group-ID or sticky bit"
}

# "a, b" -> ["a","b"] after checking each item (whole) against an extended regular expression. The patterns keep
# quotes, backslashes and control characters out of the JSON; the broker's own parser has the final word
# (install-t212-broker.sh runs the new broker's validate-config on the result).
json_list() {
  local list="$1" pattern="$2" out="" item items=()
  IFS=',' read -r -a items <<< "$list"
  for item in "${items[@]}"; do
    item="$(printf '%s' "$item" | tr -d '[:space:]')"
    [ -n "$item" ] || continue
    printf '%s' "$item" | grep -Eqx "$pattern" || die "invalid value: $item"
    out="${out:+$out,}\"$item\""
  done
  printf '[%s]' "$out"
}

# Dies unless VALUE is a plain JSON number (an integer when the fifth argument is "integer") from MIN to MAX.
number_in() {
  local value="$1" min="$2" max="$3" name="$4" pattern='^(0|[1-9][0-9]*)(\.[0-9]+)?$'
  [ "${5:-}" != integer ] || pattern='^(0|[1-9][0-9]*)$'
  if ! [[ "$value" =~ $pattern ]] || ! awk -v v="$value" -v lo="$min" -v hi="$max" 'BEGIN { exit !(v >= lo && v <= hi) }'; then
    die "$name must be a number from $min to $max (got: $value)"
  fi
}

# Prints the config.json the installer writes into a new state directory, from its options: ENVS ORIGINS
# MAX_ORDER_VALUE MAX_DAILY_ORDER_VALUE LIVE_COOLDOWN_SECONDS MAX_ORDERS_PER_HOUR. Dies on a value that cannot be
# put into JSON safely; whether the result is a valid broker config is for the broker to say (validate-config).
broker_config_json() {
  local envs_json origins_json
  number_in "$3" 0.01 100000 --max-order-value
  number_in "$4" 0 1000000 --max-daily-order-value
  number_in "$5" 0 86400 --live-cooldown-seconds integer
  number_in "$6" 1 100 --max-orders-per-hour integer
  envs_json="$(json_list "$1" '(live|demo)')" || exit 1
  origins_json="$(json_list "$2" 'https://[A-Za-z0-9.-]+(:[0-9]{1,5})?|http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?')" || exit 1
  printf '{\n  "allowedEnvs": %s,\n  "maxOrderValue": %s,\n  "maxDailyOrderValue": %s,\n  "liveOrderCooldownSeconds": %s,\n  "maxOrdersPerHour": %s,\n  "origins": %s,\n  "demoConfirmWithoutPasskey": false\n}\n' \
    "$envs_json" "$3" "$4" "$5" "$6" "$origins_json"
}

# Copies an official Node.js linux tarball into WORK (a root-only directory), checks it against the SHA-256 the
# owner took from nodejs.org before anything in it runs, and unpacks it to WORK/node. Sets NODE_PREFIX. The file
# may come from anywhere, the Studio user's downloads included: only the hash decides whether it is used.
install_node_tarball() {
  local file="$1" expected work="$3" actual relative
  expected="$(printf '%s' "$2" | tr 'A-F' 'a-f')"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] \
    || die "--node-sha256 must be the 64-character SHA-256 listed in nodejs.org/dist/v<version>/SHASUMS256.txt"
  [ -f "$file" ] || die "Node tarball not found: $file"
  install -m 0600 -- "$file" "$work/node.tar"
  actual="$(sha256sum -- "$work/node.tar")"
  actual="${actual%% *}"
  if [ "$actual" != "$expected" ]; then
    rm -f -- "$work/node.tar"
    die "the Node tarball's SHA-256 is $actual, not $expected: download it again and compare with SHASUMS256.txt"
  fi
  install -d -m 0755 "$work/node"
  tar -xf "$work/node.tar" -C "$work/node" --strip-components=1 --no-same-owner --no-same-permissions
  rm -f -- "$work/node.tar"
  for relative in bin/node lib/node_modules/npm/bin/npm-cli.js \
    lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js include/node/common.gypi; do
    [ -f "$work/node/$relative" ] || die "the tarball has no $relative: use the official node-v<version>-linux-<arch>.tar.xz"
  done
  chmod -R go-w "$work/node"
  NODE_PREFIX="$work/node"
}

# Mount points of Windows drives (drvfs, over 9p or virtiofs) in a mounts table such as /proc/self/mounts.
windows_drive_roots() {
  local mounts="${1:-$T212_MOUNTS_FILE}" source mountpoint fstype options rest
  [ -r "$mounts" ] || return 0
  # shellcheck disable=SC2034 # source and rest only take up their fields
  while read -r source mountpoint fstype options rest; do
    case "$fstype" in
      drvfs|virtiofs) ;;
      9p) case ",$options;" in *[,\;]aname=drvfs[,\;]*) ;; *) continue ;; esac ;;
      *) continue ;;
    esac
    printf '%b\n' "$mountpoint"
  done < "$mounts"
}

# Paths on the given Windows drives that USER can write and that would let a Linux user act as the Windows user:
# the drive root, each profile (.wslconfig with kernel=, PowerShell profiles, WindowsApps on the Windows PATH),
# and the Startup folders. Prints one path per line; no output means none of them is writable.
windows_writable_paths() {
  local user="$1" root profile restore
  shift
  local candidates=()
  restore="$(shopt -p nullglob)"
  shopt -s nullglob
  for root in "$@"; do
    candidates+=("$root" "$root/ProgramData/Microsoft/Windows/Start Menu/Programs/StartUp"
      "$root/Windows" "$root/Windows/System32")
    for profile in "$root"/Users/*/; do
      profile="${profile%/}"
      candidates+=("$profile" "$profile/.wslconfig"
        "$profile/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"
        "$profile/Documents/WindowsPowerShell" "$profile/Documents/PowerShell"
        "$profile/AppData/Local/Microsoft/WindowsApps")
    done
  done
  eval "$restore"
  [ "${#candidates[@]}" -gt 0 ] || return 0
  # One process as USER for every probe; only paths that exist count.
  # shellcheck disable=SC2016 # the script is for the inner shell
  as_user "$user" /bin/sh -c 'for p do if [ -e "$p" ] && [ -w "$p" ]; then printf "%s\n" "$p"; fi; done' sh "${candidates[@]}"
}

# The exact /etc/wsl.conf lines the isolation needs. The installer prints them; it never edits the file.
wsl_conf_advice() {
  cat <<'EOF'
Put these lines into /etc/wsl.conf (as root: sudo nano /etc/wsl.conf), then run  wsl.exe --shutdown  from Windows:

    [interop]
    enabled = false
    appendWindowsPath = false

    [automount]
    options = "uid=0,gid=0,umask=022,fmask=133"
    # or hide the Windows drives from WSL altogether instead:
    # enabled = false

With these, non-root users can read but no longer write /mnt/c (nothing at all with enabled = false): Studio's
files, the Trading 212 key files included, must live inside WSL. Do not add "metadata": it lets files carry their
own Linux owner and mode. The WSL interop handler and /run/WSL are locked at every boot by
studio-trader-isolation.service, which this installer installs (wsl.conf alone does not switch them off).
EOF
}

# Everything that lets USER (the OS user running Studio) become root or the Windows user and so reach the order
# key. Prints one problem per line; no output means the isolation can hold.
isolation_problems() {
  local user="$1" handler socket group path writable roots=()
  [ "$(id -u "$user" 2>/dev/null)" != 0 ] || echo "$user is root: the broker cannot be isolated from it"
  # 1. binfmt handlers: executing any Windows .exe starts it on Windows, as the Windows user.
  if [ ! -r "$T212_BINFMT_DIR/status" ]; then
    echo "cannot read $T212_BINFMT_DIR/status, so a WSL interop binfmt handler cannot be ruled out" \
      "(mount binfmt_misc: systemctl start proc-sys-fs-binfmt_misc.mount)"
  fi
  for handler in WSLInterop WSLInterop-late; do
    if [ -r "$T212_BINFMT_DIR/$handler" ] && grep -q '^enabled' "$T212_BINFMT_DIR/$handler"; then
      echo "the WSL interop binfmt handler $handler is enabled: $user can run Windows programs such as" \
        "wsl.exe -u root (studio-trader-isolation.service removes it at boot; now: echo -1 > $T212_BINFMT_DIR/$handler)"
    fi
  done
  # 2. Interop sockets: /init <program.exe> starts Windows programs through them without any binfmt handler.
  # Only a socket that a non-root account can reach counts: through a directory it may search, and writable by it.
  if [ -e "$T212_WSL_RUN_DIR" ] && nonroot_may "$T212_WSL_RUN_DIR" 1; then
    for socket in "$T212_WSL_RUN_DIR"/*interop*; do
      # -S follows links (1_interop -> 2_interop) and skips the unexpanded pattern when nothing matches.
      if [ -S "$socket" ] && nonroot_may "$socket" 2; then
        echo "the WSL interop socket $socket is usable by non-root users: /init <program.exe> starts Windows" \
          "programs through it even without a binfmt handler (studio-trader-isolation.service makes" \
          "$T212_WSL_RUN_DIR root:root 0700 at boot; now: chmod 0700 $T212_WSL_RUN_DIR)"
        break
      fi
    done
  fi
  # 3. Root-equivalent rights.
  if sudo_rules_for "$user" | grep -Eq 'NOPASSWD|!authenticate'; then
    echo "$user may use sudo without a password: anyone with a Studio terminal is root (remove NOPASSWD)"
  fi
  for group in docker lxd incus disk libvirt; do
    if groups_of "$user" | grep -qx "$group"; then
      echo "$user is in the $group group, which is root-equivalent (gpasswd -d $user $group)"
    fi
  done
  # 4. Writable Windows paths: a Startup item, .wslconfig kernel= or PowerShell profile runs as the Windows user.
  mapfile -t roots < <(windows_drive_roots "$T212_MOUNTS_FILE")
  [ "${#roots[@]}" -gt 0 ] || return 0
  # A probe that fails to run counts as a problem: an unchecked drive must not pass as a safe one.
  if ! writable="$(windows_writable_paths "$user" "${roots[@]}")"; then
    echo "could not check which Windows paths $user can write on ${roots[*]}"
    return 0
  fi
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    echo "$user can write the Windows path $path: something placed there runs as the Windows user, who can run" \
      "wsl.exe -u root ([automount] options in /etc/wsl.conf, see below)"
  done <<< "$writable"
}

# Fails closed: dies listing every problem and the wsl.conf lines, unless ACCEPT is 1 (--accept-insecure), which
# only warns.
enforce_isolation() {
  local user="$1" accept="$2" problems
  problems="$(isolation_problems "$user")"
  if [ -z "$problems" ]; then
    echo "isolation checks passed for $user"
    return 0
  fi
  printf '%s\n' "$problems" | sed 's/^/  - /' >&2
  wsl_conf_advice >&2
  if [ "$accept" = 1 ]; then
    warn "--accept-insecure: continuing although $user can reach root or Windows. The broker CANNOT protect the" \
      "order key on this machine until every problem above is fixed."
    return 0
  fi
  die "the broker cannot protect the order key while any of the above holds. Fix it (docs/t212-broker.md," \
    "step 0), run wsl.exe --shutdown from Windows, then run this again (--check-only repeats just these checks)."
}
