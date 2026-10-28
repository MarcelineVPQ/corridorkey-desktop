#!/usr/bin/env bash
# Run one isolated copy of the built app for checks and screenshots (rule 12):
# never your screen, your D-Bus, your keyring or your settings.
#
#   tools/isolated.sh --state DIR [--port P] [--size 1400x900] [--env K=V]... [--packaged DIR]
#
# --packaged DIR runs a packaged build (electron-builder's linux-unpacked folder) instead of the dev
# build in out/, so what ships inside the app (resources/engine/…) is what runs.
#
# Runs in the foreground until the app quits (close its window over CDP:
# tools/drive.mjs does); KWin exits with it. P = the page's DevTools port: without --port a free one is picked; either
# way it is written to DIR/port (tools/drive.mjs --state DIR reads it). A port another program already listens on is
# refused: Marcy's DS5 app holds 127.0.0.1:9333, and a test copy on it was driven as the wrong app (2026-10-28).
#   - env -i: a clean environment; no WAYLAND_DISPLAY/DISPLAY/DBUS/XDG_RUNTIME_DIR from your session.
#   - its own HOME (DIR/home) and XDG dirs, so settings and cache are private.
#   - a fresh XDG_RUNTIME_DIR (mode 700) and a private D-Bus session bus with
#     no services to start (no portals, kwalletd/ksecretd, at-spi).
#   - --password-store=basic: Chromium never looks for a keyring.
#   - its own headless Wayland compositor (kwin_wayland --virtual), the same
#     native-Wayland path the app requires (no X11: HDR, Marcy 2026-10-21).
#   - memory-capped (systemd-run scope, MemoryMax=4G, or --mem SIZE: running jobs needs the engine's 5-6 GB too, so a
#     keying test needs about 14G; started from your session, outside env -i).
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
STATE="" PORT="" SIZE="1400x900" ENVS=() PACKAGED="" MEM="4G"
# loop: NOT-WORTH — the command line
while [ $# -gt 0 ]; do
  case "$1" in
    --state) STATE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --mem) MEM="$2"; shift 2 ;;
    --env) ENVS+=("$2"); shift 2 ;;
    --packaged) PACKAGED="$(cd "$2" && pwd)"; shift 2 ;;
    *) echo "isolated.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$STATE" ] || { echo "usage: isolated.sh --state DIR [--port P]" >&2; exit 2; }
# the DevTools port: P only while nothing listens on it (Chromium's own bind would fail silently and drive.mjs reach
# whatever holds it), else a free one the system gives; a window remains between this check and Electron's bind
# loop: NOT-WORTH — one bind on 127.0.0.1, once per run [bounded: a local listen]
ASKED="$PORT"
PORT="$(node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>{console.log(s.address().port);s.close()})' "${ASKED:-0}")" ||
  { echo "isolated.sh: port $ASKED is in use by another program (another app's DevTools?); give another --port, or none for a free one" >&2; exit 2; }
mkdir -p "$STATE/home" "$STATE/iso/no-services"
echo "$PORT" > "$STATE/port"
echo "isolated.sh: DevTools port $PORT (in $STATE/port)" >&2
RUN="$(mktemp -d /tmp/ck-iso-XXXXXX)"   # a socket path must fit 108 bytes; tiny, removed at exit
chmod 700 "$RUN"
# the scope (KWin, D-Bus, the app) by name, so a stop of this script (Ctrl+C, kill, a caller's timeout) ends all of it:
# a signal to this shell alone left the scope running
UNIT="ck-iso-$PORT-$$"
trap 'rm -rf "$RUN"' EXIT
trap 'systemctl --user stop "$UNIT.scope" 2>/dev/null; exit 143' INT TERM
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
exec $(if [ -n "$PACKAGED" ]; then echo "\"$PACKAGED/corridorkey-desktop\""; else echo "\"$APP/node_modules/electron/dist/electron\""; fi) --no-sandbox --password-store=basic --remote-debugging-port=$PORT $([ -n "$PACKAGED" ] || echo "\"$APP\"")
RUN
chmod +x "$STATE/iso/run-app.sh"
# not exec: the EXIT trap above removes RUN only if this shell is still there when the app ends (with exec every run
# left a /tmp/ck-iso-* folder behind). In the background with a wait, so the stop trap runs at once (bash runs a trap
# only after a foreground command ends).
systemd-run --user --scope --quiet --collect --unit="$UNIT" ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax="$MEM" -p MemorySwapMax=0 -- \
  env -i HOME="$STATE/home" USER="$USER" PATH="/usr/local/bin:/usr/bin:/bin" LANG="${LANG:-C.UTF-8}" \
  XDG_RUNTIME_DIR="$RUN" XDG_CONFIG_HOME="$STATE/home/.config" XDG_CACHE_HOME="$STATE/home/.cache" XDG_DATA_HOME="$STATE/home/.local/share" \
  XDG_SESSION_TYPE=wayland GTK_USE_PORTAL=0 NO_AT_BRIDGE=1 GSETTINGS_BACKEND=memory GIO_USE_VFS=local "${ENVS[@]}" \
  dbus-run-session --config-file="$STATE/iso/session.conf" -- \
  kwin_wayland --virtual --no-lockscreen --no-global-shortcuts --socket "ck-wl-$PORT" --width "$W" --height "$H" \
  --exit-with-session="$STATE/iso/run-app.sh" >"$STATE/app.log" 2>&1 &
# loop: SERIAL-REQUIRED — waits for the app's scope [bounded: the app's quit (tools/drive.mjs closes it), or a stop]
wait $!
