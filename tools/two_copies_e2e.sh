#!/usr/bin/env bash
# Single-instance check: a second copy started on the same profile must quit and touch nothing of the first.
# Isolated (rule 12): headless KWin (kwin_wayland --virtual), a private D-Bus with no services, its own HOME and
# XDG_RUNTIME_DIR, basic password store. Runs the built app (`npm run build`, out/) with node_modules' Electron.
#
#   tools/two_copies_e2e.sh --dir DIR      (run it memory-capped: memrun.sh / a systemd scope)
#
# Copy 1 starts; a job folder stands for its running job; copy 2 starts. PASS: copy 2 exits within 15 s and the
# job folder is still there (2026-10-22: app.quit() didn't stop copy 2's ready handler, which removed it).
set -uo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
[ "${1:-}" = "--dir" ] && [ -n "${2:-}" ] || { echo "usage: two_copies_e2e.sh --dir DIR" >&2; exit 2; }
OUT="$(mkdir -p "$2" && cd "$2" && pwd)"
mkdir -p "$OUT/home" "$OUT/iso/no-services"
RUN="$(mktemp -d /tmp/ck-2c-XXXXXX)"   # a socket path must fit 108 bytes; tiny, removed at exit
chmod 700 "$RUN"
PIDS=()
cleanup() {
  # loop: NOT-WORTH — the test's few processes at cleanup
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  # loop: SERIAL-REQUIRED — 2 s for the copies to quit before the hard stop [bounded: two seconds]
  sleep 2
  # loop: NOT-WORTH — the test's few processes at cleanup
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done
  rm -rf "$RUN"
}
trap cleanup EXIT
cat > "$OUT/iso/session.conf" <<CONF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=$RUN</listen><auth>EXTERNAL</auth><servicedir>$OUT/iso/no-services</servicedir>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
CONF
dbus-daemon --config-file="$OUT/iso/session.conf" --nofork --print-address=1 > "$OUT/bus.addr" 2>/dev/null &
PIDS+=($!)
# loop: SERIAL-REQUIRED — 1 s for the private bus to start
sleep 1
E=(HOME="$OUT/home" USER="$USER" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 XDG_RUNTIME_DIR="$RUN"
  DBUS_SESSION_BUS_ADDRESS="$(head -1 "$OUT/bus.addr")" XDG_SESSION_TYPE=wayland XDG_CONFIG_HOME="$OUT/home/.config"
  XDG_CACHE_HOME="$OUT/home/.cache" XDG_DATA_HOME="$OUT/home/.local/share" GTK_USE_PORTAL=0 NO_AT_BRIDGE=1
  GSETTINGS_BACKEND=memory GIO_USE_VFS=local)
env -i "${E[@]}" kwin_wayland --virtual --no-lockscreen --no-global-shortcuts --socket ck-wl-2c --width 1280 --height 800 > "$OUT/kwin.log" 2>&1 &
PIDS+=($!)
# loop: SERIAL-REQUIRED — waits for the compositor's socket, 0.2 s steps [bounded: 10 s]
for _ in $(seq 50); do [ -S "$RUN/ck-wl-2c" ] && break; sleep 0.2; done
EL="$APP/node_modules/electron/dist/electron"
env -i "${E[@]}" WAYLAND_DISPLAY=ck-wl-2c "$EL" --no-sandbox --password-store=basic --remote-debugging-port=0 "$APP" > "$OUT/copy1.log" 2>&1 &
PIDS+=($!)
# loop: SERIAL-REQUIRED — waits for copy 1's DevTools port file (its browser is up), 0.2 s steps [bounded: 20 s]
for _ in $(seq 100); do [ -f "$OUT/home/.config/corridorkey-desktop/DevToolsActivePort" ] && break; sleep 0.2; done
# loop: SERIAL-REQUIRED — 2 s for copy 1 to finish its start
sleep 2
JOB="$OUT/home/.cache/corridorkey-desktop/jobs/running-job"
mkdir -p "$JOB" && echo x > "$JOB/baton.f16"
env -i "${E[@]}" WAYLAND_DISPLAY=ck-wl-2c "$EL" --no-sandbox --password-store=basic "$APP" > "$OUT/copy2.log" 2>&1 &
C2=$!
PIDS+=($C2)
# loop: SERIAL-REQUIRED — waits for copy 2 to quit, 0.2 s steps [bounded: 15 s]
for _ in $(seq 75); do kill -0 "$C2" 2>/dev/null || break; sleep 0.2; done
ok=1
if kill -0 "$C2" 2>/dev/null; then echo "FAIL: copy 2 still runs after 15 s"; ok=0; else echo "copy 2 quit"; fi
if [ -e "$JOB/baton.f16" ]; then echo "copy 1's job folder kept"; else echo "FAIL: copy 2 removed copy 1's job folder"; ok=0; fi
[ "$ok" = 1 ] && echo PASS
[ "$ok" = 1 ]
