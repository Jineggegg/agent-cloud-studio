#!/bin/bash
# Stops non-root WSL users from starting Windows programs, so the Studio OS user cannot run `wsl.exe -u root` and
# read the order key past the broker. Run as root at every boot by studio-trader-isolation.service, before the
# broker starts; installed (as a root-owned copy) and run once right away by scripts/wsl/install-t212-broker.sh.
# See docs/t212-broker.md, step 0.
#
# There are two ways in, and both are closed:
#   1. The binfmt_misc handler WSLInterop (WSLInterop-late on some versions) hands every executed Windows PE file
#      to /init, which asks the WSL interop server to start it on Windows as the Windows user. It is removed.
#   2. The interop server listens on unix sockets in /run/WSL (srwxrwxrwx root; 1_interop links to 2_interop).
#      /init can also be run directly, `/init /mnt/c/Windows/System32/cmd.exe /c ...`, and then uses such a socket
#      with no binfmt handler at all, so removing the handler alone is NOT enough. /run/WSL itself is made
#      root:root 0700: no non-root process can reach any socket in it, including those WSL creates there later
#      (one per session).
# /etc/wsl.conf [interop] enabled=false is not relied on: measured on WSL 3.0.1.0 with it set, the handler still
# read "enabled" after a restart and the sockets stayed world-writable. That the Windows side then refused to
# start programs (`UtilAcceptVsock:281: accept4 failed 110` after about 10 s) is not relied on either.
#
# Exits non-zero, and the unit shows as failed, unless both are verified afterwards.
set -u

BINFMT_DIR=/proc/sys/fs/binfmt_misc
RUN_DIR=/run/WSL
HANDLERS=(WSLInterop WSLInterop-late)
status=0

handler_enabled() { grep -qs '^enabled' "$BINFMT_DIR/$1"; }

# 1. Remove the handlers (-1 removes an entry; 0 would only disable it).
for handler in "${HANDLERS[@]}"; do
  if [ -e "$BINFMT_DIR/$handler" ]; then
    echo -1 > "$BINFMT_DIR/$handler" 2>/dev/null || echo 0 > "$BINFMT_DIR/$handler" 2>/dev/null || true
  fi
done
for handler in "${HANDLERS[@]}"; do
  if handler_enabled "$handler"; then
    # Last resort for this boot: switch off every binfmt_misc handler (qemu-user ones included).
    echo 0 > "$BINFMT_DIR/status" 2>/dev/null || true
    break
  fi
done

# 2. Make /run/WSL root-only. A link there is not followed: nothing but WSL's own directory is changed.
if [ -L "$RUN_DIR" ]; then
  echo "studio-trader-isolation: $RUN_DIR is a symbolic link; refusing to touch it" >&2
  status=1
elif [ -d "$RUN_DIR" ]; then
  if ! chown root:root "$RUN_DIR" || ! chmod 0700 "$RUN_DIR"; then status=1; fi
else
  echo "studio-trader-isolation: no $RUN_DIR yet; nothing to lock (studio-trader check reports it if it appears)"
fi

# Verify both.
for handler in "${HANDLERS[@]}"; do
  if handler_enabled "$handler"; then
    echo "studio-trader-isolation: the binfmt handler $handler is still enabled" >&2
    status=1
  fi
done
if [ ! -r "$BINFMT_DIR/status" ]; then
  echo "studio-trader-isolation: cannot read $BINFMT_DIR/status, so the handler state is unknown" >&2
  status=1
fi
if [ -d "$RUN_DIR" ] && [ ! -L "$RUN_DIR" ]; then
  owner_mode="$(stat -c '%u %g %a' "$RUN_DIR")"
  if [ "$owner_mode" != "0 0 700" ]; then
    echo "studio-trader-isolation: $RUN_DIR is uid/gid/mode $owner_mode, not 0 0 700" >&2
    status=1
  fi
fi

if [ "$status" -ne 0 ]; then
  echo "studio-trader-isolation: WSL interop is NOT closed; the order key is not isolated" >&2
  exit 1
fi
echo "studio-trader-isolation: WSL interop closed (no binfmt handler; $RUN_DIR root-only)"
