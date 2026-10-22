#!/usr/bin/env bash
# Run one isolated copy of the built app for checks and screenshots (rule 12):
# never your screen, your D-Bus, your keyring or your settings.
#
#   tools/isolated.sh --state DIR --port P [--size 1400x900] [--env K=V]...
#
# Runs in the foreground until the app quits (close its window over CDP:
# tools/drive.mjs does); KWin exits with it. P = the page's DevTools port.
#   - env -i: a clean environment; no WAYLAND_DISPLAY/DISPLAY/DBUS/XDG_RUNTIME_DIR from your session.
#   - its own HOME (DIR/home) and XDG dirs, so settings and cache are private.
#   - a fresh XDG_RUNTIME_DIR (mode 700) and a private D-Bus session bus with
#     no services to start (no portals, kwalletd/ksecretd, at-spi).
#   - --password-store=basic: Chromium never looks for a keyring.
#   - its own headless Wayland compositor (kwin_wayland --virtual), the same
#     native-Wayland path the app requires (no X11: HDR, Marcy 2026-10-21).
#   - memory-capped (systemd-run scope, MemoryMax=4G; started from your session, outside env -i).
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
STATE="" PORT="" SIZE="1400x900" ENVS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --state) STATE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --env) ENVS+=("$2"); shift 2 ;;
    *) echo "isolated.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$STATE" ] && [ -n "$PORT" ] || { echo "usage: isolated.sh --state DIR --port P" >&2; exit 2; }
mkdir -p "$STATE/home" "$STATE/iso/no-services"
RUN="$(mktemp -d /tmp/ck-iso-XXXXXX)"   # a socket path must fit 108 bytes; tiny, removed at exit
chmod 700 "$RUN"
trap 'rm -rf "$RUN"' EXIT
cat > "$STATE/iso/session.conf" <<CONF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=$RUN</listen>
  <auth>EXTERNAL</auth>
  <servicedir>$STATE/iso/no-services</servicedir>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>
CONF
W="${SIZE%x*}" H="${SIZE#*x}"
cat > "$STATE/iso/run-app.sh" <<RUN
#!/bin/sh
export WAYLAND_DISPLAY=ck-wl-$PORT
exec "$APP/node_modules/electron/dist/electron" --no-sandbox --password-store=basic --remote-debugging-port=$PORT "$APP"
RUN
chmod +x "$STATE/iso/run-app.sh"
exec systemd-run --user --scope --quiet --collect -p MemoryMax=4G -p MemorySwapMax=0 -- \
  env -i HOME="$STATE/home" USER="$USER" PATH="/usr/local/bin:/usr/bin:/bin" LANG="${LANG:-C.UTF-8}" \
  XDG_RUNTIME_DIR="$RUN" XDG_CONFIG_HOME="$STATE/home/.config" XDG_CACHE_HOME="$STATE/home/.cache" XDG_DATA_HOME="$STATE/home/.local/share" \
  XDG_SESSION_TYPE=wayland GTK_USE_PORTAL=0 NO_AT_BRIDGE=1 GSETTINGS_BACKEND=memory GIO_USE_VFS=local "${ENVS[@]}" \
  dbus-run-session --config-file="$STATE/iso/session.conf" -- \
  kwin_wayland --virtual --no-lockscreen --no-global-shortcuts --socket "ck-wl-$PORT" --width "$W" --height "$H" \
  --exit-with-session="$STATE/iso/run-app.sh" >"$STATE/app.log" 2>&1
