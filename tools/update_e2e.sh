#!/usr/bin/env bash
# End-to-end self-update test: an older AppImage updates itself to a newer one
# from a local signed test feed, isolated (rule 12): its own headless Wayland
# compositor (kwin_wayland --virtual: the app is Wayland-only), a private D-Bus
# with no services, its own HOME and XDG_RUNTIME_DIR, basic password store.
# Never your screen, session bus, keyring or real feed.
#
#   tools/update_e2e.sh --dir DIR --old OLD.AppImage --new NEW.AppImage --version X.Y.Z-dev.N [--systemd]
#
# DIR gets: run/ (the old AppImage, where the update lands beside it), srv/
# (the feed + the new AppImage, served on 127.0.0.1:8765), keys, logs, and on a
# failure diag.txt (each test process's state, kernel wait channel, open files
# and AppImage mounts).
# The restart's systemd-run path can't reach your user manager from inside the
# isolation (on purpose), so it takes its fallback: a detached shell. --systemd gives
# the isolation its own user manager (systemd --user on the private XDG_RUNTIME_DIR,
# SYSTEMD_UNIT_PATH = a few empty targets: it starts no unit of yours or the system's),
# so the restart takes the normal systemd-run path; the run then checks the new copy
# ran in a corridorkey-relaunch unit and started only after the old copy had exited.
# Run it memory-capped (memrun.sh / a systemd scope): it starts two Electron copies.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
DIR="" OLD="" NEW="" VER="" SYSTEMD=0
# loop: NOT-WORTH — the command line
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --old) OLD="$2"; shift 2 ;;
    --new) NEW="$2"; shift 2 ;;
    --version) VER="$2"; shift 2 ;;
    --systemd) SYSTEMD=1; shift ;;
    *) echo "update_e2e.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$DIR" ] && [ -f "$OLD" ] && [ -f "$NEW" ] && [ -n "$VER" ] || { echo "usage: see the header" >&2; exit 2; }
DIR="$(mkdir -p "$DIR" && cd "$DIR" && pwd)"
mkdir -p "$DIR/run" "$DIR/srv/v$VER" "$DIR/home" "$DIR/iso/no-services"
cp "$OLD" "$DIR/run/" && chmod +x "$DIR/run/$(basename "$OLD")"
cp "$NEW" "$DIR/srv/v$VER/"

# A throwaway key pair: the private key signs the test feed, the public key goes only to the test app.
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('$DIR/test-key.pem',k.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});process.stdout.write(k.publicKey.export({format:'der',type:'spki'}).toString('base64'))" > "$DIR/test-key.pub"
# The feed, with the app's own feedText (tools/feed-rules.mjs), then signed like CI.
node --input-type=module -e "
import { createHash } from 'node:crypto'; import { readFileSync, writeFileSync } from 'node:fs';
const { feedText } = await import('$APP/tools/feed-rules.mjs');
const data = readFileSync('$DIR/srv/v$VER/' + '$(basename "$NEW")');
const text = feedText('dev', { tag: 'v$VER', version: '$VER', notes: 'Update test build' }, { sha512: createHash('sha512').update(data).digest('hex'), size: data.length }, 'http://127.0.0.1:8765/');
writeFileSync('$DIR/srv/latest-dev.json', text); console.log(text);"
CK_FEED_KEY="$(cat "$DIR/test-key.pem")" node "$APP/tools/sign-feed.mjs" "$DIR/srv/latest-dev.json" >/dev/null

PIDS=()
RUN=""
# The test copies' processes: the AppImages started from DIR/run, their mounts' Electron, and the shell between them,
# and only inside this run's own cgroup (the memrun scope it runs in) or below it (--systemd: the private manager's
# units): a CorridorKey AppImage of yours matches the same names and must never be listed, let alone killed at cleanup.
CG="$(sed -n 's/^0:://p' /proc/$$/cgroup)"
in_our_cgroup() {
  local c
  c="$(sed -n 's/^0:://p' "/proc/$1/cgroup" 2>/dev/null)"
  [ "$c" = "$CG" ] || [ "${c#"$CG"/}" != "$c" ]
}
test_pids() {
  # loop: NOT-WORTH — the few processes matching the names, per diagnostics / cleanup
  for p in $(pgrep -f -- "$DIR/run/|\.mount_Corrid" 2>/dev/null); do
    in_our_cgroup "$p" && echo "$p"
  done
  return 0
}
# the copies' Electron main processes: a binary inside an AppImage mount, not a Chromium helper (--type=)
main_pids() {
  # loop: NOT-WORTH — the test copies' few processes
  for p in $(test_pids); do
    case "$(readlink "/proc/$p/exe" 2>/dev/null)" in */.mount_Corrid*) ;; *) continue ;; esac
    tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- '--type=' || echo "$p"
  done
  return 0
}
# a process's start in seconds since boot (/proc/PID/stat field 22, clock ticks), the clock of `uptime_now`
# (not the epoch: /proc/stat's btime is whole seconds, measured 0.9 s off)
started_at() {
  awk -v hz="$(getconf CLK_TCK)" '{sub(/^.*\) /, ""); printf "%.2f", $20 / hz}' "/proc/$1/stat"
}
uptime_now() { cut -d' ' -f1 /proc/uptime; }
diag() {
  set +o pipefail
  {
    echo "=== $(date -Is) diagnostics"
    echo "--- AppImage mounts:"; grep -E "mount_Corrid" /proc/self/mountinfo | cut -d' ' -f5 || true
    echo "--- the test copies' process trees:"
    # loop: NOT-WORTH — the test copies' few processes, once on failure
    for p in $(test_pids); do timeout 5 ps --forest -o pid,ppid,stat,wchan:30,args -g "$(ps -o sid= -p "$p" | tr -d ' ')" 2>/dev/null | cut -c1-220; done | sort -u
    # loop: NOT-WORTH — the test copies' few processes, once on failure
    for p in $(test_pids); do
      [ -r "/proc/$p/status" ] || continue
      echo "--- pid $p ppid $(awk '/^PPid/{print $2}' "/proc/$p/status") state $(awk '/^State/{print $2}' "/proc/$p/status") wchan $(cat "/proc/$p/wchan" 2>/dev/null)"
      tr '\0' ' ' < "/proc/$p/cmdline" | cut -c1-200; echo
      echo "  env: $(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -E '^(WAYLAND_DISPLAY|DISPLAY|XDG_RUNTIME_DIR|APPIMAGE|APPDIR)=' | tr '\n' ' ')"
      # loop: NOT-WORTH — one process's open files, once on failure
      for fd in /proc/$p/fd/*; do printf '  fd %s -> %s\n' "${fd##*/}" "$(readlink "$fd" 2>/dev/null)"; done | grep -E "pipe:|/dev/fuse|mount_Corrid[^/]*$|AppImage"
      # loop: NOT-WORTH — one process's threads, once on failure
      for t in /proc/$p/task/*; do printf '  thread %s %s %s\n' "${t##*/}" "$(cat "$t/comm" 2>/dev/null)" "$(cat "$t/wchan" 2>/dev/null)"; done
      if ! grep -q /dev/fuse < <(ls -l /proc/$p/fd 2>/dev/null); then
        echo "  strace (3 s, main thread):"
        timeout 3 strace -p "$p" -tt -s 120 2>&1 | head -30 | sed 's/^/    /'
      fi
    done
  } >> "$DIR/diag.txt" 2>&1
  set -o pipefail
}
cleanup() {
  # loop: NOT-WORTH — the test copies' few processes at cleanup
  for p in $(test_pids); do kill "$p" 2>/dev/null || true; done
  # loop: NOT-WORTH — the harness's own few processes at cleanup
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  # the private user manager does not quit on SIGTERM (measured): it goes now, its units were the test copies above
  [ -n "${SD_PID:-}" ] && kill -9 "$SD_PID" 2>/dev/null
  # loop: SERIAL-REQUIRED — 1 s for the copies to go before the leftover check [bounded: one second]
  sleep 1
  # loop: NOT-WORTH — stragglers after SIGTERM, once at cleanup
  for p in $(test_pids); do kill -9 "$p" 2>/dev/null || true; done
  # systemd's read-only inaccessible/ nodes (--systemd) need write access back before they can go
  [ -n "$RUN" ] && { chmod -R u+rwX "$RUN" 2>/dev/null; rm -rf "$RUN"; }
}
trap cleanup EXIT

python3 -m http.server 8765 --bind 127.0.0.1 --directory "$DIR/srv" > "$DIR/http.log" 2>&1 &
PIDS+=($!)
RUN="$(mktemp -d /tmp/ck-upd-XXXXXX)"   # a socket path must fit 108 bytes; tiny, removed at exit
chmod 700 "$RUN"
cat > "$DIR/iso/session.conf" <<CONF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=$RUN</listen>
  <auth>EXTERNAL</auth>
  <servicedir>$DIR/iso/no-services</servicedir>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>
CONF
dbus-daemon --config-file="$DIR/iso/session.conf" --nofork --print-address=1 > "$DIR/bus.addr" 2>"$DIR/bus.log" &
PIDS+=($!)
# loop: SERIAL-REQUIRED — 1 s for the private bus to start
sleep 1
BUS="$(head -1 "$DIR/bus.addr")"
WL="ck-wl-upd"
ISO_ENV=(HOME="$DIR/home" USER="$USER" PATH="/usr/local/bin:/usr/bin:/bin" LANG="${LANG:-C.UTF-8}"
  XDG_RUNTIME_DIR="$RUN" DBUS_SESSION_BUS_ADDRESS="$BUS" XDG_SESSION_TYPE=wayland
  XDG_CONFIG_HOME="$DIR/home/.config" XDG_CACHE_HOME="$DIR/home/.cache" XDG_DATA_HOME="$DIR/home/.local/share"
  GTK_USE_PORTAL=0 NO_AT_BRIDGE=1 GSETTINGS_BACKEND=memory GIO_USE_VFS=local)
# The compositor outlives both copies (no --exit-with-session: the old copy quits during the test).
env -i "${ISO_ENV[@]}" kwin_wayland --virtual --no-lockscreen --no-global-shortcuts --socket "$WL" --width 1400 --height 900 > "$DIR/kwin.log" 2>&1 &
PIDS+=($!)
# loop: SERIAL-REQUIRED — waits for the compositor's socket, 0.2 s steps [bounded: 10 s]
for _ in $(seq 1 50); do [ -S "$RUN/$WL" ] && break; sleep 0.2; done
[ -S "$RUN/$WL" ] || { echo "kwin_wayland did not start (kwin.log)" >&2; exit 1; }

SD_PID=""
if [ "$SYSTEMD" = 1 ]; then
  mkdir -p "$DIR/iso/units"
  # loop: NOT-WORTH — the six empty targets a transient service's default dependencies name
  for t in default basic sockets timers paths shutdown exit; do printf '[Unit]\nDescription=%s (test)\n' "$t" > "$DIR/iso/units/$t.target"; done
  env -i "${ISO_ENV[@]}" SYSTEMD_UNIT_PATH="$DIR/iso/units" /usr/lib/systemd/systemd --user --log-target=console > "$DIR/systemd.log" 2>&1 &
  SD_PID=$!
  # loop: SERIAL-REQUIRED — waits for the private manager's socket, 0.1 s steps [bounded: 5 s]
  for _ in $(seq 1 50); do [ -S "$RUN/systemd/private" ] && break; sleep 0.1; done
  [ -S "$RUN/systemd/private" ] || { echo "the private systemd --user did not start (systemd.log)" >&2; exit 1; }
fi

# The old copy, isolated. Its restart passes the session variables on (relaunch.ts), so the new copy is isolated too.
env -i "${ISO_ENV[@]}" WAYLAND_DISPLAY="$WL" \
  CK_UPDATE_MANIFEST=http://127.0.0.1:8765/latest.json CK_UPDATE_PUBKEY="$(cat "$DIR/test-key.pub")" \
  setsid "$DIR/run/$(basename "$OLD")" --no-sandbox --password-store=basic --remote-debugging-port=0 --enable-logging=file --log-file="$DIR/chromium.log" > "$DIR/app-old.log" 2>&1 &
PIDS+=($!)

# The AppImage mounts every 0.2 s (the old copy's must go once it has quit). Only the mount table: reading
# another process's /proc entries can block while it exits from a FUSE mount (measured: an `ss -p` sampler stalled).
# loop: SERIAL-REQUIRED — a 0.2 s sampler for the test's length [bounded: killed at cleanup]
( while :; do echo "$(date +%T.%N | cut -c1-12) $(grep -oE '/tmp/\.mount_Corrid[^ ]*' /proc/self/mountinfo | tr '\n' ' ')"; sleep 0.2; done > "$DIR/mounts.log" 2>&1 ) &
PIDS+=($!)
# The old copy's Electron main and the moment it is gone (kill -0 only: no /proc reads while it exits from FUSE),
# then the new copy's main: its start time and cgroup (read while it runs: the driver closes it at the end).
# loop: SERIAL-REQUIRED — waits for the old main, its end, then the new main, 0.05-0.1 s steps [bounded: killed at cleanup]
( m=""; while [ -z "$m" ]; do m="$(main_pids | head -1)"; sleep 0.1; done; echo "$m" > "$DIR/old-main.pid"
  # loop: SERIAL-REQUIRED — the old main's end, 0.05 s steps [bounded: killed at cleanup]
  while kill -0 "$m" 2>/dev/null; do sleep 0.05; done; uptime_now > "$DIR/old-gone"
  # loop: SERIAL-REQUIRED — the new main's start, 0.1 s steps [bounded: killed at cleanup]
  n=""; while [ -z "$n" ]; do n="$(main_pids | grep -vx "$m" | head -1 || true)"; sleep 0.1; done
  echo "$n $(started_at "$n") $(sed -n 's/^0:://p' "/proc/$n/cgroup")" > "$DIR/new-main"
  # --systemd: the relaunch unit's command as the private manager has it (the unit is gone once the copy closes)
  if [ "$SYSTEMD" = 1 ]; then
    u="$(sed -n 's/^0:://p' "/proc/$n/cgroup" | grep -oE 'corridorkey-relaunch-[0-9]+\.service' || true)"
    [ -n "$u" ] && env -i "${ISO_ENV[@]}" systemctl --user show -p ExecStart --value "$u" > "$DIR/relaunch-unit.txt" 2>&1
  fi ) &
PIDS+=($!)
# loop: SERIAL-REQUIRED — the driver step and its failure dump (one run)
if ! node "$APP/tools/update_e2e.mjs" --port-file "$DIR/home/.config/corridorkey-desktop/DevToolsActivePort" --expect "$VER" --out "$DIR"; then
  diag
  echo "--- diagnostics: $DIR/diag.txt"
  exit 1
fi
if [ -f "$DIR/new-main" ] && [ -f "$DIR/old-gone" ]; then
  read -r NEW_PID NEW_START NEW_CG < "$DIR/new-main"
  echo "--- the new copy's main process ($NEW_PID) started $(awk -v a="$NEW_START" -v b="$(cat "$DIR/old-gone")" 'BEGIN{printf "%+.2f", a - b}') s after the old one ($(cat "$DIR/old-main.pid")) had exited"
  echo "--- the new copy's cgroup: $NEW_CG"
fi
if [ "$SYSTEMD" = 1 ]; then
  case "${NEW_CG:-}" in *corridorkey-relaunch-*) ;; *) echo "FAIL: the new copy did not start through systemd-run" >&2; exit 1 ;; esac
  echo "--- the relaunch unit runs: $(grep -oE 'argv\[\]=[^;]*' "$DIR/relaunch-unit.txt" 2>/dev/null | cut -c1-160)"
  grep -q 'corridorkey-relaunch' "$DIR/relaunch-unit.txt" 2>/dev/null || { echo "FAIL: the relaunch unit does not wait for the old copy" >&2; exit 1; }
  # 0.25 s: the old copy's end is seen by a 0.05 s poll, the start time is in clock ticks
  awk -v a="$NEW_START" -v b="$(cat "$DIR/old-gone")" 'BEGIN{exit !(a - b >= -0.25)}' ||
    { echo "FAIL: the new copy started while the old one still ran" >&2; exit 1; }
fi
# loop: SERIAL-REQUIRED — 6 s: the mount guard's longest wait, then the old copy's mount must be gone
sleep 6
echo "--- AppImage mounts after the update (only the new copy's may remain):"
grep -E "mount_Corrid" /proc/self/mountinfo | cut -d' ' -f5 || true
diag
echo "--- run/ after the update:"; ls -la "$DIR/run"
